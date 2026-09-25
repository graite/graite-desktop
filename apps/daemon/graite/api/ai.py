"""Model setup and persisted page conversations over authenticated SSE."""

from __future__ import annotations

import asyncio
import base64
import hashlib
import json
import logging
import time
import uuid
from collections.abc import AsyncIterator
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Literal

import httpx
from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, ConfigDict, Field

from graite.cloud.session import get_cloud
from graite.jobs.queue import PRIORITY_INTERACTIVE
from graite.models.config import AIConfig, SaveConfig, get_key, load_config, save_config
from graite.models.downloader import CatalogModel
from graite.models.hardware import Hardware, detect
from graite.models.providers import Provider
from graite.retrieval.context import Source
from graite.retrieval.scope import Scope
from graite.retrieval.scope import resolve as resolve_scope

log = logging.getLogger("graite.ai")

router = APIRouter(prefix="/ai", tags=["AI"])


def model_busy(state: Any) -> bool:
    """True while the chat model must stay as it is: an answer is being written, or a voice
    conversation keeps the model loaded between turns."""
    voice = getattr(state, "voice", None)
    return bool(
        state.models.lock.locked()
        or state.active_chats
        or (voice is not None and voice.session is not None)
    )


class ActiveModel(BaseModel):
    label: str
    connection_name: str
    kind: str
    model: str


def active_model(config: AIConfig, catalog: dict[str, Any]) -> ActiveModel | None:
    """What the composer shows as the current model."""
    from graite.models.connections import KIND_NAMES, get_store

    if config.provider == "local":
        if not config.model_path:
            return None
        name = next(
            (m.name for m in catalog.values() if m.local_path == config.model_path),
            config.model_path.replace("\\", "/").rsplit("/", 1)[-1],
        )
        return ActiveModel(
            label=name, connection_name="On device", kind="local", model=config.model_path
        )
    if not config.model:
        return None
    store = get_store()
    found = store.resolve(config.saved_model_id) if store and config.saved_model_id else None
    if found:
        connection, saved = found
        return ActiveModel(
            label=saved.label,
            connection_name=connection.name,
            kind=connection.kind,
            model=saved.model,
        )
    return ActiveModel(
        label="Graite Cloud" if config.provider == "graite" else config.model,
        connection_name=(
            "Graite Cloud"
            if config.provider == "graite"
            else KIND_NAMES.get(config.provider, config.provider)
        ),
        kind=config.provider,
        model=config.model,
    )


class AIStatus(BaseModel):
    config: AIConfig
    active: ActiveModel | None = None
    hardware: Hardware
    key_saved: bool
    keychain_error: str | None
    loaded: bool
    busy: bool
    embedding_busy: bool = False
    embedding_loaded: bool = False
    gpu_layers: int
    runtime_warning: str | None = None
    benchmark: dict[str, Any] | None


@router.get("/status", response_model=AIStatus)
async def status(request: Request) -> AIStatus:
    manager = request.app.state.models
    config = load_config(request.app.state.db)
    error = None
    try:
        key = await asyncio.to_thread(get_key, config)
    except ValueError as exc:
        key, error = "", str(exc)
    row = request.app.state.db.execute("SELECT value FROM meta WHERE key='ai_benchmark'").fetchone()
    return AIStatus(
        config=config,
        active=active_model(config, request.app.state.downloads.items),
        hardware=await asyncio.to_thread(detect),
        key_saved=bool(key),
        keychain_error=error,
        loaded=bool(manager.server.process and manager.server.process.returncode is None),
        busy=manager.lock.locked(),
        embedding_busy=manager.embedding_lock.locked(),
        embedding_loaded=manager.embedding_loaded(),
        gpu_layers=manager.server.layers,
        runtime_warning=manager.server.warning,
        benchmark=json.loads(row[0]) if row else None,
    )


@router.put("/config", response_model=AIConfig)
async def configure(body: SaveConfig, request: Request) -> AIConfig:
    manager = request.app.state.models
    if model_busy(request.app.state):
        raise HTTPException(409, "Wait for the current answer or model check to finish.")
    previous = load_config(request.app.state.db)
    if body.provider == "graite":  # the endpoint follows the configured Graite Cloud
        body = body.model_copy(update={"base_url": get_cloud().api_url})
    async with manager.lock, manager.embedding_lock:
        try:
            config = await asyncio.to_thread(save_config, request.app.state.db, body)
        except ValueError as exc:
            raise HTTPException(400, str(exc)) from exc
        await manager.server.stop()
        manager.loaded = None
        await manager.embedding_server.stop()
        manager.embedding_path = ""
        request.app.state.db.execute("DELETE FROM meta WHERE key='ai_benchmark'")
    if config.embedding_model_id != previous.embedding_model_id:
        request.app.state.queue.enqueue("embed", key="embed")
    return config


