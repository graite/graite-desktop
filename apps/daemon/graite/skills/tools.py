"""Typed tool definitions. A tool is one operation the model may call; the schema comes
from the function signature and `Annotated[..., "description"]` parameter notes.

Groups: `read`, `search`, `meta` and `propose`. A propose tool never writes a page: it files a
proposal that the user accepts, edits or rejects (or that the page's policy applies for them).
There is no write group and never will be (CLAUDE.md rule 2).
"""

from __future__ import annotations

import inspect
import json
import types
import typing
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Annotated, Any, NotRequired, Required

from graite.vault.blocks import view_fields
from graite.vault.properties import (
    PageProperty,
    board_summary,
    compact_values,
    parse_properties,
)

ToolFn = Callable[..., Awaitable[Any]]

_EXAMPLE = '[{"name": "Status", "type": "status", "options": ["To do", "Done"], "value": "To do"}]'


class PropertyInput(typing.TypedDict, total=False):
    """One typed field on a page. Only `name` is required: the rest is inferred when missing."""

    name: Required[Annotated[str, "Field name, for example Status, Priority or Due."]]
    type: Annotated[
        str,
        "text, number, single_select, multi_select, date, checkbox, email, url or status. "
        "Use status for the field a board groups its columns by.",
    ]
    options: Annotated[
        list[str],
        "For status and select fields: every allowed option, the same on every card of a board.",
    ]
    value: Annotated[
        Any,
        "This page's value: one of the options for a status or select field, an ISO date "
        "(2026-10-02) for a date, true or false for a checkbox.",
    ]


@dataclass(frozen=True)
class Tool:
    name: str
    group: str
    description: str
    schema: dict[str, Any]
    fn: ToolFn


TOOLS: dict[str, Tool] = {}

_JSON_TYPES: dict[Any, str] = {str: "string", int: "integer", float: "number", bool: "boolean"}


def _json_type(annotation: Any) -> dict[str, Any]:
    origin = typing.get_origin(annotation)
    if origin is types.UnionType or origin is typing.Union:
        args = typing.get_args(annotation)
        members = [a for a in args if a is not type(None)]
        if len(members) == 1:
            spec = _json_type(members[0])
            if len(members) < len(args):  # `X | None`: the model may pass null
                spec["type"] = [spec["type"], "null"]
            return spec
    if origin is list:
        (item,) = typing.get_args(annotation) or (str,)
        return {"type": "array", "items": _json_type(item)}
    if annotation is Any:
        return {}  # a property value is legitimately text, a number, a bool or a list
    if typing.is_typeddict(annotation):
        hints = typing.get_type_hints(annotation, include_extras=True)
        # `from __future__ import annotations` makes the class body's annotations strings, so
        # TypedDict's own __required_keys__ never sees the Required[...] markers. Read the
        # resolved hints instead.
        total = getattr(annotation, "__total__", True)
        fields: dict[str, Any] = {}
        required: list[str] = []
        for key, hint in hints.items():
            marker = typing.get_origin(hint)
            if marker in (Required, NotRequired):
                (hint,) = typing.get_args(hint)
            if marker is Required or (total and marker is not NotRequired):
                required.append(key)
            note = ""
            if typing.get_origin(hint) is Annotated:
                hint, *extras = typing.get_args(hint)
                note = next((e for e in extras if isinstance(e, str)), "")
            fields[key] = _json_type(hint)
            if note:
                fields[key]["description"] = note
        return {
            "type": "object",
            "properties": fields,
            "required": required,
            "additionalProperties": False,
        }
    return {"type": _JSON_TYPES.get(annotation, "string")}


def build_schema(name: str, description: str, fn: ToolFn) -> dict[str, Any]:
    properties: dict[str, Any] = {}
    required: list[str] = []
    hints = typing.get_type_hints(fn, include_extras=True)
    for index, (param_name, param) in enumerate(inspect.signature(fn).parameters.items()):
        if index == 0:
            continue  # the registry
        annotation = hints.get(param_name, str)
        note = ""
        if typing.get_origin(annotation) is Annotated:
            annotation, *extras = typing.get_args(annotation)
            note = next((e for e in extras if isinstance(e, str)), "")
        spec = _json_type(annotation)
        if note:
            spec["description"] = note
        properties[param_name] = spec
        if param.default is inspect.Parameter.empty:
            required.append(param_name)
    return {
        "type": "function",
        "function": {
            "name": name,
            "description": description,
            "parameters": {
                "type": "object",
                "properties": properties,
                "required": required,
                "additionalProperties": False,
            },
        },
    }


