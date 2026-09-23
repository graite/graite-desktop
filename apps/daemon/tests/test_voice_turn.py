from __future__ import annotations

from typing import Any

from graite.voice.frames import FRAME_BYTES, FRAME_SECONDS, Reframer
from graite.voice.turn import STOP_SECS, TurnAnalyzer
from graite.voice.vad import VadGate

FRAME = b"\x01\x00" * (FRAME_BYTES // 2)


class ScriptedTurn:
    def __init__(self, *answers: float) -> None:
        self.answers = list(answers)
        self.seen: list[int] = []

    def predict(self, audio: Any) -> float:
        self.seen.append(len(audio))
        return self.answers.pop(0)


def run(analyzer: TurnAnalyzer, script: list[tuple[float, float]]) -> list[tuple[float, str, Any]]:
    """script: (seconds, vad probability) segments. Returns (time, event, detail)."""
    events: list[tuple[float, str, Any]] = []
    t = 0.0
    for seconds, prob in script:
        for _ in range(round(seconds / FRAME_SECONDS)):
            t += FRAME_SECONDS
            event = analyzer.feed(FRAME, prob)
            if event is None and analyzer.wants_check:
                event = analyzer.check()
            if event is not None:
                events.append((round(t, 2), event.kind, event.forced or event.probability))
    return events


def test_reframer_cuts_any_chunking_into_vad_frames() -> None:
    reframer = Reframer()
    assert reframer.feed(b"\x00" * 700) == []
    frames = reframer.feed(b"\x00" * 1500)
    assert [len(f) for f in frames] == [FRAME_BYTES, FRAME_BYTES]
    reframer.reset()
    assert reframer.feed(b"\x00" * (FRAME_BYTES - 1)) == []


def test_vad_gate_needs_sustained_speech_and_sustained_silence() -> None:
    gate = VadGate(start_secs=0.2, stop_secs=0.2)
    assert [gate.feed(0.9) for _ in range(5)] == [False] * 5
    assert gate.feed(0.9) is True  # ~0.2 s of speech
    assert gate.feed(0.1) is True and gate.feed(0.9) is True  # a blip of silence is ignored
    assert [gate.feed(0.1) for _ in range(6)][-1] is False


def test_a_complete_turn_ends_at_the_first_pause() -> None:
    model = ScriptedTurn(0.93)
    events = run(TurnAnalyzer(model), [(0.5, 0.0), (1.5, 0.9), (1.0, 0.0)])
    assert [e[1] for e in events] == ["speech_start", "complete"]
    assert events[1][2] is False or events[1][2] == 0.93
    # The model heard the speech plus ~0.7 s of lead-in, not the whole silent prelude.
    assert 1.5 * 16000 < model.seen[0] < 2.6 * 16000


def test_a_thinking_pause_keeps_the_turn_open_until_the_user_finishes() -> None:
    model = ScriptedTurn(0.08, 0.97)
    analyzer = TurnAnalyzer(model)
    events = run(analyzer, [(1.0, 0.9), (1.2, 0.0), (1.0, 0.9), (0.6, 0.0)])
    assert [e[1] for e in events] == ["speech_start", "pause", "complete"]
    assert model.seen[1] > model.seen[0]  # the second check hears the whole turn
    assert not analyzer.in_turn


def test_long_silence_ends_the_turn_even_if_the_model_disagrees() -> None:
    events = run(TurnAnalyzer(ScriptedTurn(0.1), stop_secs=3.0), [(1.0, 0.9), (3.5, 0.0)])
    assert [e[1] for e in events] == ["speech_start", "pause", "complete"]
    assert events[-1][2] is True and 3.9 < events[-1][0] < 4.4


def test_the_default_wait_after_a_pause_is_short_enough_to_feel_answered() -> None:
    """Every wrong "not done" costs the user this wait, so the default is the responsiveness
    floor of a spoken turn."""
    events = run(TurnAnalyzer(ScriptedTurn(0.1)), [(1.0, 0.9), (2.5, 0.0)])
    assert [e[1] for e in events] == ["speech_start", "pause", "complete"]
    assert events[-1][2] is True
    assert events[-1][0] < 1.0 + STOP_SECS + 0.2


def test_the_model_is_asked_once_per_pause_not_again_while_it_lasts() -> None:
    """Its answer follows the silence it hears, so asking again mid-pause would talk the
    model into "complete" and cut the speaker off (measured 0.27 -> 0.97). See turn.py."""
    model = ScriptedTurn(0.2)
    # An explicit stop_secs: this is about the model not being re-asked, not about how long
    # the safety net waits.
    events = run(TurnAnalyzer(model, stop_secs=3.0), [(1.0, 0.9), (2.0, 0.0)])
    assert [e[1] for e in events] == ["speech_start", "pause"]
    assert len(model.seen) == 1


def test_only_the_newest_eight_seconds_reach_the_model() -> None:
    model = ScriptedTurn(0.9)
    run(TurnAnalyzer(model), [(12.0, 0.9), (0.5, 0.0)])
    assert model.seen == [8 * 16000]
