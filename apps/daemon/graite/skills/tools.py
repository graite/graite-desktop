"""Typed tool definitions. A tool is one operation the model may call; the schema comes
from the function signature and `Annotated[..., "description"]` parameter notes.

Groups: `read`, `search`, `meta` and `propose`. A propose tool never writes a page: it files a
proposal that the user accepts, edits or rejects (or that the page's policy applies for them).
There is no write group and never will be (CLAUDE.md rule 2).
"""

from __future__ import annotations

import asyncio
import inspect
import json
import types
import typing
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Annotated, Any, NotRequired, Required

import yaml

from graite.vault.blocks import check_fences, view_fields
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


class RowOpInput(typing.TypedDict, total=False):
    """One row change in a table."""

    op: Required[Annotated[str, "insert, update or delete."]]
    id: Annotated[
        str,
        "The row's id (the `id` column from read_tables or run_query_ro). Required for update "
        "and delete; leave it out for insert.",
    ]
    values: Annotated[
        Any,
        'Column name -> new value, for insert and update, e.g. {"amount": 30, '
        '"category": "Travel"}. Numbers as numbers, dates as 2026-10-02, checkboxes as '
        "true/false, multi-select as a list.",
    ]
    after: Annotated[str, "Insert only: the id of the row to insert after; default the end."]


class ChartInput(typing.TypedDict, total=False):
    """A chart over a page's tables (a graite:chart fence)."""

    source: Annotated[
        str,
        "The table, as read_tables lists it: its name on the page (cars), or its path "
        "(Garage/_data/cars.csv). Leave out when using sql.",
    ]
    sql: Annotated[
        str,
        "Instead of source/x/y: one SELECT; the first column is the label, every other "
        "column a series. Join relations through links(table, column, row_id, target_table, "
        "target_id).",
    ]
    type: Annotated[str, "bar (default), line, area, pie, donut, scatter or number."]
    x: Annotated[
        str,
        "The field along the axis (or the slices of a pie): a column, a date bucket like "
        "month(date) (day, week, month, quarter, year), a relation column (its rows' names) "
        "or relation.column to group by a field of the linked rows (owner.city).",
    ]
    y: Annotated[
        Any,
        "What to show: a number column (rating: its values, added up per label), count "
        "(default), avg(col), min(col), max(col), count(col); a list draws one series each.",
    ]
    series: Annotated[str, "Split each bar or line by this field (like x)."]
    filter: Annotated[str, 'Which rows count, in the table filter language: status = "Done".']
    sort: Annotated[str, "x asc, x desc, y asc or y desc."]
    limit: Annotated[int, "At most this many labels (1-500)."]
    stacked: Annotated[bool, "Stack the series of a bar, line or area chart."]
    title: Annotated[str, "The chart's title; one is made from the fields when left out."]
    height: Annotated[int, "Height in pixels (120-2000), default 300."]


CHART_ORDER = (
    "title",
    "source",
    "sql",
    "type",
    "x",
    "y",
    "series",
    "filter",
    "sort",
    "limit",
    "stacked",
    "height",
)


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
            if not isinstance(meta, dict):
                continue
            values = compact_values(parse_properties(meta.get("properties")), limit=6)
            if values:
                child["properties"] = values
            if meta.get("instructions"):
                child["has_instructions"] = True  # read_page returns them
    return children


def _with_own_instructions(registry: Any, paths: list[str]) -> set[str]:
    """The pages among `paths` whose own frontmatter sets AI instructions."""
    rows = registry.ops.db.execute(
        "SELECT path FROM pages WHERE json_extract(frontmatter_json, '$.instructions') "
        "IS NOT NULL AND json_extract(frontmatter_json, '$.instructions') != ''"
    ).fetchall()
    wanted = set(paths)
    return {r["path"] for r in rows if r["path"] in wanted}


@tool(
    "read",
    "Show the page tree under a page, or the whole workspace for an empty path: `depth` "
    "levels of nested pages (1-6; use 4 or more for a deep overview). Pages marked * have "
    "their own AI instructions; read_page returns them. Collapsed branches name the call "
    "that opens them.",
)
async def navigate(
    registry: Any,
    path: Annotated[str, "Page to start from, or an empty string for the whole workspace."] = "",
    depth: Annotated[int, "How many levels of nested pages to show (1-6)."] = 2,
) -> Any:
    from graite.retrieval.navigation import render_subtree

    if not isinstance(depth, int) or not 1 <= depth <= 6:
        raise ValueError("depth must be a whole number from 1 to 6.")
    root = registry.scoped(path) if path else ""
    entries = registry.paths()
    titles = {e["path"]: e["title"] for e in entries}
    under = [
        p for p in titles if registry.scope.contains(p) and (not root or p.startswith(root + "/"))
    ]
    tree, used = render_subtree(
        [*under, *([root] if root else [])],
        titles,
        root,
        depth,
        registry.result_limit,
        _with_own_instructions(registry, under),
    )
    effective = registry.scope.policy_for(root) if root else registry.scope.policy
    result: dict[str, Any] = {
        "path": root,
        "title": titles.get(root, "Workspace") if root else "Workspace",
        "pages": len(under),
        "depth": used,
        "tree": tree or "(no pages)",
        "note": "Indentation is nesting: a page's path is its line joined to its parents' "
        "with '/'. Titles that differ from the path segment are in parentheses.",
    }
    if effective.instructions:
        result["ai_instructions"] = effective.instructions
    if used < depth:
        result["note"] += f" Shown {used} levels deep to fit; navigate a branch to go deeper."
    return result


