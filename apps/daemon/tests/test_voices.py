from __future__ import annotations

import io
import math
import struct
import wave
from typing import Any

from fastapi.testclient import TestClient

from graite.voice.engines.stub import StubEngine
from tests.test_assistant import setup

URL = "/api/v1/voice/voices"
HEADERS = {"Content-Type": "application/octet-stream"}


def tone(seconds: float, rate: int = 44100) -> bytes:
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as wav:
        wav.setnchannels(2)
        wav.setsampwidth(2)
        wav.setframerate(rate)
        for n in range(int(seconds * rate)):
            sample = int(9000 * math.sin(2 * math.pi * 220 * n / rate))
            wav.writeframesraw(struct.pack("<hh", sample, sample))
    return buffer.getvalue()


def test_a_voice_needs_consent_and_enough_speech(client: TestClient) -> None:
    assert client.get(URL).json() == {"voices": []}
    refused = client.post(f"{URL}?name=Me", content=tone(4), headers=HEADERS)
    assert refused.status_code == 400 and "permission" in refused.json()["detail"]
    short = client.post(f"{URL}?name=Me&consent=true", content=tone(1), headers=HEADERS)
    assert short.status_code == 400 and "three seconds" in short.json()["detail"]
    junk = client.post(f"{URL}?name=Me&consent=true", content=b"not audio", headers=HEADERS)
    assert junk.status_code == 400
    assert client.get(URL).json() == {"voices": []}


def test_voices_live_in_the_app_folder_and_are_chosen_in_the_assistant(
    client: TestClient, settings: Any
) -> None:
    made = client.post(
        f"{URL}?name=My voice&consent=true&filename=me.wav", content=tone(5), headers=HEADERS
    )
    assert made.status_code == 201
    voice = made.json()
    assert voice["name"] == "My voice" and 4.9 < voice["seconds"] < 5.1 and voice["consent_at"]
    clip = settings.app_dir / "voices" / voice["id"] / "voice.wav"
    with wave.open(str(clip)) as stored:
        assert (stored.getframerate(), stored.getnchannels(), stored.getsampwidth()) == (
            24000,
            1,
            2,
        )
    assert not list(settings.vault.rglob("voice.wav"))  # not vault content
    assert [v["id"] for v in client.get(URL).json()["voices"]] == [voice["id"]]
    renamed = client.patch(f"{URL}/{voice['id']}", json={"name": "Studio me"}).json()
    assert renamed["name"] == "Studio me"

    info = setup(client, voice={"language": "nl", "voice_id": voice["id"], "exaggeration": 0.7})
    assert info["voice"]["voice_id"] == voice["id"]
    state = client.app.state
    resolved, auto = state.voice.voice_for(state.definitions.assistant())
    assert resolved.reference == clip and resolved.language == "nl" and auto is False
    assert (
        client.put(
            "/api/v1/assistant", json={"name": "Ada", "voice": {"voice_id": "../etc"}}
        ).status_code
        == 400
    )

    # A sample in any voice, without saving anything; the engine stays warm for the next one.
    engine = StubEngine()
    state.voice.make_tts = lambda _config: engine
    for body in ({"voice_id": voice["id"], "text": "Testing one two."}, {"voice_id": "built-in"}):
        sample = client.post("/api/v1/voice/preview", json=body)
        assert sample.status_code == 200 and sample.content[:4] == b"RIFF"
    assert [v.reference for _, v in engine.spoken] == [clip, None]
    assert engine.loaded and engine.spoken[0][0] == "Testing one two."
    assert (
        client.post("/api/v1/voice/preview", json={"voice_id": "v_000000000000"}).status_code == 404
    )

    # Deleting the voice falls back to the built-in one instead of breaking the assistant.
    assert client.delete(f"{URL}/{voice['id']}").json() == {"ok": True}
    assert state.voice.voice_for(state.definitions.assistant())[0].reference is None
    assert client.delete(f"{URL}/nonsense").status_code == 404