class ModelList(BaseModel):
    models: list[str]


@router.post("/discover", response_model=ModelList)
async def discover(body: SaveConfig) -> ModelList:
    if body.provider == "local":
        return ModelList(models=[])
    try:
        key = body.api_key or await asyncio.to_thread(get_key, body)
        provider = Provider(body.provider, body.base_url, body.model, key or "")
        return ModelList(models=await provider.models())
    except (ValueError, httpx.HTTPError) as exc:
        detail = (
            str(exc) if isinstance(exc, ValueError) else "Could not connect to the model server."
        )
        raise HTTPException(400, detail) from exc


class CheckResult(BaseModel):
    message: str
    seconds: float
    model: str
    tokens_per_second: float | None = None


@router.post("/check", response_model=CheckResult)
async def check(request: Request) -> CheckResult:
    manager = request.app.state.models
    if model_busy(request.app.state):
        raise HTTPException(409, "A model task is already running.")
    start = time.monotonic()
    try:
        async with manager.use() as provider:
            text = ""
            async for delta in provider.chat(
                [{"role": "user", "content": "Reply with only: Ready"}], []
            ):
                text += delta.get("content") or ""
            if not text.strip():
                raise ValueError("The model returned no text.")
            result = CheckResult(
                message="Ready to chat",
                seconds=round(time.monotonic() - start, 2),
                model=provider.model,
                tokens_per_second=provider.metrics.get("predicted_per_second"),
            )
            request.app.state.db.execute(
                "INSERT OR REPLACE INTO meta VALUES ('ai_benchmark', ?)",
                (result.model_dump_json(),),
            )
            return result
    except (ValueError, OSError, httpx.HTTPError) as exc:
        detail = (
            str(exc)
            if isinstance(exc, ValueError)
            else "Could not reach the model. Check your settings."
        )
        raise HTTPException(400, detail) from exc


@router.post("/unload")
async def unload(request: Request) -> dict[str, bool]:
    manager = request.app.state.models
    if model_busy(request.app.state):
        raise HTTPException(409, "Wait for the current answer to finish.")
    async with manager.lock:
        await manager.server.stop()
        manager.loaded = None
    return {"ok": True}


class Selection(BaseModel):
    page_path: str
    text: str = Field(min_length=1, max_length=20000)


class MessageAttachment(BaseModel):
    id: str
    name: str
    kind: str


class ActivityStep(BaseModel):
    id: str
    round: int
    kind: str
    name: str
    status: str
    text: str = ""


class Message(BaseModel):
    role: str
    content: str
    interrupted: bool = False
    mode: str | None = None
    attachments: list[MessageAttachment] | None = None
    selection: Selection | None = None
    run_id: str | None = None
    sources: list[dict[str, Any]] | None = None
    cited: list[int] | None = None
    limits: list[str] | None = None
    thinking: str | None = None
    activity: list[ActivityStep] | None = None
    # True when `sources` and `cited` refer to the conversation's shared context set (only
    # the sources new in that turn are listed); False for messages from before that existed.
    context: bool = False
    proposals: list[str] | None = None
    # Voice conversation: the turn was spoken; `cut_short` when the user interrupted and
    # only the part they heard was kept.
    spoken: bool = False
    cut_short: bool = False


class ScopeModel(BaseModel):
    kind: Literal["page", "folder", "vault"] = "vault"
    roots: list[str] = Field(default_factory=list)
    excluded: list[str] = Field(default_factory=list)


class Conversation(BaseModel):
    id: str
    title: str
    messages: list[Message]
    scope: ScopeModel
    mode: str = "ask"
    page_id: str | None = None
    created_at: str | None = None
    updated_at: str
    # Every source this conversation has gathered, numbered once, without passage text.
    context: list[dict[str, Any]] = Field(default_factory=list)
    kind: str = "chat"  # "assistant" for the personal assistant's sessions


class NewConversation(BaseModel):
    page_path: str | None = None
    scope: ScopeModel | None = None
    mode: Literal["ask", "draft", "act"] = "ask"


class PatchConversation(BaseModel):
    title: str | None = Field(default=None, max_length=200)
    scope: ScopeModel | None = None
    mode: Literal["ask", "draft", "act"] | None = None


def _load_scope(request: Request, row: Any) -> Scope:
    """A conversation's scope; page-bound conversations follow their page across renames."""
    scope = (
        Scope.parse(row["scope_json"] or "{}", default_root=None)
        if row["page_id"] is None
        else None
    )
    if row["page_id"]:
        try:
            path = request.app.state.fileops.page_by_id(row["page_id"])
        except (FileNotFoundError, ValueError) as exc:
            raise HTTPException(404, "The page of this conversation no longer exists.") from exc
        raw = json.loads(row["scope_json"] or "{}")
        kind = raw.get("kind") if raw.get("kind") in ("page", "folder") else "folder"
        # The root follows the page across renames; any exclusions the client set are kept.
        excluded = [str(e) for e in raw.get("excluded") or []]
        scope = Scope(kind, [path], excluded if kind == "folder" else [])
    assert scope is not None
    return scope