def tool(group: str, description: str) -> Callable[[ToolFn], ToolFn]:
    if group not in ("read", "search", "meta", "propose"):
        raise ValueError(f"Unknown tool group {group!r}.")

    def register(fn: ToolFn) -> ToolFn:
        name = fn.__name__
        TOOLS[name] = Tool(name, group, description, build_schema(name, description, fn), fn)
        return fn

    return register


# ----------------------------------------------------------------------------- built-ins


@tool("meta", "Load a named skill from the available skills index.")
async def load_skill(
    registry: Any, name: Annotated[str, "Exact skill name from the index."]
) -> Any:
    skill = registry.library.get(str(name))
    if not skill:
        raise ValueError("Skill not found in the available index.")
    allowed = skill.get("allowed_tools")
    if isinstance(allowed, str):
        allowed = allowed.replace(",", " ").split()
    if isinstance(allowed, list):
        registry.allowed.intersection_update(allowed)
    return {"name": skill["name"], "instructions": skill["body"][: registry.result_limit]}


def _card_properties(registry: Any, parent: str, limit: int = 500) -> list[list[PageProperty]]:
    """The properties of `parent`'s child pages in scope, from the index."""
    rows = registry.ops.db.execute(
        "SELECT path, frontmatter_json FROM pages WHERE parent_path=? "
        "ORDER BY (order_key IS NULL), order_key, lower(title) LIMIT ?",
        (parent, limit),
    ).fetchall()
    out: list[list[PageProperty]] = []
    for row in rows:
        if not registry.scope.contains(row["path"]):
            continue
        try:
            meta = json.loads(row["frontmatter_json"] or "{}")
        except ValueError:
            meta = {}
        out.append(parse_properties(meta.get("properties") if isinstance(meta, dict) else None))
    return out


async def _board_fields(registry: Any, doc: Any) -> tuple[str, list[dict[str, Any]]] | None:
    """The board this page is (a graite:view parent or a page whose children carry
    properties) or belongs to as a card: its fields, options and value counts."""
    own_view = view_fields(doc.body)
    cards = _card_properties(registry, doc.path)
    if own_view or any(cards):
        return doc.path, board_summary([own_view, *cards], cards)
    parent = doc.path.rpartition("/")[0]
    if not parent or not registry.scope.contains(parent):
        return None
    try:
        parent_doc = await registry.ops.read_page(parent)
    except (ValueError, OSError):
        return None
    view = view_fields(parent_doc.body)
    siblings = _card_properties(registry, parent)
    if view or any(siblings):
        return parent, board_summary([view, *siblings], siblings)
    return None


@tool("read", "Read a page or section. If truncated, read again with next_offset to continue.")
async def read_page(
    registry: Any,
    path: Annotated[str, "Exact vault-relative page path from the pages list or a search hit."],
    section: Annotated[str | None, "Optional heading text to read only that section."] = None,
    offset: Annotated[
        int, "Character offset; use next_offset from a truncated read to continue."
    ] = 0,
) -> Any:
    if not isinstance(offset, int) or offset < 0:
        raise ValueError("offset must be a non-negative integer.")
    rel = registry.scoped(path)
    doc = await registry.ops.read_page(rel)
    body = doc.body
    heading = None
    if section:
        rows = registry.ops.db.execute(
            "SELECT text, heading_path FROM chunks WHERE page_path=? ORDER BY ord", (rel,)
        ).fetchall()
        wanted = section.strip().lower()
        parts = [
            r["text"]
            for r in rows
            if any(h.strip().lower() == wanted for h in json.loads(r["heading_path"]))
        ]
        if parts:
            body, heading = "\n\n".join(parts), section.strip()
    effective = registry.scope.policy_for(doc.path)
    excerpt = body[offset : offset + registry.result_limit]
    result = {
        "path": doc.path,
        "title": doc.title,
        "body": excerpt,
        "ai_instructions": effective.instructions,
        "changes": effective.autonomy,
        "properties": doc.frontmatter.get("properties", []),
    }
    board = await _board_fields(registry, doc)
    if board is not None:
        # Reuse these names and options on new cards; add an option for a genuinely new value.
        result["board_path"], result["board_fields"] = board
    if heading:
        result["section"] = heading
    if offset or len(body) > registry.result_limit:
        result["offset"] = offset
        result["total_chars"] = len(body)
    if offset + len(excerpt) < len(body):
        result["truncated"] = True
        result["next_offset"] = offset + len(excerpt)
    registry.note_source(
        kind="page",
        page_path=doc.path,
        page_id=doc.id,
        title=doc.title,
        heading_path=[heading] if heading else [],
        text=excerpt,
        hash=doc.hash,
        result=result,
    )
    return result