@tool(
    "read",
    "Find which pages a name refers to, best match first. Call it when the user names a page "
    "you have not seen the path of. When `ambiguous` is true, ask the user which one they "
    "mean before changing anything.",
)
async def find_pages(
    registry: Any,
    name: Annotated[str, "The page name as the user said it, for example Atlas or weekly notes."],
) -> Any:
    from graite.retrieval.navigation import rank_pages

    name = str(name).strip()
    if not name:
        raise ValueError("Give the page name to look for.")
    titles = {e["path"]: e["title"] for e in registry.paths() if registry.scope.contains(e["path"])}
    ranked = rank_pages(name[:200], titles)
    candidates = [
        {
            "path": path,
            "title": titles[path],
            "parent": path.rpartition("/")[0],
            "match": evidence,
        }
        for path, evidence in ranked
    ]
    exact = [c for c in candidates if c["match"] == "exact"]
    ambiguous = len(exact) != 1 and len(candidates) > 1
    result: dict[str, Any] = {"name": name, "candidates": candidates, "ambiguous": ambiguous}
    if not candidates:
        result["note"] = "No page matches. Ask the user, or look with navigate or search_vault."
    elif ambiguous:
        result["note"] = "Several pages could be meant. Ask the user which one."
    return result


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


# ----------------------------------------------------------------------------- tables (D69)

TABLE_HELP = (
    "Query with run_query_ro using the sql_name of each table. pages(path, title, parent_path, "
    "created, updated, tags) and page_props(path, name, value) hold the pages in scope and "
    "their properties. Multi-select cells are text like 'a; b'. Relation cells link rows of "
    "another table: in SQL they are text like '[[<row id>|<label>]] [[<row id>|<label>]]'; "
    "in propose_rows give a list of the target rows' ids. Columns marked reverse are derived "
    "from the other table and are not in SQL; change the forward column there (propose_rows "
    "on a reverse column also works). Change rows with propose_rows."
)


def _tables(registry: Any) -> Any:
    cache = getattr(registry.ops, "tables", None)
    if cache is None:
        raise ValueError("Tables are not available here.")
    return cache


def _table_alias(page: str, info: Any) -> str:
    from graite.tables.scope import table_alias

    return table_alias(page, info)


def _sql_name(alias: str) -> str:
    from graite.tables.scope import sql_name

    return sql_name(alias)


@tool(
    "read",
    "List the data tables (CSV files) of a page and its subpages: each table's SQL name, "
    "columns with types and options, row count and a few rows with their ids. Use before "
    "run_query_ro or propose_rows.",
)
async def read_tables(
    registry: Any,
    page_path: Annotated[str, "Vault-relative page path that has tables."],
) -> Any:
    rel = registry.scoped(page_path)
    cache = _tables(registry)
    infos = [
        info
        for info in await asyncio.to_thread(cache.tables)
        if (info.page_path == rel or info.page_path.startswith(rel + "/"))
        and registry.scope.contains(info.page_path)
    ]
    out = []
    for info in infos:
        sample = await asyncio.to_thread(cache.select, info.path, limit=3)
        names = sample["visible"]
        out.append(
            {
                "path": info.path,
                "sql_name": _sql_name(_table_alias(rel, info)),
                "rows": info.row_count,
                "columns": [
                    {
                        "name": c.name,
                        "type": c.type,
                        **({"options": c.options} if c.options else {}),
                        **(
                            {
                                "links_to": c.target or c.table,
                                "cardinality": c.cardinality,
                                **({"reverse_of": c.reverse} if c.reverse else {}),
                            }
                            if c.type == "relation"
                            else {}
                        ),
                    }
                    for c in info.columns
                ],
                "sample": [dict(zip(names, r["cells"], strict=False)) for r in sample["rows"]],
            }
        )
    effective = registry.scope.policy_for(rel)
    result: dict[str, Any] = {"page": rel, "tables": out, "help": TABLE_HELP}
    if not out:
        result["message"] = "This page and its subpages have no tables."
    if effective.instructions:
        result["ai_instructions"] = effective.instructions
    return result


