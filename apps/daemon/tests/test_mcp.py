from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

from graite.config import Settings
from graite.skills import tools as tool_module

MCP = {
    "Accept": "application/json, text/event-stream",
    "Content-Type": "application/json",
    "X-Graite-MCP-Client": "test-client",
}


def rpc(client: TestClient, method: str, params: dict | None = None, **headers: str) -> Any:
    body: dict[str, Any] = {"jsonrpc": "2.0", "id": 1, "method": method}
    if params is not None:
        body["params"] = params
    response = client.post("/mcp", json=body, headers={**MCP, **headers})
    assert response.status_code == 200, response.text
    return response.json()


def call(client: TestClient, name: str, **arguments: Any) -> tuple[dict, bool]:
    result = rpc(client, "tools/call", {"name": name, "arguments": arguments})["result"]
    return json.loads(result["content"][0]["text"]), bool(result.get("isError"))


def page(client: TestClient, title: str, body: str = "", **ai: Any) -> dict:
    doc = client.post("/api/v1/pages", json={"title": title}).json()
    if body:
        put = client.put(
            f"/api/v1/pages/{doc['path']}", json={"body": body, "base_hash": doc["hash"]}
        )
        assert put.status_code == 200, put.text
    if ai:
        saved = client.put(f"/api/v1/pages/{doc['path']}/ai-settings", json={"values": ai})
        assert saved.status_code == 200, saved.text
    return dict(doc)


def test_mcp_needs_the_bearer_token(client: TestClient) -> None:
    body = {"jsonrpc": "2.0", "id": 1, "method": "tools/list"}
    for auth in ({"Authorization": ""}, {"Authorization": "Bearer wrong"}):
        assert client.post("/mcp", json=body, headers={**MCP, **auth}).status_code == 401


def test_a_web_page_cannot_drive_mcp(client: TestClient) -> None:
    body = {"jsonrpc": "2.0", "id": 1, "method": "tools/list"}
    evil = client.post("/mcp", json=body, headers={**MCP, "Origin": "https://evil.example"})
    assert evil.status_code == 403
    ours = client.post("/mcp", json=body, headers={**MCP, "Origin": "tauri://localhost"})
    assert ours.status_code == 200


def test_initialize_describes_the_server(client: TestClient) -> None:
    result = rpc(
        client,
        "initialize",
        {
            "protocolVersion": "2025-06-18",
            "capabilities": {},
            "clientInfo": {"name": "t", "version": "0"},
        },
    )["result"]
    assert result["serverInfo"]["name"] == "graite"
    assert "proposal" in result["instructions"]
    assert "tools" in result["capabilities"]


def test_tools_are_the_write_free_registry(client: TestClient) -> None:
    tools = {t["name"]: t for t in rpc(client, "tools/list")["result"]["tools"]}
    expected = {
        t.name
        for t in tool_module.TOOLS.values()
        if t.group in ("read", "search", "meta", "propose")
    } - {"schedule", "search_memory"}
    assert set(tools) == expected
    assert {"read_page", "search_vault", "propose_create", "propose_edit"} <= set(tools)
    # CLAUDE.md rule 2: nothing that writes, and nothing that starts unattended local work.
    assert not [n for n in tools if n.startswith(("write_", "update_", "delete_", "create_"))]
    assert "schedule" not in tools
    schema = tools["propose_create"]["inputSchema"]
    assert schema["type"] == "object"
    assert {"title", "body", "summary"} <= set(schema["required"])


def test_creating_a_page_files_a_proposal_and_writes_nothing(
    client: TestClient, settings: Settings
) -> None:
    result, failed = call(
        client, "propose_create", title="From Claude", body="Hello", summary="A new page"
    )
    assert not failed, result
    assert result["status"] == "pending"
    assert not (settings.vault / "From Claude").exists()

    queue = client.get("/api/v1/ai/proposals").json()
    assert [p["id"] for p in queue] == [result["proposal_id"]]
    assert queue[0]["conversation_id"] == "mcp:test-client"
    assert queue[0]["kind"] == "create"

    accepted = client.post(f"/api/v1/ai/proposals/{result['proposal_id']}/accept", json={})
    assert accepted.status_code == 200, accepted.text
    assert (settings.vault / "From Claude" / "page.md").is_file()


def test_reading_searching_and_proposing_an_edit(client: TestClient, settings: Settings) -> None:
    page(client, "Recipes", "Sourdough needs a ripe starter.\n")
    read, failed = call(client, "read_page", path="Recipes")
    assert not failed
    assert "ripe starter" in json.dumps(read)
    found, _ = call(client, "search_vault", query="sourdough starter")
    assert "Recipes" in json.dumps(found)

    result, failed = call(
        client, "propose_edit", path="Recipes", old="ripe", new="lively", summary="Wording"
    )
    assert not failed, result
    assert result["status"] == "pending"
    assert "ripe" in (settings.vault / "Recipes" / "page.md").read_text()


def test_auto_apply_pages_apply_like_act_mode(client: TestClient, settings: Settings) -> None:
    page(client, "Inbox", "Start\n", autonomy="auto-apply", auto_apply_kinds=["append"])
    result, failed = call(client, "propose_append", path="Inbox", text="From MCP", summary="Note")
    assert not failed, result
    assert result["status"] == "auto_applied"
    assert "From MCP" in (settings.vault / "Inbox" / "page.md").read_text()


