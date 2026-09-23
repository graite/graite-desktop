"""Agents, workflows, schedules and runs: the automation surface of the Studio."""

from __future__ import annotations

import json
from typing import Any

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

from graite.agents.definitions import (
    AGENTS_DIR,
    WORKFLOWS_DIR,
    AgentTrigger,
    definition_path,
    render_agent,
    validate_cron,
    validate_triggers,
)
from graite.agents.triggers import in_scope
from graite.jobs.queue import PRIORITY_SUMMARY
from graite.retrieval.scope import Scope
from graite.skills.tools import TOOLS
from graite.vault import frontmatter
from graite.vault.instructions import safe_file
from graite.vault.paths import VaultPathError, validate_rel

router = APIRouter(prefix="/ai", tags=["AI"])
UI_ACTOR = "ui"


class ScopeBody(BaseModel):
    kind: str = "vault"
    roots: list[str] = Field(default_factory=list)
    excluded: list[str] = Field(default_factory=list)


class AgentInfo(BaseModel):
    name: str
    description: str
    path: str
    folder: str
    scope: ScopeBody
    mode: str
    instructions: str
    model: str | None = None
    skills: list[str] | None = None
    tools: list[str] | None = None
    schedule: str | None = None
    triggers: list[AgentTrigger] = Field(default_factory=list, max_length=20)
    assistant: bool = False
    last_run: dict[str, Any] | None = None


