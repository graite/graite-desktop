"""Built-in job handlers. Each receives a JobContext and returns a result dict."""

from __future__ import annotations

import asyncio
import json
import re
from dataclasses import replace
from datetime import UTC, datetime, timedelta
from typing import Any

from graite.index.db import transaction
from graite.jobs.queue import PRIORITY_REBUILD
from graite.jobs.worker import JobContext, PermanentJobError


async def embed(ctx: JobContext) -> dict[str, Any]:
    result: dict[str, Any] = await ctx.state.embedder.run_pending(ctx)
    return result


async def reindex(ctx: JobContext) -> dict[str, Any]:
    """Drop every derived row and rebuild from disk; vectors are re-created afterwards."""
    db = ctx.state.db
    ctx.progress(message="Rebuilding the page index…")
    with transaction(db):
        if db.execute("SELECT 1 FROM sqlite_master WHERE name='chunk_vec'").fetchone():
            db.execute("DROP TABLE chunk_vec")
        db.execute("DELETE FROM chunks")
        db.execute("DELETE FROM links")
        db.execute("UPDATE pages SET body_hash=NULL, indexed_at=NULL")
    count = await ctx.state.fileops.rescan()
    ctx.queue.enqueue("embed", key="embed", priority=PRIORITY_REBUILD)
    ctx.state.events.publish("tree_changed", {"reason": "reindex", "path": None})
    return {"pages": count}


async def attachment_text(ctx: JobContext) -> dict[str, Any]:
    """OCR a chat attachment (image or scanned PDF) with the local GLM-OCR model."""
    import shutil
    import tempfile
    from pathlib import Path

    from graite.media.ocr import recognize
    from graite.models.config import load_config

    state = ctx.state
    attachment_id = str(ctx.job.payload.get("attachment_id") or "")
    row = state.db.execute("SELECT * FROM attachments WHERE id=?", (attachment_id,)).fetchone()
    if row is None:
        raise ValueError("The attachment no longer exists.")

    def finish(
        status: str, *, text: str | None = None, pages: int | None = None, error: str | None = None
    ) -> None:
        state.db.execute(
            "UPDATE attachments SET text_status=?, text=?, pages=?, error=? WHERE id=?",
            (status, text, pages, error, attachment_id),
        )
        state.events.publish(
            "attachment_update",
            {
                "id": attachment_id,
                "conversation_id": row["conversation_id"],
                "text_status": status,
                "error": error,
            },
        )

    item = state.downloads.items.get("glm-ocr-q8")
    if not item or item.status != "installed":
        finish(
            "failed",
            error="Download GLM-OCR under Settings → Documents to read this file.",
        )
        raise ValueError("GLM-OCR is not installed.")
    source = state.settings.vault / row["rel_path"]
    if not source.is_file():
        finish("failed", error="The uploaded file is missing.")
        raise ValueError("Attachment file missing.")
    try:
        async with state.models.lock:
            await state.models.server.stop()
            state.models.loaded = None
            config = load_config(state.db)
            files = state.downloads.parts(item)
            with tempfile.TemporaryDirectory(prefix="graite-chat-") as directory:
                working = Path(directory) / ("source" + source.suffix.lower())
                shutil.copyfile(source, working)
                text = await recognize(
                    working,
                    item.local_path,
                    str(state.downloads.file_target(item, files[1])),
                    config,
                    lambda message: ctx.progress(message=message),
                )
    except Exception as exc:
        finish("failed", error=str(exc)[:300] or "Text recognition failed.")
        raise
    finish("ready", text=text.strip(), pages=row["pages"])
    return {"chars": len(text)}


