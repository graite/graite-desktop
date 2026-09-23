"""`graite-daemon mcp`: a stdio MCP server that forwards to the running daemon.

MCP clients such as Claude Desktop, Claude Code and Cursor launch this command and speak
newline-delimited JSON-RPC over stdin/stdout. Each message is posted to the daemon's `/mcp`
endpoint, found through the runtime file, so the configuration keeps working across app
restarts even though the daemon's port and token change every launch.

Kept free of heavy imports (no FastAPI app, no media libraries): it starts in milliseconds
and must never print anything but protocol messages on stdout.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
from pathlib import Path
from typing import Any

import httpx

from graite.mcp import runtime

NOT_RUNNING = "Graite is not running. Open Graite and try again."
CLIENT_HEADER = "X-Graite-MCP-Client"


def _error(message_id: Any, text: str) -> dict[str, Any]:
    return {"jsonrpc": "2.0", "id": message_id, "error": {"code": -32000, "message": text}}


class Bridge:
    def __init__(self, app_dir: Path, http: httpx.AsyncClient) -> None:
        self.app_dir = app_dir
        self.http = http
        self.client = "client"
        self.protocol: str | None = None

    async def _post(self, message: dict[str, Any]) -> httpx.Response | None:
        target = runtime.read(self.app_dir)
        if target is None:
            return None
        headers = {
            "Authorization": f"Bearer {target['token']}",
            "Content-Type": "application/json",
            "Accept": "application/json, text/event-stream",
            CLIENT_HEADER: self.client,
        }
        if self.protocol:
            headers["MCP-Protocol-Version"] = self.protocol
        try:
            return await self.http.post(f"{target['url']}/mcp", json=message, headers=headers)
        except httpx.HTTPError:
            return None

    async def forward(self, message: dict[str, Any]) -> dict[str, Any] | None:
        """The daemon's reply to one message; None when the message needs no reply."""
        message_id = message.get("id")
        if message.get("method") == "initialize":
            info = (message.get("params") or {}).get("clientInfo") or {}
            self.client = str(info.get("name") or "client")[:40]
        response = await self._post(message)
        if response is None or response.status_code == 401:
            # The app may have restarted since the last message: look it up once more.
            response = await self._post(message)
        if message_id is None:
            return None  # a notification: nothing to answer, whatever happened
        if response is None or response.status_code == 401:
            return _error(message_id, NOT_RUNNING)
        if response.status_code == 202 or not response.content:
            return None
        try:
            reply = response.json()
        except ValueError:
            return _error(message_id, f"Graite answered with HTTP {response.status_code}.")
        if not isinstance(reply, dict) or "jsonrpc" not in reply:
            detail = reply.get("detail") if isinstance(reply, dict) else None
            return _error(
                message_id, str(detail or f"Graite answered with HTTP {response.status_code}.")
            )
        if message.get("method") == "initialize":
            version = (reply.get("result") or {}).get("protocolVersion")
            self.protocol = str(version) if version else None
        return reply


async def serve(app_dir: Path) -> None:
    loop = asyncio.get_running_loop()
    write_lock = asyncio.Lock()
    tasks: set[asyncio.Task[None]] = set()

    async def emit(reply: dict[str, Any]) -> None:
        async with write_lock:
            sys.stdout.write(json.dumps(reply, ensure_ascii=False) + "\n")
            sys.stdout.flush()

    async with httpx.AsyncClient(timeout=httpx.Timeout(120.0, connect=3.0)) as http:
        bridge = Bridge(app_dir, http)

        async def handle(message: dict[str, Any]) -> None:
            reply = await bridge.forward(message)
            if reply is not None:
                await emit(reply)

        while True:
            line = await loop.run_in_executor(None, sys.stdin.readline)
            if not line:
                break  # the client closed the pipe
            line = line.strip()
            if not line:
                continue
            try:
                message = json.loads(line)
            except ValueError:
                await emit(
                    {"jsonrpc": "2.0", "id": None, "error": {"code": -32700, "message": "Bad JSON"}}
                )
                continue
            if not isinstance(message, dict):
                continue
            if message.get("method") == "initialize":
                await handle(message)  # later messages depend on what this one negotiates
                continue
            task = asyncio.create_task(handle(message))
            tasks.add(task)
            task.add_done_callback(tasks.discard)
        await asyncio.gather(*tasks, return_exceptions=True)


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(
        prog="graite-daemon mcp", description="Connect an MCP client to the running Graite app."
    )
    parser.add_argument("--app-dir", type=Path, default=Path.home() / ".graite")
    args = parser.parse_args(argv)
    try:
        asyncio.run(serve(args.app_dir))
    except KeyboardInterrupt:
        pass
