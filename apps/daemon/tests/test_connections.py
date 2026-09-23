from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

from graite.models.config import AIConfig, credential_id, credential_id_for
from graite.models.connections import OPENROUTER_URL, Store, get_store


def test_store_round_trips_connections_and_models(tmp_path: Path) -> None:
    store = Store(tmp_path / "app" / "connections.json")
    assert store.connections() == [] and store.models() == []
    router = store.add_connection("OpenRouter", "compatible", OPENROUTER_URL + "/")
    assert router.base_url == OPENROUTER_URL and router.id.startswith("c_")
    claude = store.add_connection("Work Claude", "anthropic", "https://ignored.example")
    assert claude.base_url == "https://api.anthropic.com"
    server = store.add_connection("", "compatible", "http://127.0.0.1:1234/v1/")
    assert server.name == "Model server" and server.base_url == "http://127.0.0.1:1234/v1"
    saved = store.add_model(router.id, "anthropic/claude-sonnet-4", context_length=200000)
    assert saved.label == "claude-sonnet-4" and saved.id.startswith("m_")
    again = store.add_model(router.id, "anthropic/claude-sonnet-4", label="Other")
    assert again.id == saved.id  # one row per connection + model
    # A second store over the same file sees the same data (another vault's daemon).
    other = Store(store.path)
    assert [c.id for c in other.connections()] == [router.id, claude.id, server.id]
    assert other.resolve(saved.id) is not None and other.resolve("m_missing") is None
    assert "key_saved" not in store.path.read_text()
    store.update_connection(server.id, name="LM Studio", base_url="http://localhost:1234/v1")
    assert other.connection(server.id).name == "LM Studio"  # type: ignore[union-attr]
    assert store.remove_connection(router.id) == [saved.id]
    assert store.models() == [] and [c.id for c in store.connections()] == [claude.id, server.id]
    with pytest.raises(KeyError):
        store.add_model("c_nope", "x")
    with pytest.raises(ValueError):
        store.add_connection("x", "local")
    with pytest.raises(ValueError):
        store.add_connection("x", "openrouter")


def test_version_one_files_fold_openrouter_into_model_servers(tmp_path: Path) -> None:
    path = tmp_path / "connections.json"
    path.write_text(
        json.dumps(
            {
                "version": 1,
                "connections": [
                    {
                        "id": "c_router",
                        "name": "My OpenRouter",
                        "kind": "openrouter",
                        "base_url": OPENROUTER_URL,
                        "created_at": "2026-01-01T00:00:00+00:00",
                    }
                ],
                "models": [
                    {
                        "id": "m_1",
                        "connection_id": "c_router",
                        "model": "openai/gpt-4o",
                        "label": "GPT-4o",
                        "added_at": "2026-01-01T00:00:00+00:00",
                    }
                ],
            }
        )
    )
    store = Store(path)
    (only,) = store.connections()
    assert only.kind == "compatible" and only.base_url == OPENROUTER_URL
    assert only.name == "My OpenRouter" and store.models(only.id)[0].label == "GPT-4o"
    written = json.loads(path.read_text())
    assert written["version"] == 2 and written["connections"][0]["kind"] == "compatible"
    # Old vault configs naming the retired provider normalise the same way.
    legacy = AIConfig(provider="openrouter", model="openai/gpt-4o")
    assert legacy.provider == "compatible" and legacy.base_url == OPENROUTER_URL


def test_keychain_accounts_are_per_connection_with_a_legacy_fallback() -> None:
    legacy = credential_id(AIConfig(provider="compatible", base_url=OPENROUTER_URL))
    assert credential_id_for("openrouter", OPENROUTER_URL) == legacy
    assert credential_id_for("compatible", OPENROUTER_URL) == legacy
    assert credential_id_for("anthropic", "ignored") == credential_id(
        AIConfig(provider="anthropic")
    )
    own = credential_id_for("compatible", OPENROUTER_URL, "c_1")
    assert own != legacy and own != credential_id_for("compatible", OPENROUTER_URL, "c_2")
    assert (
        credential_id(AIConfig(provider="compatible", base_url=OPENROUTER_URL, connection_id="c_1"))
        == own
    )


