"""Chatterbox Multilingual on GGML, through an owned `crispasr --server` process.

Same shape as the whisper.cpp engine (`models/speech.py`): a native binary the user points
Graite at, started on a loopback port with a generated key, stopped when the session ends.
The two GGUF files (T3 speech-token model, S3Gen decoder + vocoder) come from the catalog.

Cloning: the chatterbox backend resolves `voice` as a bare file name in the process's working
directory, so the engine runs inside a private folder holding the prepared reference clip.
The engine always watermarks its output; the spoken AI notice it would put in front of every
cloned sentence is turned off for a conversation with one's own assistant, which the engine
only accepts together with the two attestations below. They restate what the user confirmed
when they added the voice (api/voice.py).
"""

from __future__ import annotations

import asyncio
import logging
import secrets
import shutil
import socket
import sys
import tempfile
from collections import deque
from collections.abc import AsyncIterator
from pathlib import Path
from typing import Any

import httpx

from graite.models.engines import get_installer, library_env
from graite.proc import NO_WINDOW
from graite.voice.tts import EngineCrashed, EngineUnavailable, Voice

log = logging.getLogger("graite.voice")

T3_SUFFIX = "-t3-"
S3GEN_SUFFIX = "-s3gen-"
CONSENT = (
    "The user confirmed in Graite that this is their own voice or that they have the "
    "speaker's permission."
)
MARKING = (
    "The user knows this audio is AI-generated; it is played only to them by their own assistant."
)

# CrispASR caches its per-token decode graphs in "buckets", and on CUDA those crash the process
# ("illegal memory access", reproduced with v0.8.33) as soon as a short sentence follows a long
# one, which is every longer answer. The engine skips that cache while a debug dump is
# requested, so we ask for one at a step it never reaches: same audio, no slower on CUDA
# (measured), no crash.
# Not on macOS: Metal takes a different path through that code and the cache is what makes it
# fast there. Remove once the pinned engine version is shown not to need it.
STABLE_DECODE = (
    {} if sys.platform == "darwin" else {"CRISPASR_CHATTERBOX_DUMP_LOGITS_AT": "999999999"}
)

# A few words on their own ("Hi Sam.", "Sure.") give the model too little text to hold on to.
# Measured on 2026-11-23 with v0.8.54, six seeds each: at a guidance of 0.15 "Hi Sam." came out
# as up to three seconds of invented syllables twice and lost its first sound once more; at 0.5
# every take was the two words. Sentences showed no such difference. So short texts get at
# least that much guidance, and a take that runs far past what its text can need is made again
# with another seed (the engine's own seed is fixed, so the same request repeats the same take).
SHORT_CHARS = 24
SHORT_GUIDANCE = 0.5
SHORT_ATTEMPTS = 3
PIECE = 32 * 1024


def runs_on(text: str, pcm: bytes, rate: int) -> bool:
    """Whether a short text's audio is longer than those words can take. Good takes of 7 to 10
    characters measured 0.8 to 1.25 s including the engine's closing silence; runaways 1.6 s
    and up."""
    return len(pcm) / 2 / rate > 0.9 + 0.06 * len(text)


def resolve_binary(custom_path: str) -> Path | None:
    """The user's own build (Advanced), else the installed voice engine, else `PATH`."""
    installer = get_installer()
    if installer is not None:
        return installer.resolve("crispasr", custom_path)
    found = Path(custom_path or shutil.which("crispasr") or "").expanduser()
    return found if found.is_file() else None


