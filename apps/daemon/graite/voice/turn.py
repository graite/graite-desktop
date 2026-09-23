"""Has the user finished their turn? pipecat's Smart Turn v3, with its analyzer logic.

A pause is not the end of a turn: people stop mid-sentence to think. When the VAD reports
silence after speech, the model hears the whole turn so far and says whether it sounds
complete. If not, listening continues and the model is asked again at the next pause; a long
silence (`stop_secs`) ends the turn regardless.

The model is asked **once per pause**, and deliberately not again while that pause lasts.
Measured on 2026-09-20: its answer follows the amount of silence it hears, so re-asking
after a further 0.8 s turned a correct "not done" (0.27) on an unfinished clause into 0.97
and cut the speaker off mid-thought. Waiting out `stop_secs` is the safety net instead.

`stop_secs` is therefore the whole cost of a wrong "not done": the user has finished and
waits it out in silence. It is the one knob for how quickly the assistant comes back.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal, Protocol

from graite.voice.frames import FRAME_SECONDS, SAMPLE_RATE
from graite.voice.vad import VadGate, session

# How long a pause the model called unfinished may last before we answer anyway. Every wrong
# "not done" costs the user exactly this much waiting, so it is the assistant's floor for
# coming back; too low and a mid-sentence pause gets answered over.
STOP_SECS = 1.6


class TurnModel(Protocol):
    def predict(self, audio: Any) -> float: ...


class SmartTurn:
    def __init__(self, path: Path) -> None:
        self._session = session(path)

    def predict(self, audio: Any) -> float:
        """Probability that the turn in `audio` (float32, 16 kHz) is complete."""
        from graite.voice.features import log_mel

        features = log_mel(audio)[None, :, :]
        (output,) = self._session.run(None, {"input_features": features})
        return float(output.reshape(-1)[0])


@dataclass
class TurnEvent:
    kind: Literal["speech_start", "pause", "complete"]
    # pause: the model found the turn incomplete. complete: the turn's audio, PCM16LE.
    probability: float | None = None
    audio: bytes = b""
    forced: bool = False  # ended by the silence timeout, not by the model


class TurnAnalyzer:
    """Frames and their speech flag in, turn events out. `check()` runs the model and is
    called by the session off the event loop when `feed` asks for it."""

    def __init__(
        self,
        model: TurnModel,
        *,
        gate: VadGate | None = None,
        stop_secs: float = STOP_SECS,
        pre_speech_ms: float = 500.0,
        max_duration_secs: float = 8.0,
        threshold: float = 0.5,
    ) -> None:
        self.model = model
        self.gate = gate or VadGate()
        self.stop_secs = stop_secs
        self.pre_frames = round((pre_speech_ms / 1000 + self.gate.start_secs) / FRAME_SECONDS)
        self.max_samples = int(max_duration_secs * SAMPLE_RATE)
        self.threshold = threshold
        self.reset()

    def reset(self) -> None:
        self.gate.reset()
        self._frames: list[bytes] = []
        self._triggered = False
        self._speaking = False
        self._silence = 0.0
        self._pending_check = False

    @property
    def in_turn(self) -> bool:
        return self._triggered

    def feed(self, frame: bytes, prob: float) -> TurnEvent | None:
        speaking = self.gate.feed(prob)
        self._frames.append(frame)
        if not self._triggered:
            if speaking:
                self._triggered = self._speaking = True
                self._silence = 0.0
                return TurnEvent("speech_start")
            del self._frames[: -self.pre_frames or None]
            return None
        if speaking:
            self._speaking = True
            self._silence = 0.0
            self._pending_check = False
            return None
        if self._speaking:  # speech just stopped: ask the model
            self._speaking = False
            self._pending_check = True
        self._silence += FRAME_SECONDS
        if self._silence >= self.stop_secs:
            return self._complete(None, forced=True)
        return None

    def prime(self, frames: list[bytes]) -> None:
        """Start inside a turn: the user began speaking while the assistant still had the
        floor, and what they said so far is part of what they are saying now."""
        self.reset()
        self._frames = list(frames)
        self._triggered = self._speaking = True
        self.gate.speaking = True

    @property
    def wants_check(self) -> bool:
        return self._pending_check

    def audio(self) -> bytes:
        return b"".join(self._frames)

    def check(self) -> TurnEvent:
        """Run Smart Turn on the turn so far. Blocking: call it in a thread."""
        import numpy as np

        self._pending_check = False
        samples = np.frombuffer(self.audio(), dtype="<i2").astype(np.float32) / 32768.0
        probability = self.model.predict(samples[-self.max_samples :])
        if self._speaking:  # the user spoke again while the model was listening
            return TurnEvent("pause", probability)
        if probability > self.threshold:
            return self._complete(probability)
        return TurnEvent("pause", probability)

    def _complete(self, probability: float | None, *, forced: bool = False) -> TurnEvent:
        event = TurnEvent("complete", probability, self.audio(), forced)
        self.reset()
        return event
