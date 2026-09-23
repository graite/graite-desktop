from __future__ import annotations

import json
import os
import stat
from pathlib import Path

import httpx

from graite.mcp import runtime
from graite.mcp.stdio import NOT_RUNNING, Bridge


def _announce(app_dir: Path, url: str = "http://127.0.0.1:1", token: str = "tok") -> None:
    runtime.write(app_dir, url=url, token=token, vault=app_dir / "vault", version="0.1.0")


def test_runtime_file_is_private_and_only_cleared_by_its_owner(tmp_path: Path) -> None:
    _announce(tmp_path)
    target = runtime.runtime_file(tmp_path)
    assert stat.S_IMODE(target.stat().st_mode) == 0o600
    data = runtime.read(tmp_path)
    assert data is not None
    assert (data["url"], data["token"], data["pid"]) == ("http://127.0.0.1:1", "tok", os.getpid())
    assert [p.name for p in tmp_path.iterdir()] == ["daemon.json"]  # no temp file left behind

    runtime.clear(tmp_path, pid=os.getpid() + 1)  # an older daemon shutting down late
    assert target.is_file()
    runtime.clear(tmp_path)
    assert not target.exists()
    runtime.clear(tmp_path)  # already gone: no error

    target.write_text("not json")
    assert runtime.read(tmp_path) is None
    target.write_text(json.dumps({"url": "http://x"}))
    assert runtime.read(tmp_path) is None


async def test_bridge_forwards_with_token_client_name_and_protocol(tmp_path: Path) -> None:
    _announce(tmp_path, url="http://127.0.0.1:9", token="secret")
    seen: list[httpx.Request] = []

    def daemon(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        body = json.loads(request.content)
        if body["method"] == "initialize":
            return httpx.Response(
                200, json={"jsonrpc": "2.0", "id": 1, "result": {"protocolVersion": "2025-06-18"}}
            )
        if "id" not in body:
            return httpx.Response(202)
        return httpx.Response(200, json={"jsonrpc": "2.0", "id": body["id"], "result": {}})

    async with httpx.AsyncClient(transport=httpx.MockTransport(daemon)) as http:
        bridge = Bridge(tmp_path, http)
        hello = await bridge.forward(
            {
                "jsonrpc": "2.0",
                "id": 1,
                "method": "initialize",
                "params": {"clientInfo": {"name": "claude-code", "version": "2"}},
            }
        )
        assert hello is not None and hello["result"]["protocolVersion"] == "2025-06-18"
        note = await bridge.forward({"jsonrpc": "2.0", "method": "notifications/initialized"})
        assert note is None  # 202: nothing goes back to the client
        listed = await bridge.forward({"jsonrpc": "2.0", "id": 2, "method": "tools/list"})
        assert listed == {"jsonrpc": "2.0", "id": 2, "result": {}}

    assert str(seen[0].url) == "http://127.0.0.1:9/mcp"
    assert seen[0].headers["authorization"] == "Bearer secret"
    assert seen[0].headers["x-graite-mcp-client"] == "claude-code"
    assert "mcp-protocol-version" not in seen[0].headers
    assert seen[2].headers["mcp-protocol-version"] == "2025-06-18"
    assert "text/event-stream" in seen[2].headers["accept"]


async def test_bridge_says_so_when_graite_is_closed_and_recovers(tmp_path: Path) -> None:
    alive = False

    def daemon(request: httpx.Request) -> httpx.Response:
        if not alive:
            raise httpx.ConnectError("refused")
        if request.headers["authorization"] != "Bearer new":
            return httpx.Response(401, json={"detail": "unauthorized"})
        return httpx.Response(200, json={"jsonrpc": "2.0", "id": 7, "result": {"ok": True}})

    async with httpx.AsyncClient(transport=httpx.MockTransport(daemon)) as http:
        bridge = Bridge(tmp_path, http)
        message = {"jsonrpc": "2.0", "id": 7, "method": "tools/list"}
        # Never started: no runtime file at all.
        reply = await bridge.forward(message)
        assert reply == {
            "jsonrpc": "2.0",
            "id": 7,
            "error": {"code": -32000, "message": NOT_RUNNING},
        }
        # A stale file from a daemon that is gone.
        _announce(tmp_path, token="old")
        reply = await bridge.forward(message)
        assert reply is not None and reply["error"]["message"] == NOT_RUNNING
        assert await bridge.forward({"jsonrpc": "2.0", "method": "notifications/x"}) is None

        # The app starts again with a new token: the same bridge process picks it up.
        alive = True
        reply = await bridge.forward(message)
        assert reply is not None and reply["error"]["message"] == NOT_RUNNING  # still "old"
        _announce(tmp_path, token="new")
        assert await bridge.forward(message) == {"jsonrpc": "2.0", "id": 7, "result": {"ok": True}}


async def test_bridge_turns_http_errors_into_json_rpc_errors(tmp_path: Path) -> None:
    _announce(tmp_path)

    def daemon(request: httpx.Request) -> httpx.Response:
        return httpx.Response(403, json={"detail": "origin not allowed"})

    async with httpx.AsyncClient(transport=httpx.MockTransport(daemon)) as http:
        reply = await Bridge(tmp_path, http).forward({"jsonrpc": "2.0", "id": 3, "method": "ping"})
    assert reply == {
        "jsonrpc": "2.0",
        "id": 3,
        "error": {"code": -32000, "message": "origin not allowed"},
    }