def _context_json(row: Any) -> str:
    return str(row["context_json"]) if "context_json" in row.keys() else "[]"


def _conversation(request: Request, row: Any) -> Conversation:
    from graite.retrieval.contextset import ContextSet

    scope = _load_scope(request, row)
    return Conversation(
        id=row["id"],
        title=row["title"],
        messages=[Message.model_validate(m) for m in json.loads(row["messages_json"])],
        scope=ScopeModel(**scope.to_dict()),
        mode=row["mode"] or "ask",
        page_id=row["page_id"],
        created_at=row["created_at"],
        updated_at=row["updated_at"],
        context=ContextSet.load(_context_json(row)).public(),
        kind=row["kind"] if "kind" in row.keys() else "chat",
    )


def _row(request: Request, conversation_id: str) -> Any:
    row = request.app.state.db.execute(
        "SELECT * FROM conversations WHERE id=?", (conversation_id,)
    ).fetchone()
    if not row:
        raise HTTPException(404, "Conversation not found.")
    return row


async def _page_for(request: Request, path: str) -> Any:
    try:
        return await request.app.state.fileops.read_page(path)
    except (ValueError, FileNotFoundError) as exc:
        raise HTTPException(404, "Page not found or outside the vault.") from exc


@router.get("/conversations", response_model=list[Conversation])
async def conversations(
    request: Request, page_path: str | None = None, scope: str | None = None
) -> list[Conversation]:
    db = request.app.state.db
    if page_path:
        page = await _page_for(request, page_path)
        rows = db.execute(
            "SELECT * FROM conversations WHERE page_id=? ORDER BY updated_at DESC", (page.id,)
        ).fetchall()
    elif scope == "all":
        rows = db.execute(
            "SELECT * FROM conversations WHERE kind='chat' ORDER BY updated_at DESC"
        ).fetchall()
    elif scope == "vault":
        rows = db.execute(
            "SELECT * FROM conversations WHERE page_id IS NULL AND kind='chat' "
            "ORDER BY updated_at DESC"
        ).fetchall()
    else:
        raise HTTPException(400, "Pass page_path, scope=vault or scope=all.")
    result = []
    for row in rows:
        try:
            result.append(_conversation(request, row))
        except HTTPException:
            continue
    return result


@router.get("/conversations/{conversation_id}", response_model=Conversation)
async def get_conversation(conversation_id: str, request: Request) -> Conversation:
    return _conversation(request, _row(request, conversation_id))


@router.post("/conversations", response_model=Conversation)
async def new_conversation(body: NewConversation, request: Request) -> Conversation:
    db = request.app.state.db
    page_id: str | None = None
    if body.scope is not None and body.scope.kind != "vault":
        scope = Scope.parse(body.scope.model_dump())
        page = await _page_for(request, scope.roots[0])
        page_id = page.id
    elif body.scope is not None:
        scope = Scope.parse(body.scope.model_dump())
    elif body.page_path:
        page = await _page_for(request, body.page_path)
        page_id = page.id
        scope = Scope("folder", [page.path], [])
    else:
        scope = Scope("vault", [], [])
    now = datetime.now(UTC).isoformat()
    conversation_id = uuid.uuid4().hex
    db.execute(
        "INSERT INTO conversations (id, page_id, title, messages_json, scope_json, mode, "
        "created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)",
        (
            conversation_id,
            page_id,
            "New conversation",
            "[]",
            json.dumps(scope.to_dict()),
            body.mode,
            now,
            now,
        ),
    )
    return _conversation(request, _row(request, conversation_id))


@router.patch("/conversations/{conversation_id}", response_model=Conversation)
async def patch_conversation(
    conversation_id: str, body: PatchConversation, request: Request
) -> Conversation:
    row = _row(request, conversation_id)
    db = request.app.state.db
    if body.title is not None and body.title.strip():
        db.execute(
            "UPDATE conversations SET title=? WHERE id=?",
            (body.title.strip()[:200], conversation_id),
        )
    if body.mode is not None:
        db.execute("UPDATE conversations SET mode=? WHERE id=?", (body.mode, conversation_id))
    if body.scope is not None:
        if row["page_id"] is not None and body.scope.kind == "vault":
            raise HTTPException(400, "A page conversation cannot become a vault conversation.")
        scope = Scope.parse(body.scope.model_dump())
        if scope.kind != "vault":
            await _page_for(request, scope.roots[0])
        db.execute(
            "UPDATE conversations SET scope_json=? WHERE id=?",
            (json.dumps(scope.to_dict()), conversation_id),
        )
    return _conversation(request, _row(request, conversation_id))


