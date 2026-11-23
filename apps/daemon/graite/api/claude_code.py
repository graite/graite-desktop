"""Settings → Chat → Claude subscription: is Claude Code there, and help setting it up.

Nothing here sees a credential. `status` reports what `claude auth status` says; `install`
and `login` open Claude Code's own commands in a terminal window (agent/claude_setup.py).
"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Request

from graite.agent import claude_setup
from graite.agent.claude_code import MODELS, ClaudeStatus, status

router = APIRouter(prefix="/ai/claude-code", tags=["AI"])


class ClaudeCodeInfo(ClaudeStatus):
    models: list[str]
    # False when this daemon runs without a desktop (`--serve`): it cannot open a terminal.
    can_open_terminal: bool


@router.get("/status", response_model=ClaudeCodeInfo)
async def claude_code_status(request: Request) -> ClaudeCodeInfo:
    found = await status()
    return ClaudeCodeInfo(
        **found.model_dump(),
        models=list(MODELS),
        can_open_terminal=not request.app.state.settings.serve,
    )


@router.post("/install", response_model=claude_setup.Launch)
async def claude_code_install(request: Request) -> claude_setup.Launch:
    return await claude_setup.start_install(headless=request.app.state.settings.serve)


@router.post("/login", response_model=claude_setup.Launch)
async def claude_code_login(request: Request) -> claude_setup.Launch:
    try:
        return await claude_setup.start_login(headless=request.app.state.settings.serve)
    except ValueError as exc:
        raise HTTPException(409, str(exc)) from exc
