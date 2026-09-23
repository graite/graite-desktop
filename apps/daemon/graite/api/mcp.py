"""What the settings screen needs to show someone how to connect an MCP client."""

from __future__ import annotations

import os
import sys
from pathlib import Path

from fastapi import APIRouter, Request
from pydantic import BaseModel

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
    )
