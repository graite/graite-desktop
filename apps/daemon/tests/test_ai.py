from __future__ import annotations

import hashlib
import json
from collections.abc import AsyncIterator
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

from graite.models.config import AIConfig, credential_id
from graite.models.providers import Provider
from graite.skills.registry import Registry
from graite.vault.instructions import cascade


def page(client: TestClient, title: str = "Ideas", parent: str | None = None) -> dict[str, Any]:
    return client.post("/api/v1/pages", json={"title": title, "parent_path": parent}).json()


def config(client: TestClient) -> None:
    result = client.put("/api/v1/ai/config", json={"provider": "compatible", "model": "test"})
    assert result.status_code == 200


def test_settings_and_hashed_token(client: TestClient) -> None:
    response = client.get("/api/v1/ai/status")
    assert response.status_code == 200
    assert response.json()["config"]["provider"] == "local"
    row = client.app.state.db.execute("SELECT * FROM tokens WHERE id='ui'").fetchone()
    assert row["hash"] == hashlib.sha256(b"test-token").hexdigest()
    assert (
        client.get("/api/v1/ai/status", headers={"Authorization": "Bearer wrong"}).status_code
        == 401
    )


def test_secret_only_in_keychain(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    store = {}
    monkeypatch.setattr(
        "keyring.set_password", lambda service, name, value: store.update({name: value})
    )
    monkeypatch.setattr("keyring.get_password", lambda service, name: store.get(name))
    response = client.put(
        "/api/v1/ai/config",
        json={"provider": "anthropic", "model": "test", "api_key": "secret-test-key"},
    )
    assert response.status_code == 200
    assert "secret-test-key" not in response.text
    state = client.app.state.db.execute("SELECT value FROM meta WHERE key='ai_config'").fetchone()[
        0
    ]
    assert "secret-test-key" not in state
    assert client.get("/api/v1/ai/status").json()["key_saved"]
    assert credential_id(
        AIConfig(provider="compatible", base_url="https://one.example/v1")
    ) != credential_id(AIConfig(provider="compatible", base_url="https://two.example/v1"))


def test_keychain_failure_does_not_change_config(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    def fail(*args: Any) -> None:
        raise RuntimeError("locked")

    monkeypatch.setattr("keyring.set_password", fail)
    response = client.put("/api/v1/ai/config", json={"provider": "anthropic", "api_key": "secret"})
    assert response.status_code == 400
    assert client.get("/api/v1/ai/status").json()["config"]["provider"] == "local"


@pytest.mark.parametrize(
    "url",
    [
        "http://example.com/v1",
        "file:///etc/passwd",
        "https://user:pass@example.com/v1",
        "https://example.com/v1?key=secret",
    ],
)
def test_provider_urls(client: TestClient, url: str) -> None:
    assert client.put("/api/v1/ai/config", json={"base_url": url}).status_code == 422


def test_stream_tools_and_persistence(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    config(client)
    monkeypatch.setattr("keyring.get_password", lambda *_: "")
    root = page(client)
    child = page(client, "Detail", root["path"])
    outside = page(client, "Private")
    client.put(
        f"/api/v1/pages/{child['path']}",
        json={"body": "The launch color is amber.", "base_hash": child["hash"]},
    )
    seen = []

    async def fake(
        self: Provider, messages: list[dict[str, Any]], tools: list[dict[str, Any]]
    ) -> AsyncIterator[dict[str, Any]]:
        seen.append(messages.copy())
        if messages[-1]["role"] != "tool":
            yield {
                "tool_calls": [
                    {
                        "index": 0,
                        "id": "tool-1",
                        "function": {"name": "read_page", "arguments": '{"pa'},
                    }
                ]
            }
            yield {
                "tool_calls": [{"index": 0, "function": {"arguments": f'th": "{child["path"]}"}}'}}]
            }
        else:
            assert "amber" in messages[-1]["content"]
            yield {"content": "The launch color is amber."}

    monkeypatch.setattr(Provider, "chat", fake)
    c = client.post("/api/v1/ai/conversations", json={"page_path": root["path"]}).json()
    response = client.post(
        f"/api/v1/ai/conversations/{c['id']}/messages",
        json={"page_path": root["path"], "message": "What color?"},
    )
    assert response.status_code == 200
    events = [json.loads(s[6:]) for s in response.text.split("\n\n") if s.startswith("data: ")]
    assert [e["type"] for e in events].count("tool_end") == 1
    assert events[-1]["type"] == "done"
    saved = client.get("/api/v1/ai/conversations", params={"page_path": root["path"]}).json()[0]
    assert saved["messages"][-1]["content"] == "The launch color is amber."
    assert not saved["messages"][-1]["interrupted"]
    mismatch = client.post(
        f"/api/v1/ai/conversations/{c['id']}/messages",
        json={"page_path": outside["path"], "message": "Read"},
    )
    assert mismatch.status_code == 404
    assert not client.app.state.active_chats


def test_failed_stream_keeps_question(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    config(client)
    monkeypatch.setattr("keyring.get_password", lambda *_: "")

    async def fail(self: Provider, messages: Any, tools: Any) -> AsyncIterator[dict[str, Any]]:
        yield {"content": "Partial"}
        raise ValueError("Provider unavailable")

    monkeypatch.setattr(Provider, "chat", fail)
    p = page(client)
    c = client.post("/api/v1/ai/conversations", json={"page_path": p["path"]}).json()
    response = client.post(
        f"/api/v1/ai/conversations/{c['id']}/messages",
        json={"page_path": p["path"], "message": "Hello"},
    )
    assert '"type": "error"' in response.text
    saved = client.get("/api/v1/ai/conversations", params={"page_path": p["path"]}).json()[0]
    assert saved["messages"][0]["content"] == "Hello"
    assert saved["messages"][1]["interrupted"]
    assert not client.app.state.active_chats


async def test_scope_search_and_symlinks(client: TestClient, tmp_path: Path) -> None:
    p = page(client)
    child = page(client, "Detail", p["path"])
    other = page(client, "Private")
    client.put(
        f"/api/v1/pages/{child['path']}",
        json={"body": "Unusual cobalt launch", "base_hash": child["hash"]},
    )
    registry = Registry(client.app.state.fileops, p["path"])
    result = json.loads(await registry.invoke("search_vault", '{"query":"cobalt"}'))
    assert result[0]["path"] == child["path"]
    for target in [other["path"], "../outside", ".graite/index.sqlite"]:
        assert "error" in json.loads(
            await registry.invoke("read_page", json.dumps({"path": target}))
        )
    outside = tmp_path / "external"
    outside.mkdir()
    (outside / "page.md").write_text("Never read this")
    (client.app.state.settings.vault / p["path"] / "Link").symlink_to(outside)
    assert "error" in json.loads(
        await registry.invoke("read_page", json.dumps({"path": p["path"] + "/Link"}))
    )
    assert "error" in json.loads(await registry.invoke("write_page", "{}"))


def test_instructions_root_to_leaf_and_no_escape(tmp_path: Path) -> None:
    vault = tmp_path / "vault"
    (vault / "A/B").mkdir(parents=True)
    (vault / "AGENTS.md").write_text("Be brief.")
    (vault / "A/AGENTS.md").write_text("Use French.")
    (vault / "A/B/AGENTS.md").write_text("Use Dutch.")
    assert [i["text"] for i in cascade(vault, "A/B")] == ["Be brief.", "Use French.", "Use Dutch."]
    outside = tmp_path / "secret"
    outside.write_text("Secret")
    (vault / "A/B/AGENTS.md").unlink()
    (vault / "A/B/AGENTS.md").symlink_to(outside)
    with pytest.raises(ValueError):
        cascade(vault, "A/B")


def test_anthropic_tool_transcript() -> None:
    p = Provider("anthropic", "", "test", "key")
    body = p.anthropic_body(
        [
            {"role": "system", "content": "Instructions"},
            {"role": "user", "content": "Read"},
            {
                "role": "assistant",
                "content": "",
                "tool_calls": [
                    {"id": "one", "function": {"name": "read_page", "arguments": '{"path":"A"}'}}
                ],
            },
            {"role": "tool", "tool_call_id": "one", "content": "Page A"},
        ],
        [],
    )
    assert body["system"] == "Instructions"
    assert body["messages"][1]["content"][0]["input"] == {"path": "A"}
    assert body["messages"][2]["content"][0]["tool_use_id"] == "one"


async def test_anthropic_stream_adapter(monkeypatch: pytest.MonkeyPatch) -> None:
    import httpx

    events = [
        {
            "type": "content_block_start",
            "index": 0,
            "content_block": {"type": "tool_use", "id": "tool-id", "name": "read_page"},
        },
        {
            "type": "content_block_delta",
            "index": 0,
            "delta": {"type": "input_json_delta", "partial_json": '{"path":"A"}'},
        },
        {"type": "message_stop"},
    ]

    def handle(request: httpx.Request) -> httpx.Response:
        assert request.headers["x-api-key"] == "secret"
        assert request.url == "https://api.anthropic.com/v1/messages"
        return httpx.Response(200, text="".join("data: " + json.dumps(e) + "\n\n" for e in events))

    original = httpx.AsyncClient
    monkeypatch.setattr(
        httpx,
        "AsyncClient",
        lambda **kwargs: original(transport=httpx.MockTransport(handle), **kwargs),
    )
    p = Provider("anthropic", "", "test", "secret")
    result = [d async for d in p.chat([{"role": "user", "content": "Read A"}], [])]
    assert result[0]["tool_calls"][0]["id"] == "tool-id"
    assert result[1]["tool_calls"][0]["function"]["arguments"] == '{"path":"A"}'


def test_conversation_follows_renamed_page(client: TestClient) -> None:
    p = page(client)
    c = client.post("/api/v1/ai/conversations", json={"page_path": p["path"]}).json()
    renamed = client.patch(f"/api/v1/pages/{p['path']}", json={"title": "Renamed"}).json()
    result = client.get("/api/v1/ai/conversations", params={"page_path": renamed["path"]}).json()
    assert result[0]["id"] == c["id"]


async def test_skill_allowlist_and_tool_narrowing(client: TestClient) -> None:
    p = page(client)
    directory = client.app.state.settings.vault / p["path"] / "_skills"
    directory.mkdir()
    (directory / "focus.md").write_text(
        "---\nname: focus\ndescription: Focus on one page\n"
        "allowed-tools: [read_page]\n---\nRead carefully and summarize."
    )
    registry = Registry(client.app.state.fileops, p["path"])
    await registry.load_library(["focus"])
    assert "focus" in registry.skill_index()
    loaded = json.loads(await registry.invoke("load_skill", '{"name":"focus"}'))
    assert "Read carefully" in loaded["instructions"]
    assert [t["function"]["name"] for t in registry.schemas()] == ["read_page"]
    assert "error" in json.loads(await registry.invoke("search_vault", '{"query":"anything"}'))


def test_model_override_fallback() -> None:
    from graite.models.resolution import resolve

    config = AIConfig()
    resolved, notice = resolve(config, {"model": "missing"}, [], {})
    assert resolved == config
    assert notice and "default" in notice
    resolved, notice = resolve(
        AIConfig(provider="anthropic", model="default"), {"model": "override"}, [], {}
    )
    assert resolved.model == "override"
    assert notice is None


def test_connection_check_accepts_empty_stream_delta(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    config(client)
    monkeypatch.setattr("keyring.get_password", lambda *_: "")

    async def fake(self: Provider, messages: Any, tools: Any) -> AsyncIterator[dict[str, Any]]:
        yield {"role": "assistant", "content": None}
        yield {"content": "Ready"}

    monkeypatch.setattr(Provider, "chat", fake)
    response = client.post("/api/v1/ai/check")
    assert response.status_code == 200
    assert response.json()["message"] == "Ready to chat"
    assert client.get("/api/v1/ai/status").json()["benchmark"]["message"] == "Ready to chat"


def test_embeddinggemma_uses_search_prompts(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    from contextlib import asynccontextmanager

    item = client.app.state.downloads.items["embeddinggemma-300m-q8"]
    item.status, item.local_path = "installed", "/test/embedding.gguf"
    seen = []

    class FakeEmbedding:
        async def embed(self, texts: list[str]) -> list[list[float]]:
            seen.extend(texts)
            return [[1.0, 0.0] for _ in texts]

    @asynccontextmanager
    async def use_embedding(
        path: str, pooling: str, *, release: bool = False
    ) -> AsyncIterator[FakeEmbedding]:
        assert path == item.local_path and pooling == "mean" and release
        yield FakeEmbedding()

    monkeypatch.setattr(client.app.state.models, "use_embedding", use_embedding)
    for task in ["query", "document"]:
        result = client.post(
            "/api/v1/ai/embeddings", json={"model_id": item.id, "texts": ["hello"], "task": task}
        )
        assert result.status_code == 200
    assert seen == ["task: search result | query: hello", "title: none | text: hello"]


def test_speech_requires_installed_model(client: TestClient) -> None:
    assert client.post("/api/v1/ai/speech/check", content=b"not wav").status_code == 400


def test_hub_folder_and_source_validation(client: TestClient, tmp_path: Path) -> None:
    assert (
        client.post("/api/v1/ai/hub/browse", json={"repository": "other/model"}).status_code == 400
    )
    model = tmp_path / "local.gguf"
    model.write_bytes(b"GGUFtest")
    result = client.post("/api/v1/ai/hub/folder", json={"path": str(tmp_path)})
    assert result.status_code == 200
    item = result.json()[0]
    assert item["local_path"] == str(model)
    assert client.post(f"/api/v1/ai/catalog/{item['id']}/remove").status_code == 200
    assert model.exists()


async def test_last_round_answers_instead_of_failing(monkeypatch: pytest.MonkeyPatch) -> None:
    """A model that keeps calling tools must still produce the answer it has."""
    from graite.agent.loop import run

    seen_tools: list[int] = []

    async def fake(
        self: Provider, messages: list[dict[str, Any]], tools: list[dict[str, Any]]
    ) -> AsyncIterator[dict[str, Any]]:
        seen_tools.append(len(tools))
        if tools:
            yield {
                "tool_calls": [
                    {
                        "index": 0,
                        "id": f"t{len(seen_tools)}",
                        "function": {"name": "search_vault", "arguments": '{"query":"x"}'},
                    }
                ]
            }
        else:
            yield {"content": "Here is what I found."}

    monkeypatch.setattr(Provider, "chat", fake)

    class Stub:
        def schemas(self) -> list[dict[str, Any]]:
            return [{"type": "function", "function": {"name": "search_vault"}}]

        async def invoke(self, name: str, arguments: str) -> str:
            return json.dumps([])

    events = [e async for e in run(Provider("local", "", "m", ""), [], Stub(), max_rounds=3)]  # type: ignore[arg-type]
    assert events[-1] == {"type": "answer", "text": "Here is what I found."}
    assert seen_tools[-1] == 0  # tools withdrawn on the final round
