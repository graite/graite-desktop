"""What a voice session needs, checked and loaded once: models, engines, memory, priority."""

from __future__ import annotations

import asyncio
import logging
import shutil
from pathlib import Path
from typing import Any

from graite.voice.session import SendBytes, SendJson, VoiceSession
from graite.voice.tts import EngineUnavailable, TTSEngine, Voice, get_engine
from graite.voice.voices import VoiceLibrary

log = logging.getLogger("graite.voice")
HEADROOM = 2 * 1024**3
PREVIEW_IDLE = 60.0  # a sample keeps the engine loaded this long, so the next one is quick
# "Hi <name>." / "Hi there." in the languages people are most likely to set; English otherwise.
GREETINGS = {
    "en": ("Hi {name}.", "Hi there."),
    "nl": ("Hoi {name}.", "Hallo daar."),
    "de": ("Hallo {name}.", "Hallo."),
    "fr": ("Bonjour {name}.", "Bonjour."),
    "es": ("Hola {name}.", "Hola."),
    "it": ("Ciao {name}.", "Ciao."),
    "pt": ("Olá {name}.", "Olá."),
}


def greeting_text(name: str | None, language: str) -> str:
    named, plain = GREETINGS.get(language, GREETINGS["en"])
    return named.format(name=name.strip()) if name and name.strip() else plain


class Busy(ValueError):
    pass


