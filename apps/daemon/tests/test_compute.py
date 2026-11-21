"""AI on another of the account's computers: two daemons, one fake engine."""

from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Any

import httpx
import pytest

from graite.compute import serve
from graite.compute.service import CallFailed
from graite.models.config import AIConfig, SaveConfig, is_cloud, load_config, save_config
from graite.models.providers import Provider
from tests.test_sync_client import Device, devices, hub, wait  # noqa: F401

WORDS = ["Hello", " from", " the", " desk", "."]


class FakeEngine:
    """A llama-server stand-in: streams WORDS, remembers what it was asked."""

    def __init__(self) -> None:
        self.requests: list[dict[str, Any]] = []
        self.started = 0
        self.finished = 0

    async def stream(self) -> AsyncIterator[bytes]:
        self.started += 1
        for word in WORDS:
            chunk = {"choices": [{"delta": {"content": word}}]}
            yield f"data: {json.dumps(chunk)}\n\n".encode()
        done = {"choices": [{"delta": {}, "finish_reason": "stop"}], "usage": {"total_tokens": 9}}
        yield f"data: {json.dumps(done)}\n\ndata: [DONE]\n\n".encode()
        self.finished += 1

    def handler(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(json.loads(request.content))
        return httpx.Response(
            200, headers={"content-type": "text/event-stream"}, content=self.stream()
        )


def serve_with(desk: Device, engine: FakeEngine, monkeypatch: pytest.MonkeyPatch) -> None:
    """The desk has a local model (the fake engine) and shares it."""
    state = desk.web.app.state  # type: ignore[union-attr]

    def set_up() -> None:
        save_config(state.db, SaveConfig(provider="local", model_path="/models/gemma-3-4b.gguf"))

    @asynccontextmanager
    async def use(config: AIConfig | None = None) -> AsyncIterator[Provider]:
        yield Provider("local", "http://engine.test/v1", "local", "engine-key")

    async def apply(inner: Any) -> None:
        set_up()
        inner.models.use = use
        inner.compute.handlers = serve.handlers(inner, httpx.MockTransport(engine.handler))
        inner.compute.set_serving(True)

    desk.run(apply)


def test_chat_runs_on_the_other_computers_model_and_streams_back(
    devices: tuple[Device, Device],  # noqa: F811
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    laptop, desk = devices
    engine = FakeEngine()
    serve_with(desk, engine, monkeypatch)

    found = laptop.web.get("/api/v1/compute/status").json()  # type: ignore[union-attr]
    assert [(d["id"], d["chat_model"], d["uses"]) for d in found["devices"]] == [
        ("desk", "gemma-3-4b", [])
    ]
    chosen = laptop.web.post("/api/v1/compute/use", json={"device_id": "desk"})  # type: ignore[union-attr]
    assert chosen.status_code == 200 and chosen.json()["provider"] == "device"
    assert chosen.json()["model"] == "gemma-3-4b"
    status = laptop.web.get("/api/v1/ai/status").json()  # type: ignore[union-attr]
    assert status["active"]["label"] == "gemma-3-4b" and status["active"]["kind"] == "device"
    assert laptop.web.get("/api/v1/compute/status").json()["devices"][0]["uses"] == ["chat"]  # type: ignore[union-attr]

    async def ask(state: Any) -> tuple[str, dict[str, Any], bool]:
        config = load_config(state.db)
        question = [{"role": "user", "content": "Who is there?"}]
        text = ""
        async with state.models.use() as provider:
            async for delta in provider.chat(question, []):
                text += delta.get("content") or ""
            return text, dict(provider.metrics), is_cloud(config)

    text, metrics, cloud = laptop.run(ask)
    assert text == "Hello from the desk."
    assert metrics.get("total_tokens") == 9
    # The user's own computer counts as local: local-only pages may use it (D122).
    assert cloud is False
    sent = engine.requests[0]
    assert sent["model"] == "local" and sent["stream"] is True
    assert sent["messages"][-1] == {"role": "user", "content": "Who is there?"}


def test_a_computer_that_does_not_share_refuses_and_says_so(
    devices: tuple[Device, Device],  # noqa: F811
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    laptop, desk = devices
    engine = FakeEngine()
    serve_with(desk, engine, monkeypatch)

    async def off(state: Any) -> None:
        state.compute.set_serving(False)

    desk.run(off)
    assert laptop.web.get("/api/v1/compute/status").json()["devices"] == []  # type: ignore[union-attr]
    refused = laptop.web.post("/api/v1/compute/use", json={"device_id": "desk"})  # type: ignore[union-attr]
    assert refused.status_code == 400

    async def ask(state: Any) -> str:
        try:
            await state.compute.ask("desk", "chat", {}, b"{}")
        except CallFailed as exc:
            return str(exc)
        return ""

    assert "does not share its AI" in laptop.run(ask)
    assert engine.requests == []


def test_this_computer_shares_only_after_the_switch(
    devices: tuple[Device, Device],  # noqa: F811
) -> None:
    laptop, _ = devices
    web = laptop.web
    assert web is not None
    assert web.get("/api/v1/compute/status").json()["serving"] is False
    assert web.put("/api/v1/compute/serve", json={"on": True}).json()["serving"] is True
    assert web.put("/api/v1/compute/serve", json={"on": False}).json()["serving"] is False


def test_a_call_to_a_computer_that_went_away_fails_instead_of_waiting(
    devices: tuple[Device, Device],  # noqa: F811
) -> None:
    laptop, desk = devices
    desk.stop()
    wait(lambda: "desk" not in laptop.sync.peers)

    async def ask(state: Any) -> str:
        try:
            await state.compute.ask("desk", "info", {})
        except ValueError as exc:
            return str(exc)
        return ""

    assert "not connected" in laptop.run(ask)


def test_stopping_an_answer_stops_the_other_computers_model(
    devices: tuple[Device, Device],  # noqa: F811
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    laptop, desk = devices
    engine = FakeEngine()

    async def slow() -> AsyncIterator[bytes]:
        engine.started += 1
        yield b'data: {"choices": [{"delta": {"content": "One"}}]}\n\n'
        await asyncio.sleep(30)
        engine.finished += 1

    engine.stream = slow  # type: ignore[method-assign]
    serve_with(desk, engine, monkeypatch)

    async def ask_and_stop(state: Any) -> bytes:
        reply = await state.compute.call("desk", "chat", {}, b'{"messages": []}')
        async for piece in reply.pieces():
            await reply.close()
            return bytes(piece)
        return b""

    assert b"One" in laptop.run(ask_and_stop)

    async def running(state: Any) -> int:
        return len(state.compute._running)

    wait(lambda: desk.run(running) == 0, seconds=5)
    assert engine.started == 1 and engine.finished == 0


# ------------------------------------------------------------ documents, speech and voice


class FakeWhisper:
    """A Whisper server stand-in that counts how often it had to load."""

    loads = 0
    heard: list[tuple[int, str]] = []

    def __init__(self, model: str, binary_path: str = "", engine_path: str = "") -> None:
        self.running = False

    async def start(self) -> None:
        if not self.running:
            type(self).loads += 1
            self.running = True

    async def transcribe(
        self, audio: bytes, *, language: str = "auto", max_seconds: int = 300
    ) -> dict[str, Any]:
        self.heard.append((len(audio), language))
        return {"text": " Good morning. ", "language": "en", "seconds": 0.1, "confidence": -0.1}

    async def stop(self) -> None:
        self.running = False


class FakeVoice:
    """A voice engine stand-in: says the text back as bytes, remembers the voices it used."""

    name, sample_rate, controls = "fake-voice", 16000, ("speed",)
    loads = 0
    voices: list[bytes | None] = []

    async def load(self) -> None:
        type(self).loads += 1

    async def unload(self) -> None:
        return None

    def memory_bytes(self) -> int:
        return 0

    async def synthesize(self, text: str, voice: Any) -> AsyncIterator[bytes]:
        self.voices.append(voice.reference.read_bytes() if voice.reference else None)
        for word in text.split():
            yield word.encode()


def workstation(desk: Device, monkeypatch: pytest.MonkeyPatch) -> list[str]:
    """The desk has models for documents, speech and voice (all fakes) and shares them.
    Returns the file names it was asked to read."""
    read: list[str] = []

    async def recognize(path: Any, model: str, projector: str, config: Any, progress: Any) -> str:
        read.append(path.name)
        progress("Reading page 1 of 1…")
        return "Invoice 42: " + path.read_bytes().decode()

    FakeWhisper.loads, FakeWhisper.heard = 0, []
    FakeVoice.loads, FakeVoice.voices = 0, []
    engine = FakeVoice()
    monkeypatch.setattr(serve, "recognize", recognize)
    monkeypatch.setattr(serve, "SpeechServer", FakeWhisper)
    monkeypatch.setattr(serve, "speech_binary", lambda *paths: "/bin/whisper")
    monkeypatch.setattr(serve, "validate_audio", lambda audio, limit: None)
    monkeypatch.setattr(serve, "audio_wav", lambda path: b"WAV:" + path.read_bytes())
    monkeypatch.setattr(serve, "get_engine", lambda config, downloads: engine)

    async def apply(inner: Any) -> None:
        for item_id in (serve.OCR_MODEL, serve.SPEECH_MODEL):
            inner.downloads.items[item_id].status = "installed"
        inner.compute.handlers = serve.handlers(inner)
        inner.compute.set_serving(True)

    desk.run(apply)
    return read


def use(laptop: Device, what: str, on: bool = True) -> dict[str, Any]:
    response = laptop.web.post(  # type: ignore[union-attr]
        "/api/v1/compute/use", json={"device_id": "desk", "what": what, "on": on}
    )
    assert response.status_code == 200, response.text
    return dict(response.json())


def test_the_other_computer_is_offered_for_what_it_can_do(
    devices: tuple[Device, Device],  # noqa: F811
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    laptop, desk = devices
    workstation(desk, monkeypatch)
    found = laptop.web.get("/api/v1/compute/status").json()["devices"]  # type: ignore[union-attr]
    assert [(d["chat_model"], d["documents"], d["speech"], d["voice"]) for d in found] == [
        (None, True, True, True)
    ]
    # No chat model there, so chat cannot be moved to it.
    refused = laptop.web.post("/api/v1/compute/use", json={"device_id": "desk"})  # type: ignore[union-attr]
    assert refused.status_code == 400

    assert use(laptop, "documents")["ocr_provider"] == "device"
    assert use(laptop, "voice")["tts_device_name"]
    found = laptop.web.get("/api/v1/compute/status").json()["devices"]  # type: ignore[union-attr]
    assert found[0]["uses"] == ["documents", "voice"]
    assert laptop.web.get("/api/v1/ai/status").json()["ocr_source"] == "device"  # type: ignore[union-attr]
    # And back to this computer.
    back = use(laptop, "documents", on=False)
    assert back["ocr_provider"] == "auto" and back["ocr_device_id"] == ""


def test_a_document_is_read_by_the_other_computer(
    devices: tuple[Device, Device],  # noqa: F811
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Any,
) -> None:
    from graite.compute.remote import recognize_device

    laptop, desk = devices
    read = workstation(desk, monkeypatch)
    scan = tmp_path / "scan.png"
    scan.write_bytes(b"total 12 euro " * 40_000)  # more than one piece on the wire

    async def ask(state: Any) -> tuple[str, list[str]]:
        said: list[str] = []
        return await recognize_device(state.compute, "desk", scan, said.append), said

    text, said = laptop.run(ask)
    assert text.startswith("Invoice 42: total 12 euro") and len(text) > 500_000
    assert read == ["source.png"]
    assert said == ["Sending to your other computer…", "Reading page 1 of 1…"]


def test_speech_is_heard_by_the_other_computer_which_keeps_its_model_loaded(
    devices: tuple[Device, Device],  # noqa: F811
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from graite.compute.remote import DeviceSpeech, transcribe_device

    laptop, desk = devices
    workstation(desk, monkeypatch)
    use(laptop, "speech")

    async def ask(state: Any) -> tuple[Any, Any, str]:
        config = load_config(state.db)
        live = state.voice.make_stt(config)
        first = await live.transcribe(b"RIFFturn", language="nl")
        second = await transcribe_device(state.compute, "desk", b"ID3song", kind="mp3")
        return first, second, type(live).__name__

    first, second, kind = laptop.run(ask)
    assert kind == DeviceSpeech.__name__
    assert first["text"] == "Good morning." and first["language"] == "en"
    assert first["confidence"] == -0.1
    assert second["text"] == "Good morning."
    # The recording that was not WAV was decoded there; the model loaded once for both.
    assert FakeWhisper.heard == [(8, "nl"), (len(b"WAV:ID3song"), "auto")]
    assert FakeWhisper.loads == 1


def test_the_assistant_speaks_with_the_other_computers_voice(
    devices: tuple[Device, Device],  # noqa: F811
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Any,
) -> None:
    from graite.compute.remote import DeviceVoice
    from graite.voice.tts import Voice

    laptop, desk = devices
    workstation(desk, monkeypatch)
    use(laptop, "voice")
    clip = tmp_path / "me.wav"
    clip.write_bytes(b"my own voice")

    async def speak(state: Any) -> tuple[str, int, tuple[str, ...], list[bytes]]:
        engine = state.voice.make_tts(load_config(state.db))
        await engine.load()
        said = [piece async for piece in engine.synthesize("Hello there", Voice())]
        said += [piece async for piece in engine.synthesize("Hi", Voice(reference=clip))]
        said += [piece async for piece in engine.synthesize("again", Voice(reference=clip))]
        return type(engine).__name__, engine.sample_rate, engine.controls, said

    kind, rate, controls, said = laptop.run(speak)
    assert kind == DeviceVoice.__name__
    assert (rate, controls) == (16000, ("speed",))
    assert said == [b"Hello", b"there", b"Hi", b"again"]
    # The clip travelled once and was there the second time.
    assert FakeVoice.voices == [None, b"my own voice", b"my own voice"]
    ready = laptop.web.get("/api/v1/voice/status").json()  # type: ignore[union-attr]
    assert "tts" not in [m["key"] for m in ready["missing"]]
    assert ready["controls"] == ["speed"]


def test_a_computer_without_the_model_says_what_to_do_there(
    devices: tuple[Device, Device],  # noqa: F811
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Any,
) -> None:
    from graite.compute.remote import recognize_device

    laptop, desk = devices
    workstation(desk, monkeypatch)
    use(laptop, "documents")

    async def remove(state: Any) -> None:
        state.downloads.items[serve.OCR_MODEL].status = "available"

    desk.run(remove)
    scan = tmp_path / "scan.png"
    scan.write_bytes(b"x")

    async def ask(state: Any) -> str:
        try:
            return await recognize_device(state.compute, "desk", scan, lambda message: None)
        except ValueError as exc:
            return str(exc)

    assert "Settings → Documents" in laptop.run(ask)


def test_chat_can_ask_for_any_chat_model_the_other_computer_has(
    devices: tuple[Device, Device],  # noqa: F811
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    laptop, desk = devices
    engine = FakeEngine()
    serve_with(desk, engine, monkeypatch)
    loaded: list[tuple[str, str]] = []

    async def second_model(inner: Any) -> None:
        item = next(m for m in inner.downloads.items.values() if m.role == "chat")
        item.status, item.local_path = "installed", "/models/big-one-27b.gguf"
        # The desk itself chats through Graite Cloud; its own engine still answers calls.
        save_config(
            inner.db,
            SaveConfig(
                provider="graite", model="cloud-model", model_path="/models/gemma-3-4b.gguf"
            ),
        )

        @asynccontextmanager
        async def use(config: AIConfig | None = None) -> AsyncIterator[Provider]:
            assert config is not None
            loaded.append((config.provider, config.model_path))
            yield Provider("local", "http://engine.test/v1", "local", "engine-key")

        inner.models.use = use

    desk.run(second_model)
    found = laptop.web.get("/api/v1/compute/status").json()["devices"][0]  # type: ignore[union-attr]
    assert found["chat_model"] == "gemma-3-4b"
    assert found["chat_models"] == ["gemma-3-4b", "big-one-27b"]

    chosen = laptop.web.post(  # type: ignore[union-attr]
        "/api/v1/compute/use", json={"device_id": "desk", "model": "big-one-27b"}
    )
    assert chosen.status_code == 200 and chosen.json()["model"] == "big-one-27b"
    found = laptop.web.get("/api/v1/compute/status").json()["devices"][0]  # type: ignore[union-attr]
    assert found["chat_model"] == "big-one-27b" and found["uses"] == ["chat"]
    unknown = laptop.web.post(  # type: ignore[union-attr]
        "/api/v1/compute/use", json={"device_id": "desk", "model": "not-there"}
    )
    assert unknown.status_code == 400

    async def ask(state: Any) -> str:
        text = ""
        async with state.models.use() as provider:
            async for delta in provider.chat([{"role": "user", "content": "Hi"}], []):
                text += delta.get("content") or ""
        return text

    assert laptop.run(ask) == "Hello from the desk."
    assert loaded == [("local", "/models/big-one-27b.gguf")]

    # A model that has since been removed there is refused by name.
    async def removed(state: Any) -> str:
        try:
            await state.compute.ask("desk", "chat", {"model": "gone-1b"}, b'{"messages": []}')
        except CallFailed as exc:
            return str(exc)
        return ""

    assert "gone-1b is no longer on that computer" in laptop.run(removed)