@tool(
    "read",
    "Run one read-only SQL SELECT over the tables in scope and the pages table. Tables on "
    "page_path are named by their name (expenses); others by their path "
    '("Projects/Atlas/expenses"). pages(path, title, parent_path, created, updated, tags) and '
    "page_props(path, name, value) hold pages and their properties. links(table, column, "
    "row_id, target_table, target_id) holds every relation link: join a table's id to "
    "links.row_id and links.target_id to the other table's id. At most 200 rows return.",
)
async def run_query_ro(
    registry: Any,
    page_path: Annotated[str, "The page the query is about; its tables get short names."],
    sql: Annotated[str, "One SELECT statement (WITH ... SELECT is fine)."],
) -> Any:
    from graite.tables.readonly import run_query
    from graite.tables.scope import query_pages, query_tables

    rel = registry.scoped(page_path)
    cache = _tables(registry)
    infos = [
        info
        for info in await asyncio.to_thread(cache.tables)
        if registry.scope.contains(info.page_path)
    ]
    tables = query_tables(rel, infos)
    pages = query_pages(registry.ops.db, registry.scope.contains)
    result = await asyncio.to_thread(run_query, cache.db_path, tables, pages, str(sql))
    # Keep the answer inside the tool budget: drop rows from the end, and say so.
    while result["rows"] and len(json.dumps(result, default=str)) > registry.result_limit:
        result["rows"] = result["rows"][: len(result["rows"]) * 3 // 4]
        result["truncated"] = True
    result["row_count"] = len(result["rows"])
    return result


@tool(
    "propose",
    "Propose adding, changing or deleting rows in a data table (a CSV in a page's _data "
    "folder). Address rows by their id from read_tables or run_query_ro. The page's AI "
    "settings decide whether this applies at once or waits for review.",
)
async def propose_rows(
    registry: Any,
    table_path: Annotated[str, "The table's path from read_tables, e.g. Atlas/_data/expenses.csv."],
    ops: Annotated[list[RowOpInput], "The row changes, applied in order."],
    summary: Annotated[str, "One line saying what changes and why."],
) -> Any:
    from graite.tables import paths as table_paths

    table = table_paths.parse(str(table_path))
    if not ops:
        raise ValueError("Give at least one row change.")
    return await _propose(
        registry,
        "rows",
        table.page,
        str(summary),
        rows={"table": table.rel, "ops": [dict(o) for o in ops]},
    )


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
    result = {
        "proposal_id": proposal["id"],
        "status": status,
        "path": proposal.get("new_path") or proposal["page_path"],
        "message": message,
    }
    if effective.instructions:
        # What the user asked of AI on this page (or a new page's parent) — follow it next.
        result["ai_instructions"] = effective.instructions
    return result


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
    "Propose a chart of a page's table data (a bar, line, area, pie, donut, scatter or big "
    "number), drawn from the page's tables, its subpages' and the tables they link to, and "
    "updated as rows change. Read the tables with read_tables first. The chart is checked "
    "against the data before it is filed. With `title_page`, a new page is proposed under "
    "`page_path` for it instead.",
)
async def propose_chart(
    registry: Any,
    page_path: Annotated[str, "The page to add the chart to."],
    chart: Annotated[ChartInput, "What to draw."],
    summary: Annotated[str, "One line saying what the chart shows."],
    title_page: Annotated[str | None, "Title of a new page for the chart, under page_path."] = None,
) -> Any:
    from graite.tables.charts import chart_data

    spec = {k: chart[k] for k in CHART_ORDER if isinstance(chart, dict) and k in chart}  # type: ignore[literal-required]
    if isinstance(spec.get("y"), list) and len(spec["y"]) == 1:
        spec["y"] = spec["y"][0]
    rel = registry.scoped(page_path)
    cache = _tables(registry)
    # Draw it once now: a wrong column or relation comes back as words to fix, not as a
    # broken block on the page.
    data_spec = {k: v for k, v in spec.items() if k not in ("title", "height")}
    await asyncio.to_thread(chart_data, cache, registry.ops.db, rel, data_spec)
    fence = "```graite:chart\n" + yaml.safe_dump(spec, sort_keys=False, allow_unicode=True)
    fence += "```\n"
    problem = check_fences(fence)
    if problem:
        raise ValueError(problem)
    if title_page:
        return await _propose(
            registry, "create", rel, str(summary), title=str(title_page), new_text=fence
        )
    return await _propose(registry, "append", rel, str(summary), new_text="\n" + fence)


