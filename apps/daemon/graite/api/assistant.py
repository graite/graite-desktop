"""The personal assistant: its definition, its memory pages and its conversations."""

from __future__ import annotations

import json
import uuid
from datetime import UTC, datetime, timedelta
from typing import Any

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

from graite.agents.definitions import (
    AgentTrigger,
    VoiceSettings,
    definition_path,
    validate_voice,
)
from graite.api.automation import AgentBody, ScopeBody, _write_agent
from graite.assistant import memory
from graite.assistant.profile import join_sections, split_sections
from graite.review.policy import opt_in
from graite.vault import policy

router = APIRouter(prefix="/assistant", tags=["Assistant"])
UI_ACTOR = "ui"
# A conversation left alone this long is history; the next visit starts a fresh one and
# memory carries the continuity.
SESSION_IDLE = timedelta(hours=6)


class Sections(BaseModel):
    personality: str = Field(default="", max_length=8000)
    context: str = Field(default="", max_length=8000)
    guidelines: str = Field(default="", max_length=8000)
    goals: str = Field(default="", max_length=8000)


class MemoryState(BaseModel):
    page_id: str | None = None
    root: str | None = None
    pages: dict[str, str] = Field(default_factory=dict)
    auto_apply: bool = False
    opted_in: bool = False
    legacy: list[str] = Field(default_factory=list)


class Question(BaseModel):
    run_id: str
    question: str
    asked_at: str


class LoopState(BaseModel):
    schedule_id: str
    enabled: bool
    next_run_at: str | None = None
    last_run_at: str | None = None
    last_status: str | None = None


class AssistantInfo(BaseModel):
    configured: bool
    name: str = ""
    user_name: str = ""  # what it calls the user; empty = "there"
    description: str = ""
    path: str | None = None
    sections: Sections = Field(default_factory=Sections)
    scope: ScopeBody = Field(default_factory=ScopeBody)
    mode: str = "act"
    model: str | None = None
    skills: list[str] | None = None
    tools: list[str] | None = None
    schedule: str | None = None
    triggers: list[AgentTrigger] = Field(default_factory=list, max_length=20)
    voice: VoiceSettings = Field(default_factory=VoiceSettings)
    memory: MemoryState = Field(default_factory=MemoryState)
    conversation_id: str | None = None
    # Things the background loop wants to know before it can help, newest first.
    questions: list[Question] = Field(default_factory=list)
    loop: LoopState | None = None


