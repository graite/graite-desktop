"""What a serving computer does with a call from another of the account's devices.

It runs its own local models and never touches its vault for a call: the calling device
sends everything the model needs.
"""

from __future__ import annotations

import asyncio
import contextlib
import hashlib
import json
import re
import socket
import tempfile
from collections.abc import AsyncIterator, Awaitable, Callable
from pathlib import Path
from typing import Any

import httpx

from graite.media.decode import IMAGES, audio_wav
from graite.media.ocr import recognize
from graite.models.config import load_config
from graite.models.sources import OCR_MODEL, SPEECH_MODEL
from graite.models.speech import SpeechServer, speech_binary, validate_audio
from graite.voice.tts import Voice, get_engine

NO_MODEL = "That computer has no local chat model set up. Choose one there under Settings → Chat."
NO_OCR = (
    "That computer has no model to read documents. Download it there under Settings → Documents."
)
NO_SPEECH = "That computer has no speech model. Download it there under Settings → Speech."
# Reply status of a `tts` call that names a voice clip this computer has not been sent yet.
SEND_VOICE = 428
IDLE = 600.0  # how long speech and voice stay loaded after their last call
BEAT = 20.0  # a long job says it is still at it this often, so the caller keeps waiting


class _Kept:
    """An engine this computer keeps loaded between calls, and lets go after a quiet while.
    `lock` is held for a whole call: one at a time."""

    def __init__(self, close: Callable[[Any], Awaitable[None]]) -> None:
        self.lock = asyncio.Lock()
        self._close = close
        self._engine: Any = None
        self._key: Any = None
        self._uses = 0
        self._task: asyncio.Future[None] | None = None

    async def take(self, key: Any, make: Callable[[], Any]) -> Any:
        self._uses += 1
        if self._engine is None or self._key != key:
            await self.drop()
            self._engine, self._key = make(), key
        return self._engine

    def rest(self) -> None:
        uses = self._uses

        def later() -> None:
            self._task = asyncio.ensure_future(self._idle(uses))

        asyncio.get_running_loop().call_later(IDLE, later)

    async def _idle(self, uses: int) -> None:
        async with self.lock:
            if uses == self._uses:
                await self.drop()

    async def drop(self) -> None:
        engine, self._engine = self._engine, None
        if engine is not None:
            with contextlib.suppress(Exception):
                await self._close(engine)


async def _beats(task: asyncio.Task[Any], beat: bytes) -> AsyncIterator[bytes]:
    """`beat` every so often until `task` is done; stops the task when nobody listens."""
    try:
        while not task.done():
            done, _ = await asyncio.wait({task}, timeout=BEAT)
            if not done:
                yield beat
    finally:
        if not task.done():
            task.cancel()
            with contextlib.suppress(BaseException):
                await task


def _installed(state: Any, item_id: str) -> Any:
    item = state.downloads.items.get(item_id)
    return item if item is not None and item.status == "installed" else None


def _speech_model(state: Any, config: Any) -> Any:
    item = _installed(state, SPEECH_MODEL)
    if item is None or speech_binary(config.whisper_binary_path, config.tts_binary_path) is None:
        return None
    return item


def offers(state: Any) -> dict[str, Any]:
    """What this computer can do for the account's other devices."""
    config = load_config(state.db)
    voice: dict[str, Any] | None = None
    try:
        engine = get_engine(config, state.downloads)
        voice = {
            "name": engine.name,
            "sample_rate": engine.sample_rate,
            "controls": list(engine.controls),
        }
    except ValueError:  # no voice model or engine here
        pass
    return {
        "name": socket.gethostname(),
        "chat": local_model_name(state),
        "chat_models": list(chat_models(state)),
        "ocr": _installed(state, OCR_MODEL) is not None,
        "stt": _speech_model(state, config) is not None,
        "tts": voice,
    }


def _name(path: str) -> str:
    return path.replace("\\", "/").rsplit("/", 1)[-1].removesuffix(".gguf")