@tool(
    "propose",
    "Propose an HTML dashboard for a page: a file in its _dashboards folder, shown on the "
    "page in a sandboxed frame with no network. In the HTML, window.graite gives the data: "
    "await graite.query(sql) returns rows as objects (read-only SQL over the page's tables, "
    "its subpages' and the tables they link to, plus links and pages); "
    "graite.chart(element, spec) draws a chart spec like propose_chart's (or any ECharts "
    "option) that redraws itself; graite.onChange(fn) runs when the data changes; "
    "graite.format(n, currency) formats numbers; CSS variables --graite-fg, --graite-muted, "
    "--graite-border, --graite-bg and --graite-color-1..9 follow the app's theme. ECharts is "
    "loaded as `echarts`. Load the charts-and-dashboards skill for a full example. Giving "
    "the name of an existing dashboard replaces its HTML (read it first).",
)
async def propose_dashboard(
    registry: Any,
    page_path: Annotated[str, "The page the dashboard belongs to."],
    name: Annotated[str, "The file name without .html, e.g. overview."],
    html: Annotated[str, "The whole HTML document."],
    summary: Annotated[str, "One line saying what the dashboard shows."],
    show_on_page: Annotated[
        bool, "Also add the dashboard block to the page when it is not shown there yet."
    ] = True,
) -> Any:
    from graite.dashboards import paths as dash_paths
    from graite.dashboards.validation import check_html

    text = str(html)
    check_html(text)
    rel = registry.scoped(page_path)
    target = dash_paths.parse(rel, str(name))
    if "propose_edit" not in registry.allowed and await registry.ops.read_dashboard(
        target.page, target.src
    ):
        # Ask mode adds things but never rewrites them: a new name, or Act mode, to change it.
        raise ValueError(
            f"{target.src} already exists. In this chat mode you can add a new dashboard "
            "(another name); switching to Act lets you change this one."
        )
    return await _propose(
        registry,
        "dashboard",
        rel,
        str(summary),
        dashboard={"src": target.src, "html": text, "show": bool(show_on_page)},
    )


@tool(
    "read",
    "Read a page's dashboard HTML (a file in its _dashboards folder), before changing it "
    "with propose_dashboard.",
)
async def read_dashboard(
    registry: Any,
    page_path: Annotated[str, "The page the dashboard belongs to."],
    name: Annotated[str, "The file name without .html, e.g. overview."],
) -> Any:
    from graite.dashboards import paths as dash_paths

    rel = registry.scoped(page_path)
    target = dash_paths.parse(rel, str(name))
    html = await registry.ops.read_dashboard(target.page, target.src)
    if html is None:
        raise ValueError(f"{target.rel} does not exist; propose_dashboard creates it.")
    return {"path": target.rel, "src": target.src, "html": html[: registry.result_limit]}


@tool(
    "propose",
    "Propose a board (kanban), table or list view on a page: the page's child pages become "
    "its cards or rows, and `group` names the status field the columns come from. With "
    "`title`, a new page is proposed under `path` instead. Add the cards afterwards with "
    "propose_create (parent_path = the returned path) and change them with "
    "propose_properties.",
)
async def propose_view(
    registry: Any,
    path: Annotated[str, "The page to add the view to; with `title`, the new page's parent."],
    view: Annotated[str, "kanban, table or list."],
    summary: Annotated[str, "One line saying what the view is for."],
    group: Annotated[str | None, "The field that makes the columns, for example Status."] = None,
    show: Annotated[list[str] | None, "Other fields to show on each card or row."] = None,
    fields: Annotated[
        list[PropertyInput] | None,
        "Field definitions (name, type, options) so the view works before its first card; "
        "include the `group` field with its options.",
    ] = None,
    title: Annotated[str | None, "Title of a new page for the view, under `path`."] = None,
) -> Any:
    spec: dict[str, Any] = {"view": str(view).strip().lower()}
    if group:
        spec["group"] = str(group)
    if show:
        spec["show"] = [str(name) for name in show]
    if fields:
        spec["settings"] = {
            "fields": [
                {k: f[k] for k in ("name", "type", "options") if k in f}
                for f in fields
                if isinstance(f, dict)
            ]
        }
    fence = "```graite:view\n" + yaml.safe_dump(spec, sort_keys=False, allow_unicode=True)
    fence += "```\n"
    problem = check_fences(fence)
    if problem:
        raise ValueError(problem)
    if title:
        return await _propose(
            registry, "create", str(path or ""), str(summary), title=str(title), new_text=fence
        )
    rel = registry.scoped(path)
    doc = await registry.ops.read_page(rel)
    if view_fields(doc.body) or "```graite:view" in doc.body:
        raise ValueError(
            "This page already has a view. Change it with propose_edit, or add the view to a "
            "new page with `title`."
        )
    return await _propose(registry, "append", rel, str(summary), new_text="\n" + fence)


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
