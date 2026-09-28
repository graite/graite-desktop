"""The remote MCP relay client against a fake Graite Cloud socket (graite/cloud/relay.py)."""

from __future__ import annotations

import json
import queue
import threading
import time
from collections.abc import Callable, Iterator
from typing import Any

import pytest
from fastapi.testclient import TestClient
from websockets.sync.server import Server, ServerConnection, serve

from graite.app import create_app
from graite.cloud import relay
from graite.cloud.session import CloudSession
from graite.config import Settings

TOKEN = "test-token"


@pytest.fixture
def cloud(monkeypatch: pytest.MonkeyPatch) -> Iterator[Any]:
    """A relay endpoint on a free port; tests set what it does with each connection."""
    frames: queue.Queue[Any] = queue.Queue()
    behaviour: dict[str, Callable[[ServerConnection], None]] = {}

    def handler(socket: ServerConnection) -> None:
        auth = socket.request.headers.get("Authorization") if socket.request else None
        frames.put(("headers", {"Authorization": auth}))
        behaviour["run"](socket)

    server: Server = serve(handler, "127.0.0.1", 0)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    port = server.socket.getsockname()[1]

    async def token(self: CloudSession) -> str:
        return "cloud-access-token"

    monkeypatch.setattr(CloudSession, "access_token", token)

    def set_behaviour(run: Callable[[ServerConnection], None]) -> None:
        behaviour["run"] = run

    try:
        yield set_behaviour, frames, f"http://127.0.0.1:{port}"
    finally:
        server.shutdown()


@pytest.fixture
def app_client(settings: Settings, cloud: Any) -> Iterator[TestClient]:
    configured = settings.model_copy(update={"cloud_url": cloud[2]})
    with TestClient(create_app(configured), headers={"Authorization": f"Bearer {TOKEN}"}) as client:
        yield client


def _wait(check: Callable[[], bool], seconds: float = 10) -> None:
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if check():
            return
        time.sleep(0.05)
    raise AssertionError("timed out")


def test_relay_is_off_until_switched_on(app_client: TestClient) -> None:
    remote = app_client.get("/api/v1/mcp/info").json()["remote"]
    assert remote["enabled"] is False and remote["connected"] is False
    assert remote["url"].endswith("/mcp")


def test_relay_replays_requests_through_the_daemons_own_mcp(
    app_client: TestClient, cloud: Any
) -> None:
    set_behaviour, frames, _ = cloud

    def run(socket: ServerConnection) -> None:
        frames.put(json.loads(socket.recv(timeout=10)))
        body = {
            "jsonrpc": "2.0",
            "id": 7,
            "method": "tools/call",
            "params": {"name": "find_pages", "arguments": {"name": "Recipes"}},
        }
        socket.send(json.dumps({"type": "request", "id": "r1", "client": "ChatGPT", "body": body}))
        frames.put(json.loads(socket.recv(timeout=10)))
        note = {"jsonrpc": "2.0", "method": "notifications/initialized"}
        socket.send(json.dumps({"type": "request", "id": "r2", "client": "ChatGPT", "body": note}))
        frames.put(json.loads(socket.recv(timeout=10)))
        socket.recv(timeout=30)  # hold the socket open until the daemon closes it

    set_behaviour(run)
    app_client.post("/api/v1/pages", json={"title": "Recipes"})
    assert app_client.put("/api/v1/mcp/remote", json={"enabled": True}).json()["enabled"]

    kind, headers = frames.get(timeout=10)
    assert kind == "headers"
    assert headers["Authorization"] == "Bearer cloud-access-token"
    hello = frames.get(timeout=10)
    assert hello["type"] == "hello" and hello["server"]["name"] == "graite"
    assert "find_pages" in {t["name"] for t in hello["tools"]}
    assert hello["install_id"] and hello["vault"] == "vault"

    answer = frames.get(timeout=10)
    assert answer["type"] == "response" and answer["id"] == "r1" and answer["status"] == 200
    found = json.loads(answer["body"]["result"]["content"][0]["text"])
    assert found["candidates"][0]["path"] == "Recipes"
    notified = frames.get(timeout=10)
    assert notified["id"] == "r2" and notified["status"] == 202 and notified["body"] is None

    _wait(lambda: app_client.get("/api/v1/mcp/info").json()["remote"]["connected"])
    off = app_client.put("/api/v1/mcp/remote", json={"enabled": False}).json()
    assert off["enabled"] is False
    _wait(lambda: not app_client.get("/api/v1/mcp/info").json()["remote"]["connected"])


def test_a_replaced_relay_waits_instead_of_fighting(app_client: TestClient, cloud: Any) -> None:
    set_behaviour, frames, _ = cloud
    connections: list[int] = []

    def run(socket: ServerConnection) -> None:
        connections.append(1)
        socket.recv(timeout=10)  # hello
        socket.close(relay.CLOSE_REPLACED, "replaced")

    set_behaviour(run)
    app_client.put("/api/v1/mcp/remote", json={"enabled": True})
    _wait(lambda: app_client.get("/api/v1/mcp/info").json()["remote"]["error"] == relay.REPLACED)
    time.sleep(1.5)
    assert len(connections) == 1


def test_ws_url_follows_the_cloud_scheme() -> None:
    assert relay.ws_url("https://api.example.com/") == "wss://api.example.com/relay/v1/connect"
    assert relay.ws_url("http://127.0.0.1:8000") == "ws://127.0.0.1:8000/relay/v1/connect"
