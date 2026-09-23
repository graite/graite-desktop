"""Short, local speech checks using an owned whisper.cpp process."""

from __future__ import annotations

import asyncio
import io
import re
import secrets
import shutil
import socket
import tempfile
import time
import wave
from pathlib import Path

import httpx

from graite.proc import NO_WINDOW


def readable_transcript(text: str) -> str:
    """Insert reading breaks without inventing content or changing word order."""
    paragraphs = []
    for paragraph in re.split(r"\n\s*\n", text.strip()):
        line: list[str] = []
        for word in paragraph.split():
            line.append(word)
            if (len(line) >= 45 and re.search(r"[.!?][\"'”’)]?$", word)) or len(line) >= 85:
                paragraphs.append(" ".join(line))
                line = []
        if line:
            paragraphs.append(" ".join(line))
    return "\n\n".join(paragraphs)


def validate_audio(audio: bytes, max_seconds: int = 300) -> None:
    try:
        with wave.open(io.BytesIO(audio)) as wav:
            if wav.getsampwidth() != 2 or wav.getnchannels() not in (1, 2):
                raise ValueError("Use a 16-bit mono or stereo WAV recording.")
            if (
                not wav.getframerate()
                or not 0 < wav.getnframes() / wav.getframerate() <= max_seconds
            ):
                raise ValueError("Use a WAV recording of up to five minutes.")
    except (wave.Error, EOFError) as exc:
        raise ValueError("Use a 16-bit PCM WAV recording for this speech check.") from exc


# whisper.cpp reports the detected language by its English name; the TTS wants the code.
LANGUAGE_CODES = {
    "arabic": "ar", "danish": "da", "german": "de", "greek": "el", "english": "en",
    "spanish": "es", "finnish": "fi", "french": "fr", "hebrew": "he", "hindi": "hi",
    "italian": "it", "japanese": "ja", "korean": "ko", "malay": "ms", "dutch": "nl",
    "norwegian": "no", "polish": "pl", "portuguese": "pt", "russian": "ru", "swedish": "sv",
    "swahili": "sw", "turkish": "tr", "chinese": "zh",
}  # fmt: skip


def language_code(value: object) -> str | None:
    name = str(value or "").strip().lower()
    if name in LANGUAGE_CODES.values():
        return name
    return LANGUAGE_CODES.get(name)


def pcm_to_wav(pcm: bytes, sample_rate: int = 16000) -> bytes:
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(sample_rate)
        wav.writeframes(pcm)
    return buffer.getvalue()


class SpeechServer:
    """An owned `whisper-server` process on a loopback port behind a secret path prefix.

    One-off jobs start it, transcribe and stop it (`transcribe` below). A voice session keeps
    it running so every turn costs only the inference.
    """

    def __init__(self, model: str, binary_path: str) -> None:
        self.model = model
        self.binary_path = binary_path
        self.process: asyncio.subprocess.Process | None = None
        self._directory: tempfile.TemporaryDirectory[str] | None = None
        self._base = ""

    @property
    def running(self) -> bool:
        return self.process is not None and self.process.returncode is None

    async def start(self) -> None:
        if self.running:
            return
        binary = await asyncio.to_thread(
            Path(self.binary_path or shutil.which("whisper-server") or "").expanduser
        )
        if not binary.is_file():
            raise ValueError("Set the whisper-server executable under Advanced settings and save.")
        model_file = Path(self.model)
        if not await asyncio.to_thread(model_file.is_file):
            raise ValueError("Download the speech model first.")
        with socket.socket() as sock:
            sock.bind(("127.0.0.1", 0))
            port = sock.getsockname()[1]
        prefix = "/" + secrets.token_hex(24)
        self._base = f"http://127.0.0.1:{port}{prefix}"
        self._directory = tempfile.TemporaryDirectory(prefix="graite-speech-")
        directory = self._directory.name
        try:
            self.process = await asyncio.create_subprocess_exec(
                str(binary.resolve()),
                "-m",
                str(await asyncio.to_thread(model_file.resolve)),
                "--host",
                "127.0.0.1",
                "--port",
                str(port),
                "--request-path",
                prefix,
                "--public",
                directory,
                "--tmp-dir",
                directory,
                "-l",
                "auto",
                cwd=directory,
                stdout=asyncio.subprocess.DEVNULL,
                stderr=asyncio.subprocess.DEVNULL,
                creationflags=NO_WINDOW,
            )
            async with httpx.AsyncClient(timeout=3) as client:
                for _ in range(120):
                    if self.process.returncode is not None:
                        raise ValueError(
                            "Speech model could not load. Check the engine and available memory."
                        )
                    try:
                        response = await client.get(self._base + "/health")
                        if response.status_code == 200:
                            return
                    except httpx.HTTPError:
                        pass
                    await asyncio.sleep(0.5)
            raise ValueError("Speech model loading timed out.")
        except BaseException:
            await self.stop()
            raise

    async def transcribe(
        self, audio: bytes, *, language: str = "auto", max_seconds: int = 300
    ) -> dict[str, str | float | None]:
        """WAV bytes in; the text, the detected language code (if known), the time, and how
        confident Whisper was."""
        start = time.monotonic()
        async with httpx.AsyncClient(timeout=max(300, max_seconds * 2)) as client:
            response = await client.post(
                self._base + "/inference",
                files={"file": ("recording.wav", audio, "audio/wav")},
                data={"response_format": "verbose_json", "language": language},
            )
            response.raise_for_status()
            data = response.json()
        scores = [
            float(segment["avg_logprob"])
            for segment in data.get("segments") or []
            if isinstance(segment, dict) and isinstance(segment.get("avg_logprob"), int | float)
        ]
        return {
            "text": str(data.get("text", "")).strip(),
            "language": language_code(data.get("language")),
            "seconds": round(time.monotonic() - start, 2),
            # How sure Whisper was of its words (mean token log-probability of its least sure
            # segment): clear speech is around -0.1, words imagined into noise well below -0.5.
            "confidence": min(scores) if scores else None,
        }

    async def stop(self) -> None:
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


async def transcribe(
    audio: bytes, model: str, binary_path: str, *, max_seconds: int = 300
) -> dict[str, str | float]:
    validate_audio(audio, max_seconds)
    server = SpeechServer(model, binary_path)
    start = time.monotonic()
    try:
        await server.start()
        result = await server.transcribe(audio, max_seconds=max_seconds)
        return {"text": str(result["text"]), "seconds": round(time.monotonic() - start, 2)}
    finally:
        await server.stop()
