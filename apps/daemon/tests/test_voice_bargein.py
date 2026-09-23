# ruff: noqa: E501
from __future__ import annotations

import numpy as np
import pytest

from graite.voice.bargein import BargeInGuard, ReferenceTrack, judge
from graite.voice.frames import FRAME_SAMPLES, FRAME_SECONDS

RATE_OUT = 24000


def speechlike(seconds: float, rate: int, seed: int) -> np.ndarray:
    """Noise with a syllable-like envelope (3-5 Hz), peak around 0.5."""
    rng = np.random.default_rng(seed)
    n = int(seconds * rate)
    t = np.arange(n) / rate
    envelope = np.clip(np.sin(2 * np.pi * 3.7 * t + rng.uniform(0, 6)) * 0.6 + 0.5, 0.02, 1)
    envelope *= np.clip(np.sin(2 * np.pi * 0.6 * t) * 0.5 + 0.7, 0.2, 1)
    return (rng.standard_normal(n) * 0.18 * envelope).astype(np.float32)


def to_mic(reference: np.ndarray, *, gain: float, lag_ms: float) -> np.ndarray:
    """What a microphone next to the speakers hears of `reference` (24 kHz -> 16 kHz): delayed,
    quieter, smeared by the room."""
    idx = (np.arange(int(len(reference) * 16000 / RATE_OUT)) * RATE_OUT / 16000).astype(int)
    mic = reference[idx] * gain
    tail = np.exp(-np.arange(int(0.08 * 16000)) / (0.02 * 16000))
    mic = np.convolve(mic, tail / tail.sum(), mode="same")
    return np.concatenate([np.zeros(int(lag_ms * 16)), mic]).astype(np.float32)


def pcm16(x: np.ndarray) -> bytes:
    return (np.clip(x, -1, 1) * 32767).astype("<i2").tobytes()


def run(mic: np.ndarray, reference: np.ndarray, *, vad_floor: float = 0.004) -> list[float]:
    """Play `reference` while the microphone hears `mic`. The VAD is the worst case: it calls
    anything audible speech, including the assistant's own echo. Returns candidate times."""
    track = ReferenceTrack()
    track.append(pcm16(reference), RATE_OUT)
    guard = BargeInGuard(track)
    found: list[float] = []
    frames = len(mic) // FRAME_SAMPLES
    for i in range(frames):
        now = 100.0 + i * FRAME_SECONDS
        if i % 3 == 0:  # the client reports its playback position every ~100 ms
            track.clock(i * FRAME_SECONDS * 1000, guard.mic_ms)
        chunk = mic[i * FRAME_SAMPLES : (i + 1) * FRAME_SAMPLES]
        prob = 0.95 if float(np.sqrt((chunk * chunk).mean())) > vad_floor else 0.02
        if guard.feed(pcm16(chunk), prob, now):
            found.append(round(i * FRAME_SECONDS, 2))
            guard.reject(now)
    return found


def noise(n: int, level: float = 0.001) -> np.ndarray:
    return (np.random.default_rng(1).standard_normal(n) * level).astype(np.float32)


def test_the_assistants_own_voice_from_the_speakers_is_not_a_candidate() -> None:
    reference = speechlike(8, RATE_OUT, seed=3)
    mic = to_mic(reference, gain=0.3, lag_ms=120)
    mic = mic + noise(len(mic))
    assert run(mic, reference) == []


def test_the_user_talking_over_the_echo_is_found_quickly() -> None:
    reference = speechlike(8, RATE_OUT, seed=3)
    mic = to_mic(reference, gain=0.3, lag_ms=120)
    mic = mic + noise(len(mic))
    user = speechlike(1.5, 16000, seed=9) * 1.6  # close to the microphone: louder than the echo
    start = int(4.0 * 16000)
    mic[start : start + len(user)] += user
    found = run(mic, reference)
    assert found and 4.0 < found[0] < 4.6
    assert all(4.0 < t < 6.0 for t in found)


def test_a_user_drowned_out_by_loud_speakers_is_not_heard() -> None:
    """Fails safe: no candidate, the answer plays on; the button and Space still interrupt.
    (A user who is merely quieter than the echo's peaks is still found in its dips.)"""
    reference = speechlike(6, RATE_OUT, seed=5)
    mic = to_mic(reference, gain=1.5, lag_ms=200)
    user = speechlike(1.0, 16000, seed=2) * 0.04
    mic[48000 : 48000 + len(user)] += user
    assert run(mic, reference) == []


def test_with_headphones_any_sustained_speech_is_a_candidate_but_clicks_are_not() -> None:
    reference = speechlike(6, RATE_OUT, seed=7)
    mic = noise(6 * 16000)
    mic[30000:30400] += 0.5  # a bang: 25 ms
    user = speechlike(1.2, 16000, seed=4)
    mic[64000 : 64000 + len(user)] += user
    found = run(mic, reference)
    assert found and 4.0 < found[0] < 4.6


