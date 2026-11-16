"""Who may read a page (`cloud: allowed | local-only | none`), what counts as a local model,
and chats that look at every page or at none."""

from __future__ import annotations

from typing import Any

import pytest
from fastapi.testclient import TestClient

from graite.models.config import AIConfig, is_cloud
from graite.models.providers import Provider
from graite.retrieval import answer
from graite.retrieval.scope import Scope, resolve
from graite.review.policy import decide
from graite.vault import policy
from tests.test_ai import page
from tests.test_page_permissions import settings

REMOTE = "https://models.example/v1"


def use_server(client: TestClient, base_url: str | None = None) -> None:
    body: dict[str, Any] = {"provider": "compatible", "model": "test"}
    if base_url:
        body["base_url"] = base_url
    assert client.put("/api/v1/ai/config", json=body).status_code == 200


def ask(client: TestClient, monkeypatch: pytest.MonkeyPatch, scope: dict[str, Any]) -> Any:
    """Send one message; returns (response text, prompts the model was given)."""
    conversation = client.post("/api/v1/ai/conversations", json={"scope": scope}).json()
    called: list[Any] = []

    async def fake(self: Provider, messages: Any, tools: Any):  # type: ignore[no-untyped-def]
        called.append(messages)
        yield {"content": "An answer."}

    monkeypatch.setattr(Provider, "chat", fake)
    response = client.post(
        f"/api/v1/ai/conversations/{conversation['id']}/messages", json={"message": "Summarize"}
    )
    return response.text, called


@pytest.mark.parametrize(
    ("provider", "base_url", "cloud"),
    [
        ("local", "http://127.0.0.1:1234/v1", False),
        ("compatible", "http://127.0.0.1:1234/v1", False),
        ("compatible", "http://localhost:11434/v1", False),
        ("compatible", "http://[::1]:8080/v1", False),
        ("compatible", "https://192.168.1.20:1234/v1", True),  # another machine on the network
        ("compatible", REMOTE, True),
        ("anthropic", "https://api.anthropic.com", True),
        ("graite", "http://127.0.0.1:8000", True),  # hosted, whatever the address says
    ],
)
def test_only_this_computer_counts_as_local(provider: str, base_url: str, cloud: bool) -> None:
    assert is_cloud(AIConfig(provider=provider, base_url=base_url)) is cloud  # type: ignore[arg-type]


def test_page_access_only_gets_stricter_going_down(client: TestClient) -> None:
    parent = page(client, "Journal")
    child = page(client, "Health", parent["path"])
    settings(client, parent["path"], cloud="local-only")
    # A child cannot open what its parent closed, but it can close further.
    settings(client, child["path"], cloud="allowed")
    resolver = policy.Resolver(client.app.state.settings.vault, client.app.state.db)
    assert resolver.resolve(child["path"]).values["cloud"] == "local-only"
    settings(client, child["path"], cloud="none")
    resolver = policy.Resolver(client.app.state.settings.vault, client.app.state.db)
    effective = resolver.resolve(child["path"])
    assert effective.values["cloud"] == "none"
    assert not effective.ai_allowed and not effective.cloud_allowed
    assert not effective.readable(cloud=False) and not effective.readable(cloud=True)
    parent_policy = resolver.resolve(parent["path"])
    assert parent_policy.readable(cloud=False) and not parent_policy.readable(cloud=True)
    with pytest.raises(ValueError, match="allowed, local-only or none"):
        policy.validate({"cloud": "sometimes"})


def test_a_page_closed_to_ai_is_left_out_for_local_models_too(client: TestClient) -> None:
    open_page = page(client, "Notes")
    closed = page(client, "Diary")
    below = page(client, "Entry", closed["path"])
    settings(client, closed["path"], cloud="none")
    state = client.app.state
    local = resolve(state.db, state.settings.vault, Scope("vault"), cloud_provider=False)
    assert local.excluded_no_ai == [closed["path"], below["path"]]
    assert local.paths == [open_page["path"]] and not local.all_pages
    assert not local.contains(closed["path"]) and local.contains(open_page["path"])
    cloud = resolve(state.db, state.settings.vault, Scope("vault"), cloud_provider=True)
    assert cloud.excluded_no_ai == local.excluded_no_ai and cloud.excluded_local_only == []
    refused = decide(local.policy_for(closed["path"]), "edit", cloud_model=False)
    assert refused.action == "refuse" and "turned off" in refused.reason