async def run_turn(ctx: JobContext, turn: Any, *, record_run: bool = True) -> dict[str, Any]:
    """Drive one agent turn inside a job: forward status, collect the answer and proposals.

    `record_run` stamps the turn's run id on the job; a workflow keeps its own parent run
    there and passes False for its steps.
    """
    from graite.retrieval.pipeline import answer_turn

    answer = ""
    proposals: list[str] = []
    run_id: str | None = None
    tool_calls = 0
    question: str | None = None
    async for item in answer_turn(turn):
        if ctx.cancelled.is_set():
            raise asyncio.CancelledError
        kind = item["type"]
        if kind == "run":
            run_id = item["run_id"]
            if record_run:
                ctx.queue.db.execute("UPDATE jobs SET run_id=? WHERE id=?", (run_id, ctx.job.id))
        elif kind == "status":
            ctx.progress(message=item["text"], run_id=run_id)
        elif kind == "tool_start":
            tool_calls += 1
            ctx.progress(message=f"Using {item['name']}", run_id=run_id, tools=tool_calls)
        elif kind == "proposal":
            proposals.append(item["proposal"]["id"])
        elif kind == "clarify":
            question = str(item.get("question") or "")
            ctx.progress(message=f"Needs input: {question}"[:300], run_id=run_id)
        elif kind == "answer":
            answer = item["text"]
            proposals = list(item.get("proposals") or proposals)
    return {
        "run_id": run_id,
        "answer": answer,
        "proposals": proposals,
        "tool_calls": tool_calls,
        "outcome": "needs_input" if question else ("proposed" if proposals else "reported"),
        "question": question,
    }


def trigger_line(payload: dict[str, Any]) -> str:
    """The user turn of an unattended run: what set it off, nothing more."""
    trigger = str(payload.get("trigger") or "manual")
    page = payload.get("trigger_page")
    if trigger in ("page_created", "page_updated") and page:
        verb = "created" if trigger == "page_created" else "updated"
        return f"Page [[{page}]] was {verb}. Start with that page."
    if trigger == "cron":
        return f"Scheduled run at {datetime.now(UTC):%Y-%m-%d %H:%M} UTC."
    if trigger == "tool":
        return "Scheduled from a conversation. Run now."
    return "Run now."


def _agent_context(
    state: Any,
    ctx: JobContext,
    *,
    instructions: str,
    scope: Any,
    mode: str,
    agent: str | None,
    definition: Any | None,
    extra_sources: list[Any] | None = None,
    parent_run_id: str | None = None,
    workflow: str | None = None,
    trigger: str = "manual",
    tools: list[str] | None = None,
    run_kind: str = "agent_run",
    trigger_text: str = "Run now.",
    trigger_page: str | None = None,
    conversation_id: str | None = None,
) -> Any:
    from graite.agents.definitions import agent_query, clean_instructions
    from graite.models.config import load_config
    from graite.models.resolution import resolve
    from graite.retrieval.pipeline import TurnContext
    from graite.skills.registry import groups_for

    config = load_config(state.db)
    notes: list[str] = []
    override = definition.model if definition is not None else None
    if override:
        config, note = resolve(config, {"model": override}, [], state.downloads.items)
        if note:
            notes.append(note.replace("The page's", "The agent's"))
    task = clean_instructions(instructions)
    description = definition.description if definition is not None else ""
    return TurnContext(
        state=state,
        conversation_id=conversation_id,
        scope=scope,
        question=trigger_text,
        task=task,
        search_query=agent_query(description, task, trigger_page),
        notes=notes,
        history=[],
        config=config,
        mode=mode,
        extra_sources=list(extra_sources or []),
        skills_allowlist=definition.skills if definition is not None else None,
        trigger=trigger,
        page_path=scope.roots[0] if scope.roots else None,
        run_kind=run_kind,
        groups=groups_for(mode),
        agent=agent,
        workflow=workflow,
        parent_run_id=parent_run_id,
        job_id=ctx.job.id,
        tools=tools
        if tools is not None
        else (definition.tools if definition is not None else None),
    )


QUESTION = re.compile(r"^[ \t>*-]*QUESTION:[ \t]*(.+)$", re.M)
LOOP_LAST_KEY = "assistant_loop_last"
LOOP_QUIET = timedelta(hours=6)


def _meta(db: Any, key: str) -> str | None:
    row = db.execute("SELECT value FROM meta WHERE key=?", (key,)).fetchone()
    return str(row[0]) if row else None


def _set_meta(db: Any, key: str, value: str) -> None:
    db.execute("INSERT OR REPLACE INTO meta VALUES (?, ?)", (key, value))