class CrispasrEngine:
    name = "chatterbox-ggml"
    sample_rate = 24000
    controls: tuple[str, ...] = ("exaggeration", "cfg")

    def __init__(self, binary: Path, t3: Path, s3gen: Path) -> None:
        self.binary = binary
        self.t3 = t3
        self.s3gen = s3gen
        self.process: asyncio.subprocess.Process | None = None
        self._directory: tempfile.TemporaryDirectory[str] | None = None
        self._url = ""
        self._key = ""
        self._voices: dict[Path, str] = {}
        # The engine's last words. It writes a line per decoding step, so only the tail is
        # kept; it is logged when the process dies, which is the only time anyone needs it.
        self._stderr: deque[str] = deque(maxlen=40)
        self._reader: asyncio.Task[None] | None = None

    @classmethod
    def from_settings(cls, config: Any, downloads: Any, item: Any = None) -> CrispasrEngine:
        binary = resolve_binary(str(getattr(config, "tts_binary_path", "") or ""))
        if binary is None:
            raise EngineUnavailable(
                "Install the voice engine in Settings → Voice to let your assistant talk."
            )
        if item is None:
            item = next(
                (
                    m
                    for m in downloads.items.values()
                    if m.role == "tts" and m.status == "installed"
                ),
                None,
            )
        if item is None:
            raise EngineUnavailable("Download the voice model under Settings → Voice first.")
        folder = downloads.target(item).parent
        names = [f.filename for f in item.files] or [item.filename]
        t3 = next((folder / n for n in names if T3_SUFFIX in n), None)
        s3gen = next((folder / n for n in names if S3GEN_SUFFIX in n), None)
        if t3 is None or s3gen is None or not t3.is_file() or not s3gen.is_file():
            raise EngineUnavailable("The voice model is incomplete. Download it again.")
        return cls(binary, t3, s3gen)

    def memory_bytes(self) -> int:
        return int((self.t3.stat().st_size + self.s3gen.stat().st_size) * 1.3)

    @property
    def running(self) -> bool:
        return self.process is not None and self.process.returncode is None

    async def load(self) -> None:
        if self.running:
            return
        await self.unload()  # a crashed engine leaves its folder and reader behind
        with socket.socket() as sock:
            sock.bind(("127.0.0.1", 0))
            port = sock.getsockname()[1]
        self._key = secrets.token_hex(24)
        self._url = f"http://127.0.0.1:{port}"
        self._directory = tempfile.TemporaryDirectory(prefix="graite-voice-")
        self._voices = {}
        self._stderr.clear()
        try:
            self.process = await asyncio.create_subprocess_exec(
                str(self.binary.resolve()),
                "--server",
                "--backend",
                "chatterbox",
                "-m",
                str(self.t3),
                "--codec-model",
                str(self.s3gen),
                "--host",
                "127.0.0.1",
                "--port",
                str(port),
                cwd=self._directory.name,
                env={**library_env(self.binary), **STABLE_DECODE, "CRISPASR_API_KEYS": self._key},
                stdout=asyncio.subprocess.DEVNULL,
                stderr=asyncio.subprocess.PIPE,
                creationflags=NO_WINDOW,
            )
            self._reader = asyncio.create_task(self._read_stderr(self.process))
            async with httpx.AsyncClient(timeout=3) as client:
                for _ in range(240):
                    if self.process.returncode is not None:
                        raise EngineUnavailable(
                            "The speech engine could not start. Check the engine path and "
                            "available memory."
                        )
                    try:
                        if (await client.get(self._url + "/health")).status_code == 200:
                            return
                    except httpx.HTTPError:
                        pass
                    await asyncio.sleep(0.5)
            raise EngineUnavailable("The speech engine took too long to load.")
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
            # A crash closes the connection a moment before the process is reaped.
            await asyncio.wait_for(asyncio.shield(process.wait()), 5)
        except TimeoutError:
            return False
        if self._reader is not None:
            await asyncio.gather(self._reader, return_exceptions=True)
        tail = [line for line in self._stderr if line.strip()][-12:]
        log.error(
            "the speech engine exited with code %s; its last output:\n%s",
            process.returncode,
            "\n".join(tail) or "(none)",
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
        if self._directory is not None:
            await asyncio.to_thread(self._directory.cleanup)
            self._directory = None

    async def _voice_name(self, reference: Path) -> str:
        """Link the prepared clip into the engine's folder under a name it accepts."""
        name = self._voices.get(reference)
        if name is None:
            assert self._directory is not None
            name = f"voice{len(self._voices)}.wav"
            await asyncio.to_thread(shutil.copyfile, reference, Path(self._directory.name) / name)
            self._voices[reference] = name
        return name

    async def synthesize(self, text: str, voice: Voice) -> AsyncIterator[bytes]:
        if not self.running:
            await self.load()
        body: dict[str, Any] = {
            "input": text,
            "language": voice.language,
            "response_format": "pcm",
            "stream": True,
            "exaggeration": voice.exaggeration,
            "cfg_scale": voice.cfg,
        }
        if voice.reference is not None:
            body |= {
                "voice": await self._voice_name(voice.reference),
                "consent_attestation": CONSENT,
                "spoken_disclaimer": False,
                "marking_attestation": MARKING,
            }
        if len(text) >= SHORT_CHARS:
            async for chunk in self._stream(body):
                yield chunk
            return
        # The engine sends a sentence only once it is whole, so holding a short one back to
        # look at it costs no time.
        body["cfg_scale"] = max(voice.cfg, SHORT_GUIDANCE)
        best = b""
        for attempt in range(SHORT_ATTEMPTS):
            if attempt:
                body["seed"] = attempt
            pcm = b"".join([chunk async for chunk in self._stream(body)])
            if pcm and (not best or len(pcm) < len(best)):
                best = pcm
            if pcm and not runs_on(text, pcm, self.sample_rate):
                break
            log.info(
                "a short sentence (%d characters) came out as %.1f s; trying another take",
                len(text),
                len(pcm) / 2 / self.sample_rate,
            )
        for start in range(0, len(best), PIECE):
            yield best[start : start + PIECE]

    async def _stream(self, body: dict[str, Any]) -> AsyncIterator[bytes]:
        headers = {"Authorization": f"Bearer {self._key}"}
        try:
            async for chunk in self._request(body, headers):
                yield chunk
        except httpx.HTTPError as exc:
            if await self._died():
                raise EngineCrashed("The speech engine stopped unexpectedly.") from exc
            raise

    def stamp(self) -> str:
        """Which engine build and model this is: audio kept from another one is not reused."""
        parts = []
        for file in (self.binary, self.t3, self.s3gen):
            try:
                stat = file.stat()
                parts.append(f"{file.name}:{stat.st_size}:{stat.st_mtime_ns}")
            except OSError:
                parts.append(file.name)
        return "|".join(parts)

    async def _request(self, body: dict[str, Any], headers: dict[str, str]) -> AsyncIterator[bytes]:
        async with httpx.AsyncClient(timeout=httpx.Timeout(120, connect=5)) as client:
            async with client.stream(
                "POST", self._url + "/v1/audio/speech", json=body, headers=headers
            ) as response:
                if response.status_code != 200:
                    detail = (await response.aread()).decode("utf-8", "ignore")[:300]
                    raise ValueError(f"The speech engine refused the request: {detail}")
                rest = b""
                async for chunk in response.aiter_bytes():
                    data = rest + chunk
                    cut = len(data) - len(data) % 2
                    rest = data[cut:]
                    if cut:
                        yield data[:cut]
