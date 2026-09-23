"""One live voice conversation with the assistant.

Transport-agnostic: the WebSocket route feeds it microphone bytes and control messages and
gives it two callables to send JSON events and audio back. States:

    listening -> transcribing -> thinking -> speaking -> listening

`mode="test"` is the test bench (Settings → Voice): the same microphone path, VAD, Smart Turn
and Whisper, with live meters, and no assistant behind it. Either way the session watches its
input: a microphone that delivers nothing, or digital silence, is reported (`input_silent`)
instead of being waited on.

While the assistant thinks or speaks, the microphone goes to the `BargeInGuard`
(`voice/bargein.py`): sustained speech that is louder than the echo we expect makes a
candidate, playback ducks, and Whisper decides on a short snippet whether the user really took
the floor. With `barge_in` off the microphone is simply ignored until the assistant is done.
"""

from __future__ import annotations

import asyncio
import json
import logging
import re
from collections.abc import Awaitable, Callable
from datetime import UTC, datetime
from typing import Any

from graite.models.speech import pcm_to_wav
from graite.voice.bargein import BargeInGuard, ReferenceTrack, judge
from graite.voice.chunker import SpeechChunker
from graite.voice.fillers import filler
from graite.voice.frames import Reframer
from graite.voice.tts import TTSEngine, Voice
from graite.voice.turn import TurnAnalyzer, TurnEvent
from graite.voice.vad import Vad

log = logging.getLogger("graite.voice")

SendJson = Callable[[dict[str, Any]], Awaitable[None]]
SendBytes = Callable[[bytes], Awaitable[None]]
# What whisper writes when it heard nothing worth writing.
NOISE = re.compile(
    r"^[\s\[\(\*♪]*(blank[_ ]audio|silence|music|muziek|applause)?[\s\]\)\*♪.]*$", re.I
)
FORWARD = {"run", "status", "tool_start", "tool_end", "proposal", "clarify", "limits"}
MIN_TURN_BYTES = 32000 // 4  # a quarter of a second: shorter than any word worth answering
SILENT_LEVEL = 3e-4  # RMS below ~10/32768: silence, not merely a quiet room
SILENT_AFTER = 3.0  # seconds of no frames at all before saying the input is dead
# Frames that carry only silence look the same whether the microphone is broken or the user
# is thinking, so that warning waits far longer and only while nothing has ever been heard.
NEVER_HEARD_AFTER = 12.0
# A tool round this long with the user hearing nothing earns one more "still looking".
STILL_AFTER = 4.0