class AssistantBody(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    user_name: str = Field(default="", max_length=60)
    description: str = Field(default="", max_length=300)
    sections: Sections = Field(default_factory=Sections)
    scope: ScopeBody | None = None
    mode: str = "act"
    model: str | None = None
    skills: list[str] | None = None
    tools: list[str] | None = None
    schedule: str | None = None
    triggers: list[AgentTrigger] = Field(default_factory=list, max_length=20)
    voice: VoiceSettings | None = None
    # Renaming the assistant renames its memory page too, while that page still carries the
    # old name. A page the user renamed themselves is left alone.
    rename_memory: bool = True


class ConversationRef(BaseModel):
    id: str
    title: str
    updated_at: str


def _latest(db: Any) -> Any:
    return db.execute(
        "SELECT id, title, updated_at FROM conversations WHERE kind='assistant' "
        "ORDER BY updated_at DESC LIMIT 1"
    ).fetchone()


DISMISSED_KEY = "assistant_dismissed_questions"


def _dismissed(db: Any) -> list[str]:
    row = db.execute("SELECT value FROM meta WHERE key=?", (DISMISSED_KEY,)).fetchone()
    try:
        return [str(v) for v in json.loads(row[0])] if row else []
    except ValueError:
        return []


def _questions(db: Any) -> list[Question]:
    dismissed = set(_dismissed(db))
    rows = db.execute(
        "SELECT id, output_json, started_at FROM runs WHERE kind='assistant_loop' "
        "AND status='needs_input' ORDER BY started_at DESC LIMIT 20"
    ).fetchall()
    found = []
    for row in rows:
        try:
            question = str(json.loads(row["output_json"] or "{}").get("question") or "").strip()
        except ValueError:
            continue
        if question and row["id"] not in dismissed:
            found.append(Question(run_id=row["id"], question=question, asked_at=row["started_at"]))
    return found[:5]


def _loop(state: Any) -> LoopState | None:
    from graite.jobs.cron import ASSISTANT_SOURCE

    row = state.db.execute("SELECT * FROM cron WHERE source=?", (ASSISTANT_SOURCE,)).fetchone()
    if row is None:
        return None
    return LoopState(
        schedule_id=row["id"],
        enabled=bool(row["enabled"]),
        next_run_at=row["next_run_at"],
        last_run_at=row["last_run_at"],
        last_status=row["last_status"],
    )


def _info(request: Request) -> AssistantInfo:
    state = request.app.state
    definition = state.definitions.assistant()
    if definition is None:
        return AssistantInfo(configured=False)
    latest = _latest(state.db)
    return AssistantInfo(
        configured=True,
        name=definition.name,
        user_name=definition.user_name or "",
        description=definition.description,
        path=definition.path,
        sections=Sections(**split_sections(definition.instructions)),
        scope=ScopeBody(**definition.scope.to_dict()),
        mode=definition.mode,
        model=definition.model,
        skills=definition.skills,
        tools=definition.tools,
        schedule=definition.schedule,
        triggers=[AgentTrigger(**t) for t in definition.triggers],
        voice=VoiceSettings(**(definition.voice or {})),
        memory=MemoryState(**memory.info(state, definition.memory).to_dict()),
        conversation_id=latest["id"] if latest else None,
        questions=_questions(state.db),
        loop=_loop(state),
    )


@router.get("", response_model=AssistantInfo)
async def get_assistant(request: Request) -> AssistantInfo:
    return _info(request)


@router.put("", response_model=AssistantInfo)
async def save_assistant(body: AssistantBody, request: Request) -> AssistantInfo:
    state = request.app.state
    name = body.name.strip()
    if not name:
        raise HTTPException(400, "Give your assistant a name.")
    current = state.definitions.assistant()
    other = state.definitions.agent(name)
    if other is not None and not other.assistant:
        raise HTTPException(409, "An agent with this name already exists.")
    try:
        voice = validate_voice(
            body.voice.model_dump(exclude_none=True)
            if body.voice is not None
            else (current.voice if current else None)
        )
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    remembered = await memory.ensure(state, name, current.memory if current else None)
    if (
        current is not None
        and body.rename_memory
        and current.name != name
        and remembered.root is not None
    ):
        page = await state.fileops.read_page(remembered.root)
        if page.title == current.name:
            await state.fileops.update_meta(remembered.root, title=name, actor=UI_ACTOR)
    await _write_agent(
        request,
        AgentBody(
            name=name,
            description=body.description,
            instructions=join_sections(body.sections.model_dump()),
            scope=body.scope,
            mode=body.mode,
            model=body.model,
            skills=body.skills,
            tools=body.tools,
            schedule=body.schedule,
            triggers=body.triggers,
        ),
        existing=current.path if current else definition_path("agent", None, "assistant"),
        extra={
            "assistant": True,
            "memory": remembered.page_id,
            "voice": voice,
            "user_name": body.user_name.strip() or None,
        },
    )
    return _info(request)


class OptInResult(BaseModel):
    opted_in: bool


@router.post("/memory/opt-in", response_model=OptInResult)
async def opt_in_memory(request: Request) -> OptInResult:
    """Confirm, once, that the assistant may update its own memory pages without review."""
    state = request.app.state
    definition = state.definitions.assistant()
    root = memory.root_path(state, definition.memory) if definition else None
    if root is None:
        raise HTTPException(404, "Set up your assistant first.")
    effective = policy.resolve(state.settings.vault, state.db, root)
    if effective.autonomy != "auto-apply":
        raise HTTPException(409, "The memory page no longer asks for automatic updates.")
    opt_in(state.db, str(effective.sources.get("autonomy", "vault")))
    return OptInResult(opted_in=True)


class Queued(BaseModel):
    job_id: str


class MemoryItem(BaseModel):
    path: str
    title: str
    body: str = ""
    kind: str | None = None
    pinned: bool = False
    last_recalled: str | None = None


class MemoryList(BaseModel):
    root: str | None = None
    parent: str | None = None
    kinds: list[str] = Field(default_factory=lambda: list(memory.KINDS))
    items: list[MemoryItem] = Field(default_factory=list)


class MemoryBody(BaseModel):
    title: str = Field(min_length=1, max_length=200)
    body: str = Field(default="", max_length=20000)
    kind: str | None = None
    pinned: bool = False


class UpgradeResult(BaseModel):
    created: int
    memories: str | None = None


def _memory_root(state: Any) -> tuple[Any, str]:
    definition = state.definitions.assistant()
    root = memory.root_path(state, definition.memory) if definition else None
    if definition is None or root is None:
        raise HTTPException(404, "Set up your assistant first.")
    return definition, root


@router.get("/memory", response_model=MemoryList)
async def list_memories(request: Request) -> MemoryList:
    """Every memory page, for the Memory tab: what it says, its kind, whether it is pinned
    and when a conversation last recalled it."""
    state = request.app.state
    definition = state.definitions.assistant()
    root = memory.root_path(state, definition.memory) if definition else None
    if root is None:
        return MemoryList()
    seen = memory.last_recalled(state.db)
    items = [
        MemoryItem(**m.to_dict(), last_recalled=seen.get(m.path))
        for m in await memory.all_memories(state, root)
    ]
    return MemoryList(root=root, parent=memory.memories_path(state, root), items=items)


@router.post("/memory", response_model=MemoryItem)
async def add_memory(body: MemoryBody, request: Request) -> MemoryItem:
    state = request.app.state
    definition, root = _memory_root(state)
    parent = memory.memories_path(state, root)
    if parent is None:
        await memory.ensure(state, definition.name, definition.memory, UI_ACTOR)
        parent = memory.memories_path(state, root)
    if parent is None:
        raise HTTPException(409, "The Memories page could not be created.")
    if body.kind is not None and body.kind not in memory.KINDS:
        raise HTTPException(400, f"Kind must be one of {', '.join(memory.KINDS)}.")
    added = await memory.add(
        state,
        parent,
        body.title.strip(),
        body.body,
        kind=body.kind,
        pinned=body.pinned,
        actor=UI_ACTOR,
    )
    return MemoryItem(**added.to_dict())


@router.post("/memory/upgrade", response_model=UpgradeResult)
async def upgrade_memory(request: Request) -> UpgradeResult:
    """Turn the old Profile and Playbook lists into one memory page per entry."""
    state = request.app.state
    definition, _ = _memory_root(state)
    try:
        result = await memory.upgrade(state, definition.memory, UI_ACTOR)
    except ValueError as exc:
        raise HTTPException(409, str(exc)) from exc
    return UpgradeResult(**result)


@router.post("/memory/tidy", response_model=Queued, status_code=202)
async def tidy_memory(request: Request) -> Queued:
    """Merge, generalise and forget memories now, whatever the weekly schedule says."""
    from graite.jobs.queue import PRIORITY_SUMMARY

    state = request.app.state
    _memory_root(state)
    job_id = state.queue.enqueue(
        "assistant_tidy",
        {"trigger": "manual", "preemptible": True},
        key="assistant_tidy",
        priority=PRIORITY_SUMMARY,
        max_attempts=1,
    )
    return Queued(job_id=job_id)


def _create_conversation(state: Any) -> ConversationRef:
    definition = state.definitions.assistant()
    if definition is None:
        raise HTTPException(404, "Set up your assistant first.")
    now = datetime.now(UTC).isoformat()
    conversation_id = uuid.uuid4().hex
    state.db.execute(
        "INSERT INTO conversations (id, page_id, title, messages_json, scope_json, mode, "
        "created_at, updated_at, kind) VALUES (?,?,?,?,?,?,?,?,'assistant')",
        (
            conversation_id,
            None,
            f"{datetime.now(UTC):%Y-%m-%d %H:%M}",
            "[]",
            json.dumps(definition.scope.to_dict()),
            definition.mode,
            now,
            now,
        ),
    )
    return ConversationRef(id=conversation_id, title="", updated_at=now)


@router.get("/conversations", response_model=list[ConversationRef])
async def list_conversations(request: Request) -> list[ConversationRef]:
    rows = request.app.state.db.execute(
        "SELECT id, title, updated_at FROM conversations WHERE kind='assistant' "
        "ORDER BY updated_at DESC LIMIT 100"
    ).fetchall()
    return [ConversationRef(**dict(row)) for row in rows]


@router.post("/conversations", response_model=ConversationRef)
async def new_conversation(request: Request, fresh: bool = False) -> ConversationRef:
    """The conversation to talk in: the latest one while it is recent, otherwise (or with
    `fresh`) a new session."""
    state = request.app.state
    latest = None if fresh else _latest(state.db)
    if latest is not None:
        try:
            idle = datetime.now(UTC) - datetime.fromisoformat(latest["updated_at"])
        except ValueError:
            idle = SESSION_IDLE
        if idle < SESSION_IDLE:
            return ConversationRef(**dict(latest))
    return _create_conversation(state)


@router.post("/loop/run", response_model=Queued, status_code=202)
async def run_loop(request: Request) -> Queued:
    """One background pass now, whatever the schedule says."""
    from graite.jobs.queue import PRIORITY_SUMMARY

    state = request.app.state
    if state.definitions.assistant() is None:
        raise HTTPException(404, "Set up your assistant first.")
    job_id = state.queue.enqueue(
        "assistant_loop",
        {"trigger": "manual", "preemptible": True},
        key="assistant_loop",
        priority=PRIORITY_SUMMARY,
        max_attempts=1,
    )
    return Queued(job_id=job_id)


@router.post("/questions/{run_id}/dismiss")
async def dismiss_question(run_id: str, request: Request) -> dict[str, bool]:
    db = request.app.state.db
    kept = [*_dismissed(db), run_id][-200:]
    db.execute("INSERT OR REPLACE INTO meta VALUES (?, ?)", (DISMISSED_KEY, json.dumps(kept)))
    return {"ok": True}
