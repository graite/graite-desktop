"""Speech to text on this computer, through an owned Whisper server process.

Two engines speak the same `/inference` API: Graite's installed voice engine (`crispasr`, run
with its whisper backend, so nobody has to install whisper.cpp by hand) and a `whisper-server`
the user points Graite at under Settings → Speech (geek mode). `speech_binary` picks one.
"""

from __future__ import annotations

import asyncio
import io
import math
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

NOT_FOUND = (
    "Install the voice engine under Settings → Speech to turn speech into text on this computer."
)


def speech_binary(configured: str = "", tts_configured: str = "") -> Path | None:
    """The executable that runs Whisper: the user's own `whisper-server` when one is set, else
    Graite's installed voice engine, else a `whisper-server` on `PATH`."""
    if configured.strip():
        own = Path(configured).expanduser()
        return own if own.is_file() else None
    from graite.models.engines import get_installer

    installer = get_installer()
    if installer is not None:
        found = installer.resolve("crispasr", tts_configured)
        if found is not None:
            return found
    elif tts_configured.strip() and Path(tts_configured).expanduser().is_file():
        return Path(tts_configured).expanduser()
    on_path = shutil.which("whisper-server")
    return Path(on_path) if on_path else None


def is_crispasr(binary: Path) -> bool:
    return binary.name.lower().removesuffix(".exe") == "crispasr"


def segment_confidence(data: dict[str, object]) -> float | None:
    """Whisper's certainty about its least sure segment, as a mean token log-probability.

    whisper-server reports `avg_logprob` per segment; the voice engine reports per-token
    probabilities instead, which give the same number.
    """
    scores: list[float] = []
    for segment in data.get("segments") or []:  # type: ignore[attr-defined]
        if not isinstance(segment, dict):
            continue
        if isinstance(segment.get("avg_logprob"), int | float):
            scores.append(float(segment["avg_logprob"]))
            continue
        probabilities = [
            float(token["confidence"])
            for token in segment.get("tokens") or []
            if isinstance(token, dict) and isinstance(token.get("confidence"), int | float)
        ]
        if probabilities:
            logs = [math.log(max(p, 1e-6)) for p in probabilities]
            scores.append(sum(logs) / len(logs))
    return min(scores) if scores else None


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
    """An owned Whisper server on a loopback port, behind a secret path prefix
    (`whisper-server`) or a generated API key (the voice engine).

    One-off jobs start it, transcribe and stop it (`transcribe` below). A voice session keeps
    it running so every turn costs only the inference.
    """

    def __init__(self, model: str, binary_path: str = "", engine_path: str = "") -> None:
        self.model = model
        self.binary_path = binary_path
        self.engine_path = engine_path
        self._key = ""
        self.process: asyncio.subprocess.Process | None = None
        self._directory: tempfile.TemporaryDirectory[str] | None = None
        self._base = ""

    @property
    def running(self) -> bool:
        return self.process is not None and self.process.returncode is None

    async def start(self) -> None:
        if self.running:
            return
        binary = await asyncio.to_thread(speech_binary, self.binary_path, self.engine_path)
        if binary is None:
            raise ValueError(NOT_FOUND)
        model_file = Path(self.model)
        if not await asyncio.to_thread(model_file.is_file):
            raise ValueError("Download the speech model first.")
        with socket.socket() as sock:
            sock.bind(("127.0.0.1", 0))
            port = sock.getsockname()[1]
        self._directory = tempfile.TemporaryDirectory(prefix="graite-speech-")
        directory = self._directory.name
        model = str(await asyncio.to_thread(model_file.resolve))
        env = None
        if is_crispasr(binary):
            # The voice engine has no path prefix; a generated key keeps other local programs out.
            self._key = secrets.token_hex(24)
            self._base = f"http://127.0.0.1:{port}"
            args = [
                "--server", "--backend", "whisper", "-m", model, "--host", "127.0.0.1",
                "--port", str(port), "--api-keys", self._key, "-l", "auto",
            ]  # fmt: skip
            from graite.models.engines import library_env

            env = library_env(binary)
        else:
            prefix = "/" + secrets.token_hex(24)
            self._base = f"http://127.0.0.1:{port}{prefix}"
            args = [
                "-m", model, "--host", "127.0.0.1", "--port", str(port),
                "--request-path", prefix, "--public", directory, "--tmp-dir", directory,
                "-l", "auto",
            ]  # fmt: skip
        try:
            self.process = await asyncio.create_subprocess_exec(
                str(binary.resolve()),
                *args,
                cwd=directory,
                env=env,
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
                        response = await client.get(self._base + "/health", headers=self._headers)
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
                headers=self._headers,
                files={"file": ("recording.wav", audio, "audio/wav")},
                data={"response_format": "verbose_json", "language": language},
            )
            response.raise_for_status()
            data = response.json()
        confidence = segment_confidence(data)
        return {
            "text": str(data.get("text", "")).strip(),
            "language": language_code(data.get("language")),
            "seconds": round(time.monotonic() - start, 2),
            # How sure Whisper was of its words (mean token log-probability of its least sure
            # segment): clear speech is around -0.1, words imagined into noise well below -0.5.
            "confidence": confidence,
        }

    @property
    def _headers(self) -> dict[str, str]:
        return {"Authorization": f"Bearer {self._key}"} if self._key else {}

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
    audio: bytes,
    model: str,
    binary_path: str = "",
    *,
    engine_path: str = "",
    max_seconds: int = 300,
) -> dict[str, str | float]:
    validate_audio(audio, max_seconds)
    server = SpeechServer(model, binary_path, engine_path)
    start = time.monotonic()
    try:
        await server.start()
        result = await server.transcribe(audio, max_seconds=max_seconds)
        return {"text": str(result["text"]), "seconds": round(time.monotonic() - start, 2)}
    finally:
        await server.stop()