class AgentBody(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    description: str = Field(default="", max_length=300)
    instructions: str = Field(default="", max_length=32000)
    folder: str | None = None
    scope: ScopeBody | None = None
    mode: str = "act"
    model: str | None = None
    skills: list[str] | None = None
    tools: list[str] | None = None
    schedule: str | None = None
    triggers: list[AgentTrigger] = Field(default_factory=list, max_length=20)


class StepBody(BaseModel):
    agent: str = Field(min_length=1)
    instructions: str | None = Field(default=None, max_length=8000)
    scope: ScopeBody | None = None


class WorkflowInfo(BaseModel):
    name: str
    description: str
    path: str
    folder: str
    steps: list[StepBody]
    schedule: str | None = None
    last_run: dict[str, Any] | None = None


class WorkflowBody(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    description: str = Field(default="", max_length=300)
    folder: str | None = None
    steps: list[StepBody] = Field(min_length=1, max_length=20)
    schedule: str | None = None


class RunRequest(BaseModel):
    instructions: str | None = Field(default=None, max_length=8000)


class Queued(BaseModel):
    job_id: str


class ScheduleInfo(BaseModel):
    id: str
    name: str
    expr: str
    source: str
    job_kind: str
    payload: dict[str, Any]
    page_path: str | None = None
    enabled: bool
    last_run_at: str | None = None
    next_run_at: str | None = None
    last_status: str | None = None
    failures: int = 0


class ScheduleBody(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    expr: str
    job_kind: str = "agent_run"
    payload: dict[str, Any] = Field(default_factory=dict)
    page_path: str | None = None


class SchedulePatch(BaseModel):
    name: str | None = Field(default=None, max_length=120)
    expr: str | None = None
    enabled: bool | None = None


class RunInfo(BaseModel):
    id: str
    kind: str
    trigger: str
    conversation_id: str | None = None
    job_id: str | None = None
    parent_run_id: str | None = None
    agent: str | None = None
    workflow: str | None = None
    page_path: str | None = None
    mode: str | None = None
    provider: str | None = None
    model: str | None = None
    status: str
    error: str | None = None
    started_at: str
    finished_at: str | None = None
    input: dict[str, Any] | None = None
    output: dict[str, Any] | None = None


class RunDetail(RunInfo):
    steps: list[dict[str, Any]] = Field(default_factory=list)
    proposals: list[dict[str, Any]] = Field(default_factory=list)
    children: list[RunInfo] = Field(default_factory=list)


def _state(request: Request) -> Any:
    return request.app.state


def _folder(folder: str | None) -> str | None:
    if not folder:
        return None
    try:
        return validate_rel(folder)
    except VaultPathError as exc:
        raise HTTPException(400, str(exc)) from exc


def _validate_tools(tools: list[str] | None, mode: str) -> None:
    if tools is None:
        return
    unknown = sorted(set(tools) - set(TOOLS))
    if unknown:
        raise HTTPException(
            400,
            f"Unknown tools: {', '.join(unknown)}. Available: {', '.join(sorted(TOOLS))}.",
        )
    proposing = sorted(t for t in tools if TOOLS[t].group == "propose")
    if mode == "ask" and proposing:
        raise HTTPException(
            400,
            "An Ask-mode agent cannot propose changes. Switch the agent to Act or remove "
            f"{', '.join(proposing)}.",
        )


def _last_run(db: Any, column: str, name: str) -> dict[str, Any] | None:
    row = db.execute(
        f"SELECT id, status, started_at, finished_at, error FROM runs WHERE {column}=? "
        "ORDER BY started_at DESC LIMIT 1",
        (name,),
    ).fetchone()
    return dict(row) if row else None


def _loads(raw: Any) -> dict[str, Any] | None:
    if not raw:
        return None
    try:
        value = json.loads(raw)
    except ValueError:
        return None
    return value if isinstance(value, dict) else None


def _step_info(row: Any) -> dict[str, Any]:
    data = dict(row)
    return {
        "ord": data["ord"],
        "kind": data["kind"],
        "name": data.get("name"),
        "status": data["status"],
        "started_at": data.get("started_at"),
        "finished_at": data.get("finished_at"),
        "input": _loads(data.get("input_json")) or {},
        "output": _loads(data.get("output_json")) or {},
    }


def _run_info(row: Any) -> RunInfo:
    data = dict(row)

    def loads(key: str) -> dict[str, Any] | None:
        return _loads(data.get(key))

    return RunInfo(
        id=data["id"],
        kind=data["kind"],
        trigger=data["trigger"],
        conversation_id=data.get("conversation_id"),
        job_id=data.get("job_id"),
        parent_run_id=data.get("parent_run_id"),
        agent=data.get("agent"),
        workflow=data.get("workflow"),
        page_path=data.get("page_path"),
        mode=data.get("mode"),
        provider=data.get("provider"),
        model=data.get("model"),
        status=data["status"],
        error=data.get("error"),
        started_at=data["started_at"],
        finished_at=data.get("finished_at"),
        input=loads("input_json"),
        output=loads("output_json"),
    )


# ----------------------------------------------------------------- agents


@router.get("/agents", response_model=list[AgentInfo])
async def list_agents(request: Request) -> list[AgentInfo]:
    state = _state(request)
    return [
        AgentInfo(**a.to_dict(), last_run=_last_run(state.db, "agent", a.name))
        for a in state.definitions.agents()
    ]


def _existing_meta(state: Any, rel: str | None) -> dict[str, Any]:
    """Frontmatter of the file a save replaces, so keys this editor does not manage survive."""
    if not rel:
        return {}
    try:
        text = safe_file(state.settings.vault, rel).read_text(encoding="utf-8")
        return frontmatter.split(text)[0]
    except (OSError, ValueError):
        return {}


async def _write_agent(
    request: Request,
    body: AgentBody,
    *,
    existing: str | None,
    extra: dict[str, Any] | None = None,
) -> AgentInfo:
    """`extra` carries frontmatter the generic editor does not know (the assistant's keys)."""
    state = _state(request)
    if not body.name.strip():
        raise HTTPException(400, "Give the agent a name.")
    if body.mode not in ("ask", "act"):
        raise HTTPException(400, "Agent mode must be ask or act.")
    folder = _folder(body.folder)
    try:
        schedule = validate_cron(body.schedule)
        triggers = validate_triggers([t.model_dump() for t in body.triggers])
        scope = (
            Scope.parse(body.scope.model_dump())
            if body.scope is not None
            else (Scope("folder", [folder]) if folder else Scope("vault"))
        )
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    _validate_tools(body.tools, body.mode)
    outside = [t["path"] for t in triggers if not in_scope(t["path"], scope)]
    if outside:
        raise HTTPException(
            400,
            f"Trigger path outside the agent's scope: {', '.join(outside)}. "
            "Widen the scope or point the trigger at a page inside it.",
        )
    rel = existing or definition_path("agent", folder, body.name)
    text = render_agent(
        {
            "name": body.name.strip(),
            "description": body.description.strip(),
            "scope": body.scope.model_dump() if body.scope else None,
            "mode": body.mode,
            "model": body.model,
            "skills": body.skills,
            "tools": body.tools,
            "schedule": schedule,
            "triggers": triggers,
            **(extra or {}),
        },
        body.instructions,
        keep=_existing_meta(state, existing),
    )
    try:
        await state.fileops.write_definition(rel, text, UI_ACTOR)
    except FileNotFoundError as exc:
        raise HTTPException(404, f"Folder not found: {exc}") from exc
    except VaultPathError as exc:
        raise HTTPException(400, str(exc)) from exc
    state.definitions.refresh(force=True)
    state.cron.sync()
    definition = state.definitions.agent(body.name.strip())
    if definition is None:
        raise HTTPException(400, "The agent file could not be read back.")
    return AgentInfo(**definition.to_dict(), last_run=None)


@router.post("/agents", response_model=AgentInfo, status_code=201)
async def create_agent(body: AgentBody, request: Request) -> AgentInfo:
    if _state(request).definitions.agent(body.name.strip()):
        raise HTTPException(409, "An agent with this name already exists.")
    return await _write_agent(request, body, existing=None)


@router.put("/agents/{name}", response_model=AgentInfo)
async def update_agent(name: str, body: AgentBody, request: Request) -> AgentInfo:
    state = _state(request)
    current = state.definitions.agent(name)
    if current is None:
        raise HTTPException(404, "Agent not found.")
    if body.name.strip() != name and state.definitions.agent(body.name.strip()):
        raise HTTPException(409, "An agent with this name already exists.")
    return await _write_agent(request, body, existing=current.path)


@router.delete("/agents/{name}")
async def delete_agent(name: str, request: Request) -> dict[str, bool]:
    state = _state(request)
    current = state.definitions.agent(name)
    if current is None:
        raise HTTPException(404, "Agent not found.")
    await state.fileops.delete_definition(current.path, UI_ACTOR)
    state.definitions.refresh(force=True)
    state.cron.sync()
    return {"ok": True}


@router.post("/agents/{name}/run", response_model=Queued, status_code=202)
async def run_agent(name: str, body: RunRequest, request: Request) -> Queued:
    state = _state(request)
    agent = state.definitions.agent(name)
    if agent is None:
        raise HTTPException(404, "Agent not found.")
    payload: dict[str, Any] = {"agent": name, "trigger": "manual"}
    if body.instructions:
        payload["instructions"] = f"{agent.instructions}\n\n{body.instructions.strip()}".strip()
    job_id = state.queue.enqueue(
        "agent_run",
        payload,
        key=f"agent:{name}",  # a second click folds into the pending run
        page_path=agent.scope.roots[0] if agent.scope.roots else None,
        priority=PRIORITY_SUMMARY,
        max_attempts=1,
    )
    return Queued(job_id=job_id)


# ----------------------------------------------------------------- workflows


@router.get("/workflows", response_model=list[WorkflowInfo])
async def list_workflows() -> list[WorkflowInfo]:
    return []


@router.post("/workflows")
@router.put("/workflows/{name}")
@router.delete("/workflows/{name}")
@router.post("/workflows/{name}/run")
async def workflows_unavailable() -> None:
    raise HTTPException(
        410, "Workflows are no longer available. Use an agent with instructions and tools."
    )


# ----------------------------------------------------------------- schedules


@router.get("/schedules", response_model=list[ScheduleInfo])
async def list_schedules(request: Request) -> list[ScheduleInfo]:
    return [ScheduleInfo.model_validate(r) for r in _state(request).cron.rows()]


@router.post("/schedules", response_model=ScheduleInfo, status_code=201)
async def create_schedule(body: ScheduleBody, request: Request) -> ScheduleInfo:
    if body.job_kind not in ("agent_run", "live_note"):
        raise HTTPException(400, "job_kind must be agent_run or live_note.")
    try:
        expr = validate_cron(body.expr)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    if expr is None:
        raise HTTPException(400, "A schedule needs a cron expression.")
    row = _state(request).cron.create(
        body.name, expr, body.job_kind, body.payload, source="user", page_path=body.page_path
    )
    return ScheduleInfo.model_validate(row)


@router.patch("/schedules/{cron_id}", response_model=ScheduleInfo)
async def patch_schedule(cron_id: str, body: SchedulePatch, request: Request) -> ScheduleInfo:
    try:
        expr = validate_cron(body.expr) if body.expr is not None else None
        row = _state(request).cron.update(cron_id, name=body.name, expr=expr, enabled=body.enabled)
    except KeyError as exc:
        raise HTTPException(404, "Schedule not found.") from exc
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    return ScheduleInfo.model_validate(row)


@router.delete("/schedules/{cron_id}")
async def delete_schedule(cron_id: str, request: Request) -> dict[str, bool]:
    cron = _state(request).cron
    if cron.get(cron_id) is None:
        raise HTTPException(404, "Schedule not found.")
    cron.delete(cron_id)
    return {"ok": True}


@router.post("/schedules/{cron_id}/run", response_model=Queued, status_code=202)
async def run_schedule(cron_id: str, request: Request) -> Queued:
    try:
        return Queued(job_id=_state(request).cron.fire(cron_id))
    except KeyError as exc:
        raise HTTPException(404, "Schedule not found.") from exc


# ----------------------------------------------------------------- runs


@router.get("/runs", response_model=list[RunInfo])
async def list_runs(
    request: Request,
    kind: str | None = None,
    status: str | None = None,
    agent: str | None = None,
    limit: int = 50,
) -> list[RunInfo]:
    clauses, params = [], []
    if kind:
        clauses.append("kind=?")
        params.append(kind)
    if status:
        clauses.append("status=?")
        params.append(status)
    if agent:
        clauses.append("agent=?")
        params.append(agent)
    where = ("WHERE " + " AND ".join(clauses)) if clauses else ""
    rows = (
        _state(request)
        .db.execute(
            f"SELECT * FROM runs {where} ORDER BY started_at DESC LIMIT ?",
            (*params, max(1, min(limit, 500))),
        )
        .fetchall()
    )
    return [_run_info(r) for r in rows]


@router.get("/runs/{run_id}", response_model=RunDetail)
async def get_run(run_id: str, request: Request) -> RunDetail:
    state = _state(request)
    row = state.db.execute("SELECT * FROM runs WHERE id=?", (run_id,)).fetchone()
    if row is None:
        raise HTTPException(404, "Run not found.")
    steps = [
        _step_info(s)
        for s in state.db.execute(
            "SELECT ord, kind, name, status, started_at, finished_at, input_json, output_json "
            "FROM run_steps WHERE run_id=? ORDER BY ord",
            (run_id,),
        )
    ]
    children = [
        _run_info(c)
        for c in state.db.execute(
            "SELECT * FROM runs WHERE parent_run_id=? ORDER BY started_at", (run_id,)
        )
    ]
    proposals = state.proposals.find(run_id=run_id, limit=200)
    for child in children:
        proposals.extend(state.proposals.find(run_id=child.id, limit=200))
    return RunDetail(
        **_run_info(row).model_dump(), steps=steps, proposals=proposals, children=children
    )


__all__ = ["AGENTS_DIR", "WORKFLOWS_DIR", "router"]