def chat_models(state: Any) -> dict[str, str]:
    """The local chat models on this computer, name → file. The one it uses for its own
    chats comes first: that is what a caller gets when it names none."""
    config = load_config(state.db)
    found: dict[str, str] = {}
    if config.model_path:
        found[_name(str(config.model_path))] = str(config.model_path)
    for item in state.downloads.items.values():
        if item.role == "chat" and item.status == "installed" and item.local_path:
            found.setdefault(_name(item.local_path), item.local_path)
    return found


def local_model_name(state: Any) -> str | None:
    """The local chat model this computer answers with unless asked for another."""
    return next(iter(chat_models(state)), None)


def handlers(state: Any, transport: httpx.AsyncBaseTransport | None = None) -> dict[str, Any]:
    speech = _Kept(lambda server: server.stop())
    voice = _Kept(lambda engine: engine.unload())

    async def info(head: dict[str, Any], body: bytes) -> AsyncIterator[dict[str, Any] | bytes]:
        yield {"status": 200}
        yield json.dumps(await asyncio.to_thread(offers, state)).encode()

    async def chat(head: dict[str, Any], body: bytes) -> AsyncIterator[dict[str, Any] | bytes]:
        """An OpenAI chat-completions request, answered by one of this computer's local
        models: the one `head["model"]` names, else the one it uses itself. The reply is the
        engine's own (streamed) answer, passed on as it comes."""
        models = chat_models(state)
        if not models:
            raise ValueError(NO_MODEL)
        wanted = str(head.get("model") or "") or next(iter(models))
        if wanted not in models:
            raise ValueError(f"{wanted} is no longer on that computer. Choose another model.")
        # Whatever this computer chats with itself (it may use Graite Cloud): the call runs on
        # its own engine.
        config = load_config(state.db).model_copy(
            update={"provider": "local", "model_path": models[wanted]}
        )
        try:
            request = json.loads(body)
        except ValueError as exc:
            raise ValueError("That request could not be read.") from exc
        if not isinstance(request, dict):
            raise ValueError("That request could not be read.")
        request["model"] = "local"
        async with state.models.use(config) as provider:
            async with httpx.AsyncClient(
                timeout=httpx.Timeout(600, connect=15), transport=transport
            ) as client:
                async with client.stream(
                    "POST",
                    provider.url + "/chat/completions",
                    headers=provider.headers(),
                    json=request,
                ) as response:
                    yield {
                        "status": response.status_code,
                        "content_type": response.headers.get("content-type", ""),
                    }
                    async for piece in response.aiter_raw():
                        yield piece

    async def ocr(head: dict[str, Any], body: bytes) -> AsyncIterator[dict[str, Any] | bytes]:
        """A whole image or PDF in; lines of JSON back: `{"progress"}` while reading, then
        `{"text"}`."""
        item = _installed(state, OCR_MODEL)
        if item is None:
            raise ValueError(NO_OCR)
        suffix = str(head.get("suffix") or "").lower()
        if suffix not in IMAGES and suffix != ".pdf":
            raise ValueError("That computer can read images and PDFs only.")
        config = load_config(state.db)
        said: list[str] = []

        async def work() -> str:
            with tempfile.TemporaryDirectory(prefix="graite-shared-") as directory:
                working = Path(directory) / ("source" + suffix)
                await asyncio.to_thread(working.write_bytes, body)
                # Like reading a document of its own: the chat model makes room first.
                async with state.models.lock:
                    await state.models.server.stop()
                    state.models.loaded = None
                    files = state.downloads.parts(item)
                    return await recognize(
                        working,
                        item.local_path,
                        str(state.downloads.file_target(item, files[1])),
                        config,
                        said.append,
                    )

        yield {"status": 200}
        task = asyncio.create_task(work())
        quiet = 0.0
        try:
            while not task.done():
                await asyncio.wait({task}, timeout=0.5)
                quiet += 0.5
                if said or quiet >= BEAT:
                    quiet = 0.0
                    yield (
                        b"".join(json.dumps({"progress": m}).encode() + b"\n" for m in said)
                        or b"\n"
                    )
                said.clear()
        finally:
            if not task.done():
                task.cancel()
                with contextlib.suppress(BaseException):
                    await task
        yield json.dumps({"text": task.result()}).encode() + b"\n"

    async def stt(head: dict[str, Any], body: bytes) -> AsyncIterator[dict[str, Any] | bytes]:
        """A recording in (WAV, or any format this computer can decode); what Whisper heard
        back, as one JSON value."""
        config = load_config(state.db)
        item = await asyncio.to_thread(_speech_model, state, config)
        if item is None:
            raise ValueError(NO_SPEECH)
        limit = 300 if head.get("live") else 3600
        language = str(head.get("language") or "auto")[:8]
        kind = re.sub(r"[^a-z0-9]", "", str(head.get("format") or "wav").lower())[:8]

        async def work() -> dict[str, Any]:
            audio = body
            if kind != "wav":
                with tempfile.TemporaryDirectory(prefix="graite-shared-") as directory:
                    working = Path(directory) / ("recording." + kind)
                    await asyncio.to_thread(working.write_bytes, body)
                    audio = await asyncio.to_thread(audio_wav, working)
            validate_audio(audio, limit)
            key = (item.local_path, config.whisper_binary_path, config.tts_binary_path)
            async with speech.lock:
                server = await speech.take(
                    key,
                    lambda: SpeechServer(
                        item.local_path, config.whisper_binary_path, config.tts_binary_path
                    ),
                )
                try:
                    await server.start()
                    return dict(
                        await server.transcribe(audio, language=language, max_seconds=limit)
                    )
                except httpx.HTTPError as exc:
                    await speech.drop()
                    raise ValueError("That computer could not transcribe this.") from exc
                finally:
                    speech.rest()

        yield {"status": 200}
        task = asyncio.create_task(work())
        async for beat in _beats(task, b" "):
            yield beat
        yield json.dumps(task.result()).encode()

    async def tts(head: dict[str, Any], body: bytes) -> AsyncIterator[dict[str, Any] | bytes]:
        """Text in; PCM16 mono back as it is spoken. A voice to clone is named by the hash of
        its clip, and sent along only when this computer does not have it yet. `warm` only
        loads the engine."""
        config = load_config(state.db)
        reference: Path | None = None
        clip = str(head.get("voice") or "")
        if clip:
            if not re.fullmatch(r"[0-9a-f]{64}", clip):
                raise ValueError("That request could not be read.")
            reference = state.settings.app_dir / "cache" / "voice" / f"shared-{clip}.wav"
            if body:
                if hashlib.sha256(body).hexdigest() != clip:
                    raise ValueError("That request could not be read.")

                def keep(target: Path = reference) -> None:
                    target.parent.mkdir(parents=True, exist_ok=True)
                    target.write_bytes(body)

                await asyncio.to_thread(keep)
            elif not await asyncio.to_thread(reference.is_file):
                yield {"status": SEND_VOICE}
                return
        async with voice.lock:
            key = (config.tts_model, config.tts_binary_path, config.binary_path)
            engine = await voice.take(key, lambda: get_engine(config, state.downloads))
            try:
                await engine.load()
                yield {
                    "status": 200,
                    "name": engine.name,
                    "sample_rate": engine.sample_rate,
                    "controls": list(engine.controls),
                }
                if head.get("warm"):
                    return
                how = Voice(
                    str(head.get("language") or "en")[:8],
                    reference,
                    float(head.get("exaggeration", 0.5)),
                    float(head.get("cfg", 0.5)),
                    float(head.get("speed", 1.0)),
                )
                async for chunk in engine.synthesize(str(head.get("text") or "")[:8000], how):
                    yield chunk
            finally:
                voice.rest()

    async def close() -> None:
        for kept in (speech, voice):
            async with kept.lock:
                await kept.drop()

    state.compute_close = close
    return {"info": info, "chat": chat, "ocr": ocr, "stt": stt, "tts": tts}
