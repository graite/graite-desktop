# ruff: noqa: E501
from __future__ import annotations

import json
from typing import Any

import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from graite.models.config import load_config
from graite.models.providers import Provider
from graite.voice.engines.stub import StubEngine
from graite.voice.frames import FRAME_BYTES
from tests.test_ai import config
from tests.test_assistant import setup
from tests.test_voice_turn import ScriptedTurn

SPEECH = b"\x00\x10" * (FRAME_BYTES // 2)
SILENCE = b"\x00\x00" * (FRAME_BYTES // 2)


class LoudnessVad:
    """Speech is any frame that is not digital silence."""

    def prob(self, frame: bytes) -> float:
        return 0.95 if any(frame) else 0.02

    def reset(self) -> None:
        pass


class ScriptedSTT:
    def __init__(self, *heard: dict[str, Any]) -> None:
        self.heard = list(heard)
        self.running = False
        self.audio: list[int] = []

    async def start(self) -> None:
        self.running = True

    async def stop(self) -> None:
        self.running = False

    async def transcribe(self, wav: bytes, **_: Any) -> dict[str, Any]:
        self.audio.append(len(wav))
        return self.heard.pop(0)


def install(client: TestClient, stt: ScriptedSTT, tts: StubEngine, *turns: float) -> None:
    runtime = client.app.state.voice
    runtime.make_vad = lambda: LoudnessVad()
    runtime.make_turn_model = lambda: ScriptedTurn(*turns)
    runtime.make_stt = lambda _config: stt
    runtime.make_tts = lambda _config: tts


def speaking(prompts: list[Any], options: list[Any], text: str):  # type: ignore[no-untyped-def]
    async def fake(self: Provider, messages: Any, tools: Any, **kwargs: Any):  # type: ignore[no-untyped-def]
        prompts.append(messages)
        options.append(kwargs)
        for word in text.split(" "):
            yield {"content": word + " "}

    return fake


def say(ws: Any, seconds: float = 1.0, pause: float = 0.5) -> None:
    for _ in range(round(seconds / 0.032)):
        ws.send_bytes(SPEECH)
    for _ in range(round(pause / 0.032)):
        ws.send_bytes(SILENCE)


def until(ws: Any, kind: str, **match: Any) -> tuple[dict[str, Any], list[dict[str, Any]], int]:
    """Read until a JSON event of `kind` (with `match`) arrives: (event, events seen, audio bytes)."""
    seen: list[dict[str, Any]] = []
    audio = 0
    while True:
        message = ws.receive()
        if message.get("bytes") is not None:
            audio += len(message["bytes"])
            continue
        if message["type"] == "websocket.close":
            raise AssertionError(f"socket closed while waiting for {kind}: {seen}")
        event = json.loads(message["text"])
        if __import__("os").environ.get("VOICE_DEBUG"):
            print("EV", kind, message["text"][:110], file=__import__("sys").stderr, flush=True)
        seen.append(event)
        if event["type"] == kind and all(event.get(k) == v for k, v in match.items()):
            return event, seen, audio


def begin(ws: Any) -> list[dict[str, Any]]:
    """Open a conversation the way the client does: the assistant says hello first, the client
    plays it and reports so, and then the floor is the user's."""
    _, seen, _ = until(ws, "ready")
    end, more, audio = until(ws, "speech_end")
    assert audio > 0
    ws.send_text(json.dumps({"type": "played", "ms": end["ms"], "done": True}))
    _, last, _ = until(ws, "state", state="listening")
    return seen + more + last


def connect(client: TestClient, conversation_id: str, extra: str = "") -> Any:
    return client.websocket_connect(
        f"/api/v1/voice/session?token=test-token&conversation_id={conversation_id}{extra}"
    )


@pytest.fixture
def ada(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> dict[str, Any]:
    config(client)
    monkeypatch.setattr("keyring.get_password", lambda *_: "")
    setup(client, voice={"language": "auto"})
    return client.post("/api/v1/assistant/conversations").json()


def test_status_lists_what_is_missing(client: TestClient) -> None:
    status = client.get("/api/v1/voice/status").json()
    keys = {m["key"] for m in status["missing"]}
    assert status["ready"] is False and {"assistant", "vad", "turn", "tts"} <= keys


def test_socket_needs_the_token(client: TestClient) -> None:
    with pytest.raises(WebSocketDisconnect) as closed:
        with client.websocket_connect(
            "/api/v1/voice/session?token=wrong", headers={"Authorization": ""}
        ):
            pass
    assert closed.value.code == 4401


def test_a_spoken_turn_is_heard_answered_aloud_and_saved(
    client: TestClient, ada: dict[str, Any], monkeypatch: pytest.MonkeyPatch
) -> None:
    stt = ScriptedSTT({"text": " Wat weet je over\n Atlas? ", "language": "nl"})
    tts = StubEngine()
    install(client, stt, tts, 0.96)
    prompts: list[Any] = []
    options: list[Any] = []
    answer = "Je hebt drie notities over Atlas [1]. De deadline is **vrijdag**."
    monkeypatch.setattr(Provider, "chat", speaking(prompts, options, answer))
    with connect(client, ada["id"]) as ws:
        seen = begin(ws)
        assert next(e for e in seen if e["type"] == "ready")["sample_rate"] == 24000
        assert [e["state"] for e in seen if e["type"] == "state"] == [
            "loading",
            "speaking",
            "listening",
        ]
        hello = next(e for e in seen if e["type"] == "audio_start")
        assert hello["text"] == "Hi there." and hello["greeting"] is True
        assert stt.running and tts.loaded and client.app.state.models.pinned
        assert client.app.state.foreground.active
        assert (
            client.put(
                "/api/v1/ai/config", json={"provider": "compatible", "model": "x"}
            ).status_code
            == 409
        )

        say(ws)
        transcript, seen, _ = until(ws, "transcript")
        assert (transcript["text"], transcript["language"]) == ("Wat weet je over Atlas?", "nl")
        assert {"type": "turn", "state": "complete", "probability": 0.96} in seen
        end, more, audio = until(ws, "speech_end")
        seen += more
        spoken = [e["text"] for e in seen if e["type"] == "audio_start" and not e.get("greeting")]
        assert spoken == ["Je hebt drie notities over Atlas.", "De deadline is vrijdag."]
        assert audio > 0 and end["ms"] > 1000
        assert [e["state"] for e in seen if e["type"] == "state"] == [
            "transcribing",
            "thinking",
            "speaking",
        ]
        final = next(e for e in seen if e["type"] == "answer")["text"]
        assert final.startswith("Je hebt drie notities over Atlas") and "vrijdag" in final
        ws.send_text(json.dumps({"type": "played", "ms": end["ms"], "done": True}))
        until(ws, "state", state="listening")
        ws.send_text(json.dumps({"type": "end"}))
    assert [t for t, _ in tts.spoken] == [
        "Hi there.",
        "Je hebt drie notities over Atlas.",
        "De deadline is vrijdag.",
    ]
    assert [v.language for _, v in tts.spoken] == [
        "en",
        "nl",
        "nl",
    ]  # hello, then the speaker's language
    assert len(stt.audio) == 1
    system = prompts[0][0]["content"]
    assert "spoken conversation" in system and "You are Ada" in system
    assert options[0] == {"thinking": False}
    # The speaker's language rides along with the question, but is not saved with it.
    assert prompts[0][-1]["content"] == (
        "Wat weet je over Atlas?\n\n"
        "(Spoken aloud: concise natural sentences; include all items when asked. Reply in Dutch.)"
    )
    saved = client.get(f"/api/v1/ai/conversations/{ada['id']}").json()["messages"]
    assert [(m["role"], m["spoken"], m["cut_short"]) for m in saved] == [
        ("user", True, False),
        ("assistant", True, False),
    ]
    assert saved[1]["content"] == final
    # Everything the session held is released again.
    state = client.app.state
    assert not stt.running and not tts.loaded and not state.models.pinned
    assert state.voice.session is None and not state.foreground.active


def test_interrupting_keeps_only_what_was_heard(
    client: TestClient, ada: dict[str, Any], monkeypatch: pytest.MonkeyPatch
) -> None:
    stt = ScriptedSTT({"text": "Tell me about Atlas", "language": "en"})
    tts = StubEngine(seconds_per_word=0.2, delay=0.05)
    install(client, stt, tts, 0.9)
    answer = "Atlas has three open notes right now. The deadline is next Friday. Anna reviews the budget first."
    monkeypatch.setattr(Provider, "chat", speaking([], [], answer))
    with connect(client, ada["id"]) as ws:
        begin(ws)
        say(ws)
        until(ws, "audio_end", utterance=0)
        # The first sentence (7 words, 1.4 s) was heard in full, then half of the second.
        ws.send_text(json.dumps({"type": "interrupt", "ms": 1400 + 500}))
        until(ws, "interrupted")
        until(ws, "state", state="listening")
        ws.send_text(json.dumps({"type": "end"}))
    saved = client.get(f"/api/v1/ai/conversations/{ada['id']}").json()["messages"]
    assert saved[-1]["cut_short"] is True and saved[-1]["role"] == "assistant"
    assert saved[-1]["content"].startswith("Atlas has three open notes right now. The deadline")
    assert saved[-1]["content"].endswith("…") and "Anna" not in saved[-1]["content"]


def playing(ws: Any, seconds: float, *, speech: bool, start_ms: float = 0.0) -> float:
    """Send microphone audio at the pace of a real microphone while reporting playback, like
    the client does: the guard compares the two on a shared clock."""
    import time

    frames = round(seconds / 0.032)
    for i in range(frames):
        ws.send_bytes(SPEECH if speech else SILENCE)
        if i % 3 == 0:
            ws.send_text(json.dumps({"type": "played", "ms": start_ms + i * 32}))
        time.sleep(0.03)
    return start_ms + frames * 32


LONG = "One two three four five six seven. Eight nine ten eleven twelve thirteen. Fourteen fifteen sixteen seventeen."


def test_speaking_over_the_assistant_ducks_checks_the_words_and_interrupts(
    client: TestClient, ada: dict[str, Any], monkeypatch: pytest.MonkeyPatch
) -> None:
    stt = ScriptedSTT(
        {"text": "Tell me about Atlas", "language": "en"},
        {"text": "Wait, that is", "language": "en"},  # the snippet the guard collected
        {"text": "Wait, that is not what I meant", "language": "en"},  # the whole new turn
    )
    tts = StubEngine(seconds_per_word=0.25, delay=0.06)
    install(client, stt, tts, 0.9, 0.9)
    monkeypatch.setattr(Provider, "chat", speaking([], [], LONG))
    with connect(client, ada["id"]) as ws:  # interrupting by voice is the default
        begin(ws)
        say(ws)
        until(ws, "audio_start")
        at = playing(ws, 1.0, speech=False)  # the guard learns there is no echo here
        playing(ws, 1.6, speech=True, start_ms=at)  # the user talks over the answer
        _, seen, _ = until(ws, "interrupted")
        kinds = [(e["type"], e.get("on", e.get("state"))) for e in seen]
        assert ("duck", True) in kinds and ("barge_in", "checking") in kinds
        assert kinds.index(("duck", True)) < kinds.index(("barge_in", "confirmed"))
        until(ws, "state", state="listening")
        say(ws, 0.6, 0.5)  # …and finishes the sentence
        transcript, _, _ = until(ws, "transcript")
        assert transcript["text"] == "Wait, that is not what I meant"
        ws.send_text(json.dumps({"type": "end"}))
    # The new turn's audio starts with what was said while interrupting (pre-roll included).
    assert len(stt.audio) == 3 and stt.audio[2] > stt.audio[1]
    saved = client.get(f"/api/v1/ai/conversations/{ada['id']}").json()["messages"]
    assert saved[1]["role"] == "assistant" and saved[1]["cut_short"] is True


@pytest.mark.parametrize(
    ("heard", "reason"),
    [("Mm-hmm.", "backchannel"), (" [BLANK_AUDIO]", "nothing"), ("two three four five", "echo")],
)
def test_sounds_that_are_not_the_user_taking_the_floor_leave_the_answer_running(
    client: TestClient,
    ada: dict[str, Any],
    monkeypatch: pytest.MonkeyPatch,
    heard: str,
    reason: str,
) -> None:
    stt = ScriptedSTT(
        {"text": "Tell me about Atlas", "language": "en"}, {"text": heard, "language": "en"}
    )
    tts = StubEngine(seconds_per_word=0.25, delay=0.06)
    install(client, stt, tts, 0.9)
    monkeypatch.setattr(Provider, "chat", speaking([], [], LONG))
    with connect(client, ada["id"]) as ws:
        begin(ws)
        say(ws)
        until(ws, "audio_start")
        at = playing(ws, 1.0, speech=False)
        at = playing(ws, 1.2, speech=True, start_ms=at)
        rejected, seen, _ = until(ws, "barge_in", state="rejected")
        assert rejected["reason"] == reason
        ducks = [e["on"] for e in seen if e["type"] == "duck"]
        assert ducks == [True, False]  # turned down while checking, back up after
        # The stub synthesizes faster than speech, so the audio may all be here already; what
        # matters is that the answer is neither interrupted nor cut.
        assert not [e for e in seen if e["type"] == "interrupted"]
        ws.send_text(json.dumps({"type": "played", "ms": 5000, "done": True}))
        _, seen, _ = until(ws, "state", state="listening")
        assert not [e for e in seen if e["type"] == "interrupted"]
        ws.send_text(json.dumps({"type": "end"}))
    saved = client.get(f"/api/v1/ai/conversations/{ada['id']}").json()["messages"]
    assert saved[-1]["cut_short"] is False and saved[-1]["content"].endswith("seventeen.")


def test_with_voice_interruption_off_the_microphone_is_ignored_while_speaking(
    client: TestClient, ada: dict[str, Any], monkeypatch: pytest.MonkeyPatch
) -> None:
    stt = ScriptedSTT({"text": "Tell me about Atlas", "language": "en"})
    install(client, stt, StubEngine(seconds_per_word=0.2, delay=0.04), 0.9)
    monkeypatch.setattr(Provider, "chat", speaking([], [], LONG))
    with connect(client, ada["id"], "&barge_in=false") as ws:
        begin(ws)
        say(ws)
        until(ws, "audio_start")
        playing(ws, 2.0, speech=True)
        _, seen, _ = until(ws, "speech_end")
        assert not [e for e in seen if e["type"] in ("duck", "barge_in", "interrupted")]
        ws.send_text(json.dumps({"type": "end"}))
    assert len(stt.audio) == 1


def test_noise_and_silence_do_not_reach_the_model(
    client: TestClient, ada: dict[str, Any], monkeypatch: pytest.MonkeyPatch
) -> None:
    stt = ScriptedSTT({"text": " [BLANK_AUDIO] ", "language": "en"})
    install(client, stt, StubEngine(), 0.9)
    called: list[Any] = []
    monkeypatch.setattr(Provider, "chat", speaking(called, [], "Should not be said."))
    with connect(client, ada["id"]) as ws:
        begin(ws)
        say(ws)
        until(ws, "state", state="transcribing")
        until(ws, "state", state="listening")
        ws.send_text(json.dumps({"type": "end"}))
    assert called == []


def test_one_voice_conversation_at_a_time(client: TestClient, ada: dict[str, Any]) -> None:
    install(client, ScriptedSTT(), StubEngine())
    with connect(client, ada["id"]) as ws:
        begin(ws)
        with connect(client, ada["id"]) as second:
            error = json.loads(second.receive()["text"])
            assert error["type"] == "error" and "already running" in error["text"]
            assert second.receive()["code"] == 4409
        ws.send_text(json.dumps({"type": "end"}))


def test_missing_engines_are_explained(client: TestClient, ada: dict[str, Any]) -> None:
    with connect(client, ada["id"]) as ws:
        error = json.loads(ws.receive()["text"])
        assert error["type"] == "error" and "Download" in error["text"]
        assert ws.receive()["code"] == 4412
    assert client.app.state.voice.session is None


def test_the_assistant_greets_by_name_and_the_greeting_is_not_a_message(
    client: TestClient, monkeypatch: pytest.MonkeyPatch, settings: Any
) -> None:
    config(client)
    monkeypatch.setattr("keyring.get_password", lambda *_: "")
    setup(client, user_name="Sam", voice={"language": "nl"})
    conversation = client.post("/api/v1/assistant/conversations").json()
    tts = StubEngine()
    install(client, ScriptedSTT(), tts)
    with connect(client, conversation["id"]) as ws:
        seen = begin(ws)
        assert next(e for e in seen if e["type"] == "audio_start")["text"] == "Hoi Sam."
        ws.send_text(json.dumps({"type": "end"}))
    assert client.get(f"/api/v1/ai/conversations/{conversation['id']}").json()["messages"] == []
    # Synthesized once: the next conversation plays it from the cache.
    assert list((settings.app_dir / "cache" / "voice").glob("greeting-*.pcm"))
    with connect(client, conversation["id"]) as ws:
        begin(ws)
        ws.send_text(json.dumps({"type": "end"}))
    assert [t for t, _ in tts.spoken] == ["Hoi Sam."]


def test_a_tool_wait_is_filled_with_speech_and_the_phase_follows_it(
    client: TestClient, ada: dict[str, Any], monkeypatch: pytest.MonkeyPatch
) -> None:
    """Search and read take seconds with nothing to hear: the assistant says it is looking,
    once more if the tool drags on, and goes back to "thinking" while it waits again."""
    import asyncio

    from graite.skills.registry import Registry
    from graite.voice import session as voice_session
    from graite.voice.fillers import FILLERS

    monkeypatch.setattr(voice_session, "STILL_AFTER", 0.1)
    original = Registry.invoke

    async def slow(self: Registry, name: str, arguments: str) -> str:
        if name == "search_vault":
            await asyncio.sleep(0.4)
        return await original(self, name, arguments)

    monkeypatch.setattr(Registry, "invoke", slow)
    rounds = [("search_vault", {"query": "Atlas"}), ("list_children", {"path": ""})]

    async def fake(self: Provider, messages: Any, tools: Any, **_: Any):  # type: ignore[no-untyped-def]
        done = sum(1 for m in messages if m.get("role") == "tool")
        if done < len(rounds):
            name, arguments = rounds[done]
            yield {
                "tool_calls": [
                    {
                        "index": 0,
                        "id": f"t{done}",
                        "function": {"name": name, "arguments": json.dumps(arguments)},
                    }
                ]
            }
            return
        yield {"content": "Atlas has no pages yet."}

    monkeypatch.setattr(Provider, "chat", fake)
    tts = StubEngine()
    install(client, ScriptedSTT({"text": "What about Atlas?", "language": "en"}), tts, 0.9)
    with connect(client, ada["id"]) as ws:
        begin(ws)
        say(ws)
        end, seen, _ = until(ws, "speech_end")
        ws.send_text(json.dumps({"type": "played", "ms": end["ms"], "done": True}))
        until(ws, "state", state="listening")
        ws.send_text(json.dumps({"type": "end"}))
    spoken = [e["text"] for e in seen if e["type"] == "audio_start"]
    assert len(spoken) == 3, spoken
    assert spoken[0] in FILLERS["en"]["search"]  # one filler for the first tool only
    assert spoken[1] in FILLERS["en"]["still"]  # and one more for a long tool round
    assert spoken[2] == "Atlas has no pages yet."
    states = [e["state"] for e in seen if e["type"] == "state"]
    assert states == ["transcribing", "thinking", "speaking", "thinking", "speaking"]
    assert [e["name"] for e in seen if e["type"] == "tool_end"] == ["search_vault", "list_children"]
    # The fillers were heard, but they are not part of the answer that is saved.
    saved = client.get(f"/api/v1/ai/conversations/{ada['id']}").json()["messages"]
    assert saved[-1]["content"] == "Atlas has no pages yet."


def test_fillers_follow_the_language_and_the_kind_of_tool() -> None:
    from graite.voice.fillers import FILLERS, filler, group

    assert group("search_vault") == "search" and group("read_page") == "read"
    assert group("propose_append") == "propose" and group("list_children") == "read"
    assert filler("read_page", "nl") in FILLERS["nl"]["read"]
    assert filler("propose_edit", "de") in FILLERS["en"]["propose"]  # English fallback
    assert filler(None, "nl-NL") in FILLERS["nl"]["still"]
    # Rotating: three asks do not say the same thing three times.
    assert len({filler("search_vault", "en") for _ in range(3)}) > 1


def test_voice_preserves_the_tool_budget_and_requests_brief_speech(
    client: TestClient, ada: dict[str, Any], monkeypatch: pytest.MonkeyPatch
) -> None:
    from graite.models.manager import Manager

    seen_configs: list[Any] = []
    original = Manager.use

    def use(self: Manager, override: Any = None) -> Any:
        seen_configs.append(override)
        return original(self, override)

    monkeypatch.setattr(Manager, "use", use)
    prompts: list[Any] = []
    install(client, ScriptedSTT({"text": "Hello", "language": "en"}), StubEngine(), 0.9)
    monkeypatch.setattr(Provider, "chat", speaking(prompts, [], "Hello to you."))
    with connect(client, ada["id"]) as ws:
        begin(ws)
        say(ws)
        until(ws, "speech_end")
        ws.send_text(json.dumps({"type": "end"}))
    # Room to finish a sentence; brevity is the prompt's job, not a hard cut that truncates
    # mid-thought or leaves a reasoning model with nothing to say.
    assert (
        seen_configs
        and seen_configs[-1].max_output_tokens == load_config(client.app.state.db).max_output_tokens
    )
    system = prompts[0][0]["content"]
    assert "read aloud" in system and "Default to one or two short sentences" in system
    assert "complete that request" in system


def test_the_test_bench_shows_levels_turn_taking_and_the_transcript(client: TestClient) -> None:
    """No assistant, no chat model, no voice engine: microphone, VAD, Smart Turn, Whisper."""
    stt = ScriptedSTT(
        {
            "text": " I was thinking about lunch ",
            "language": "en",
            "confidence": -0.1,
            "seconds": 0.3,
        }
    )
    install(client, stt, StubEngine(), 0.05, 0.97)
    with client.websocket_connect("/api/v1/voice/session?token=test-token&mode=test") as ws:
        ready, _, _ = until(ws, "ready")
        assert ready["mode"] == "test"
        say(ws, 0.8, 0.5)  # "I was thinking…" and a pause: not done yet
        pause, seen, _ = until(ws, "turn", state="incomplete")
        assert pause["probability"] == 0.05
        meters = [e for e in seen if e["type"] == "meter"]
        assert (
            meters and max(m["vad"] for m in meters) > 0.9 and max(m["level"] for m in meters) > 0.1
        )
        say(ws, 0.6, 0.5)  # "…about lunch."
        heard, seen, _ = until(ws, "transcript")
        assert {"type": "turn", "state": "complete", "probability": 0.97} in seen
        assert heard["text"] == "I was thinking about lunch" and heard["confidence"] == -0.1
        assert heard["audio_seconds"] > 1.5
        until(ws, "state", state="listening")  # and it listens again, nothing else happens
        ws.send_text(json.dumps({"type": "end"}))
    assert stt.running is False and client.app.state.voice.session is None
    assert not client.app.state.models.pinned and not client.app.state.foreground.active


def test_a_dead_microphone_is_reported(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    from graite.voice import session as voice_session

    monkeypatch.setattr(voice_session, "SILENT_AFTER", 1.0)
    monkeypatch.setattr(voice_session, "NEVER_HEARD_AFTER", 1.0)
    install(client, ScriptedSTT(), StubEngine())
    with client.websocket_connect("/api/v1/voice/session?token=test-token&mode=test") as ws:
        until(ws, "ready")
        for _ in range(40):
            ws.send_bytes(SILENCE)  # frames arrive, but they are digital silence
        silent, seen, _ = until(ws, "input_silent")
        assert silent["reason"] == "silence"
        assert any(e["type"] == "input" and e["frames"] > 0 and e["level"] == 0 for e in seen)
        say(ws, 1.2, 0.0)
        until(ws, "input_ok")
        ws.send_text(json.dumps({"type": "end"}))
    with client.websocket_connect("/api/v1/voice/session?token=test-token&mode=test") as ws:
        until(ws, "ready")
        silent, _, _ = until(ws, "input_silent")  # nothing sent at all
        assert silent["reason"] == "no_audio"
        ws.send_text(json.dumps({"type": "end"}))


def test_a_pause_is_not_a_broken_microphone(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Once the microphone has been heard, staying quiet is thinking, not a fault. The old
    watchdog warned after three seconds of any silence and re-armed on every pause."""
    from graite.voice import session as voice_session

    monkeypatch.setattr(voice_session, "SILENT_AFTER", 1.0)
    monkeypatch.setattr(voice_session, "NEVER_HEARD_AFTER", 1.0)
    # An empty transcript sends the turn straight back to listening, so this exercises the
    # watchdog and nothing downstream of it.
    install(client, ScriptedSTT({"text": "", "language": None}), StubEngine(), 0.05)
    with client.websocket_connect("/api/v1/voice/session?token=test-token&mode=test") as ws:
        until(ws, "ready")
        say(ws, 1.2, 2.5)  # the microphone proves itself, then the turn ends
        until(ws, "state", state="listening")
        for _ in range(150):  # a long, ordinary thinking pause
            ws.send_bytes(SILENCE)
        _, seen, _ = until(ws, "input", frames=0)
        assert not [e for e in seen if e["type"] == "input_silent"]
        ws.send_text(json.dumps({"type": "end"}))
