"""Realtime voice with the assistant: readiness, the duplex audio socket, and its voice.

The socket is the daemon's second WebSocket (after `/events`). Client -> server: binary
PCM16LE 16 kHz mono microphone audio in any chunking, and JSON controls
(`interrupt`, `played`, `mute`, `barge_in`, `end`). Server -> client: JSON events and binary
PCM16LE audio at the rate announced in `ready`, belonging to the last `audio_start`.
"""

from __future__ import annotations

import asyncio
import io
import json
import logging
import tempfile
import wave
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException, Request, Response, WebSocket, WebSocketDisconnect
from pydantic import BaseModel, Field

from graite.api.auth import websocket_authorized
from graite.voice.runtime import Busy
from graite.voice.tts import Voice
from graite.voice.voices import BUILT_IN, VoiceInfo

log = logging.getLogger("graite.voice")
router = APIRouter(tags=["Voice"])
UI_ACTOR = "ui"
REFERENCE_MIN_SECONDS = 3
REFERENCE_MAX_SECONDS = 30
REFERENCE_MAX_BYTES = 40 * 1024 * 1024
CLOSE_UNAUTHORIZED = 4401
CLOSE_BUSY = 4409
CLOSE_NOT_READY = 4412


class Missing(BaseModel):
    key: str
    text: str


class VoiceStatus(BaseModel):
    ready: bool
    missing: list[Missing] = Field(default_factory=list)
    active: bool = False


@router.get("/voice/status", response_model=VoiceStatus)
async def voice_status(request: Request) -> VoiceStatus:
    return VoiceStatus(**request.app.state.voice.status())


@router.websocket("/voice/session")
async def voice_session(websocket: WebSocket) -> None:
    state = websocket.app.state
    if not websocket_authorized(websocket, state.settings.token):
        await websocket.close(code=CLOSE_UNAUTHORIZED)
        return
    await websocket.accept()
    conversation_id = websocket.query_params.get("conversation_id") or ""
    barge_in = websocket.query_params.get("barge_in") != "false"  # on unless switched off
    testing = websocket.query_params.get("mode") == "test"  # the test bench: no assistant
    lock = asyncio.Lock()  # events and audio come from two tasks; frames must not interleave

    async def send_json(data: dict[str, Any]) -> None:
        async with lock:
            await websocket.send_text(json.dumps(data, ensure_ascii=False))

    async def send_bytes(data: bytes) -> None:
        async with lock:
            await websocket.send_bytes(data)

    try:
        if testing:
            session = await state.voice.open_test(send_json, send_bytes)
        else:
            session = await state.voice.open(
                conversation_id, send_json, send_bytes, barge_in=barge_in
            )
    except Busy as exc:
        await send_json({"type": "error", "text": str(exc)})
        await websocket.close(code=CLOSE_BUSY)
        return
    except WebSocketDisconnect:
        return
    except (ValueError, OSError) as exc:
        await send_json({"type": "error", "text": str(exc)})
        await websocket.close(code=CLOSE_NOT_READY)
        return
    try:
        while True:
            message = await websocket.receive()
            if message["type"] == "websocket.disconnect":
                break
            if message.get("bytes") is not None:
                await session.audio(message["bytes"])
            elif message.get("text"):
                try:
                    control = json.loads(message["text"])
                except ValueError:
                    continue
                if not isinstance(control, dict):
                    continue
                if control.get("type") == "end":
                    break
                await session.control(control)
    except WebSocketDisconnect:
        pass
    finally:
        await state.voice.close()
        try:
            await websocket.close()
        except RuntimeError:
            pass


# ----------------------------------------------------------------- voices


class VoiceList(BaseModel):
    voices: list[VoiceInfo]


def _library(request: Request) -> Any:
    return request.app.state.voice.voices


@router.get("/voice/voices", response_model=VoiceList)
async def list_voices(request: Request) -> VoiceList:
    library = _library(request)
    return VoiceList(voices=await asyncio.to_thread(library.all))