class VoiceSession:
    def __init__(
        self,
        state: Any,
        conversation_id: str,
        *,
        vad: Vad,
        analyzer: TurnAnalyzer,
        stt: Any,
        tts: TTSEngine | None,
        voice: Voice,
        send_json: SendJson,
        send_bytes: SendBytes,
        barge_in: bool = True,
        auto_language: bool = True,
        mode: str = "talk",
    ) -> None:
        self.state = state
        self.conversation_id = conversation_id
        self.vad = vad
        self.analyzer = analyzer
        self.stt = stt
        self.tts = tts
        self.voice = voice
        self.send_json = send_json
        self.send_bytes = send_bytes
        self.mode = mode
        self.barge_in = barge_in and mode == "talk"
        self.auto_language = auto_language
        self.phase = "starting"
        self.muted = False
        self.reframer = Reframer()
        self._task: asyncio.Task[None] | None = None
        # This answer's sentences: [text, milliseconds sent so far, fully synthesized].
        self._utterances: list[list[Any]] = []
        # Which of them were fillers ("Let me check your pages."): heard, but not the answer.
        self._fillers: set[int] = set()
        self._played_ms = 0.0
        self._played = asyncio.Event()
        self._closed = False
        self.reference = ReferenceTrack()
        self.guard = BargeInGuard(self.reference)
        self._confirming: asyncio.Task[None] | None = None
        self._snippet_ready = asyncio.Event()
        # What came in from the microphone: for the meters, the silence warning and the log.
        self._monitor: asyncio.Task[None] | None = None
        self.frames_in = 0
        self.heard_audio = False  # the microphone has sent real sound at least once
        self.peak_level = 0.0
        self.peak_vad = 0.0
        self.turns = 0
        self._window_frames = 0
        self._window_level = 0.0

    # ----------------------------------------------------------------- lifecycle

    async def _phase(self, phase: str) -> None:
        if phase != self.phase:
            self.phase = phase
            await self.send_json({"type": "state", "state": phase})

    async def start(self, greeting: tuple[str, bytes] | None = None) -> None:
        rate = self.tts.sample_rate if self.tts is not None else 24000
        await self.send_json({"type": "ready", "sample_rate": rate, "mode": self.mode})
        self._monitor = asyncio.create_task(self._watch_input())
        if greeting is not None and greeting[1]:
            await self._greet(*greeting)
        await self._phase("listening")

    async def _greet(self, text: str, pcm: bytes) -> None:
        """The assistant speaks first. Also the quickest proof that sound comes out."""
        assert self.tts is not None
        rate = self.tts.sample_rate
        await self._phase("speaking")
        self.reference.reset()
        self._played.clear()
        self._played_ms = 0.0
        ms = len(pcm) / 2 / rate * 1000
        await self.send_json(
            {
                "type": "audio_start",
                "utterance": 0,
                "text": text,
                "sample_rate": rate,
                "greeting": True,
            }
        )
        for start in range(0, len(pcm), 9600):
            chunk = pcm[start : start + 9600]
            self.reference.append(chunk, rate)
            await self.send_bytes(chunk)
        await self.send_json({"type": "audio_end", "utterance": 0, "ms": round(ms)})
        await self.send_json({"type": "speech_end", "ms": round(ms)})
        try:
            await asyncio.wait_for(self._played.wait(), timeout=ms / 1000 + 2.0)
        except TimeoutError:
            pass

    async def _watch_input(self) -> None:
        """Once a second: what the microphone delivered, and whether the input looks dead.

        A thinking pause is not a broken microphone. Two different faults, two different
        tests, and each is reported at most once per session:

        - no frames at all: the client is sending us nothing. Said quickly.
        - frames that only ever carry silence: a headset in music mode sounds exactly like a
          quiet room, so we wait much longer and only complain while this session has never
          once heard audio above the floor. After the first real sound the microphone has
          proved itself and we never raise it again.
        """
        dead = 0.0
        silent = 0.0
        warned = False
        while not self._closed:
            await asyncio.sleep(1.0)
            frames, level = self._window_frames, self._window_level
            self._window_frames, self._window_level = 0, 0.0
            await self.send_json({"type": "input", "frames": frames, "level": round(level, 4)})
            if level >= SILENT_LEVEL:
                self.heard_audio = True
            if self.phase != "listening" or self.muted:
                dead = silent = 0.0
                continue
            dead = dead + 1.0 if frames == 0 else 0.0
            silent = silent + 1.0 if level < SILENT_LEVEL else 0.0
            if warned:
                if dead == 0.0 and silent == 0.0:
                    warned = False
                    await self.send_json({"type": "input_ok"})
                continue
            reason = (
                "no_audio"
                if dead >= SILENT_AFTER
                else "silence"
                if silent >= NEVER_HEARD_AFTER and not self.heard_audio
                else None
            )
            if reason is not None:
                warned = True
                await self.send_json({"type": "input_silent", "reason": reason})

    async def close(self) -> None:
        self._closed = True
        if self._monitor is not None:
            self._monitor.cancel()
            await asyncio.gather(self._monitor, return_exceptions=True)
        await self._cancel_turn(persist=True)
        log.info(
            "voice session (%s) ended: %d frames in, peak level %.4f, peak vad %.2f, %d turns",
            self.mode,
            self.frames_in,
            self.peak_level,
            self.peak_vad,
            self.turns,
        )

    # ----------------------------------------------------------------- input

    async def audio(self, data: bytes) -> None:
        if self._closed or self.muted:
            return
        if self.phase != "listening" and not self.barge_in:
            self.reframer.reset()
            return
        for frame in self.reframer.feed(data):
            prob = self.vad.prob(frame)
            level = BargeInGuard._rms(frame)
            self.frames_in += 1
            self._window_frames += 1
            self._window_level = max(self._window_level, level)
            self.peak_level = max(self.peak_level, level)
            self.peak_vad = max(self.peak_vad, prob)
            if self.mode == "test" and self.frames_in % 3 == 0:
                await self.send_json(
                    {"type": "meter", "level": round(level, 4), "vad": round(prob, 2)}
                )
            if self.phase != "listening":
                self._guard(frame, prob)
                continue
            event = self.analyzer.feed(frame, prob)
            if event is not None:
                await self._on_turn(event)
            if self.analyzer.wants_check and self.phase == "listening":
                await self._on_turn(await asyncio.to_thread(self.analyzer.check))

    def _guard(self, frame: bytes, prob: float) -> None:
        """The assistant has the floor: is this the user taking it back?"""
        if self.guard.feed(frame, prob) and self._confirming is None:
            self._snippet_ready.clear()
            self._confirming = asyncio.create_task(self._confirm())
        if self.guard.ready:
            self._snippet_ready.set()

    async def _confirm(self) -> None:
        """A candidate interruption: turn the assistant down, listen for a moment, and let the
        words decide. Coughs, echo and "mm-hm" leave the answer running."""
        try:
            await self.send_json({"type": "duck", "on": True})
            echo = self.guard.echo
            await self.send_json(
                {
                    "type": "barge_in",
                    "state": "checking",
                    "echo_gain": round(echo.gain, 3),
                }
            )
            try:
                await asyncio.wait_for(self._snippet_ready.wait(), timeout=2.0)
            except TimeoutError:
                pass
            heard = await self.stt.transcribe(pcm_to_wav(self.guard.snippet()))
            text = " ".join(str(heard.get("text") or "").split())
            confidence = heard.get("confidence")
            verdict = judge(
                text,
                self._assistant_text(),
                float(confidence) if isinstance(confidence, int | float) else None,
            )
            if verdict.interrupt and self.phase == "listening":
                # The answer ended while we were checking: the words open the next turn.
                frames = self.guard.accept()
                if not self.analyzer.in_turn:
                    self.analyzer.prime(frames)
                await self.send_json({"type": "duck", "on": False})
                return
            if not verdict.interrupt:
                self.guard.reject(echo=verdict.reason == "echo")
                await self.send_json({"type": "duck", "on": False})
                await self.send_json(
                    {
                        "type": "barge_in",
                        "state": "rejected",
                        "reason": verdict.reason,
                        "heard": text[:120],
                    }
                )
                return
            frames = self.guard.accept()
            await self.send_json({"type": "barge_in", "state": "confirmed", "heard": text[:120]})
            await self.interrupt(keep_listening=True)
            # What the user said while interrupting is the start of their turn.
            self.analyzer.prime(frames)
            await self.send_json({"type": "vad", "speaking": True})
        except asyncio.CancelledError:
            raise
        except Exception:  # noqa: BLE001 - a failed check must never end the answer
            log.exception("barge-in check failed")
            self.guard.reject()
            await self.send_json({"type": "duck", "on": False})
        finally:
            self._confirming = None

    def _assistant_text(self) -> str:
        """What an echo could contain: everything of this answer that has been sent to the
        speakers so far (the room may still be carrying the previous sentence)."""
        return " ".join(str(u[0]) for u in self._utterances)

    async def control(self, message: dict[str, Any]) -> None:
        kind = message.get("type")
        if kind == "interrupt":
            self._note_played(message)
            await self.interrupt()
        elif kind == "played":
            self._note_played(message)
            if message.get("done"):
                self._played.set()
        elif kind == "mute":
            self.muted = bool(message.get("on"))
            if self.muted:
                self._reset_listening()
        elif kind == "barge_in":
            self.barge_in = bool(message.get("on"))

    def _note_played(self, message: dict[str, Any]) -> None:
        try:
            played = float(message.get("ms") or 0)
        except (TypeError, ValueError):
            return
        if played > self._total_ms() + 500:
            return  # a late report about the previous answer
        self._played_ms = max(self._played_ms, played)
        self.reference.clock(self._played_ms, self.guard.mic_ms)

    def _reset_listening(self) -> None:
        self.reframer.reset()
        self.analyzer.reset()
        self.vad.reset()

    async def _on_turn(self, event: TurnEvent) -> None:
        if event.kind == "speech_start":
            await self.send_json({"type": "vad", "speaking": True})
            return
        if event.kind == "pause":
            await self.send_json(
                {"type": "turn", "state": "incomplete", "probability": event.probability}
            )
            return
        await self.send_json({"type": "vad", "speaking": False})
        if self.phase != "listening" or len(event.audio) < MIN_TURN_BYTES:
            return
        await self.send_json(
            {"type": "turn", "state": "complete", "probability": event.probability}
        )
        self.turns += 1
        await self._phase("transcribing")
        self._task = asyncio.create_task(self._respond(event.audio))

    async def interrupt(self, *, keep_listening: bool = False) -> None:
        """Stop thinking and speaking. What was already said stays in the conversation."""
        if self.phase not in ("transcribing", "thinking", "speaking"):
            return
        await self._cancel_turn(persist=True)
        await self.send_json({"type": "interrupted"})
        if not keep_listening:
            self._reset_listening()
        await self._phase("listening")

    async def _cancel_turn(self, *, persist: bool) -> None:
        task, self._task = self._task, None
        if task is not None and not task.done():
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)
        check = self._confirming
        if check is not None and check is not asyncio.current_task() and not check.done():
            check.cancel()
            await asyncio.gather(check, return_exceptions=True)

    # ----------------------------------------------------------------- one turn

    async def _respond(self, pcm: bytes) -> None:
        try:
            heard = await self.stt.transcribe(pcm_to_wav(pcm))
            text = " ".join(str(heard.get("text") or "").split())
            if not text or NOISE.match(text):
                if self.mode == "test":
                    await self.send_json({"type": "transcript", "text": "", "language": None})
                return
            language = heard.get("language") if self.auto_language else None
            await self.send_json(
                {
                    "type": "transcript",
                    "text": text,
                    "language": language or self.voice.language,
                    "confidence": heard.get("confidence"),
                    "seconds": heard.get("seconds"),
                    "audio_seconds": round(len(pcm) / 32000, 2),
                }
            )
            if self.mode == "test":
                return  # the test bench stops at "this is what I heard"
            await self._phase("thinking")
            await self._turn(text, str(language or self.voice.language))
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001 - a failed turn must not end the session
            log.exception("voice turn failed")
            detail = str(exc) if isinstance(exc, ValueError) else "Something went wrong."
            await self.send_json({"type": "error", "text": detail})
        finally:
            if not self._closed and asyncio.current_task() is self._task:
                self._task = None
                self._reset_listening()
                await self._phase("listening")

    def _spoken_text(self) -> str:
        """The part of the answer the user actually heard, by playback position."""
        remaining = self._played_ms
        done = [(len(str(t).split()), ms) for t, ms, complete in self._utterances if complete]
        words_done = sum(n for n, _ in done)
        per_word = sum(ms for _, ms in done) / words_done if words_done else 330.0
        parts: list[str] = []
        for index, (text, ms, complete) in enumerate(self._utterances):
            if index in self._fillers:
                if complete and remaining >= ms:
                    remaining -= ms
                    continue
                break  # cut off while still saying "one moment": nothing of the answer
            if complete and remaining >= ms:
                parts.append(text)
                remaining -= ms
                continue
            # Cut inside this sentence; one still being synthesized has no length yet.
            words = str(text).split()
            length = ms if complete and ms > 0 else len(words) * per_word
            heard = words[: int(len(words) * max(0.0, remaining) / max(length, 1.0))]
            if heard:
                parts.append(" ".join(heard) + "…")
            break
        return " ".join(parts)

    async def _turn(self, text: str, language: str) -> None:
        from graite.assistant.service import build_turn, enqueue_reflect
        from graite.models.config import load_config
        from graite.retrieval.contextset import ContextSet
        from graite.retrieval.pipeline import TurnContext, answer_turn
        from graite.retrieval.scope import Scope

        state, db = self.state, self.state.db
        row = db.execute(
            "SELECT * FROM conversations WHERE id=? AND kind='assistant'", (self.conversation_id,)
        ).fetchone()
        if row is None:
            raise ValueError("This conversation no longer exists.")
        history: list[dict[str, Any]] = json.loads(row["messages_json"])
        context = ContextSet.load(row["context_json"])
        title = row["title"]

        def persist() -> None:
            db.execute(
                "UPDATE conversations SET title=?,messages_json=?,context_json=?,updated_at=? "
                "WHERE id=?",
                (
                    title,
                    json.dumps(history, ensure_ascii=False),
                    context.dump(),
                    datetime.now(UTC).isoformat(),
                    self.conversation_id,
                ),
            )

        base = TurnContext(
            state=state,
            conversation_id=self.conversation_id,
            scope=Scope("vault"),
            question=text,
            history=list(history),
            config=load_config(db),
            context=context,
            feedback=state.proposals.undelivered_rejections(self.conversation_id),
        )
        ctx = await build_turn(state, base, voice=True, language=language)
        history.append({"role": "user", "content": text, "mode": ctx.mode, "spoken": True})
        persist()

        self._utterances = []
        self._fillers = set()
        self._played_ms = 0.0
        self._played.clear()
        self.reference.reset()
        self.guard.begin_answer()
        voice = Voice(language, self.voice.reference, self.voice.exaggeration, self.voice.cfg)
        sentences: asyncio.Queue[str | None] = asyncio.Queue()
        speaker = asyncio.create_task(self._speak(sentences, voice))
        chunker = SpeechChunker()
        final: dict[str, Any] | None = None
        run_id: str | None = None
        queued = 0  # sentences handed to the speaker this turn, fillers included
        running: set[str] = set()  # tool calls started and not yet finished
        filled = still_said = False
        still: asyncio.Task[None] | None = None

        def say(sentence: str, *, is_filler: bool = False) -> None:
            nonlocal queued
            if is_filler:
                # The speaker takes sentences in order, so the queue position is the index.
                self._fillers.add(queued)
            sentences.put_nowait(sentence)
            queued += 1

        async def still_looking() -> None:
            nonlocal still_said
            await asyncio.sleep(STILL_AFTER)
            if running and not still_said:
                still_said = True
                say(filler(None, language), is_filler=True)

        def stop_still() -> None:
            nonlocal still
            if still is not None:
                still.cancel()
                still = None

        try:
            async for item in answer_turn(ctx):
                kind = item["type"]
                if kind == "run":
                    run_id = item["run_id"]
                if kind == "token":
                    for sentence in chunker.feed(item["text"]):
                        say(sentence)
                elif kind == "reset":
                    chunker.reset()
                elif kind == "tool_start":
                    name = str(item.get("name") or "")
                    # Heard everything so far and now waiting again: "thinking", not "speaking".
                    done = sum(1 for u in self._utterances if u[2])
                    if self.phase == "speaking" and done >= queued:
                        await self._phase("thinking")
                    if not filled and not queued and name != "request_clarification":
                        filled = True
                        say(filler(name, language), is_filler=True)
                    if not running and still is None and not still_said:
                        still = asyncio.create_task(still_looking())
                    running.add(str(item.get("id")))
                elif kind == "tool_end":
                    running.discard(str(item.get("id")))
                    if not running:
                        stop_still()
                elif kind == "answer":
                    final = item
                    for sentence in chunker.flush():
                        say(sentence)
                    await self.send_json(
                        {"type": "answer", "text": item["text"], "run_id": item.get("run_id")}
                    )
                if kind in FORWARD:
                    await self.send_json(item)
            stop_still()
            sentences.put_nowait(None)
            await speaker
            await self.send_json({"type": "speech_end", "ms": round(self._total_ms())})
        except asyncio.CancelledError:
            stop_still()
            speaker.cancel()
            await asyncio.gather(speaker, return_exceptions=True)
            heard = self._spoken_text()
            if heard:
                history.append(
                    {
                        "role": "assistant",
                        "content": heard,
                        "spoken": True,
                        "cut_short": True,
                        "run_id": run_id,
                        "context": True,
                    }
                )
            persist()
            raise
        except BaseException:
            stop_still()
            speaker.cancel()
            await asyncio.gather(speaker, return_exceptions=True)
            persist()
            raise
        if final is not None:
            message: dict[str, Any] = {
                "role": "assistant",
                "content": final["text"],
                "spoken": True,
                "run_id": run_id,
                "context": True,
                "sources": final.get("new_sources"),
                "cited": final.get("cited"),
                "limits": final.get("limits"),
            }
            if final.get("proposals"):
                message["proposals"] = final["proposals"]
            if final.get("activity"):
                message["activity"] = final["activity"]
            history.append(message)
        persist()
        if final is not None:
            enqueue_reflect(state, self.conversation_id)
        # Stay "speaking" (microphone gated) until the client has played everything.
        total = self._total_ms() / 1000
        if total > 0:
            try:
                await asyncio.wait_for(self._played.wait(), timeout=total + 3.0)
            except TimeoutError:
                pass
            except asyncio.CancelledError:
                # Synthesis is faster than speech: the whole answer is usually sent, and
                # saved, long before it has been heard. Interrupted now, keep what was heard.
                if final is not None and history and history[-1].get("role") == "assistant":
                    heard = self._spoken_text()
                    if heard:
                        history[-1] = {**history[-1], "content": heard, "cut_short": True}
                    else:
                        history.pop()
                    persist()
                raise

    def _total_ms(self) -> float:
        return float(sum(entry[1] for entry in self._utterances))

    async def _synthesize(
        self,
        sentences: asyncio.Queue[str | None],
        ready: asyncio.Queue[tuple[str, asyncio.Queue[bytes | None]] | None],
        voice: Voice,
    ) -> None:
        """One sentence ahead: the next is synthesized while this one is still being heard, so a
        cold or processor-bound engine leaves no gap between them.

        Each sentence is handed over *before* it is synthesized and its chunks flow through a queue,
        so the first audio still leaves the moment the engine produces it. `maxsize=1` on `ready`
        is the brake: never more than one sentence ahead of an answer the user may interrupt.
        """
        assert self.tts is not None
        try:
            while (sentence := await sentences.get()) is not None:
                chunks: asyncio.Queue[bytes | None] = asyncio.Queue()
                await ready.put((sentence, chunks))
                async for chunk in self.tts.synthesize(sentence, voice):
                    chunks.put_nowait(chunk)
                chunks.put_nowait(None)
        finally:
            await ready.put(None)

    async def _speak(self, sentences: asyncio.Queue[str | None], voice: Voice) -> None:
        assert self.tts is not None
        rate = self.tts.sample_rate
        ready: asyncio.Queue[tuple[str, asyncio.Queue[bytes | None]] | None] = asyncio.Queue(
            maxsize=1
        )
        producer = asyncio.create_task(self._synthesize(sentences, ready, voice))
        try:
            while (item := await ready.get()) is not None:
                sentence, chunks = item
                index = len(self._utterances)
                entry: list[Any] = [sentence, 0.0, False]
                self._utterances.append(entry)
                sent = 0
                # Counted as it goes out, not as it was made: the echo guard and the
                # "what did they actually hear" history both mean bytes on the wire.
                while (chunk := await chunks.get()) is not None:
                    if sent == 0:
                        await self._phase("speaking")
                        await self.send_json(
                            {
                                "type": "audio_start",
                                "utterance": index,
                                "text": sentence,
                                "sample_rate": rate,
                            }
                        )
                    sent += len(chunk)
                    entry[1] = sent / 2 / rate * 1000
                    self.reference.append(chunk, rate)
                    await self.send_bytes(chunk)
                entry[2] = True
                if sent:
                    await self.send_json(
                        {"type": "audio_end", "utterance": index, "ms": round(entry[1])}
                    )
        finally:
            producer.cancel()
            await asyncio.gather(producer, return_exceptions=True)
