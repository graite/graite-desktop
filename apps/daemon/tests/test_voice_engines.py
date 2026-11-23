"""Which engine speaks: the chosen voice model decides, not the order of installation."""

from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest

from graite.voice import tts
from graite.voice.engines import crispasr, llama_tts
from graite.voice.engines.crispasr import CrispasrEngine
from graite.voice.engines.llama_tts import LlamaTtsEngine
from graite.voice.tts import EngineUnavailable, Voice, runs_on_llama, voice_model


def _item(model_id: str, *names: str, status: str = "installed") -> Any:
    return SimpleNamespace(
        id=model_id,
        role="tts",
        status=status,
        filename=names[0],
        files=[SimpleNamespace(filename=name) for name in names],
    )


CHATTERBOX = _item("chatterbox", "chatterbox-v3-t3-q8_0.gguf", "chatterbox-v3-s3gen-q8_0.gguf")
ZONOS = _item("zonos3-mini-q8", "ZONOS3-Mini-Q8_0.gguf", "mmproj-ZONOS3-Mini-F32.gguf")


def _downloads(folder: Path, *items: Any) -> Any:
    return SimpleNamespace(
        items={item.id: item for item in items},
        target=lambda item: folder / item.filename,
    )


def test_the_chosen_voice_model_wins_and_a_missing_choice_falls_back(tmp_path: Path) -> None:
    downloads = _downloads(tmp_path, CHATTERBOX, ZONOS)
    assert voice_model(SimpleNamespace(tts_model=""), downloads) is CHATTERBOX
    assert voice_model(SimpleNamespace(tts_model="zonos3-mini-q8"), downloads) is ZONOS
    assert voice_model(SimpleNamespace(tts_model="removed"), downloads) is CHATTERBOX
    only = _downloads(tmp_path, _item("chatterbox", "a-t3-.gguf", status="available"), ZONOS)
    assert voice_model(SimpleNamespace(tts_model="chatterbox"), only) is ZONOS
    assert voice_model(SimpleNamespace(tts_model=""), _downloads(tmp_path)) is None


def test_a_model_with_a_companion_file_is_spoken_by_the_chat_engine() -> None:
    assert runs_on_llama(ZONOS) and not runs_on_llama(CHATTERBOX)


def test_zonos_is_started_on_the_chat_engine_with_both_files(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    binary = tmp_path / "llama-server"
    binary.write_bytes(b"")
    for name in ("ZONOS3-Mini-Q8_0.gguf", "mmproj-ZONOS3-Mini-F32.gguf"):
        (tmp_path / name).write_bytes(b"x" * 10)
    monkeypatch.setattr(llama_tts, "resolve_binary", lambda custom: binary)
    monkeypatch.setattr(llama_tts, "can_speak", lambda found: True)
    config = SimpleNamespace(tts_model="zonos3-mini-q8", binary_path="", tts_binary_path="")

    engine = tts.get_engine(config, _downloads(tmp_path, CHATTERBOX, ZONOS))

    assert isinstance(engine, LlamaTtsEngine) and engine.sample_rate == 44100
    assert engine.model.name == "ZONOS3-Mini-Q8_0.gguf"
    assert engine.mmproj.name == "mmproj-ZONOS3-Mini-F32.gguf"
    assert engine.memory_bytes() == 26


def test_a_chat_engine_too_old_to_speak_says_so(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    binary = tmp_path / "llama-server"
    binary.write_bytes(b"")
    monkeypatch.setattr(llama_tts, "resolve_binary", lambda custom: binary)
    monkeypatch.setattr(llama_tts, "can_speak", lambda found: False)
    config = SimpleNamespace(tts_model="", binary_path="", tts_binary_path="")

    with pytest.raises(EngineUnavailable, match="newer chat engine"):
        tts.get_engine(config, _downloads(tmp_path, ZONOS))


def _chatterbox(tmp_path: Path, takes: list[float]) -> tuple[CrispasrEngine, list[dict[str, Any]]]:
    """An engine whose every request returns the next of `takes` (seconds of audio)."""
    files = [tmp_path / name for name in ("crispasr", "a-t3-q8.gguf", "a-s3gen-q8.gguf")]
    for file in files:
        file.write_bytes(b"x")
    engine = CrispasrEngine(*files)
    engine.process = SimpleNamespace(returncode=None)  # type: ignore[assignment]
    bodies: list[dict[str, Any]] = []

    async def request(body: dict[str, Any], headers: dict[str, str]) -> Any:
        bodies.append(dict(body))
        yield b"\0\0" * int(takes[len(bodies) - 1] * engine.sample_rate)

    engine._request = request  # type: ignore[method-assign]
    return engine, bodies


async def _seconds(engine: CrispasrEngine, text: str, voice: Voice) -> float:
    pcm = b"".join([chunk async for chunk in engine.synthesize(text, voice)])
    return len(pcm) / 2 / engine.sample_rate


async def test_a_few_words_get_enough_guidance_and_a_runaway_take_is_made_again(
    tmp_path: Path,
) -> None:
    engine, bodies = _chatterbox(tmp_path, [3.4, 1.0])
    assert await _seconds(engine, "Hi, Sam.", Voice(cfg=0.15)) == 1.0
    # The engine's own seed never changes, so the second take has to ask for another.
    assert [body.get("seed") for body in bodies] == [None, 1]
    assert all(body["cfg_scale"] == crispasr.SHORT_GUIDANCE for body in bodies)
    # More guidance than the floor is the user's choice and stays.
    engine, bodies = _chatterbox(tmp_path, [1.0])
    await _seconds(engine, "Sure.", Voice(cfg=0.8))
    assert bodies[0]["cfg_scale"] == 0.8


async def test_when_every_take_runs_on_the_shortest_is_spoken(tmp_path: Path) -> None:
    engine, bodies = _chatterbox(tmp_path, [3.4, 2.0, 2.6])
    assert await _seconds(engine, "Hi, Sam.", Voice()) == 2.0
    assert len(bodies) == crispasr.SHORT_ATTEMPTS


async def test_a_sentence_is_passed_through_as_the_user_set_it(tmp_path: Path) -> None:
    engine, bodies = _chatterbox(tmp_path, [9.0])
    text = "I looked through your notes and found three pages."
    assert await _seconds(engine, text, Voice(cfg=0.15)) == 9.0
    assert bodies == [
        {
            "input": text,
            "language": "en",
            "response_format": "pcm",
            "stream": True,
            "exaggeration": 0.5,
            "cfg_scale": 0.15,
        }
    ]


def test_the_engine_stamp_changes_with_the_build(tmp_path: Path) -> None:
    engine, _ = _chatterbox(tmp_path, [])
    before = engine.stamp()
    engine.binary.write_bytes(b"a newer build")
    assert engine.stamp() != before
