from __future__ import annotations

from pathlib import Path

from fastapi.testclient import TestClient

from graite import profile
from graite.profile import Profile, ProfileStore, clean_name
from graite.retrieval import answer
from graite.vault import policy


def test_profile_round_trips_and_cleans_the_name(tmp_path: Path) -> None:
    store = ProfileStore(tmp_path / "app" / "profile.json")
    assert store.load().first_name == ""
    store.save(Profile(first_name="  Sam \n Lee  "))
    # A second store over the same file sees it (another vault's daemon).
    assert ProfileStore(store.path).load().first_name == "Sam Lee"
    assert clean_name("x" * 200) == "x" * 60
    store.path.write_text("not json", encoding="utf-8")
    assert store.load().first_name == ""


def test_first_name_is_none_until_given(tmp_path: Path) -> None:
    before = profile.get_profile_store()
    try:
        profile.set_profile_store(None)
        assert profile.first_name() is None
        store = ProfileStore(tmp_path / "profile.json")
        profile.set_profile_store(store)
        assert profile.first_name() is None
        store.save(Profile(first_name="Sam"))
        assert profile.first_name() == "Sam"
    finally:
        profile.set_profile_store(before)


def test_profile_api(client: TestClient) -> None:
    assert client.get("/api/v1/profile").json() == {"first_name": ""}
    saved = client.put("/api/v1/profile", json={"first_name": " Sam "})
    assert saved.status_code == 200 and saved.json() == {"first_name": "Sam"}
    assert client.get("/api/v1/profile").json() == {"first_name": "Sam"}


def test_chat_and_agent_prompts_carry_the_name() -> None:
    effective = policy.Effective()
    named, _ = answer.messages(effective, [], [], [], "hi", 8192, user_name="Sam")
    plain, _ = answer.messages(effective, [], [], [], "hi", 8192)
    assert "The user's name is Sam." in named[0]["content"]
    assert "The user's name" not in plain[0]["content"]
    agent, _ = answer.agent_messages(
        effective, [], [], "Summarize.", "Run now.", 8192, propose=False, user_name="Sam"
    )
    assert "The user's name is Sam." in agent[0]["content"]
