"""Documents, speech and the assistant's voice on another of the account's computers: the
asking side. Each is the same shape as its local and Graite Cloud counterpart."""

from __future__ import annotations

import asyncio
import hashlib
import json
import time
from collections.abc import AsyncIterator, Callable
from pathlib import Path
from typing import Any

from graite.compute.serve import SEND_VOICE
from graite.compute.service import MAX_REQUEST, Compute
from graite.voice.tts import Voice

TOO_LARGE = "This file is too large to send to your other computer (64 MB at most)."


async def recognize_device(
    compute: Compute, peer: str, path: Path, progress: Callable[[str], None]
) -> str:
    """The text of an image or PDF, read by the other computer's OCR model."""
    body = await asyncio.to_thread(path.read_bytes)
    if len(body) > MAX_REQUEST:
        raise ValueError(TOO_LARGE)
    progress("Sending to your other computer…")
    reply = await compute.call(peer, "ocr", {"suffix": path.suffix.lower()}, body)
    text: str | None = None
    try:
        rest = b""
        async for piece in reply.pieces():
            *lines, rest = (rest + piece).split(b"\n")
            for line in lines:
                if not line.strip():
                    continue
                message = json.loads(line)
                if "text" in message:
                    text = str(message["text"])
                elif message.get("progress"):
                    progress(str(message["progress"]))
    finally:
        await reply.close()
    if text is None:
        raise ValueError("The other computer could not finish this.")
    return text


async def transcribe_device(
    compute: Compute,
    peer: str,
    audio: bytes,
    *,
    kind: str = "wav",
    live: bool = False,
    language: str = "auto",
) -> dict[str, str | float | None]:
    """What the other computer's Whisper heard in a recording."""
    if len(audio) > MAX_REQUEST:
        raise ValueError(TOO_LARGE)
    start = time.monotonic()
    result = await compute.ask(
        peer, "stt", {"format": kind, "live": live, "language": language}, audio
    )
    if not isinstance(result, dict):
        raise ValueError("The other computer could not finish this.")
    return {
        "text": str(result.get("text") or "").strip(),
        "language": result.get("language"),
        "seconds": round(time.monotonic() - start, 2),
        "confidence": result.get("confidence"),
    }


class DeviceSpeech:
    """Live voice turns heard by another computer; the same shape as `SpeechServer`."""

    running = True

    def __init__(self, compute: Compute, peer: str) -> None:
        self._compute, self._peer = compute, peer

    async def start(self) -> None:
        return None

    async def transcribe(
        self, audio: bytes, *, language: str = "auto", max_seconds: int = 300
    ) -> dict[str, str | float | None]:
        return await transcribe_device(
            self._compute, self._peer, audio, live=max_seconds <= 300, language=language
        )

    async def stop(self) -> None:
        return None


class DeviceVoice:
    """The assistant's voice, spoken by another computer's voice model (a `TTSEngine`)."""

    name = "device"
    sample_rate = 24000
    controls: tuple[str, ...] = ("exaggeration", "cfg", "speed")

    def __init__(self, compute: Compute, peer: str) -> None:
        self._compute, self._peer = compute, peer
        self._clips: dict[tuple[str, int, int], tuple[str, bytes]] = {}
        known = (compute.known.get(peer) or {}).get("tts")
        if isinstance(known, dict):
            self._learn(known)

    def _learn(self, head: dict[str, Any]) -> None:
        self.name = "device:" + str(head.get("name") or "")
        self.sample_rate = int(head.get("sample_rate") or self.sample_rate)
        if isinstance(head.get("controls"), list):
            self.controls = tuple(str(c) for c in head["controls"])

    async def load(self) -> None:
        reply = await self._compute.call(self._peer, "tts", {"warm": True})
        self._learn(reply.head)
        await reply.close()

    async def unload(self) -> None:
        return None  # the other computer lets go of it by itself

    def memory_bytes(self) -> int:
        return 0

    def _clip(self, path: Path) -> tuple[str, bytes]:
        stat = path.stat()
        key = (str(path), stat.st_size, stat.st_mtime_ns)
        if key not in self._clips:
            data = path.read_bytes()
            self._clips = {key: (hashlib.sha256(data).hexdigest(), data)}
        return self._clips[key]

    async def synthesize(self, text: str, voice: Voice) -> AsyncIterator[bytes]:
        head: dict[str, Any] = {
            "text": text,
            "language": voice.language,
            "exaggeration": voice.exaggeration,
            "cfg": voice.cfg,
            "speed": voice.speed,
        }
        clip = b""
        if voice.reference is not None:
            head["voice"], clip = await asyncio.to_thread(self._clip, voice.reference)
        reply = await self._compute.call(self._peer, "tts", head)
        if reply.head.get("status") == SEND_VOICE:  # it has not heard this voice yet
            await reply.close()
            reply = await self._compute.call(self._peer, "tts", head, clip)
        try:
            async for piece in reply.pieces():
                yield piece
        finally:
            await reply.close()