def wav_to_mp3(wav_bytes: bytes, *, bitrate: int = 64_000) -> bytes:
    """Mono 16 kHz WAV as MP3: an hour of speech is about 30 MB instead of 115."""
    import av

    output = io.BytesIO()
    with (
        av.open(io.BytesIO(wav_bytes), "r", format="wav") as source,
        av.open(output, "w", format="mp3") as target,
    ):
        stream = target.add_stream("libmp3lame", rate=16000)
        stream.bit_rate = bitrate
        stream.layout = "mono"
        for frame in source.decode(audio=0):
            frame.pts = None
            for packet in stream.encode(frame):
                target.mux(packet)
        for packet in stream.encode(None):
            target.mux(packet)
    return output.getvalue()


async def transcribe_cloud(wav_bytes: bytes) -> dict[str, str | float]:
    """A whole recording (already decoded and checked to be at most an hour) through Graite
    Cloud's Whisper. The server splits long audio itself."""
    from graite.cloud.session import get_cloud

    start = time.monotonic()
    mp3 = await asyncio.to_thread(wav_to_mp3, wav_bytes)
    body = await get_cloud().transcribe(mp3, filename="recording.mp3", mime="audio/mpeg")
    return {
        "text": str(body.get("text") or "").strip(),
        "seconds": round(time.monotonic() - start, 2),
    }


class CloudSpeech:
    """Live voice turns through Graite Cloud; the same shape as `SpeechServer`.

    Each turn is a few seconds of WAV, sent as it is. Graite Cloud does not report how sure
    Whisper was, so barge-in falls back to judging the words alone (voice/bargein.py).
    """

    running = True

    async def start(self) -> None:
        return None

    async def transcribe(
        self, audio: bytes, *, language: str = "auto", max_seconds: int = 300
    ) -> dict[str, str | float | None]:
        from graite.cloud.session import get_cloud

        start = time.monotonic()
        body = await get_cloud().transcribe(
            audio, filename="turn.wav", mime="audio/wav", purpose="voice"
        )
        return {
            "text": str(body.get("text") or "").strip(),
            "language": language_code(body.get("language")),
            "seconds": round(time.monotonic() - start, 2),
            "confidence": None,
        }

    async def stop(self) -> None:
        return None