class VoiceRuntime:
    def __init__(self, state: Any) -> None:
        self.state = state
        self.session: VoiceSession | None = None
        self._stt: Any = None
        self._tts: TTSEngine | None = None
        self._release: Any = None
        self.voices = VoiceLibrary(state.settings.app_dir)
        self._preview: TTSEngine | None = None
        self._preview_timer: asyncio.Task[None] | None = None

    # ----------------------------------------------------------------- readiness

    def _installed(self, role: str) -> Any:
        return next(
            (
                m
                for m in self.state.downloads.items.values()
                if m.role == role and m.status == "installed"
            ),
            None,
        )

    def _model_path(self, role: str) -> Path | None:
        item = self._installed(role)
        return self.state.downloads.target(item) if item else None

    def status(self) -> dict[str, Any]:
        from graite.models.config import load_config

        config = load_config(self.state.db)
        missing: list[dict[str, str]] = []

        def need(ok: bool, key: str, text: str) -> None:
            if not ok:
                missing.append({"key": key, "text": text})

        need(self.state.definitions.assistant() is not None, "assistant", "Set up your assistant.")
        need(
            bool(config.model_path if config.provider == "local" else config.model),
            "chat",
            "Choose a chat model.",
        )
        need(self._installed("vad") is not None, "vad", "Download the voice activity model.")
        need(self._installed("turn") is not None, "turn", "Download the Smart Turn model.")
        need(self._installed("speech") is not None, "speech", "Download the Whisper speech model.")
        whisper = Path(config.whisper_binary_path or shutil.which("whisper-server") or "")
        need(whisper.is_file(), "whisper_engine", "Set the whisper-server engine.")
        need(self._installed("tts") is not None, "tts", "Download the Chatterbox voice model.")
        from graite.voice.engines.crispasr import resolve_binary

        need(
            resolve_binary(config.tts_binary_path) is not None,
            "tts_engine",
            "Install the voice engine.",
        )
        return {"ready": not missing, "missing": missing, "active": self.session is not None}

    def _check_memory(self, config: Any, tts: TTSEngine) -> None:
        import psutil

        needed = tts.memory_bytes() + HEADROOM
        speech = self._model_path("speech")
        if speech is not None and speech.is_file():
            needed += int(speech.stat().st_size * 1.3)
        manager = self.state.models
        if config.provider == "local" and manager.loaded != config and config.model_path:
            try:
                needed += int(Path(config.model_path).stat().st_size * 1.2)
            except OSError:
                pass
        available = psutil.virtual_memory().available
        if available < needed:
            raise ValueError(
                "Not enough free memory to keep the chat model, speech recognition and the "
                f"voice loaded together (needs about {needed / 1024**3:.0f} GB, "
                f"{available / 1024**3:.0f} GB free). Close other apps or pick a smaller model."
            )

    # ----------------------------------------------------------------- engines (tests swap these)

    def make_vad(self) -> Any:
        from graite.voice.vad import SileroVAD

        path = self._model_path("vad")
        if path is None:
            raise EngineUnavailable("Download the voice activity model first.")
        return SileroVAD(path)

    def make_turn_model(self) -> Any:
        from graite.voice.turn import SmartTurn

        path = self._model_path("turn")
        if path is None:
            raise EngineUnavailable("Download the Smart Turn model first.")
        return SmartTurn(path)

    def make_stt(self, config: Any) -> Any:
        from graite.models.speech import SpeechServer

        path = self._model_path("speech")
        if path is None:
            raise EngineUnavailable("Download the Whisper speech model first.")
        return SpeechServer(str(path), config.whisper_binary_path)

    def make_tts(self, config: Any) -> TTSEngine:
        return get_engine(config, self.state.downloads)

    # ----------------------------------------------------------------- sessions

    def voice_for(self, definition: Any) -> tuple[Voice, bool]:
        """The assistant's voice settings, and whether the language follows the speaker."""
        settings = dict(definition.voice or {}) if definition is not None else {}
        language = str(settings.get("language") or "auto")
        reference = self.voices.path(settings.get("voice_id"))
        name = settings.get("reference")  # older definitions: a clip with the memory page
        if reference is None and name and settings.get("consent_at") and definition.memory:
            try:
                candidate = self.state.fileops.attachment_path(definition.memory, str(name))
                reference = candidate if candidate.is_file() else None
            except (FileNotFoundError, ValueError):
                reference = None
        voice = Voice(
            "en" if language == "auto" else language,
            reference,
            float(settings.get("exaggeration", 0.5)),
            float(settings.get("cfg", 0.5)),
        )
        return voice, language == "auto"

    async def _greeting(self, tts: TTSEngine, definition: Any, voice: Voice) -> tuple[str, bytes]:
        """The assistant's first words, synthesized once per voice and kept: the second time
        they are there before the engine has finished loading."""
        import hashlib

        text = greeting_text(definition.user_name, voice.language)
        stamp = ""
        if voice.reference is not None:
            try:
                stat = voice.reference.stat()
                stamp = f"{voice.reference}:{stat.st_size}:{stat.st_mtime_ns}"
            except OSError:
                stamp = str(voice.reference)
        key = "|".join(
            [tts.name, text, voice.language, stamp, f"{voice.exaggeration:.2f}", f"{voice.cfg:.2f}"]
        )
        folder = self.state.settings.app_dir / "cache" / "voice"
        cached = folder / f"greeting-{hashlib.sha256(key.encode()).hexdigest()[:16]}.pcm"
        try:
            if await asyncio.to_thread(cached.is_file):
                return text, await asyncio.to_thread(cached.read_bytes)
        except OSError:
            pass
        chunks = [chunk async for chunk in tts.synthesize(text, voice)]
        pcm = b"".join(chunks)

        def keep() -> None:
            folder.mkdir(parents=True, exist_ok=True)
            cached.write_bytes(pcm)

        try:
            await asyncio.to_thread(keep)
        except OSError:
            pass
        return text, pcm

    async def open(
        self,
        conversation_id: str,
        send_json: SendJson,
        send_bytes: SendBytes,
        *,
        barge_in: bool = True,
    ) -> VoiceSession:
        from graite.models.config import load_config
        from graite.voice.turn import TurnAnalyzer

        if self.session is not None:
            raise Busy("A voice conversation is already running.")
        state = self.state
        definition = state.definitions.assistant()
        if definition is None:
            raise ValueError("Set up your assistant first.")
        config = load_config(state.db)
        vad = await asyncio.to_thread(self.make_vad)
        analyzer = TurnAnalyzer(await asyncio.to_thread(self.make_turn_model))
        stt = self.make_stt(config)
        tts = self.make_tts(config)
        await asyncio.to_thread(self._check_memory, config, tts)
        voice, auto_language = self.voice_for(definition)
        session = VoiceSession(
            state,
            conversation_id,
            vad=vad,
            analyzer=analyzer,
            stt=stt,
            tts=tts,
            voice=voice,
            send_json=send_json,
            send_bytes=send_bytes,
            barge_in=barge_in,
            auto_language=auto_language,
        )
        self.session = session  # claimed before the slow part, so a second client is refused
        gate = state.foreground.hold()
        try:
            await gate.__aenter__()
            self._release = gate
            state.models.pinned = True
            await send_json({"type": "state", "state": "loading"})
            self._stt, self._tts = stt, tts
            await self._drop_preview()
            await asyncio.gather(stt.start(), tts.load(), self._warm_chat(config))
            # Saying hello also makes the engine encode a cloned voice before the first answer.
            greeting = await self._greeting(tts, definition, voice)
            await session.start(greeting)
        except BaseException:
            await self.close()
            raise
        return session

    async def open_test(self, send_json: SendJson, send_bytes: SendBytes) -> VoiceSession:
        """The test bench: microphone → VAD → Smart Turn → Whisper, and nothing behind it. No
        assistant, chat model or voice engine is needed, so it also works on a half set-up
        install."""
        from graite.models.config import load_config
        from graite.voice.turn import TurnAnalyzer

        if self.session is not None:
            raise Busy("A voice conversation is already running.")
        config = load_config(self.state.db)
        vad = await asyncio.to_thread(self.make_vad)
        analyzer = TurnAnalyzer(await asyncio.to_thread(self.make_turn_model))
        stt = self.make_stt(config)
        session = VoiceSession(
            self.state,
            "",
            vad=vad,
            analyzer=analyzer,
            stt=stt,
            tts=None,
            voice=Voice(),
            send_json=send_json,
            send_bytes=send_bytes,
            mode="test",
        )
        self.session = session
        try:
            await send_json({"type": "state", "state": "loading"})
            self._stt = stt
            await stt.start()
            await session.start()
        except BaseException:
            await self.close()
            raise
        return session

    # ----------------------------------------------------------------- samples

    async def sample_engine(self, config: Any) -> TTSEngine:
        """A loaded engine for "hear a sample". It stays loaded for a minute, so trying a few
        sentences or voices in a row does not pay the start-up every time."""
        if self._preview is None:
            engine = self.make_tts(config)
            await engine.load()
            self._preview = engine
        if self._preview_timer is not None:
            self._preview_timer.cancel()
        self._preview_timer = asyncio.create_task(self._expire_preview())
        return self._preview

    async def _expire_preview(self) -> None:
        await asyncio.sleep(PREVIEW_IDLE)
        self._preview_timer = None
        await self._drop_preview()

    async def _drop_preview(self) -> None:
        timer, self._preview_timer = self._preview_timer, None
        if timer is not None and timer is not asyncio.current_task():
            timer.cancel()
        engine, self._preview = self._preview, None
        if engine is not None:
            try:
                await engine.unload()
            except Exception:  # noqa: BLE001
                log.exception("stopping the sample engine failed")

    async def _warm_chat(self, config: Any) -> None:
        if config.provider == "local":
            async with self.state.models.use(config):
                pass

    async def close(self) -> None:
        session, self.session = self.session, None
        if session is not None:
            await session.close()
        stt, tts, self._stt, self._tts = self._stt, self._tts, None, None
        for stop in ([stt.stop] if stt else []) + ([tts.unload] if tts else []):
            try:
                await stop()
            except Exception:  # noqa: BLE001
                log.exception("stopping a voice engine failed")
        if self._release is not None:
            self.state.models.pinned = False
        release, self._release = self._release, None
        if release is not None:
            await release.__aexit__(None, None, None)

    async def stop(self) -> None:
        await self.close()
        await self._drop_preview()