@router.post("/voice/voices", response_model=VoiceInfo, status_code=201)
async def add_voice(
    request: Request, name: str, consent: bool = False, filename: str = "voice.wav"
) -> VoiceInfo:
    """A voice from a short recording of one person (the request body). It is converted to
    the mono 24 kHz WAV the voice engine reads, and only stored with the confirmation that
    the user may use this voice."""
    from graite.media.decode import audio_wav

    if not consent:
        raise HTTPException(
            400,
            "Confirm that this is your own voice, or that you have the speaker's permission.",
        )
    data = await request.body()
    if not data or len(data) > REFERENCE_MAX_BYTES:
        raise HTTPException(400, "Use a recording of up to 40 MB.")
    suffix = Path(filename).suffix.lower() or ".wav"

    def prepare() -> tuple[bytes, float]:
        with tempfile.NamedTemporaryFile(suffix=suffix) as handle:
            handle.write(data)
            handle.flush()
            wav = audio_wav(Path(handle.name), rate=24000, max_seconds=REFERENCE_MAX_SECONDS)
        with wave.open(io.BytesIO(wav)) as parsed:
            return wav, parsed.getnframes() / parsed.getframerate()

    try:
        wav, seconds = await asyncio.to_thread(prepare)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    except Exception as exc:  # noqa: BLE001 - undecodable input
        raise HTTPException(400, "This recording could not be read.") from exc
    if seconds < REFERENCE_MIN_SECONDS:
        raise HTTPException(400, "Use at least three seconds of clear speech; ten is better.")
    library = _library(request)
    created: VoiceInfo = await asyncio.to_thread(library.add, name, wav, seconds)
    return created


class RenameVoice(BaseModel):
    name: str = Field(min_length=1, max_length=60)


@router.patch("/voice/voices/{voice_id}", response_model=VoiceInfo)
async def rename_voice(voice_id: str, body: RenameVoice, request: Request) -> VoiceInfo:
    try:
        renamed: VoiceInfo = await asyncio.to_thread(_library(request).rename, voice_id, body.name)
    except ValueError as exc:
        raise HTTPException(404, str(exc)) from exc
    return renamed


@router.delete("/voice/voices/{voice_id}")
async def delete_voice(voice_id: str, request: Request) -> dict[str, bool]:
    try:
        await asyncio.to_thread(_library(request).remove, voice_id)
    except ValueError as exc:
        raise HTTPException(404, str(exc)) from exc
    return {"ok": True}


class PreviewBody(BaseModel):
    text: str = Field(default="", max_length=300)
    language: str | None = None
    # A voice from the library to try; omitted = the assistant's current voice.
    voice_id: str | None = None
    exaggeration: float | None = Field(default=None, ge=0, le=2)
    cfg: float | None = Field(default=None, ge=0, le=1)


@router.post("/voice/preview")
async def preview(body: PreviewBody, request: Request) -> Response:
    """One sentence in a voice, as a WAV. The engine stays loaded for a minute afterwards."""
    from graite.models.config import load_config

    state = request.app.state
    runtime = state.voice
    if runtime.session is not None:
        raise HTTPException(409, "Wait for the running conversation to finish.")
    definition = state.definitions.assistant()
    voice, _ = runtime.voice_for(definition)
    reference = voice.reference
    if body.voice_id is not None:
        reference = runtime.voices.path(body.voice_id)
        if reference is None and body.voice_id != BUILT_IN:
            raise HTTPException(404, "This voice no longer exists.")
    language = body.language if body.language and body.language != "auto" else voice.language
    voice = Voice(
        language,
        reference,
        voice.exaggeration if body.exaggeration is None else body.exaggeration,
        voice.cfg if body.cfg is None else body.cfg,
    )
    name = definition.name if definition else "your assistant"
    text = body.text.strip() or f"Hi, I am {name}. This is how I sound."
    output = io.BytesIO()
    try:
        engine = await runtime.sample_engine(load_config(state.db))
        with wave.open(output, "wb") as wav:
            wav.setnchannels(1)
            wav.setsampwidth(2)
            wav.setframerate(engine.sample_rate)
            async for chunk in engine.synthesize(text, voice):
                wav.writeframesraw(chunk)
    except ValueError as exc:
        raise HTTPException(409, str(exc)) from exc
    return Response(output.getvalue(), media_type="audio/wav")