@router.delete("/conversations/{conversation_id}")
async def delete_conversation(conversation_id: str, request: Request) -> dict[str, bool]:
    _row(request, conversation_id)
    if conversation_id in request.app.state.active_chats:
        raise HTTPException(409, "Stop the running answer first.")
    db = request.app.state.db
    db.execute("DELETE FROM attachments WHERE conversation_id=?", (conversation_id,))
    db.execute("DELETE FROM conversations WHERE id=?", (conversation_id,))
    await request.app.state.fileops.remove_chat_folder(conversation_id)
    return {"ok": True}


# ----------------------------------------------------------------- attachments

ATTACHMENT_LIMIT = 25 * 1024 * 1024
TEXT_SUFFIXES = {".md", ".txt", ".markdown"}


class ChatAttachment(BaseModel):
    id: str
    conversation_id: str
    name: str
    kind: str
    mime: str | None
    size: int
    text_status: str
    pages: int | None = None
    error: str | None = None
    created_at: str
    text_preview: str | None = None


def _attachment(row: Any) -> ChatAttachment:
    return ChatAttachment(
        id=row["id"],
        conversation_id=row["conversation_id"],
        name=row["name"],
        kind=row["kind"],
        mime=row["mime"],
        size=row["size"],
        text_status=row["text_status"],
        pages=row["pages"],
        error=row["error"],
        created_at=row["created_at"],
        text_preview=(row["text"] or "")[:300] or None,
    )


@router.post("/conversations/{conversation_id}/attachments", response_model=ChatAttachment)
async def upload_attachment(conversation_id: str, request: Request, name: str) -> ChatAttachment:
    from graite.media.decode import IMAGES, MIMES, pdf_text

    _row(request, conversation_id)
    suffix = Path(name).suffix.lower()
    if suffix not in TEXT_SUFFIXES and suffix != ".pdf" and suffix not in IMAGES:
        raise HTTPException(400, "Attach a PDF, an image, or a Markdown or text file.")
    data = bytearray()
    async for chunk in request.stream():
        data.extend(chunk)
        if len(data) > ATTACHMENT_LIMIT:
            raise HTTPException(413, "Attachments can be up to 25 MB.")
    if not data:
        raise HTTPException(400, "The file is empty.")
    attachment_id = uuid.uuid4().hex
    rel_path = await request.app.state.fileops.store_chat_attachment(
        conversation_id, attachment_id, name, bytes(data)
    )
    kind = "pdf" if suffix == ".pdf" else "image" if suffix in IMAGES else "text"
    text: str | None = None
    pages: int | None = None
    status = "pending"
    error: str | None = None
    if kind == "text":
        text, status = bytes(data).decode("utf-8", errors="replace")[:400_000], "ready"
    elif kind == "pdf":
        try:
            text, pages = await asyncio.to_thread(
                pdf_text, request.app.state.settings.vault / rel_path
            )
            status = "ready" if (text or "").strip() else "pending"
        except ValueError as exc:
            status, error = "failed", str(exc)
    db = request.app.state.db
    db.execute(
        "INSERT INTO attachments (id, conversation_id, name, kind, mime, size, sha256, rel_path, "
        "text, text_status, pages, error, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
        (
            attachment_id,
            conversation_id,
            Path(name).name[:200],
            kind,
            MIMES.get(suffix, "text/plain"),
            len(data),
            hashlib.sha256(bytes(data)).hexdigest(),
            rel_path,
            text or None,
            status,
            pages,
            error,
            datetime.now(UTC).isoformat(),
        ),
    )
    if status == "pending":
        request.app.state.queue.enqueue(
            "attachment_text",
            {"attachment_id": attachment_id},
            key=f"attachment_text:{attachment_id}",
            priority=PRIORITY_INTERACTIVE,
            max_attempts=1,
        )
    return _attachment(
        db.execute("SELECT * FROM attachments WHERE id=?", (attachment_id,)).fetchone()
    )


@router.get("/conversations/{conversation_id}/attachments", response_model=list[ChatAttachment])
async def list_attachments(conversation_id: str, request: Request) -> list[ChatAttachment]:
    _row(request, conversation_id)
    rows = request.app.state.db.execute(
        "SELECT * FROM attachments WHERE conversation_id=? ORDER BY created_at", (conversation_id,)
    ).fetchall()
    return [_attachment(r) for r in rows]


@router.get(
    "/conversations/{conversation_id}/attachments/{attachment_id}", response_model=ChatAttachment
)
async def get_attachment(
    conversation_id: str, attachment_id: str, request: Request
) -> ChatAttachment:
    row = request.app.state.db.execute(
        "SELECT * FROM attachments WHERE id=? AND conversation_id=?",
        (attachment_id, conversation_id),
    ).fetchone()
    if not row:
        raise HTTPException(404, "Attachment not found.")
    return _attachment(row)


