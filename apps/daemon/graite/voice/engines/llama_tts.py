"""ZONOS3 Mini through an owned `llama-server` process and its `POST /tts`.

The chat engine speaks too: llama.cpp runs the ZONOS3 backbone (one GGUF) with its codec,
speaker encoder and built-in voices in a second file (the "mmproj"). Same shape as the
Chatterbox engine (`engines/crispasr.py`): started on a loopback port with a generated key,
stopped when the session ends, restarted by the next request after a crash.

Audio streams out as it is generated (44.1 kHz), so the first sound of a sentence leaves long
before the sentence is finished. Cloning sends the prepared reference clip with every request;
the server encodes it into a speaker embedding (it uses up to the first 60 seconds). The
clip is only ever set for a voice the user confirmed they may use (api/voice.py).
"""

from __future__ import annotations

import asyncio
import base64
import logging
import secrets
import socket
from collections import deque
from collections.abc import AsyncIterator
from pathlib import Path
from typing import Any

import httpx

from graite.models.engines import get_installer, library_env
from graite.proc import NO_WINDOW
from graite.voice.tts import EngineCrashed, EngineUnavailable, Voice

log = logging.getLogger("graite.voice")

MMPROJ_PREFIX = "mmproj-"
# The flag that arrived with speech generation: a build without it cannot run this model.
TTS_FLAG = "--tts-voice"
OLD_ENGINE = (
    "This voice needs a newer chat engine. Update the chat engine in Settings → Chat, "
    "then try again."
)


def resolve_binary(custom_path: str) -> Path | None:
    """The user's own llama-server (Advanced), else the installed chat engine, else `PATH`."""
    import shutil

    installer = get_installer()
    if installer is not None:
        return installer.resolve("llama", custom_path)
    found = Path(custom_path or shutil.which("llama-server") or "").expanduser()
    return found if found.is_file() else None


def can_speak(binary: Path) -> bool:
    from graite.models.llama_server import supports

    return supports(str(binary), TTS_FLAG, library_env(binary))


