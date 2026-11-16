"""What the settings screen needs to show someone how to connect an MCP client."""

from __future__ import annotations

import asyncio
import os
import sys
import time
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Literal

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

from graite.cloud.relay import enabled as relay_enabled
from graite.cloud.relay import set_enabled as set_relay_enabled
from graite.mcp import clients
from graite.mcp.clients import ClientStatus
from graite.mcp.server import SWITCHED_OFF
from graite.mcp.server import enabled as mcp_enabled
from graite.mcp.server import set_enabled as set_mcp_enabled

router = APIRouter(prefix="/mcp", tags=["mcp"])


class McpInfo(BaseModel):
    # Streamable HTTP endpoint of this daemon. Needs the bearer token the client already has.
    http_url: str
    # False when the port and token change on every launch (the desktop app): a pasted URL
    # would break at the next restart, so the stdio command is the one to hand out.
    http_stable: bool
    # The command an MCP client launches; it finds the running daemon by itself.
    stdio_command: str
    stdio_args: list[str]
    tools: list[str]
    # The one switch: off means no AI app can reach Graite, on this computer or remotely.
    enabled: bool = True
    # The app that last used Graite, and when (ISO time). None until one has.
    last_used: LastUsed | None = None
    remote: RemoteInfo
    # Claude Code, Codex and Cursor on this computer: found, set up, and how to add Graite.
    clients: list[ClientStatus]


class LastUsed(BaseModel):
    client: str
    at: str


class EnabledIn(BaseModel):
    enabled: bool


class TestResult(BaseModel):
    """The outcome of "Test": a real MCP round trip, the way an app would make it."""

    ok: bool
    # What was tested: this daemon's endpoint ("server") or the command an app launches
    # ("bridge"), which is the part that breaks when Graite was moved or reinstalled.
    via: str
    tools: int = 0
    pages: int = 0
    ms: int = 0
    error: str | None = None


class RemoteInfo(BaseModel):
    # Remote access through Graite Cloud (graite/cloud/relay.py): off unless switched on here.
    enabled: bool
    connected: bool
    # The URL to paste into Claude, ChatGPT or another hosted client.
    url: str
    error: str | None = None


class RemoteIn(BaseModel):
    enabled: bool


def _appimage() -> str | None:
    """The AppImage file this daemon was started from, if any.

    Inside an AppImage `sys.executable` lives under a mount point that changes on every start
    (`/tmp/.mount_…`), so it cannot be handed out. The file itself stays put, and the app's
    own `mcp` argument passes straight through to this bridge (src-tauri/src/main.rs).
    """
    image, mount = os.environ.get("APPIMAGE"), os.environ.get("APPDIR")
    if not image or not mount or not Path(image).is_file():
        return None
    try:
        inside = Path(sys.executable).resolve().is_relative_to(Path(mount).resolve())
    except OSError:
        return None
    return image if inside else None


def stdio_launch(app_dir: Path) -> tuple[str, list[str]]:
    if getattr(sys, "frozen", False):
        command, args = _appimage() or sys.executable, ["mcp"]
    else:
        # A source checkout: run the same entry point through uv.
        project = Path(__file__).resolve().parents[2]
        command, args = "uv", ["run", "--project", str(project), "graite-daemon", "mcp"]
    if app_dir.resolve() != (Path.home() / ".graite").resolve():
        args += ["--app-dir", str(app_dir)]
    return command, args


@router.get("/info", response_model=McpInfo)
async def info(request: Request) -> McpInfo:
    state = request.app.state
    settings = state.settings
    command, args = stdio_launch(settings.app_dir)
    registry = await state.mcp.registry()
    return McpInfo(
        http_url=str(request.base_url).rstrip("/") + "/mcp",
        http_stable=bool(settings.dev or settings.serve),
        stdio_command=command,
        stdio_args=args,
        tools=sorted(registry.allowed),
        enabled=mcp_enabled(state.db),
        last_used=_last_used(state),
        remote=_remote(request),
        clients=clients.statuses(command, args, headless=settings.serve),
    )


def _last_used(state: Any) -> LastUsed | None:
    seen = state.mcp.last_used
    if seen is None:
        return None
    return LastUsed(client=seen[0], at=datetime.fromtimestamp(seen[1], UTC).isoformat())


@router.put("/enabled", response_model=McpInfo)
async def set_enabled(body: EnabledIn, request: Request) -> McpInfo:
    """Switch access for AI apps on or off. Off refuses every app at once, local and remote,
    without removing what was set up, so switching it on again just works."""
    set_mcp_enabled(request.app.state.db, body.enabled)
    request.app.state.relay.poke()
    return await info(request)