def test_local_only_pages_are_invisible_to_an_mcp_client(client: TestClient) -> None:
    page(client, "Public", "The launch codename is heron.\n")
    page(client, "Diary", "The secret codename is kingfisher.\n", cloud="local-only")

    read, failed = call(client, "read_page", path="Diary")
    assert failed
    assert "kingfisher" not in json.dumps(read)
    found, _ = call(client, "search_vault", query="codename")
    assert "heron" in json.dumps(found)
    assert "kingfisher" not in json.dumps(found) and "Diary" not in json.dumps(found)

    result, failed = call(client, "propose_append", path="Diary", text="x", summary="s")
    assert failed, result
    assert client.get("/api/v1/ai/proposals").json() == []


def test_local_only_set_after_first_use_takes_effect(client: TestClient) -> None:
    doc = page(client, "Later", "Soon private.\n")
    assert not call(client, "read_page", path="Later")[1]
    saved = client.put(
        f"/api/v1/pages/{doc['path']}/ai-settings", json={"values": {"cloud": "local-only"}}
    )
    assert saved.status_code == 200
    # The resolved scope is cached on the fileops epoch; a policy change must drop it.
    assert call(client, "read_page", path="Later")[1]


def test_a_client_only_sees_its_own_proposals(client: TestClient) -> None:
    state = client.app.state  # type: ignore[attr-defined]
    page(client, "Shared", "Body\n")
    call(client, "propose_append", path="Shared", text="mine", summary="From MCP")
    other = rpc(
        client,
        "tools/call",
        {
            "name": "propose_append",
            "arguments": {"path": "Shared", "text": "theirs", "summary": "Other client"},
        },
        **{"X-Graite-MCP-Client": "someone-else"},
    )
    assert not other["result"].get("isError")
    assert len(state.proposals.find()) == 2

    listed, failed = call(client, "list_proposals")
    assert not failed
    assert "From MCP" in json.dumps(listed)
    assert "Other client" not in json.dumps(listed)


def test_schedule_and_unknown_tools_are_refused(client: TestClient) -> None:
    for name in ("schedule", "write_page", "run_query_ro"):
        result, failed = call(client, name, when="daily", instructions="x")
        assert failed, (name, result)
    assert client.get("/api/v1/ai/schedules").status_code in (200, 404)


def test_skills_are_offered_as_prompts(client: TestClient, settings: Settings) -> None:
    skill = settings.vault / ".graite" / "skills" / "weekly-review"
    skill.mkdir(parents=True)
    (skill / "SKILL.md").write_text(
        "---\nname: weekly-review\ndescription: Summarise the week.\n---\nList what changed.\n"
    )
    prompts = {
        p["name"]: p["description"] for p in rpc(client, "prompts/list")["result"]["prompts"]
    }
    assert prompts["weekly-review"] == "Summarise the week."
    # Built-ins reach an MCP client too: a hosted model has the same no way of guessing the
    # graite:view contract, and the same habit of writing `## To do` headings instead.
    assert "page-views" in prompts
    got = rpc(client, "prompts/get", {"name": "weekly-review"})["result"]
    assert "List what changed." in got["messages"][0]["content"]["text"]
    tools = {t["name"]: t for t in rpc(client, "tools/list")["result"]["tools"]}
    assert "weekly-review" in tools["load_skill"]["description"]


def test_info_tells_the_settings_screen_how_to_connect(
    client: TestClient, settings: Settings
) -> None:
    info = client.get("/api/v1/mcp/info").json()
    assert info["http_url"].endswith("/mcp")
    assert info["http_stable"] is False  # a desktop launch: new port and token every time
    assert info["stdio_args"][-3:] == ["mcp", "--app-dir", str(settings.app_dir)]
    assert "propose_create" in info["tools"] and "schedule" not in info["tools"]
    assert "token" not in json.dumps(info).lower()


def test_an_appimage_hands_out_its_own_file_not_the_mount(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from graite.api.mcp import stdio_launch

    home = Path.home() / ".graite"
    image = tmp_path / "Graite_0.1.0_amd64.AppImage"
    image.write_bytes(b"")
    mount = tmp_path / ".mount_GraitXyz"
    sidecar = mount / "usr/lib/Graite/resources/daemon/graite-daemon"
    sidecar.parent.mkdir(parents=True)
    sidecar.write_bytes(b"")
    monkeypatch.setattr(sys, "frozen", True, raising=False)
    monkeypatch.setattr(sys, "executable", str(sidecar))

    # A .deb / .rpm install: the sidecar path is stable, use it directly.
    monkeypatch.delenv("APPIMAGE", raising=False)
    monkeypatch.delenv("APPDIR", raising=False)
    assert stdio_launch(home) == (str(sidecar), ["mcp"])

    # An AppImage: the mount point changes on every start, the file does not.
    monkeypatch.setenv("APPIMAGE", str(image))
    monkeypatch.setenv("APPDIR", str(mount))
    assert stdio_launch(home) == (str(image), ["mcp"])
    assert stdio_launch(tmp_path / "app") == (
        str(image),
        ["mcp", "--app-dir", str(tmp_path / "app")],
    )

    # Launched *from* some AppImage (say a terminal) but not part of it: leave it alone.
    monkeypatch.setenv("APPDIR", str(tmp_path / ".mount_Other"))
    assert stdio_launch(home) == (str(sidecar), ["mcp"])
    # A stale variable pointing at a file that is gone.
    monkeypatch.setenv("APPDIR", str(mount))
    image.unlink()
    assert stdio_launch(home) == (str(sidecar), ["mcp"])