async def assistant_loop(ctx: JobContext) -> dict[str, Any]:
    """One background pass of the personal assistant over its goals."""
    from graite.agents.triggers import in_scope
    from graite.assistant import memory
    from graite.assistant.service import LOOP_TOOLS, effective_scope, loop_task

    state = ctx.state
    definition = state.definitions.assistant()
    if definition is None:
        raise PermanentJobError("The assistant no longer exists.")
    root = memory.root_path(state, definition.memory)
    scope = effective_scope(definition, root)
    last = _meta(state.db, LOOP_LAST_KEY)
    rows = state.db.execute(
        "SELECT path FROM pages WHERE updated > ? ORDER BY updated DESC LIMIT 200", (last or "",)
    ).fetchall()
    changed = [
        r["path"]
        for r in rows
        if in_scope(r["path"], scope)
        and not (root and (r["path"] == root or r["path"].startswith(root + "/")))
    ]
    at = datetime.now(UTC)
    manual = ctx.job.payload.get("trigger") == "manual"
    if last and not changed and not manual:
        try:
            quiet = at - datetime.fromisoformat(last) < LOOP_QUIET
        except ValueError:
            quiet = False
        if quiet:
            return {"outcome": "skipped", "reason": "Nothing changed since the last pass."}
    from graite.models.config import load_config

    config = load_config(state.db)
    remembered = await memory.digest(state, root, cloud=config.provider != "local")
    turn = _agent_context(
        state,
        ctx,
        instructions=loop_task(
            definition, remembered, root, changed, f"{at:%A %Y-%m-%d %H:%M} UTC"
        ),
        scope=scope,
        mode=definition.mode,
        agent=definition.name,
        definition=definition,
        trigger=str(ctx.job.payload.get("trigger") or "manual"),
        trigger_text=trigger_line(ctx.job.payload),
        run_kind="assistant_loop",
        tools=[t for t in (definition.tools or LOOP_TOOLS) if t in LOOP_TOOLS],
    )
    turn = replace(turn, memory_root=root)
    ctx.progress(message=f"{definition.name} is looking at your goals…")
    result = await run_turn(ctx, turn)
    asked = QUESTION.search(result.get("answer") or "")
    if asked and not result.get("question"):
        result["question"] = asked.group(1).strip()[:500]
        result["outcome"] = "needs_input"
        if result.get("run_id"):
            state.db.execute(
                "UPDATE runs SET status='needs_input', output_json=json_set("
                "coalesce(output_json,'{}'), '$.question', ?) WHERE id=?",
                (result["question"], result["run_id"]),
            )
    _set_meta(state.db, LOOP_LAST_KEY, f"{at:%Y-%m-%dT%H:%M:%SZ}")
    return result


async def assistant_reflect(ctx: JobContext) -> dict[str, Any]:
    """After a conversation: file what is worth remembering into the memory pages."""
    from graite.assistant import memory
    from graite.assistant.service import REFLECT_TOOLS, reflect_task
    from graite.retrieval.context import Source
    from graite.retrieval.scope import Scope

    state = ctx.state
    definition = state.definitions.assistant()
    conversation_id = str(ctx.job.payload.get("conversation_id") or "")
    row = state.db.execute(
        "SELECT messages_json FROM conversations WHERE id=? AND kind='assistant'",
        (conversation_id,),
    ).fetchone()
    root = memory.root_path(state, definition.memory) if definition else None
    if definition is None or row is None or root is None:
        return {"outcome": "skipped"}
    messages = json.loads(row["messages_json"] or "[]")
    key = f"assistant_reflected:{conversation_id}"
    done = int(_meta(state.db, key) or 0)
    fresh = [m for m in messages[done:] if m.get("role") in ("user", "assistant")]
    if not any(m.get("role") == "user" for m in fresh):
        return {"outcome": "skipped"}
    speakers = {"user": "User", "assistant": definition.name}
    transcript = "\n\n".join(
        f"{speakers[m['role']]}: {str(m.get('content') or '')[:3000]}" for m in fresh
    )[-24000:]
    turn = _agent_context(
        state,
        ctx,
        instructions=reflect_task(definition, root),
        scope=Scope("folder", [root]),
        mode="act",
        agent=definition.name,
        definition=definition,
        extra_sources=[
            Source(0, "attachment", None, None, "Conversation transcript", [], transcript)
        ],
        trigger="conversation",
        trigger_text="The conversation ended. Update your memory.",
        run_kind="assistant_reflect",
        tools=REFLECT_TOOLS,
        conversation_id=None,
    )
    turn = replace(turn, memory_root=root)
    ctx.progress(message=f"{definition.name} is updating its memory…")
    result = await run_turn(ctx, turn)
    _set_meta(state.db, key, str(len(messages)))
    return result