@tool(
    "read",
    "List up to 100 child pages in scope, with each one's filled properties. Use an empty "
    "path for top-level pages.",
)
async def list_children(
    registry: Any,
    path: Annotated[str, "Parent page path, or an empty string for the vault root."],
    offset: Annotated[int, "Skip this many children to get the next batch."] = 0,
) -> Any:
    if not isinstance(offset, int) or offset < 0:
        raise ValueError("offset must be a non-negative integer.")
    parent = registry.scoped(path) if path else ""
    children: list[dict[str, Any]] = [
        dict(p)
        for p in registry.paths()
        if p["path"].rpartition("/")[0] == parent and p["path"] != parent
    ][offset : offset + 100]
    if children:
        marks = ",".join("?" * len(children))
        stored = {
            row["path"]: row["frontmatter_json"]
            for row in registry.ops.db.execute(
                f"SELECT path, frontmatter_json FROM pages WHERE path IN ({marks})",
                [c["path"] for c in children],
            )
        }
        for child in children:
            try:
                meta = json.loads(stored.get(child["path"]) or "{}")
            except ValueError:
                continue
            raw = meta.get("properties") if isinstance(meta, dict) else None
            values = compact_values(parse_properties(raw), limit=6)
            if values:
                child["properties"] = values
    return children


@tool("search", "Search the pages in scope for passages that match a question or keywords.")
async def search_vault(
    registry: Any,
    query: Annotated[str, "A question or a few keywords; quote exact phrases."],
    k: Annotated[int, "How many passages to return (1-20)."] = 8,
) -> Any:
    query = str(query)[:300].strip()
    if not query:
        raise ValueError("Enter at least one search word.")
    k = max(1, min(int(k), 20))
    candidates = await registry.searcher.search(query, registry.scope, k=k)
    results = []
    for c in candidates[:k]:
        entry = {
            "path": c.page_path,
            "title": c.title,
            "heading": " > ".join(c.heading_path),
            "snippet": c.text[:600],
        }
        registry.note_source(
            kind="page",
            page_path=c.page_path,
            page_id=c.page_id,
            title=c.title,
            heading_path=c.heading_path,
            text=c.text,
            hash=c.file_hash,
            result=entry,
            chunk_ids=[c.chunk_id],
        )
        results.append(entry)
    return results


@tool(
    "search",
    "Search your memory of the user (one page per memory) for what matches a topic or a "
    "question. Check it before saving a memory, so you do not add one twice.",
)
async def search_memory(
    registry: Any,
    query: Annotated[str, "What to look for, in a few words."],
    k: Annotated[int, "How many memories to return (1-20)."] = 8,
) -> Any:
    from graite.assistant import memory

    root = registry.turn.get("memory_root")
    state = registry.state
    if not root or state is None:
        raise ValueError("This conversation has no memory.")
    query = str(query)[:300].strip()
    if not query:
        raise ValueError("Enter at least one search word.")
    found = await memory.search(
        state,
        root,
        query,
        cloud=bool(registry.turn.get("cloud_model")),
        limit=max(1, min(int(k), 20)),
    )
    if not found:
        return {"memories": [], "note": "Nothing in memory matches that."}
    return {"memories": [m.to_dict() for m in found]}