def test_chat_refuses_a_page_closed_to_ai(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    use_server(client)  # on this computer
    doc = page(client, "Diary")
    settings(client, doc["path"], cloud="none")
    text, called = ask(client, monkeypatch, {"kind": "page", "roots": [doc["path"]]})
    assert "AI is turned off for this page" in text and not called


def test_a_server_on_this_computer_may_read_a_local_only_page(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    doc = page(client, "Private")
    settings(client, doc["path"], cloud="local-only")
    scope = {"kind": "page", "roots": [doc["path"]]}
    use_server(client)  # 127.0.0.1
    text, called = ask(client, monkeypatch, scope)
    assert called and "local models only" not in text
    use_server(client, REMOTE)
    text, called = ask(client, monkeypatch, scope)
    assert "local models only" in text and not called


def test_a_chat_with_no_pages_answers_without_the_notes(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    use_server(client)
    page(client, "Notes")
    text, called = ask(client, monkeypatch, {"kind": "none"})
    assert called, text
    system = called[0][0]["content"]
    assert "selected no pages" in system and "## Your pages" not in system
    assert "No pages are selected" in text
    state = client.app.state
    nothing = resolve(state.db, state.settings.vault, Scope("none"), cloud_provider=False)
    assert nothing.paths == [] and not nothing.all_pages
    assert Scope.parse({"kind": "none", "roots": ["Notes"]}).to_dict() == {
        "kind": "none",
        "roots": [],
        "excluded": [],
    }


def test_all_pages_sends_the_page_list_not_the_page_bodies(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    use_server(client)
    for n in range(6):
        doc = page(client, f"Topic {n}")
        client.put(
            f"/api/v1/pages/{doc['path']}",
            json={"body": f"UNIQUEBODY{n} " + "filler sentence. " * 200, "base_hash": doc["hash"]},
        )
    text, called = ask(client, monkeypatch, {"kind": "vault"})
    assert called, text
    prompt = "\n".join(str(m.get("content")) for m in called[0])
    # Every page is named in the map; none of their text is loaded for an unrelated question.
    assert all(f"Topic {n}" in prompt for n in range(6))
    assert "UNIQUEBODY" not in prompt


def test_a_page_chat_can_look_at_all_pages_or_none_and_stays_with_its_page(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    use_server(client)
    doc = page(client, "Atlas")
    page(client, "Elsewhere")
    created = client.post(
        "/api/v1/ai/conversations", json={"page_path": doc["path"], "scope": {"kind": "vault"}}
    ).json()
    assert created["page_id"] == doc["id"]
    assert created["scope"] == {"kind": "vault", "roots": [], "excluded": []}
    listed = client.get("/api/v1/ai/conversations", params={"page_path": doc["path"]}).json()
    assert [c["id"] for c in listed] == [created["id"]]

    called: list[Any] = []

    async def fake(self: Provider, messages: Any, tools: Any):  # type: ignore[no-untyped-def]
        called.append(messages)
        yield {"content": "An answer."}

    monkeypatch.setattr(Provider, "chat", fake)
    sent = client.post(
        f"/api/v1/ai/conversations/{created['id']}/messages", json={"message": "What is here?"}
    )
    system = called[0][0]["content"]
    # It may read every page, and still knows which page the user is on.
    assert "Elsewhere" in system and f"[[{doc['path']}]]" in system, sent.text

    for kind in ("none", "folder", "vault"):
        scope = {"kind": kind, "roots": [doc["path"]] if kind == "folder" else []}
        patched = client.patch(f"/api/v1/ai/conversations/{created['id']}", json={"scope": scope})
        assert patched.status_code == 200 and patched.json()["scope"]["kind"] == kind


def test_no_pages_note_is_part_of_the_prompt() -> None:
    effective = policy.Effective()
    with_note, _ = answer.messages(effective, [], [], [], "hi", 8192, no_pages=True)
    without, _ = answer.messages(effective, [], [], [], "hi", 8192)
    assert "selected no pages" in with_note[0]["content"]
    assert "selected no pages" not in without[0]["content"]