TIDY_LISTING = 12000  # bytes of the memory listing the tidy pass reads


async def assistant_tidy(ctx: JobContext) -> dict[str, Any]:
    """The weekly pass over the assistant's memory: merge, generalise, forget (D57)."""
    from graite.assistant import memory
    from graite.assistant.service import TIDY_TOOLS, tidy_task
    from graite.retrieval.scope import Scope

    state = ctx.state
    definition = state.definitions.assistant()
    root = memory.root_path(state, definition.memory) if definition else None
    if definition is None or root is None:
        return {"outcome": "skipped"}
    items = await memory.all_memories(state, root)
    if len(items) < 2:
        return {"outcome": "skipped", "reason": "Too few memories to tidy."}
    seen = memory.last_recalled(state.db)
    lines = []
    for m in items:
        flags = [m.kind or "no kind", "pinned" if m.pinned else ""]
        flags.append(f"last recalled {seen[m.path]}" if m.path in seen else "never recalled")
        body = " ".join(m.body.split())[:400]
        lines.append(
            f"- [{m.path}] {m.title} ({', '.join(f for f in flags if f)})"
            + (f"\n  {body}" if body else "")
        )
    listing = "\n".join(lines)
    if len(listing.encode()) > TIDY_LISTING:
        listing = listing.encode()[:TIDY_LISTING].decode("utf-8", "ignore").rsplit("\n- ", 1)[0]
        listing += "\n(more memories not shown; the next pass sees them)"
    at = datetime.now(UTC)
    turn = _agent_context(
        state,
        ctx,
        instructions=tidy_task(definition, root, listing, f"{at:%A %Y-%m-%d}"),
        scope=Scope("folder", [root]),
        mode="act",
        agent=definition.name,
        definition=definition,
        trigger=str(ctx.job.payload.get("trigger") or "schedule"),
        trigger_text="Tidy your memory.",
        run_kind="assistant_tidy",
        tools=TIDY_TOOLS,
        conversation_id=None,
    )
    turn = replace(turn, memory_root=root)
    ctx.progress(message=f"{definition.name} is tidying its memory…")
    return await run_turn(ctx, turn)


async def agent_run(ctx: JobContext) -> dict[str, Any]:
    """Run an agent definition, or ad-hoc instructions (the `schedule` tool), once."""
    from graite.retrieval.scope import Scope

    state = ctx.state
    payload = ctx.job.payload
    name = str(payload.get("agent") or "") or None
    definition = state.definitions.agent(name) if name else None
    if name and definition is None:
        raise PermanentJobError(f"Agent '{name}' no longer exists.")
    instructions = str(payload.get("instructions") or "").strip() or (
        definition.instructions if definition else ""
    )
    if not instructions:
        raise PermanentJobError("This agent has no instructions.")
    scope = (
        Scope.parse(payload["scope"])
        if payload.get("scope")
        else definition.scope
        if definition
        else Scope("vault")
    )
    mode = str(payload.get("mode") or (definition.mode if definition else "act"))
    turn = _agent_context(
        state,
        ctx,
        instructions=instructions,
        scope=scope,
        mode=mode,
        agent=name,
        definition=definition,
        trigger=str(payload.get("trigger") or "manual"),
        trigger_text=trigger_line(payload),
        trigger_page=str(payload.get("trigger_page") or "") or None,
        conversation_id=str(payload.get("conversation_id") or "") or None,
    )
    ctx.progress(message=f"Running {name or 'scheduled instructions'}…")
    return await run_turn(ctx, turn)