@router.delete("/conversations/{conversation_id}/attachments/{attachment_id}")
async def delete_attachment(
    conversation_id: str, attachment_id: str, request: Request
) -> dict[str, bool]:
    db = request.app.state.db
    row = db.execute(
        "SELECT * FROM attachments WHERE id=? AND conversation_id=?",
        (attachment_id, conversation_id),
    ).fetchone()
    if not row:
        raise HTTPException(404, "Attachment not found.")
    db.execute("DELETE FROM attachments WHERE id=?", (attachment_id,))
    await request.app.state.fileops.remove_chat_attachment(row["rel_path"])
    return {"ok": True}


# ----------------------------------------------------------------- chat


class ChatRequest(BaseModel):
    page_path: str | None = None
    message: str = Field(min_length=1, max_length=16000)
    mode: Literal["ask", "draft", "act"] | None = None
    attachments: list[str] = Field(default_factory=list)
    selection: Selection | None = None
    replace_from: int | None = Field(default=None, ge=0)


def _attachment_sources(
    request: Request, ids: list[str], conversation_id: str
) -> tuple[list[Source], list[dict[str, Any]], list[tuple[str, str]]]:
    if not ids:
        return [], [], []
    db = request.app.state.db
    marks = ",".join("?" * len(ids))
    rows = db.execute(
        f"SELECT * FROM attachments WHERE conversation_id=? AND id IN ({marks})",
        (conversation_id, *ids),
    ).fetchall()
    found = {r["id"]: r for r in rows}
    if len(found) != len(set(ids)):
        raise HTTPException(404, "An attachment was not found in this conversation.")
    sources: list[Source] = []
    images: list[tuple[str, str]] = []
    meta: list[dict[str, Any]] = []
    for attachment_id in ids:
        row = found[attachment_id]
        meta.append({"id": row["id"], "name": row["name"], "kind": row["kind"]})
        if row["text_status"] == "ready" and row["text"]:
            sources.append(
                Source(
                    0, "attachment", None, None, row["name"], [], row["text"][:40000], row["sha256"]
                )
            )
        if row["kind"] == "image":
            path = request.app.state.settings.vault / row["rel_path"]
            try:
                images.append(
                    (row["mime"] or "image/png", base64.b64encode(path.read_bytes()).decode())
                )
            except OSError:
                continue
    return sources, meta, images


SCOPE_CACHE_SIZE = 32


def _resolved_scope(request: Request, conversation_id: str, scope: Scope, config: AIConfig) -> Any:
    """Resolve the scope once per conversation and vault change, not once per message."""
    state = request.app.state
    cache: dict[str, tuple[tuple[str, bool, int], Any]] = state.__dict__.setdefault(
        "scope_cache", {}
    )
    cloud = config.provider != "local"
    key = (json.dumps(scope.to_dict(), sort_keys=True), cloud, state.fileops.epoch)
    hit = cache.get(conversation_id)
    if hit is not None and hit[0] == key:
        return hit[1]
    resolved = resolve_scope(state.db, state.settings.vault, scope, cloud_provider=cloud)
    cache[conversation_id] = (key, resolved)
    while len(cache) > SCOPE_CACHE_SIZE:
        del cache[next(iter(cache))]
    return resolved


