"""AI on another of your computers (the "local AI workstation"): whether this one shares its
models, which of your other devices do, and choosing one of them for chat, documents, speech
or the assistant's voice. The calls themselves are `graite/compute`."""

from __future__ import annotations

import asyncio
from typing import Any, Literal

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

from graite.compute.serve import offers
from graite.models.config import AIConfig, SaveConfig, load_config, save_config

router = APIRouter(prefix="/compute", tags=["compute"])

Task = Literal["chat", "documents", "speech", "voice"]


class ComputeDevice(BaseModel):
    id: str
    name: str
    # The local chat model that computer answers with; None when it shares none.
    chat_model: str | None = None
    # Every local chat model it has; one of them can be asked for by name.
    chat_models: list[str] = []
    # Whether it can read documents (OCR), turn speech into text, and speak for the assistant.
    documents: bool = False
    speech: bool = False
    voice: bool = False
    # What this computer uses it for now.
    uses: list[Task] = []


class ComputeStatus(BaseModel):
    # Whether this computer lets the account's other devices use its local models.
    serving: bool
    # What it has to offer them: its local chat model, and the three other tasks.
    chat_model: str | None = None
    documents: bool = False
    speech: bool = False
    voice: bool = False
    # The account's other devices that are connected and share something.
    devices: list[ComputeDevice] = []


class ServeIn(BaseModel):
    on: bool


class UseIn(BaseModel):
    device_id: str
    what: Task = "chat"
    # For chat: which of that computer's models. Omitted = the one it uses itself.
    model: str | None = None
    # False hands the task back to this computer (or Graite Cloud, as the settings say).
    on: bool = True


def _uses(config: AIConfig, device_id: str) -> list[Task]:
    chosen: list[tuple[Task, bool]] = [
        ("chat", config.provider == "device" and config.device_id == device_id),
        ("documents", config.ocr_provider == "device" and config.ocr_device_id == device_id),
        ("speech", config.stt_provider == "device" and config.stt_device_id == device_id),
        ("voice", config.tts_provider == "device" and config.tts_device_id == device_id),
    ]
    return [task for task, on in chosen if on]


async def _device(compute: Any, peer: str, name: str) -> ComputeDevice | None:
    info = await compute.offers(peer)
    if info is None:
        return None  # not sharing, an older Graite, or gone
    device = ComputeDevice(
        id=peer,
        name=name,
        chat_model=str(info["chat"]) if info.get("chat") else None,
        chat_models=[str(m) for m in info.get("chat_models") or []]
        or ([str(info["chat"])] if info.get("chat") else []),
        documents=bool(info.get("ocr")),
        speech=bool(info.get("stt")),
        voice=bool(info.get("tts")),
    )
    if not (device.chat_model or device.documents or device.speech or device.voice):
        return None
    return device


async def _status(request: Request) -> ComputeStatus:
    state = request.app.state
    config = load_config(state.db)
    peers = dict(state.sync.peers)
    found = await asyncio.gather(
        *(
            _device(state.compute, peer, str(info.get("device") or "Another computer"))
            for peer, info in peers.items()
            if peer != state.sync._replica  # the list of connected devices includes this one
        )
    )
    devices = [device for device in found if device is not None]
    for device in devices:
        device.uses = _uses(config, device.id)
        if "chat" in device.uses and config.model in device.chat_models:
            device.chat_model = config.model  # the one this computer asks for
    mine = await asyncio.to_thread(offers, state)
    return ComputeStatus(
        serving=state.compute.serving,
        chat_model=mine["chat"],
        documents=mine["ocr"],
        speech=mine["stt"],
        voice=mine["tts"] is not None,
        devices=devices,
    )


@router.get("/status", response_model=ComputeStatus)
async def status(request: Request) -> ComputeStatus:
    return await _status(request)


@router.put("/serve", response_model=ComputeStatus)
async def serve(body: ServeIn, request: Request) -> ComputeStatus:
    """Let this account's other devices use this computer's local models, or stop that."""
    await asyncio.to_thread(request.app.state.compute.set_serving, body.on)
    return await _status(request)


NOT_SHARED = {
    "chat": "That computer is not sharing a chat model right now.",
    "documents": "That computer cannot read documents right now.",
    "speech": "That computer cannot turn speech into text right now.",
    "voice": "That computer has no voice model to share right now.",
}


@router.post("/use", response_model=AIConfig)
async def use(body: UseIn, request: Request) -> AIConfig:
    """Do one kind of AI work on another of the account's devices, or take it back."""
    state = request.app.state
    current = load_config(state.db)
    change: dict[str, Any]
    if body.on:
        mine = body.device_id == state.sync._replica
        peer = None if mine else state.sync.peers.get(body.device_id)
        device = (
            await _device(
                state.compute, body.device_id, str(peer.get("device") or "Another computer")
            )
            if peer is not None
            else None
        )
        offered = device is not None and (
            device.chat_model if body.what == "chat" else getattr(device, body.what)
        )
        if device is None or not offered:
            raise HTTPException(400, NOT_SHARED[body.what])
        if body.what == "chat" and body.model and body.model not in device.chat_models:
            raise HTTPException(400, "That computer does not have this model anymore.")
        change = {
            "chat": {
                "provider": "device",
                "model": body.model or device.chat_model or "",
                "device_id": device.id,
                "device_name": device.name,
            },
            "documents": {
                "ocr_provider": "device",
                "ocr_device_id": device.id,
                "ocr_device_name": device.name,
            },
            "speech": {
                "stt_provider": "device",
                "stt_device_id": device.id,
                "stt_device_name": device.name,
            },
            "voice": {
                "tts_provider": "device",
                "tts_device_id": device.id,
                "tts_device_name": device.name,
            },
        }[body.what]
    else:
        change = {
            "chat": {"provider": "local", "model": "", "device_id": "", "device_name": ""},
            "documents": {"ocr_provider": "auto", "ocr_device_id": "", "ocr_device_name": ""},
            "speech": {"stt_provider": "auto", "stt_device_id": "", "stt_device_name": ""},
            "voice": {"tts_provider": "local", "tts_device_id": "", "tts_device_name": ""},
        }[body.what]
    wanted = SaveConfig(**(current.model_dump() | change))
    manager = state.models
    if body.what != "chat":
        try:
            return await asyncio.to_thread(save_config, state.db, wanted)
        except ValueError as exc:
            raise HTTPException(400, str(exc)) from exc
    if manager.lock.locked():
        raise HTTPException(409, "Wait for the current answer or model check to finish.")
    async with manager.lock:
        try:
            saved = await asyncio.to_thread(save_config, state.db, wanted)
        except ValueError as exc:
            raise HTTPException(400, str(exc)) from exc
        # The model that was loaded here is no longer the one in use: free its memory.
        await manager.server.stop()
        manager.loaded = None
    return saved