async def workflow_run(ctx: JobContext) -> dict[str, Any]:
    """Run a workflow's steps in order; each step is an agent run that sees the previous answer."""
    from graite.retrieval.context import Source
    from graite.retrieval.pipeline import close_run, open_run

    state = ctx.state
    name = str(ctx.job.payload.get("workflow") or "")
    definition = state.definitions.workflow(name)
    if definition is None:
        raise PermanentJobError(f"Workflow '{name}' no longer exists.")
    parent = open_run(
        state.db,
        kind="workflow_run",
        trigger=str(ctx.job.payload.get("trigger") or "manual"),
        job_id=ctx.job.id,
        workflow=name,
        mode="act",
        input_json=json.dumps({"steps": [s.agent for s in definition.steps]}),
    )
    ctx.queue.db.execute("UPDATE jobs SET run_id=? WHERE id=?", (parent, ctx.job.id))
    steps: list[dict[str, Any]] = []
    proposals: list[str] = []
    previous: dict[str, Any] | None = None
    try:
        for index, step in enumerate(definition.steps, start=1):
            agent = state.definitions.agent(step.agent)
            if agent is None:
                raise PermanentJobError(f"Step {index}: agent '{step.agent}' does not exist.")
            ctx.progress(
                message=f"Step {index}/{len(definition.steps)}: {agent.name}", run_id=parent
            )
            extra = []
            if previous and previous.get("answer"):
                extra.append(
                    Source(
                        0,
                        "step",
                        None,
                        None,
                        f"Output of {previous['agent']}",
                        [],
                        str(previous["answer"])[:20000],
                    )
                )
            instructions = agent.instructions
            if step.instructions:
                instructions = f"{instructions}\n\n{step.instructions}".strip()
            turn = _agent_context(
                state,
                ctx,
                instructions=instructions,
                scope=step.scope or agent.scope,
                mode=agent.mode,
                agent=agent.name,
                definition=agent,
                extra_sources=extra,
                parent_run_id=parent,
                workflow=name,
                trigger="workflow",
            )
            result = await run_turn(ctx, turn, record_run=False)
            previous = {"agent": agent.name, **result}
            steps.append({"agent": agent.name, **result})
            proposals.extend(result["proposals"])
    except BaseException as exc:
        status = "cancelled" if isinstance(exc, asyncio.CancelledError) else "failed"
        close_run(state.db, parent, status, error=str(exc)[:1000] or status, steps=steps)
        raise
    close_run(state.db, parent, "succeeded", steps=steps, proposals=proposals)
    return {"run_id": parent, "steps": steps, "proposals": proposals}


async def live_note(ctx: JobContext) -> dict[str, Any]:
    """Keep a page current: run its `live.objective` against it and file proposals."""
    from graite.retrieval.scope import Scope

    state = ctx.state
    path = str(ctx.job.payload.get("page_path") or "")
    try:
        doc = await state.fileops.read_page(path)
    except (ValueError, FileNotFoundError) as exc:
        raise PermanentJobError(f"The page {path} no longer exists.") from exc
    live = doc.frontmatter.get("live")
    objective = str(live.get("objective") or "").strip() if isinstance(live, dict) else ""
    if not objective:
        raise PermanentJobError("The page has no live objective any more.")
    turn = _agent_context(
        state,
        ctx,
        instructions=(
            f"Keep the page '{doc.title}' ({path}) current. Objective: {objective}\n"
            "Read the page first, then propose the edits or appends that fulfil the objective."
        ),
        scope=Scope("page", [path]),
        mode="act",
        agent=f"live:{path}",
        definition=None,
        trigger="cron",
        tools=["read_page", "search_vault", "list_children", "propose_edit", "propose_append"],
        run_kind="live_note",
        trigger_text=trigger_line({**ctx.job.payload, "trigger": "cron"}),
    )
    ctx.progress(message=f"Updating {doc.title}…")
    result = await run_turn(ctx, turn)
    await state.fileops.set_live_status(path, run_at=datetime.now(UTC).isoformat())
    return result


def _unavailable(kind: str):  # type: ignore[no-untyped-def]
    async def handler(ctx: JobContext) -> dict[str, Any]:
        raise PermanentJobError(f"The '{kind}' job is not available in this version.")

    return handler


HANDLERS = {
    "embed": embed,
    "reindex": reindex,
    "attachment_text": attachment_text,
    "agent_run": agent_run,
    "assistant_loop": assistant_loop,
    "assistant_tidy": assistant_tidy,
    "assistant_reflect": assistant_reflect,
    "workflow_run": _unavailable("workflow_run"),
    "live_note": live_note,
    **{kind: _unavailable(kind) for kind in ("summarize_page", "extract_entities")},
}