# ----------------------------------------------------------------------------- proposals


async def _propose(registry: Any, kind: str, path: str, summary: str, **fields: Any) -> Any:
    from graite.review import policy as review_policy

    proposals = getattr(registry, "proposals", None)
    if proposals is None:
        raise ValueError("Proposals are not available in this conversation.")
    rel = registry.create_parent(path) if kind == "create" else registry.scoped(path)
    subject = rel if kind != "create" else (rel or None)
    effective = registry.scope.policy_for(subject) if subject else registry.scope.policy
    decision = review_policy.decide(
        effective,
        kind,
        cloud_model=bool(registry.turn.get("cloud_model")),
        opted=review_policy.opted_in(registry.ops.db),
    )
    if decision.action == "refuse":
        raise ValueError(decision.reason)
    proposal = await proposals.create(
        kind,
        rel,
        summary=str(summary or "")[:500] or f"{kind} {rel}",
        policy=decision.policy,
        run_id=registry.turn.get("run_id"),
        conversation_id=registry.turn.get("conversation_id"),
        opt_in_source=decision.opt_in_source,
        **fields,
    )
    registry.pending_events.append({"type": "proposal", "proposal": proposal})
    status = proposal["status"]
    if status == "auto_applied":
        message = f"Applied {proposal['id']} ({decision.reason}). The user can revert it."
    elif decision.policy == review_policy.NEEDS_OPT_IN:
        message = (
            f"Proposal {proposal['id']} created; awaiting review "
            "(auto-apply needs a one-time confirmation)."
        )
    else:
        message = f"Proposal {proposal['id']} created; awaiting review."
    return {
        "proposal_id": proposal["id"],
        "status": status,
        "path": proposal.get("new_path") or proposal["page_path"],
        "message": message,
    }


@tool("meta", "Ask one clarification needed to continue. Pauses this turn for the user's reply.")
async def request_clarification(
    registry: Any,
    question: Annotated[str, "A short, specific question about the missing decision."],
) -> Any:
    question = str(question).strip()
    if not question:
        raise ValueError("Ask a nonempty question.")
    return {"question": question[:1000], "status": "needs_input"}


@tool(
    "propose",
    "Propose replacing one passage of a page. `old` must occur exactly once on the page; quote "
    "it verbatim. Nothing changes until the user accepts.",
)
async def propose_edit(
    registry: Any,
    path: Annotated[str, "Vault-relative page path."],
    old: Annotated[str, "The exact text to replace, copied from the page."],
    new: Annotated[str, "The replacement text."],
    summary: Annotated[str, "One line saying what the change does and why."],
) -> Any:
    return await _propose(
        registry, "edit", str(path), str(summary), old_text=str(old), new_text=str(new)
    )


@tool("propose", "Propose appending Markdown to the end of a page.")
async def propose_append(
    registry: Any,
    path: Annotated[str, "Vault-relative page path."],
    text: Annotated[str, "Markdown to add at the end."],
    summary: Annotated[str, "One line saying what is added and why."],
) -> Any:
    return await _propose(registry, "append", str(path), str(summary), new_text=str(text))


@tool(
    "propose",
    "Propose a new page with a title and Markdown body under a parent page. `properties` gives "
    "the page typed fields, which is how a card joins a board on its parent page. Returns the "
    "path the page will have, for use as the parent of the pages nested under it.",
)
async def propose_create(
    registry: Any,
    title: Annotated[str, "Title of the new page."],
    body: Annotated[str, "Markdown body of the new page."],
    summary: Annotated[str, "One line saying what the page is for."],
    parent_path: Annotated[
        str | None,
        "Parent page path, or omit to create it at the vault root. May be the path a page "
        "proposed earlier in this turn will have.",
    ] = None,
    properties: Annotated[
        list[PropertyInput] | None,
        f"Typed fields for this page, for example {_EXAMPLE}. Nested pages only.",
    ] = None,
) -> Any:
    return await _propose(
        registry,
        "create",
        str(parent_path or ""),
        str(summary),
        title=str(title),
        new_text=str(body),
        properties=list(properties) if properties else None,
    )


