"""Remote MCP: this daemon's outbound connection to the Graite Cloud relay.

Hosted AI clients (claude.ai, ChatGPT) call `POST {cloud}/mcp` with an OAuth token of their
own. Graite Cloud forwards each request over one WebSocket that this daemon opened, and the
daemon replays it against its own `/mcp`, so a remote client goes through exactly the same
scope, policy and review queue as a local one (docs/design/remote-mcp-relay.md, D64).
Nothing is listening on this computer: the socket is outbound, and nothing about the vault
is stored in the cloud.

The relay is opt-in per vault (`meta.mcp_remote`) and needs a Graite Cloud sign-in whose
token carries the `relay` scope. Request bodies are never logged.

Frames (text JSON):
  daemon → cloud  {"type": "hello", "install_id", "vault", "version", "server", "tools"}
  cloud → daemon  {"type": "request", "id", "client", "body"}
  daemon → cloud  {"type": "response", "id", "status", "body"}
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import sqlite3
from typing import Any

import httpx
from websockets.asyncio.client import ClientConnection, connect
from websockets.exceptions import ConnectionClosed, InvalidStatus

from graite import __version__
from graite.cloud.session import get_cloud
from graite.mcp.server import CLIENT_HEADER, INSTRUCTIONS

log = logging.getLogger(__name__)

RELAY_PATH = "/relay/v1/connect"
MAX_BACKOFF = 60.0
# Close codes Graite Cloud uses (graite-inference relay/routes.py).
CLOSE_UNAUTHORIZED = 4401  # no valid token with the `relay` scope
CLOSE_REPLACED = 4000  # another Graite window connected for the same account
CLOSE_EXPIRED = 4001  # the access token expired: reconnect with a fresh one

SIGN_IN = "Sign in to Graite Cloud to use remote access."
SIGN_IN_AGAIN = "Sign in to Graite Cloud again to turn on remote access."
REPLACED = "Another Graite window is using remote access. Turn it off there, then here on again."


def enabled(db: sqlite3.Connection) -> bool:
    row = db.execute("SELECT value FROM meta WHERE key='mcp_remote'").fetchone()
    return bool(row) and row[0] == "1"


def set_enabled(db: sqlite3.Connection, on: bool) -> None:
    db.execute("INSERT OR REPLACE INTO meta VALUES ('mcp_remote', ?)", ("1" if on else "0",))
    db.commit()


def ws_url(cloud_url: str) -> str:
    base = cloud_url.rstrip("/")
    if base.startswith("https://"):
        return "wss://" + base.removeprefix("https://") + RELAY_PATH
    return "ws://" + base.removeprefix("http://") + RELAY_PATH


class Relay:
    """One background task that keeps the relay socket open while remote access is on."""

    def __init__(self, app: Any) -> None:
        self._app = app
        self._wake = asyncio.Event()
        self._task: asyncio.Task[None] | None = None
        self._tasks: set[asyncio.Task[None]] = set()
        self.connected = False
        self.error: str | None = None

    @property
    def mcp_url(self) -> str:
        return get_cloud().cloud_url + "/mcp"

    def start(self) -> None:
        self._task = asyncio.create_task(self._run(), name="mcp-relay")

    async def stop(self) -> None:
        if self._task is not None:
            self._task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._task
        for task in list(self._tasks):
            task.cancel()
        await asyncio.gather(*self._tasks, return_exceptions=True)

    def poke(self) -> None:
        """Remote access was switched, or the sign-in changed: look again now."""
        self._wake.set()

    async def _wait(self, seconds: float | None) -> None:
        with contextlib.suppress(TimeoutError):
            await asyncio.wait_for(self._wake.wait(), seconds)
        self._wake.clear()

    async def _run(self) -> None:
        backoff = 1.0
        while True:
            self.connected = False
            if not enabled(self._app.state.db):
                self.error = None
                await self._wait(None)
                continue
            try:
                token = await get_cloud().access_token()
            except ValueError as exc:  # unreachable, or the keychain is locked
                self.error = str(exc)
                await self._wait(backoff)
                backoff = min(backoff * 2, MAX_BACKOFF)
                continue
            if token is None:
                self.error = SIGN_IN
                await self._wait(60)
                continue
            try:
                async with connect(
                    ws_url(get_cloud().cloud_url),
                    additional_headers={"Authorization": f"Bearer {token}"},
                    open_timeout=15,
                    max_size=8 * 1024 * 1024,
                ) as socket:
                    await socket.send(json.dumps(await self._hello()))
                    self.connected, self.error, backoff = True, None, 1.0
                    log.info("remote MCP relay connected")
                    await self._serve(socket)
            except ConnectionClosed as exc:
                code = exc.rcvd.code if exc.rcvd else None
                self.connected = False
                log.info("remote MCP relay closed (%s)", code)
                if code == CLOSE_EXPIRED:
                    continue
                if code == CLOSE_REPLACED:
                    self.error = REPLACED
                    await self._wait(None)  # never fight the other window for the socket
                    continue
                if code == CLOSE_UNAUTHORIZED:
                    self.error = SIGN_IN_AGAIN
                    await self._wait(300)
                    continue
                self.error = "Remote access lost its connection. Reconnecting…"
            except InvalidStatus as exc:
                status = exc.response.status_code
                self.error = SIGN_IN_AGAIN if status in (401, 403) else f"HTTP {status}"
                log.info("remote MCP relay refused (HTTP %s)", status)
                if status in (401, 403):
                    await self._wait(300)
                    continue
            except (OSError, TimeoutError) as exc:
                self.error = "Graite Cloud can’t be reached. Retrying…"
                log.info("remote MCP relay unreachable: %s", exc.__class__.__name__)
            self.connected = False
            await self._wait(backoff)
            backoff = min(backoff * 2, MAX_BACKOFF)

    async def _serve(self, socket: ClientConnection) -> None:
        """Answer requests until the socket closes, or remote access is switched off."""
        reader = asyncio.create_task(self._read(socket))
        try:
            while not reader.done():
                waiter = asyncio.create_task(self._wake.wait())
                await asyncio.wait({reader, waiter}, return_when=asyncio.FIRST_COMPLETED)
                if not waiter.done():
                    waiter.cancel()
                    continue
                self._wake.clear()
                if not enabled(self._app.state.db):
                    await socket.close()
            await reader  # re-raises ConnectionClosed with the cloud's close code
        finally:
            reader.cancel()

    async def _read(self, socket: ClientConnection) -> None:
        async for raw in socket:
            try:
                frame = json.loads(raw)
            except ValueError:
                continue
            if not isinstance(frame, dict) or frame.get("type") != "request":
                continue
            task = asyncio.create_task(self._answer(socket, frame))
            self._tasks.add(task)
            task.add_done_callback(self._tasks.discard)

    async def _answer(self, socket: ClientConnection, frame: dict[str, Any]) -> None:
        status, body = await self.replay(frame.get("body"), str(frame.get("client") or ""))
        with contextlib.suppress(ConnectionClosed):
            reply = {"type": "response", "id": frame.get("id"), "status": status, "body": body}
            await socket.send(json.dumps(reply))

    async def replay(self, body: Any, client: str) -> tuple[int, Any]:
        """Send one JSON-RPC message through this daemon's own `/mcp`, as a local client."""
        headers = {
            "Authorization": f"Bearer {self._app.state.settings.token}",
            "Accept": "application/json, text/event-stream",
            "Content-Type": "application/json",
            CLIENT_HEADER: client or "remote client",
        }
        transport = httpx.ASGITransport(app=self._app)
        async with httpx.AsyncClient(
            transport=transport, base_url="http://127.0.0.1", timeout=120
        ) as http:
            response = await http.post("/mcp", content=json.dumps(body), headers=headers)
        if not response.content:
            return response.status_code, None
        try:
            return response.status_code, response.json()
        except ValueError:
            return 502, None

    async def _hello(self) -> dict[str, Any]:
        """Who is connecting, and the tool list Graite Cloud answers with while offline."""
        _, listed = await self.replay(
            {"jsonrpc": "2.0", "id": "hello", "method": "tools/list"}, "graite-relay"
        )
        result = listed.get("result") if isinstance(listed, dict) else None
        tools = result.get("tools", []) if isinstance(result, dict) else []
        cloud = get_cloud()
        return {
            "type": "hello",
            "install_id": await asyncio.to_thread(cloud.install_id),
            "vault": self._app.state.settings.vault.name,
            "version": __version__,
            "server": {"name": "graite", "version": __version__, "instructions": INSTRUCTIONS},
            "tools": tools,
        }
