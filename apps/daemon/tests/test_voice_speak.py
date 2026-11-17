"""Sending one sentence while the next is being synthesized."""

from __future__ import annotations

import asyncio
from typing import Any

from graite.voice.session import VoiceSession
from graite.voice.tts import Voice

CHUNK = b"\x00\x01" * 240


class SlowEngine:
    """Writes into a shared timeline so the overlap is visible, not merely assumed."""

    name = "slow"
    sample_rate = 24000

    def __init__(self, timeline: list[str], delay: float = 0.01) -> None:
        self.timeline = timeline
        self.delay = delay

    async def synthesize(self, text: str, voice: Any) -> Any:
        self.timeline.append(f"synth-start {text}")
        for _ in range(3):
            await asyncio.sleep(self.delay)
            yield CHUNK
        self.timeline.append(f"synth-end {text}")


def _session(timeline: list[str]) -> VoiceSession:
    session = VoiceSession.__new__(VoiceSession)
    session.tts = SlowEngine(timeline)  # type: ignore[assignment]
    session.phase = "thinking"
    session._utterances = []
    current = {"text": ""}

    async def send_json(event: dict[str, Any]) -> None:
        if event["type"] == "audio_start":
            current["text"] = event["text"]
            timeline.append(f"send-start {event['text']}")
        elif event["type"] == "audio_end":
            timeline.append(f"send-end {current['text']}")

    async def send_bytes(data: bytes) -> None:
        # Playback is much slower than synthesis, with margin for Windows' ~16 ms timer.
        await asyncio.sleep(0.05)

    session.send_json = send_json  # type: ignore[assignment]
    session.send_bytes = send_bytes  # type: ignore[assignment]
    session.reference = type("R", (), {"append": lambda self, chunk, rate: None})()  # type: ignore[assignment]
    return session


async def test_the_next_sentence_is_synthesized_while_this_one_is_being_sent() -> None:
    """Without this, a cold or processor-bound engine leaves a silent gap between sentences."""
    timeline: list[str] = []
    session = _session(timeline)
    sentences: asyncio.Queue[str | None] = asyncio.Queue()
    for text in ("One.", "Two.", "Three."):
        sentences.put_nowait(text)
    sentences.put_nowait(None)

    await session._speak(sentences, Voice("en", None, 0.5, 0.5))

    assert [t for t in timeline if t.startswith("send-start")] == [
        "send-start One.",
        "send-start Two.",
        "send-start Three.",
    ]
    # The overlap: "Two." is synthesized while "One." is still going out.
    assert timeline.index("synth-start Two.") < timeline.index("send-end One.")
    assert timeline.index("synth-end Two.") < timeline.index("send-end One.")
    # …but never more than one sentence ahead, so an interruption wastes nothing.
    assert timeline.index("send-start Two.") < timeline.index("synth-start Three.")
    assert len(session._utterances) == 3 and all(entry[2] for entry in session._utterances)


async def test_audio_starts_on_the_first_chunk_not_the_finished_sentence() -> None:
    """Buffering a whole sentence before sending would trade first-audio latency for the gap."""
    timeline: list[str] = []
    session = _session(timeline)
    sentences: asyncio.Queue[str | None] = asyncio.Queue()
    sentences.put_nowait("One.")
    sentences.put_nowait(None)

    await session._speak(sentences, Voice("en", None, 0.5, 0.5))

    assert timeline.index("send-start One.") < timeline.index("synth-end One.")


class FlakyEngine:
    """Dies on chosen calls, the way a native engine does when its process crashes."""

    name = "flaky"
    sample_rate = 24000

    def __init__(self, failures: dict[int, str]) -> None:
        self.failures = failures  # call number -> "before" or "during" the audio
        self.calls: list[str] = []

    async def synthesize(self, text: str, voice: Any) -> Any:
        self.calls.append(text)
        failure = self.failures.get(len(self.calls))
        if failure == "before":
            raise RuntimeError("engine died")
        yield CHUNK
        if failure == "during":
            raise RuntimeError("engine died")
        yield CHUNK


def _queue(*texts: str) -> asyncio.Queue[str | None]:
    sentences: asyncio.Queue[str | None] = asyncio.Queue()
    for text in (*texts, None):
        sentences.put_nowait(text)
    return sentences


async def test_a_sentence_the_engine_died_on_is_tried_again() -> None:
    """One crashed request used to end the whole answer in silence, mid-thought."""
    timeline: list[str] = []
    session = _session(timeline)
    engine = FlakyEngine({2: "before"})
    session.tts = engine  # type: ignore[assignment]

    await session._speak(_queue("One.", "Two.", "Three."), Voice("en", None, 0.5, 0.5))

    assert engine.calls == ["One.", "Two.", "Two.", "Three."]
    assert [t for t in timeline if t.startswith("send-end")] == [
        "send-end One.",
        "send-end Two.",
        "send-end Three.",
    ]


async def test_a_sentence_cut_off_halfway_is_not_repeated_and_the_answer_goes_on() -> None:
    timeline: list[str] = []
    session = _session(timeline)
    engine = FlakyEngine({1: "during"})
    session.tts = engine  # type: ignore[assignment]

    await session._speak(_queue("One.", "Two."), Voice("en", None, 0.5, 0.5))

    assert engine.calls == ["One.", "Two."]
    assert [t for t in timeline if t.startswith("send-start")] == [
        "send-start One.",
        "send-start Two.",
    ]


async def test_an_engine_that_keeps_dying_is_an_error_not_a_finished_answer() -> None:
    import pytest

    timeline: list[str] = []
    session = _session(timeline)
    engine = FlakyEngine({2: "before", 3: "before", 4: "before"})
    session.tts = engine  # type: ignore[assignment]

    with pytest.raises(RuntimeError):
        await session._speak(_queue("One.", "Two.", "Three."), Voice("en", None, 0.5, 0.5))

    assert engine.calls == ["One.", "Two.", "Two.", "Two."]
    assert [t for t in timeline if t.startswith("send-end")] == ["send-end One."]