@tool(
    "propose",
    "Propose setting typed fields on an existing page: give it a Status, move a card to another "
    "column of its board, or fill in a date. Fields you do not list are left as they are.",
)
async def propose_properties(
    registry: Any,
    path: Annotated[str, "Vault-relative page path."],
    properties: Annotated[list[PropertyInput], f"The fields to set, for example {_EXAMPLE}."],
    summary: Annotated[str, "One line saying what changes and why."],
) -> Any:
    return await _propose(
        registry, "properties", str(path), str(summary), properties=list(properties or [])
    )


@tool(
    "propose",
    "Propose moving a page to the trash. Applied automatically only where the page's AI "
    "settings allow deletes (the assistant's own memory); otherwise it awaits review.",
)
async def propose_delete(
    registry: Any,
    path: Annotated[str, "Vault-relative page path."],
    summary: Annotated[str, "One line saying why the page should go."],
) -> Any:
    return await _propose(registry, "delete", str(path), str(summary))


@tool("propose", "Propose moving a page under another page. Never applied automatically.")
async def propose_move(
    registry: Any,
    path: Annotated[str, "Vault-relative page path."],
    summary: Annotated[str, "One line saying why."],
    new_parent_path: Annotated[str | None, "Destination parent page, or omit for the root."] = None,
) -> Any:
    # The destination may be a page proposed earlier in this turn, as for propose_create.
    target = registry.create_parent(str(new_parent_path)) if new_parent_path else ""
    return await _propose(registry, "move", str(path), str(summary), new_path=target)


@tool("meta", "List this conversation's proposals and their status.")
async def list_proposals(
    registry: Any,
    status: Annotated[str | None, "pending, accepted, rejected, conflict or omit for all."] = None,
) -> Any:
    proposals = getattr(registry, "proposals", None)
    if proposals is None:
        return []
    rows = proposals.find(
        status=str(status) if status else None,
        conversation_id=registry.turn.get("conversation_id"),
        limit=50,
    )
    return [
        {
            "id": r["id"],
            "kind": r["kind"],
            "page_path": r["new_path"] or r["page_path"],
            "summary": r["summary"],
            "status": r["status"],
            "reason": r["reason"],
        }
        for r in rows
    ]


# ----------------------------------------------------------------------------- scheduling


@tool(
    "meta",
    "Schedule instructions to run later as an agent over this conversation's pages: `when` is "
    "'in 2 hours', 'tomorrow', an ISO time, or a five-field cron expression for a repeating "
    "schedule. The run files proposals; it never writes pages.",
)
async def schedule(
    registry: Any,
    when: Annotated[str, "When to run: 'in 30 minutes', 'tomorrow', ISO time or cron."],
    instructions: Annotated[str, "What the scheduled run should do."],
    name: Annotated[str | None, "Short name for a repeating schedule."] = None,
) -> Any:
    from graite.jobs.queue import PRIORITY_SUMMARY
    from graite.jobs.when import is_cron, parse_when

    state = getattr(registry, "state", None)
    if state is None or not hasattr(state, "queue"):
        raise ValueError("Scheduling is not available in this conversation.")
    text = str(instructions).strip()
    if not text:
        raise ValueError("Say what the scheduled run should do.")
    scope = registry.scope.scope
    payload = {
        "instructions": text[:8000],
        "scope": scope.to_dict(),
        "mode": "act",
        "conversation_id": registry.turn.get("conversation_id"),
    }
    root = scope.roots[0] if scope.roots else None
    when_text = str(when).strip()
    if is_cron(when_text):
        cron = getattr(state, "cron", None)
        if cron is None:
            raise ValueError("Repeating schedules are not available.")
        row = cron.create(
            str(name or text[:60]),
            " ".join(when_text.split()),
            "agent_run",
            payload,
            source="tool",
            page_path=root,
        )
        return {"cron_id": row["id"], "expr": row["expr"], "next_run_at": row["next_run_at"]}
    at = parse_when(when_text)
    job_id = state.queue.enqueue(
        "agent_run",
        {**payload, "trigger": "tool"},
        page_path=root,
        priority=PRIORITY_SUMMARY,
        run_at=at.isoformat(),
        max_attempts=1,
    )
    return {"job_id": job_id, "runs_at": at.isoformat()}