def _error(reply: Any) -> str | None:
    if not isinstance(reply, dict):
        return "Graite gave no answer."
    error = reply.get("error")
    if isinstance(error, dict):
        return str(error.get("message") or "The request failed.")
    return None


async def _test_server(request: Request) -> TestResult:
    """initialize → tools/list → navigate, through `/mcp` exactly as an app's request goes."""
    relay = request.app.state.relay
    started = time.monotonic()

    def failed(message: str) -> TestResult:
        return TestResult(ok=False, via="server", error=message)

    status, reply = await relay.replay(
        {
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": {
                "protocolVersion": "2025-06-18",
                "capabilities": {},
                "clientInfo": {"name": "graite-test", "version": "1"},
            },
        },
        "graite-test",
    )
    if status == 403:
        return failed(SWITCHED_OFF)
    if status != 200 or _error(reply):
        return failed(_error(reply) or f"Graite answered with HTTP {status}.")
    _, listed = await relay.replay(
        {"jsonrpc": "2.0", "id": 2, "method": "tools/list"}, "graite-test"
    )
    if _error(listed):
        return failed(_error(listed) or "")
    tools = listed["result"].get("tools", [])
    _, called = await relay.replay(
        {
            "jsonrpc": "2.0",
            "id": 3,
            "method": "tools/call",
            "params": {"name": "navigate", "arguments": {"path": "", "depth": 1}},
        },
        "graite-test",
    )
    result = called.get("result") if isinstance(called, dict) else None
    if _error(called) or not isinstance(result, dict) or result.get("isError"):
        return failed(_error(called) or "Graite could not read the page tree.")
    pages = request.app.state.db.execute("SELECT count(*) FROM pages").fetchone()[0]
    return TestResult(
        ok=True,
        via="server",
        tools=len(tools),
        pages=int(pages),
        ms=int((time.monotonic() - started) * 1000),
    )


async def _test_bridge(command: str, args: list[str]) -> TestResult:
    """Launch the command an app launches and list the tools through it."""
    from mcp import ClientSession, StdioServerParameters
    from mcp.client.stdio import stdio_client

    started = time.monotonic()
    try:
        async with asyncio.timeout(20):
            async with stdio_client(StdioServerParameters(command=command, args=args)) as (
                read,
                write,
            ):
                async with ClientSession(read, write) as session:
                    await session.initialize()
                    tools = (await session.list_tools()).tools
    except TimeoutError:
        return TestResult(ok=False, via="bridge", error="Graite's command did not answer in time.")
    except FileNotFoundError:
        return TestResult(
            ok=False,
            via="bridge",
            error=f"{command} was not found. Graite may have moved: press Update.",
        )
    except Exception as exc:  # noqa: BLE001 - whatever went wrong is what the user needs to see
        return TestResult(ok=False, via="bridge", error=str(exc) or exc.__class__.__name__)
    return TestResult(
        ok=True, via="bridge", tools=len(tools), ms=int((time.monotonic() - started) * 1000)
    )


@router.post("/test", response_model=TestResult)
async def test(request: Request, via: Literal["server", "bridge"] = "server") -> TestResult:
    """Check that an AI app can use Graite right now, by doing what the app does."""
    state = request.app.state
    if not mcp_enabled(state.db):
        return TestResult(ok=False, via=via, error=SWITCHED_OFF)
    if via == "bridge":
        command, args = stdio_launch(state.settings.app_dir)
        return await _test_bridge(command, args)
    return await _test_server(request)


def _remote(request: Request) -> RemoteInfo:
    state = request.app.state
    relay = state.relay
    return RemoteInfo(
        enabled=relay_enabled(state.db),
        connected=relay.connected,
        url=relay.mcp_url,
        error=relay.error,
    )


@router.put("/remote", response_model=RemoteInfo)
async def set_remote(body: RemoteIn, request: Request) -> RemoteInfo:
    state = request.app.state
    set_relay_enabled(state.db, body.enabled)
    state.relay.poke()
    return _remote(request)


@router.post("/clients/{client}", response_model=ClientStatus)
async def add_client(client: str, request: Request) -> ClientStatus:
    """Add Graite to one MCP app on this computer. Only ever called from a click."""
    settings = request.app.state.settings
    command, args = stdio_launch(settings.app_dir)
    try:
        return await clients.install(client, command, args, headless=settings.serve)
    except (ValueError, OSError) as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