def test_speech_in_the_gap_between_two_sentences_counts() -> None:
    quiet = np.zeros(int(1.5 * RATE_OUT), dtype=np.float32)
    reference = np.concatenate([speechlike(3, RATE_OUT, seed=3), quiet])
    mic = to_mic(reference, gain=0.3, lag_ms=120) + noise(
        len(to_mic(reference, gain=0.3, lag_ms=120))
    )
    user = speechlike(0.9, 16000, seed=8) * 0.8
    start = int(3.4 * 16000)
    mic[start : start + len(user)] += user
    found = run(mic, reference)
    assert found and 3.4 < found[0] < 4.0


def test_the_snippet_keeps_what_was_said_just_before_the_candidate() -> None:
    track = ReferenceTrack()
    guard = BargeInGuard(track)
    quiet, loud = (
        pcm16(np.zeros(FRAME_SAMPLES, np.float32)),
        pcm16(np.full(FRAME_SAMPLES, 0.2, np.float32)),
    )
    for i in range(20):
        guard.feed(quiet, 0.02, 10 + i * FRAME_SECONDS)
    started = [guard.feed(loud, 0.9, 11 + i * FRAME_SECONDS) for i in range(12)]
    assert started.index(True) == 5 and guard.collecting and not guard.ready  # the 6th vote
    for i in range(30):
        guard.feed(loud, 0.9, 12 + i * FRAME_SECONDS)
    assert guard.ready
    # Whisper judges from just before the candidate; the next turn gets the whole pre-roll.
    assert len(guard.snippet()) < len(b"".join(guard.frames()))
    frames = guard.accept()
    assert len(frames) > 30 and frames[0] == quiet and frames[-1] == loud
    assert not guard.collecting


@pytest.mark.parametrize(
    ("heard", "assistant", "interrupt", "reason"),
    [
        ("", "The deadline is next Friday.", False, "nothing"),
        (" [BLANK_AUDIO] ", "The deadline is next Friday.", False, "nothing"),
        ("(coughing)", "The deadline is next Friday.", False, "nothing"),
        ("the deadline is next", "The deadline is next Friday.", False, "echo"),
        (
            "Deadline is next Friday",
            "The deadline is next Friday, and Anna reviews it.",
            False,
            "echo",
        ),
        ("Friday", "The deadline is next Friday.", False, "echo"),
        (
            "Anna reviews the budget and Peter signs it of",
            "Anna reviews the budget, and Pieter signs it off.",
            False,
            "echo",
        ),
        (
            "which can hold 200 guests the venue",
            "The venue is the Grand Hotel, which can hold two hundred guests.",
            False,
            "echo",
        ),
        ("okay", "The deadline is next Friday.", False, "backchannel"),
        ("Mm-hmm.", "The deadline is next Friday.", False, "backchannel"),
        ("ja ja", "De deadline is vrijdag.", False, "backchannel"),
        ("Stop.", "The deadline is next Friday.", True, "command"),
        ("wacht even", "De deadline is volgende week vrijdag.", True, "command"),
        ("Warte mal", "Der Termin ist am Freitag.", True, "command"),
        ("attends", "La date limite est vendredi.", True, "command"),
        ("wait the deadline", "The deadline is next Friday.", True, "command"),
        ("but that moved to Monday", "The deadline is next Friday.", True, "words"),
        (
            "I meant the budget, who reviewed",
            "I already told you everything I know. Anna reviews the budget, and Pieter signs it off.",
            True,
            "words",
        ),
        (
            "I will make a notification",
            "I will make a note of this so I can recall it.",
            False,
            "echo",
        ),
        ("The Atlas launched", "The Atlas launch deadline is Friday.", False, "echo"),
        (
            "- It's Friday the 25th.",
            "The Atlas launch deadline is Friday the twenty-fifth of September.",
            False,
            "echo",
        ),
        ("okay but what about Anna", "The deadline is next Friday.", True, "words"),
        ("nee dat klopt niet", "De deadline is vrijdag.", True, "command"),
    ],
)
def test_judging_a_snippet(heard: str, assistant: str, interrupt: bool, reason: str) -> None:
    verdict = judge(heard, assistant)
    assert (verdict.interrupt, verdict.reason) == (interrupt, reason)


def test_a_stop_word_the_assistant_itself_is_saying_is_still_echo() -> None:
    assert judge("please stop the", "Please stop the timer when you are done.").interrupt is False


def test_a_late_playback_report_from_the_previous_answer_is_ignored() -> None:
    track = ReferenceTrack()
    track.append(pcm16(speechlike(2, RATE_OUT, seed=1)), RATE_OUT)
    track.clock(9000.0, 0.0)  # the last answer was nine seconds long
    assert track.position(100.0) == 0.0
    track.clock(640.0, 640.0)
    assert track.position(672.0) == 672.0


def test_words_whisper_was_not_sure_of_do_not_interrupt() -> None:
    """A loud noise over the assistant's voice can make Whisper imagine a sentence."""
    assistant = "The deadline is next Friday."
    assert judge("Let's not explain.", assistant, confidence=-0.9).reason == "unclear"
    assert judge("Let's not explain.", assistant, confidence=-0.12).interrupt is True
    assert judge("Stop.", assistant, confidence=-0.3).reason == "command"
    assert judge("Let's not explain.", assistant).interrupt is True  # an engine without scores