def test_legacy_config_is_linked_to_a_connection_on_load(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr("keyring.get_password", lambda *_: "")
    db = client.app.state.db
    legacy = AIConfig(provider="compatible", base_url=OPENROUTER_URL, model="openai/gpt-4o")
    db.execute("INSERT OR REPLACE INTO meta VALUES ('ai_config', ?)", (legacy.model_dump_json(),))
    status = client.get("/api/v1/ai/status").json()
    config = status["config"]
    assert config["connection_id"] and config["saved_model_id"]
    assert status["active"] == {
        "label": "gpt-4o",
        "connection_name": "Model server",
        "kind": "compatible",
        "model": "openai/gpt-4o",
    }
    listed = client.get("/api/v1/ai/connections").json()
    assert [c["id"] for c in listed["connections"]] == [config["connection_id"]]
    assert listed["models"][0]["model"] == "openai/gpt-4o"
    # Loading again does not create a second connection.
    client.get("/api/v1/ai/status")
    assert len(client.get("/api/v1/ai/connections").json()["connections"]) == 1


def test_connections_api_and_picking_a_saved_model(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    keys: dict[str, str] = {}
    monkeypatch.setattr("keyring.set_password", lambda s, n, v: keys.__setitem__(n, v))
    monkeypatch.setattr("keyring.get_password", lambda s, n: keys.get(n))
    monkeypatch.setattr("keyring.delete_password", lambda s, n: keys.pop(n, None))
    created = client.post(
        "/api/v1/ai/connections",
        json={
            "name": "OpenRouter",
            "kind": "compatible",
            "base_url": OPENROUTER_URL,
            "api_key": "sk-or-test",
        },
    )
    assert created.status_code == 201, created.text
    connection = created.json()
    assert connection["base_url"] == OPENROUTER_URL and connection["key_saved"] is True
    assert "sk-or-test" not in created.text
    assert keys[credential_id_for("compatible", OPENROUTER_URL, connection["id"])] == "sk-or-test"
    # A second, differently named connection to the same host keeps its own key.
    second = client.post(
        "/api/v1/ai/connections",
        json={
            "name": "OpenRouter (work)",
            "kind": "compatible",
            "base_url": OPENROUTER_URL,
            "api_key": "sk-or-work",
        },
    ).json()
    assert keys[credential_id_for("compatible", OPENROUTER_URL, second["id"])] == "sk-or-work"
    assert keys[credential_id_for("compatible", OPENROUTER_URL, connection["id"])] == "sk-or-test"
    # A key saved before connections existed is still found, under the kind + endpoint account.
    legacy = client.post(
        "/api/v1/ai/connections",
        json={"name": "LM Studio", "kind": "compatible", "base_url": "http://127.0.0.1:1234/v1"},
    ).json()
    assert legacy["key_saved"] is False
    keys[credential_id_for("compatible", "http://127.0.0.1:1234/v1")] = "old-key"
    listed = {c["id"]: c for c in client.get("/api/v1/ai/connections").json()["connections"]}
    assert listed[legacy["id"]]["key_saved"] is True
    # Rename and repoint a model server; the URL is validated like any other.
    patched = client.patch(
        f"/api/v1/ai/connections/{legacy['id']}",
        json={"name": "Ollama", "base_url": "http://localhost:11434/v1/"},
    )
    assert patched.status_code == 200, patched.text
    assert patched.json()["name"] == "Ollama"
    assert patched.json()["base_url"] == "http://localhost:11434/v1"
    assert (
        client.patch(
            f"/api/v1/ai/connections/{legacy['id']}", json={"base_url": "ftp://x"}
        ).status_code
        == 400
    )
    for extra in (second["id"], legacy["id"]):
        client.delete(f"/api/v1/ai/connections/{extra}")
    assert credential_id_for("compatible", OPENROUTER_URL, second["id"]) not in keys
    bad = client.post(
        "/api/v1/ai/connections", json={"kind": "compatible", "base_url": "http://x.example/v1"}
    )
    assert bad.status_code == 400
    assert client.post("/api/v1/ai/connections", json={"kind": "openrouter"}).status_code == 400

    async def fake_list(self: Any) -> list[dict[str, Any]]:
        assert self.headers()["Authorization"] == "Bearer sk-or-test"
        assert self.headers()["X-Title"] == "Graite"
        return [
            {
                "id": "anthropic/claude-sonnet-4",
                "name": "Claude Sonnet 4",
                "context_length": 200000,
                "pricing": None,
            },
            {
                "id": "openai/gpt-4o",
                "name": "GPT-4o",
                "context_length": 128000,
                "pricing": {"prompt": "0.000005", "completion": "0.000015"},
            },
        ]

    monkeypatch.setattr("graite.models.providers.Provider.list_models", fake_list)
    found = client.post(f"/api/v1/ai/connections/{connection['id']}/discover").json()["models"]
    assert [m["name"] for m in found] == ["Claude Sonnet 4", "GPT-4o"]
    saved = client.post(
        f"/api/v1/ai/connections/{connection['id']}/models",
        json={"model": "anthropic/claude-sonnet-4", "label": "Sonnet 4", "context_length": 200000},
    ).json()
    assert saved["label"] == "Sonnet 4"
    config = client.get("/api/v1/ai/status").json()["config"]
    picked = client.put("/api/v1/ai/config", json={**config, "saved_model_id": saved["id"]})
    assert picked.status_code == 200
    body = picked.json()
    assert body["provider"] == "compatible" and body["model"] == "anthropic/claude-sonnet-4"
    assert body["connection_id"] == connection["id"] and body["base_url"] == OPENROUTER_URL
    assert client.get("/api/v1/ai/status").json()["active"]["label"] == "Sonnet 4"
    # Choosing a local model again drops the saved-model link.
    local = client.put(
        "/api/v1/ai/config",
        json={**body, "provider": "local", "model_path": "/m.gguf", "saved_model_id": None},
    ).json()
    assert local["provider"] == "local" and local["connection_id"] is None
    client.put("/api/v1/ai/config", json={**body, "saved_model_id": saved["id"]})
    # The selected model cannot be removed; another one can.
    assert client.delete(f"/api/v1/ai/models/{saved['id']}").status_code == 409
    other = client.post(
        f"/api/v1/ai/connections/{connection['id']}/models", json={"model": "openai/gpt-4o"}
    ).json()
    assert client.delete(f"/api/v1/ai/models/{other['id']}").json()["ok"] is True
    # Removing the connection falls the vault back to local and clears its key use.
    gone = client.delete(f"/api/v1/ai/connections/{connection['id']}").json()
    assert gone["removed_models"] == [saved["id"]]
    assert credential_id_for("compatible", OPENROUTER_URL, connection["id"]) not in keys
    assert client.get("/api/v1/ai/status").json()["config"]["provider"] == "local"
    assert client.get("/api/v1/ai/connections").json() == {"connections": [], "models": []}
    assert get_store() is not None and get_store().path.parent.name == "app"  # type: ignore[union-attr]


def test_page_model_override_uses_a_saved_model(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    from graite.models.resolution import resolve

    monkeypatch.setattr("keyring.get_password", lambda *_: "k")
    store = get_store()
    assert store is not None
    connection = store.add_connection("Claude", "anthropic")
    saved = store.add_model(connection.id, "claude-sonnet-4-5")
    config, note = resolve(AIConfig(), {"model": saved.id}, [], {})
    assert note is None and config.provider == "anthropic" and config.model == "claude-sonnet-4-5"
    config, note = resolve(AIConfig(), {"model": "m_missing"}, [], {})
    assert config.provider == "local" and note and "saved model" in note