@router.post("/conversations/{conversation_id}/messages")
async def chat(conversation_id: str, body: ChatRequest, request: Request) -> StreamingResponse:
    from graite.retrieval.pipeline import TurnContext, answer_turn

    if not body.message.strip():
        raise HTTPException(400, "Enter a question.")
    state = request.app.state
    db = state.db
    row = _row(request, conversation_id)
    scope = _load_scope(request, row)
    if body.page_path:
        page = await _page_for(request, body.page_path)
        if row["page_id"] and page.id != row["page_id"]:
            raise HTTPException(404, "Conversation not found for this page.")
    mode = body.mode or row["mode"] or "ask"
    active = state.active_chats
    base_config = load_config(db)
    if base_config.provider == "local" and state.models.lock.locked():
        # A background pass of the assistant yields to the person at the keyboard.
        await state.foreground.preempt()
    if conversation_id in active or (
        base_config.provider == "local" and state.models.lock.locked()
    ):
        raise HTTPException(409, "An answer is already running. Stop it or wait for it to finish.")
    try:
        resolved = _resolved_scope(request, conversation_id, scope, base_config)
    except FileNotFoundError as exc:
        raise HTTPException(404, "A page in this conversation's scope no longer exists.") from exc
    # Model selection belongs to chat and agents, never inherited page settings.
    config, fallback = base_config, None
    extra_sources, attachment_meta, images = _attachment_sources(
        request, body.attachments, conversation_id
    )
    if body.selection is not None:
        try:
            selected = await state.fileops.read_page(body.selection.page_path)
            title = selected.title
        except (ValueError, FileNotFoundError):
            title = body.selection.page_path
        extra_sources.insert(
            0,
            Source(
                0,
                "selection",
                body.selection.page_path,
                None,
                f"Selected text from {title}",
                [],
                body.selection.text,
            ),
        )
    from graite.retrieval.contextset import ContextSet

    history = json.loads(row["messages_json"])
    context = ContextSet.load(_context_json(row))
    if body.replace_from is not None:
        if body.replace_from >= len(history) or history[body.replace_from].get("role") != "user":
            raise HTTPException(400, "replace_from must point at one of your earlier messages.")
        history = history[: body.replace_from]
        if body.replace_from == 0:
            context = ContextSet()
    first_turn = not any(m.get("role") == "user" for m in history)
    user_message: dict[str, Any] = {"role": "user", "content": body.message.strip(), "mode": mode}
    if attachment_meta:
        user_message["attachments"] = attachment_meta
    if body.selection is not None:
        user_message["selection"] = body.selection.model_dump()
    history.append(user_message)
    title = body.message.strip()[:70] if first_turn else row["title"]
    skills = resolved.policy.values.get("skills")
    ctx = TurnContext(
        state=state,
        conversation_id=conversation_id,
        scope=scope,
        question=body.message.strip(),
        history=history[:-1],
        config=config,
        mode=mode,
        extra_sources=extra_sources,
        skills_allowlist=skills if isinstance(skills, list) else None,
        page_path=scope.roots[0] if scope.roots else None,
        images=images if (config.provider == "anthropic" or config.vision) else [],
        resolved=resolved,
        context=context,
        feedback=state.proposals.undelivered_rejections(conversation_id),
    )
    is_assistant = row["kind"] == "assistant"
    if is_assistant:
        from graite.assistant.service import build_turn

        try:
            ctx = await build_turn(state, ctx)
        except ValueError as exc:
            raise HTTPException(409, str(exc)) from exc
        user_message["mode"] = ctx.mode
        config = ctx.config

    def persist() -> None:
        db.execute(
            "UPDATE conversations SET title=?,messages_json=?,context_json=?,updated_at=? "
            "WHERE id=?",
            (
                title,
                json.dumps(history, ensure_ascii=False),
                context.dump(),
                datetime.now(UTC).isoformat(),
                conversation_id,
            ),
        )

    persist()
    queue: asyncio.Queue[dict[str, Any] | None] = asyncio.Queue()

    async def produce() -> None:
        nonlocal title
        try:
            if fallback:
                await queue.put({"type": "status", "text": fallback})
                state.events.publish("model_status", {"message": fallback})
            completed = False
            async for item in answer_turn(ctx):
                await queue.put(item)
                if item["type"] == "answer":
                    completed = True
            if completed and first_turn and not is_assistant:
                from graite.agent.titles import chat_title

                await queue.put({"type": "status", "text": "Naming your chat…"})
                title = await chat_title(state.models, config, body.message.strip())
        except asyncio.CancelledError:
            await queue.put({"type": "cancelled"})
            raise
        except (ValueError, OSError, httpx.HTTPError) as exc:
            # Expected enough not to need a traceback, but a turn that failed should still
            # leave a trace: these were invisible in the log until now.
            log.warning("chat turn failed: %s", exc)
            detail = (
                str(exc)
                if isinstance(exc, ValueError)
                else "Could not reach the model. Check Settings → Chat."
            )
            await queue.put({"type": "error", "text": detail})
        except Exception as exc:  # noqa: BLE001
            log.exception("chat turn failed")
            await queue.put(
                {"type": "error", "text": f"Something went wrong: {exc.__class__.__name__}."}
            )
        finally:
            await queue.put(None)

    task = asyncio.create_task(produce())
    active[conversation_id] = task

    async def stream() -> AsyncIterator[str]:
        answer = ""
        final: dict[str, Any] | None = None
        run_id: str | None = None
        activity: dict[str, dict[str, Any]] = {}
        proposal_ids: list[str] = []

        def event(data: dict[str, Any]) -> str:
            return "data: " + json.dumps(data, ensure_ascii=False) + "\n\n"

        try:
            while True:
                item = await queue.get()
                if item is None:
                    break
                if item["type"] == "run":
                    run_id = item["run_id"]
                elif item["type"] == "token":
                    answer += item["text"]
                elif item["type"] == "reset":
                    answer = ""
                elif item["type"] == "answer":
                    answer, final = item["text"], item
                elif item["type"] == "activity":
                    activity[item["step"]["id"]] = dict(item["step"])
                elif item["type"] == "proposal":
                    proposal_ids.append(item["proposal"]["id"])
                elif item["type"] == "cancelled":
                    yield event(item)  # the client needs to know the stream ended on purpose
                    break
                yield event(item)
            if final is not None:
                yield event({"type": "done"})
        except asyncio.CancelledError:
            task.cancel()
            raise
        finally:
            if not task.done():
                task.cancel()
                await asyncio.gather(task, return_exceptions=True)
            from graite.agent.loop import visible

            if answer or final is not None or activity or proposal_ids:
                message: dict[str, Any] = {
                    "role": "assistant",
                    "content": visible(answer) if final is None else final["text"],
                    "interrupted": final is None,
                    "run_id": run_id,
                    "context": True,
                }
                if final is None:
                    message["content"] = visible(answer) or "Stopped before finishing."
                    for step in activity.values():
                        if step["status"] == "running":
                            step["status"] = "cancelled"
                    message["activity"] = list(activity.values())
                    message["proposals"] = proposal_ids
                if final is not None:
                    message["sources"] = final.get("new_sources")
                    message["cited"] = final.get("cited")
                    message["limits"] = final.get("limits")
                    if final.get("thinking"):
                        message["thinking"] = final["thinking"]
                    if final.get("activity"):
                        message["activity"] = final["activity"]
                    if final.get("proposals"):
                        message["proposals"] = final["proposals"]
                history.append(message)
            persist()
            active.pop(conversation_id, None)
            if is_assistant and final is not None:
                from graite.assistant.service import enqueue_reflect

                enqueue_reflect(state, conversation_id)

    return StreamingResponse(
        stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@router.post("/conversations/{conversation_id}/cancel")
async def cancel_chat(conversation_id: str, request: Request) -> dict[str, bool]:
    task = request.app.state.active_chats.get(conversation_id)
    if task is None:
        return {"cancelled": False}
    task.cancel()
    return {"cancelled": True}


@router.get("/catalog", response_model=list[CatalogModel])
async def model_catalog(request: Request) -> list[CatalogModel]:
    return list(request.app.state.downloads.items.values())


class HubRepository(BaseModel):
    repository: str = Field(min_length=1, max_length=250)


class HubImport(HubRepository):
    filename: str = Field(min_length=1, max_length=500)
    revision: str


class LocalFolder(BaseModel):
    path: str = Field(min_length=1, max_length=4096)


@router.post("/hub/browse", response_model=list[CatalogModel])
async def browse_hub(body: HubRepository) -> list[CatalogModel]:
    from graite.models.hub import browse

    try:
        return await browse(body.repository)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    except httpx.HTTPError as exc:
        raise HTTPException(
            400, "Could not read this repository. Check the link and connection."
        ) from exc


@router.post("/hub/add", response_model=CatalogModel)
async def add_hub(body: HubImport, request: Request) -> CatalogModel:
    models = await browse_hub(body)
    item = next(
        (m for m in models if m.filename == body.filename and m.revision == body.revision), None
    )
    if not item:
        raise HTTPException(
            409, "The repository changed. Find its models again before downloading."
        )
    downloads = request.app.state.downloads
    item = downloads.register(item)
    return CatalogModel.model_validate(downloads.start(item.id))


@router.post("/hub/folder", response_model=list[CatalogModel])
async def add_folder(body: LocalFolder, request: Request) -> list[CatalogModel]:
    from graite.models.hub import scan

    try:
        models = await asyncio.to_thread(scan, body.path)
    except (ValueError, OSError) as exc:
        raise HTTPException(
            400, str(exc) if isinstance(exc, ValueError) else "Could not read this folder."
        ) from exc
    return [request.app.state.downloads.register(item) for item in models]


@router.post("/hub/file", response_model=CatalogModel)
async def add_local_file(body: LocalFolder, request: Request) -> CatalogModel:
    from graite.models.hub import local_file

    try:
        item = await asyncio.to_thread(local_file, body.path)
    except (ValueError, OSError) as exc:
        raise HTTPException(
            400, str(exc) if isinstance(exc, ValueError) else "Could not read this model file."
        ) from exc
    return CatalogModel.model_validate(request.app.state.downloads.register(item))


@router.post("/catalog/{model_id}/{action}", response_model=CatalogModel)
async def model_action(model_id: str, action: str, request: Request) -> CatalogModel:
    downloads = request.app.state.downloads
    if model_id not in downloads.items:
        raise HTTPException(404, "Model not found.")
    item = downloads.items[model_id]
    if action == "download":
        try:
            return CatalogModel.model_validate(downloads.start(model_id))
        except ValueError as exc:
            raise HTTPException(400, str(exc)) from exc
    if action == "pause":
        await downloads.cancel(model_id)
    elif action == "remove":
        config = load_config(request.app.state.db)
        if config.model_path == str(downloads.target(item)):
            raise HTTPException(409, "Choose another model before removing the selected model.")
        manager = request.app.state.models
        if model_busy(request.app.state):
            raise HTTPException(409, "Wait for the current model task to finish.")
        async with manager.lock:
            if manager.embedding_path == str(downloads.target(item)):
                await manager.embedding_server.stop()
                manager.embedding_path = ""
            await downloads.remove(model_id)
    else:
        raise HTTPException(404, "Unknown model action.")
    return CatalogModel.model_validate(item)


class EmbedRequest(BaseModel):
    model_id: str
    texts: list[str] = Field(min_length=1, max_length=16)
    task: Literal["query", "document"] = "document"


class EmbedResult(BaseModel):
    vectors: list[list[float]]


@router.post("/embeddings", response_model=EmbedResult)
async def embeddings(body: EmbedRequest, request: Request) -> EmbedResult:
    if any(not text.strip() or len(text) > 2000 for text in body.texts):
        raise HTTPException(400, "Use non-empty passages of at most 2,000 characters.")
    item = request.app.state.downloads.items.get(body.model_id)
    if not item or item.role != "embedding" or item.status != "installed":
        raise HTTPException(400, "Download an embedding model first.")
    manager = request.app.state.models
    from graite.index.embedder import Embedder

    try:
        prefix = Embedder.prefix(item, body.task)
        texts = [prefix + text for text in body.texts]
        async with manager.use_embedding(item.local_path, item.pooling, release=True) as provider:
            return EmbedResult(vectors=await provider.embed(texts))
    except (ValueError, OSError, httpx.HTTPError) as exc:
        raise HTTPException(
            400, "Could not run the embedding model. Check the local engine."
        ) from exc


class IndexStatus(BaseModel):
    model_config = ConfigDict(extra="ignore")

    embedding_model: str | None
    vector_model: str | None
    dim: int | None
    pages: int
    failed_pages: int
    chunks: int
    pending_chunks: int
    worker: str
    last_error: str | None
    jobs: dict[str, int]


@router.get("/index/status", response_model=IndexStatus)
async def index_status(request: Request) -> IndexStatus:
    status = request.app.state.embedder.status()
    return IndexStatus.model_validate({**status, "jobs": request.app.state.queue.counts()})


@router.post("/index/rebuild", status_code=202)
async def rebuild_index(request: Request) -> dict[str, str]:
    from graite.jobs.queue import PRIORITY_REBUILD

    job_id = request.app.state.queue.enqueue("reindex", key="reindex", priority=PRIORITY_REBUILD)
    return {"job_id": job_id}


class JobInfo(BaseModel):
    id: str
    kind: str
    status: str
    page_path: str | None = None
    priority: int
    attempts: int
    progress: dict[str, Any] | None = None
    error: str | None = None
    run_id: str | None = None
    created_at: str
    finished_at: str | None = None


@router.get("/jobs", response_model=list[JobInfo])
async def list_jobs(
    request: Request, status: str | None = None, kind: str | None = None, limit: int = 100
) -> list[JobInfo]:
    jobs = request.app.state.queue.list(status=status, kind=kind, limit=min(max(limit, 1), 500))
    return [JobInfo.model_validate(job) for job in jobs]


@router.delete("/jobs/{job_id}", response_model=JobInfo)
async def cancel_job(job_id: str, request: Request) -> JobInfo:
    if request.app.state.queue.get(job_id) is None:
        raise HTTPException(404, "Job not found.")
    await request.app.state.worker.cancel(job_id)
    job = request.app.state.queue.get(job_id)
    if job is None:
        raise HTTPException(404, "Job not found.")
    return JobInfo.model_validate(job)


class SpeechResult(BaseModel):
    text: str
    seconds: float


@router.post("/speech/check", response_model=SpeechResult)
async def speech_check(request: Request) -> SpeechResult:
    from graite.models.speech import transcribe

    manager = request.app.state.models
    if model_busy(request.app.state):
        raise HTTPException(409, "Wait for the current model task to finish.")
    item = request.app.state.downloads.items.get("whisper-large-v3-turbo-q8")
    if not item or item.status != "installed":
        raise HTTPException(400, "Download Whisper Turbo first.")
    audio = bytearray()
    async for chunk in request.stream():
        audio.extend(chunk)
        if len(audio) > 30_000_000:
            raise HTTPException(413, "Use a WAV recording smaller than 30 MB.")
    # Another request can acquire the model while the audio is uploading.
    if model_busy(request.app.state):
        raise HTTPException(409, "Wait for the current model task to finish.")
    try:
        async with manager.lock:
            config = load_config(request.app.state.db)
            await manager.server.stop()
            manager.loaded = None
            result = await transcribe(bytes(audio), item.local_path, config.whisper_binary_path)
            return SpeechResult.model_validate(result)
    except (ValueError, OSError, httpx.HTTPError) as exc:
        raise HTTPException(
            400,
            str(exc)
            if isinstance(exc, ValueError)
            else "Speech check failed. Check the local engine.",
        ) from exc
