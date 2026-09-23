"""Engines Graite installs and keeps up to date for the user (`models/engines.py`)."""

from __future__ import annotations

import asyncio
from typing import Any

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

from graite.models.config import load_config
from graite.models.engines import EngineState
from graite.models.hardware import detect

router = APIRouter(prefix="/engines", tags=["Engines"])
# The path a developer typed under Advanced, per engine.
CUSTOM_PATHS = {"llama": "binary_path", "crispasr": "tts_binary_path"}


class InstallBody(BaseModel):
    # None installs the build Graite recommends for this computer; a variant id is the
    # Advanced choice.
    variant: str | None = None


def _custom(request: Request, engine_id: str) -> str:
    config = load_config(request.app.state.db)
    return str(getattr(config, CUSTOM_PATHS.get(engine_id, ""), "") or "")


def _busy(request: Request) -> None:
    from graite.api.ai import model_busy

    if model_busy(request.app.state):
        raise HTTPException(409, "Wait for the running answer or conversation to finish.")


async def _state(request: Request, engine_id: str) -> EngineState:
    installer = request.app.state.engines
    if engine_id not in installer.engines:
        raise HTTPException(404, "Engine not found.")
    hardware = await asyncio.to_thread(detect)
    return installer.state(engine_id, hardware, _custom(request, engine_id))  # type: ignore[no-any-return]


@router.get("", response_model=list[EngineState])
async def list_engines(request: Request) -> list[Any]:
    installer = request.app.state.engines
    hardware = await asyncio.to_thread(detect)
    return [installer.state(e, hardware, _custom(request, e)) for e in installer.engines]


@router.post("/{engine_id}/install", response_model=EngineState, status_code=202)
async def install_engine(engine_id: str, body: InstallBody, request: Request) -> EngineState:
    """Download, verify, try and switch to the pinned build. Also how an update is applied."""
    installer = request.app.state.engines
    if engine_id not in installer.engines:
        raise HTTPException(404, "Engine not found.")
    _busy(request)
    try:
        installer.begin(engine_id, body.variant, await asyncio.to_thread(detect))
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    return await _state(request, engine_id)


@router.post("/{engine_id}/cancel", response_model=EngineState)
async def cancel_install(engine_id: str, request: Request) -> EngineState:
    await request.app.state.engines.cancel(engine_id)
    return await _state(request, engine_id)


@router.post("/{engine_id}/rollback", response_model=EngineState)
async def rollback_engine(engine_id: str, request: Request) -> EngineState:
    _busy(request)
    try:
        await request.app.state.engines.rollback(engine_id)
    except ValueError as exc:
        raise HTTPException(409, str(exc)) from exc
    return await _state(request, engine_id)


@router.delete("/{engine_id}", response_model=EngineState)
async def remove_engine(engine_id: str, request: Request) -> EngineState:
    if engine_id not in request.app.state.engines.engines:
        raise HTTPException(404, "Engine not found.")
    _busy(request)
    await request.app.state.engines.remove(engine_id)
    return await _state(request, engine_id)