class LlamaTtsEngine:
    name = "zonos3-llama"
    sample_rate = 44100
    controls: tuple[str, ...] = ("speed",)

    def __init__(self, binary: Path, model: Path, mmproj: Path) -> None:
        self.binary = binary
        self.model = model
        self.mmproj = mmproj
        self.process: asyncio.subprocess.Process | None = None
        self._url = ""
        self._key = ""
        self._references: dict[Path, str] = {}
        self._stderr: deque[str] = deque(maxlen=40)
        self._reader: asyncio.Task[None] | None = None

    @classmethod
    def from_item(cls, config: Any, downloads: Any, item: Any) -> LlamaTtsEngine:
        binary = resolve_binary(str(getattr(config, "binary_path", "") or ""))
        if binary is None:
            raise EngineUnavailable("Install the chat engine in Settings → Chat to use this voice.")
        if not can_speak(binary):
            raise EngineUnavailable(OLD_ENGINE)
        folder = downloads.target(item).parent
        names = [f.filename for f in item.files] or [item.filename]
        mmproj = next((folder / n for n in names if n.startswith(MMPROJ_PREFIX)), None)
        model = next((folder / n for n in names if not n.startswith(MMPROJ_PREFIX)), None)
        if model is None or mmproj is None or not model.is_file() or not mmproj.is_file():
            raise EngineUnavailable("The voice model is incomplete. Download it again.")
        return cls(binary, model, mmproj)

    def memory_bytes(self) -> int:
        return int((self.model.stat().st_size + self.mmproj.stat().st_size) * 1.3)

    @property
    def running(self) -> bool:
        return self.process is not None and self.process.returncode is None

    async def load(self) -> None:
        if self.running:
            return
        await self.unload()  # a crashed engine leaves its reader behind
        with socket.socket() as sock:
            sock.bind(("127.0.0.1", 0))
            port = sock.getsockname()[1]
        self._key = secrets.token_hex(24)
        self._url = f"http://127.0.0.1:{port}"
        self._stderr.clear()
        try:
            self.process = await asyncio.create_subprocess_exec(
                str(self.binary.resolve()),
                "-m",
                str(self.model),
                "--mmproj",
                str(self.mmproj),
                "--host",
                "127.0.0.1",
                "--port",
                str(port),
                "--api-key",
                self._key,
                "-ngl",
                "99",
                "--parallel",
                "1",
                env=library_env(self.binary),
                stdout=asyncio.subprocess.DEVNULL,
                stderr=asyncio.subprocess.PIPE,
                creationflags=NO_WINDOW,
            )
            self._reader = asyncio.create_task(self._read_stderr(self.process))
            headers = {"Authorization": f"Bearer {self._key}"}
            async with httpx.AsyncClient(timeout=3, headers=headers) as client:
                for _ in range(240):
                    if self.process.returncode is not None:
                        await self._died()
                        raise EngineUnavailable(
                            "The voice model could not start. Check that the chat engine is "
                            "up to date and that there is enough free memory."
                        )
                    try:
                        if (await client.get(self._url + "/health")).status_code == 200:
                            return
                    except httpx.HTTPError:
                        pass
                    await asyncio.sleep(0.5)
            raise EngineUnavailable("The voice model took too long to load.")
        except BaseException:
            await self.unload()
            raise

    async def _read_stderr(self, process: asyncio.subprocess.Process) -> None:
        """Drain the engine's stderr (an unread pipe would stall it) and keep the tail."""
        assert process.stderr is not None
        try:
            while line := await process.stderr.readline():
                self._stderr.append(line.decode("utf-8", "replace").rstrip())
        except ValueError:
            pass  # a line longer than the stream limit: nothing worth keeping

    async def _died(self) -> bool:
        """Whether the engine process is gone; if so, its last output goes to the log."""
        process = self.process
        if process is None:
            return True
        try:
            await asyncio.wait_for(asyncio.shield(process.wait()), 5)
        except TimeoutError:
            return False
        if self._reader is not None:
            await asyncio.gather(self._reader, return_exceptions=True)
        tail = [line.replace(self._key, "[redacted]") for line in self._stderr if line.strip()]
        log.error(
            "the voice model's engine exited with code %s; its last output:\n%s",
            process.returncode,
            "\n".join(tail[-12:]) or "(none)",
        )
        return True

    async def unload(self) -> None:
        process, self.process = self.process, None
        if process and process.returncode is None:
            process.terminate()
            try:
                await asyncio.wait_for(process.wait(), 5)
            except TimeoutError:
                process.kill()
                await process.wait()
        reader, self._reader = self._reader, None
        if reader is not None:
            reader.cancel()
            await asyncio.gather(reader, return_exceptions=True)
        self._references = {}

    async def _reference(self, clip: Path) -> str:
        encoded = self._references.get(clip)
        if encoded is None:
            encoded = base64.b64encode(await asyncio.to_thread(clip.read_bytes)).decode("ascii")
            self._references[clip] = encoded
        return encoded

    async def synthesize(self, text: str, voice: Voice) -> AsyncIterator[bytes]:
        if not self.running:
            await self.load()
        # `lang` only picks how numbers and the like are written out; the model takes the
        # language from the text itself.
        body: dict[str, Any] = {
            "input": text,
            "lang": voice.language,
            "response_format": "pcm16",
            "stream": True,
        }
        if voice.speed != 1.0:
            body["speed"] = voice.speed
        if voice.reference is not None:
            body["speaker_ref_b64"] = await self._reference(voice.reference)
        try:
            async for chunk in self._request(body):
                yield chunk
        except httpx.HTTPError as exc:
            if await self._died():
                raise EngineCrashed("The voice model's engine stopped unexpectedly.") from exc
            raise

    def stamp(self) -> str:
        """Which engine build and model this is: audio kept from another one is not reused."""
        parts = []
        for file in (self.binary, self.model, self.mmproj):
            try:
                stat = file.stat()
                parts.append(f"{file.name}:{stat.st_size}:{stat.st_mtime_ns}")
            except OSError:
                parts.append(file.name)
        return "|".join(parts)

    async def _request(self, body: dict[str, Any]) -> AsyncIterator[bytes]:
        headers = {"Authorization": f"Bearer {self._key}"}
        async with httpx.AsyncClient(timeout=httpx.Timeout(120, connect=5)) as client:
            async with client.stream(
                "POST", self._url + "/tts", json=body, headers=headers
            ) as response:
                if response.status_code != 200:
                    detail = (await response.aread()).decode("utf-8", "ignore")[:300]
                    raise ValueError(f"The voice model refused the request: {detail}")
                rest = b""
                async for chunk in response.aiter_bytes():
                    data = rest + chunk
                    cut = len(data) - len(data) % 2
                    rest = data[cut:]
                    if cut:
                        yield data[:cut]
