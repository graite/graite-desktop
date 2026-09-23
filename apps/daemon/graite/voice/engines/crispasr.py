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
import secrets
import shutil
import socket
import tempfile
from collections.abc import AsyncIterator
from pathlib import Path
from typing import Any

import httpx

from graite.models.engines import get_installer, library_env
from graite.proc import NO_WINDOW
from graite.voice.tts import EngineUnavailable, Voice

T3_SUFFIX = "-t3-"
S3GEN_SUFFIX = "-s3gen-"
CONSENT = (
    "The user confirmed in Graite that this is their own voice or that they have the "
    "speaker's permission."
)
MARKING = (
    "The user knows this audio is AI-generated; it is played only to them by their own assistant."
)


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

    def __init__(self, binary: Path, t3: Path, s3gen: Path) -> None:
        self.binary = binary
        self.t3 = t3
        self.s3gen = s3gen
        self.process: asyncio.subprocess.Process | None = None
        self._directory: tempfile.TemporaryDirectory[str] | None = None
        self._url = ""
        self._key = ""
        self._voices: dict[Path, str] = {}

    @classmethod
    def from_settings(cls, config: Any, downloads: Any) -> CrispasrEngine:
        binary = resolve_binary(str(getattr(config, "tts_binary_path", "") or ""))
        if binary is None:
            raise EngineUnavailable(
                "Install the voice engine in Settings → Voice to let your assistant talk."
            )
        item = next(
            (m for m in downloads.items.values() if m.role == "tts" and m.status == "installed"),
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
        with socket.socket() as sock:
            sock.bind(("127.0.0.1", 0))
            port = sock.getsockname()[1]
        self._key = secrets.token_hex(24)
        self._url = f"http://127.0.0.1:{port}"
        self._directory = tempfile.TemporaryDirectory(prefix="graite-voice-")
        self._voices = {}
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
                env={**library_env(self.binary), "CRISPASR_API_KEYS": self._key},
                stdout=asyncio.subprocess.DEVNULL,
                stderr=asyncio.subprocess.DEVNULL,
                creationflags=NO_WINDOW,
            )
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

    async def unload(self) -> None:
        process, self.process = self.process, None
        if process and process.returncode is None:
            process.terminate()
            try:
                await asyncio.wait_for(process.wait(), 5)
            except TimeoutError:
                process.kill()
                await process.wait()
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
        headers = {"Authorization": f"Bearer {self._key}"}
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
