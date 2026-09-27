"""One-click setup of Graite in MCP apps on this computer: Claude Code, Codex and Cursor.

Each app keeps its MCP servers in a file of its own. Where the app has a CLI for it
(`claude mcp add`, `codex mcp add`) we call that; otherwise we merge one entry into its config
file and leave everything else in it alone. The entry is always `graite-local`, so it never
replaces a remote Graite connector the user added as `graite`.

Nothing here runs on its own: only a click in Settings → AI connectors calls `install`, and
only these app config files are written, never a vault file.
"""

from __future__ import annotations

import asyncio
import json
import os
import re
import shutil
import tempfile
import tomllib
from pathlib import Path
from typing import Any

from pydantic import BaseModel

from graite.proc import NO_WINDOW

NAME = "graite-local"
TIMEOUT = 20  # seconds for a CLI call


class ClientStatus(BaseModel):
    id: str
    name: str
    # The app (its CLI or its settings folder) exists on this computer.
    found: bool
    installed: bool
    # Installed, but pointing at another command than this Graite (moved or reinstalled).
    outdated: bool = False
    # The file or command Graite uses, shown so the user can see what changes.
    where: str
    can_install: bool
    note: str | None = None


def _home() -> Path:
    return Path(os.path.expanduser("~"))


def _codex_home() -> Path:
    return Path(os.environ.get("CODEX_HOME") or _home() / ".codex")


def _which(name: str) -> str | None:
    """A CLI on PATH, or in the usual per-user install folders: an app started from the
    desktop often has a shorter PATH than the user's terminal."""
    found = shutil.which(name)
    if found:
        return found
    home = _home()
    for folder in (
        home / ".local" / "bin",
        home / ".npm-global" / "bin",
        home / ".bun" / "bin",
        home / ".claude" / "local",
        Path("/usr/local/bin"),
        Path("/opt/homebrew/bin"),
    ):
        candidate = shutil.which(name, path=str(folder))
        if candidate:
            return candidate
    return None


def _pretty(path: Path) -> str:
    try:
        return "~/" + str(path.relative_to(_home()))
    except ValueError:
        return str(path)


def _write_atomic(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=f".{path.name}.")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(text)
        if path.exists():
            os.chmod(tmp, path.stat().st_mode & 0o777)
        os.replace(tmp, path)
    except BaseException:
        Path(tmp).unlink(missing_ok=True)
        raise


async def _run(*argv: str) -> tuple[int, str]:
    process = await asyncio.create_subprocess_exec(
        *argv,
        stdin=asyncio.subprocess.DEVNULL,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        creationflags=NO_WINDOW,
    )
    try:
        out, err = await asyncio.wait_for(process.communicate(), TIMEOUT)
    except TimeoutError:
        process.kill()
        raise ValueError(f"{Path(argv[0]).name} did not answer in {TIMEOUT} seconds.") from None
    text = (err or out or b"").decode(errors="replace").strip()
    return process.returncode or 0, text[-300:]


def _same(entry: Any, command: str, args: list[str]) -> bool:
    return (
        isinstance(entry, dict)
        and entry.get("command") == command
        and list(entry.get("args") or []) == args
    )


# ----------------------------------------------------------------------------- Cursor


def _cursor_file() -> Path:
    return _home() / ".cursor" / "mcp.json"


def _cursor_read() -> dict[str, Any]:
    path = _cursor_file()
    if not path.exists():
        return {}
    try:
        data = json.loads(path.read_text(encoding="utf-8") or "{}")
    except ValueError:
        raise ValueError(
            f"{_pretty(path)} is not valid JSON. Fix it, or add Graite by hand."
        ) from None
    if not isinstance(data, dict):
        raise ValueError(f"{_pretty(path)} is not a JSON object. Add Graite by hand.")
    return data


def _cursor_status(command: str, args: list[str]) -> ClientStatus:
    path = _cursor_file()
    found = path.parent.exists() or _which("cursor") is not None
    try:
        entry = (_cursor_read().get("mcpServers") or {}).get(NAME)
        note = None
    except ValueError as exc:
        entry, note = None, str(exc)
    return ClientStatus(
        id="cursor",
        name="Cursor",
        found=found,
        installed=entry is not None,
        outdated=entry is not None and not _same(entry, command, args),
        where=_pretty(path),
        can_install=note is None,
        note=note,
    )


async def _cursor_install(command: str, args: list[str]) -> None:
    data = _cursor_read()
    servers = data.get("mcpServers")
    if not isinstance(servers, dict):
        servers = {}
    servers[NAME] = {"command": command, "args": args}
    data["mcpServers"] = servers
    await asyncio.to_thread(_write_atomic, _cursor_file(), json.dumps(data, indent=2) + "\n")


# ----------------------------------------------------------------------------- Codex

_TABLE = re.compile(r"^\s*\[")


def _codex_file() -> Path:
    return _codex_home() / "config.toml"


def _codex_entry() -> Any:
    path = _codex_file()
    if not path.exists():
        return None
    try:
        data = tomllib.loads(path.read_text(encoding="utf-8"))
    except (tomllib.TOMLDecodeError, UnicodeDecodeError):
        raise ValueError(
            f"{_pretty(path)} is not valid TOML. Fix it, or add Graite by hand."
        ) from None
    return (data.get("mcp_servers") or {}).get(NAME)


def _codex_status(command: str, args: list[str]) -> ClientStatus:
    cli = _which("codex")
    try:
        entry, note = _codex_entry(), None
    except ValueError as exc:
        entry, note = None, str(exc)
    return ClientStatus(
        id="codex",
        name="Codex",
        found=cli is not None or _codex_home().exists(),
        installed=entry is not None,
        outdated=entry is not None and not _same(entry, command, args),
        where=_pretty(_codex_file()),
        can_install=note is None or cli is not None,
        note=note,
    )


def codex_block(command: str, args: list[str]) -> str:
    # JSON strings are valid TOML basic strings, with the same escapes.
    items = ", ".join(json.dumps(a) for a in args)
    return f"[mcp_servers.{NAME}]\ncommand = {json.dumps(command)}\nargs = [{items}]\n"


def _codex_rewrite(command: str, args: list[str]) -> None:
    path = _codex_file()
    _codex_entry()  # refuses a file we cannot parse, before touching it
    lines = path.read_text(encoding="utf-8").splitlines() if path.exists() else []
    header = re.compile(rf"^\s*\[\s*mcp_servers\.[\"']?{re.escape(NAME)}[\"']?\s*\]\s*(#.*)?$")
    kept: list[str] = []
    skipping = False
    for line in lines:
        if header.match(line):
            skipping = True
            continue
        if skipping and _TABLE.match(line):
            skipping = False
        if not skipping:
            kept.append(line)
    while kept and not kept[-1].strip():
        kept.pop()
    text = "\n".join(kept)
    text = (text + "\n\n" if text else "") + codex_block(command, args)
    tomllib.loads(text)  # never write a file Codex could not read
    _write_atomic(path, text)


async def _codex_install(command: str, args: list[str]) -> None:
    cli = _which("codex")
    if cli is None:
        await asyncio.to_thread(_codex_rewrite, command, args)
        return
    await _run(cli, "mcp", "remove", NAME)  # absent is fine
    code, message = await _run(cli, "mcp", "add", NAME, "--", command, *args)
    if code != 0:
        raise ValueError(f"codex mcp add failed: {message or f'exit {code}'}")


# ----------------------------------------------------------------------------- Claude Code


def _claude_entry() -> Any:
    path = _home() / ".claude.json"
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    servers = data.get("mcpServers") if isinstance(data, dict) else None
    return servers.get(NAME) if isinstance(servers, dict) else None


def _claude_status(command: str, args: list[str]) -> ClientStatus:
    cli = _which("claude")
    entry = _claude_entry()
    return ClientStatus(
        id="claude-code",
        name="Claude Code",
        found=cli is not None,
        installed=entry is not None,
        outdated=entry is not None and not _same(entry, command, args),
        where=f"claude mcp add -s user {NAME}",
        can_install=cli is not None,
        note=None if cli else "The claude command was not found. Copy the command instead.",
    )


async def _claude_install(command: str, args: list[str]) -> None:
    cli = _which("claude")
    if cli is None:
        raise ValueError("The claude command was not found on this computer.")
    await _run(cli, "mcp", "remove", "-s", "user", NAME)  # absent is fine
    code, message = await _run(cli, "mcp", "add", "-s", "user", NAME, "--", command, *args)
    if code != 0:
        raise ValueError(f"claude mcp add failed: {message or f'exit {code}'}")


# ----------------------------------------------------------------------------- public

CLIENTS = ("claude-code", "codex", "cursor")
HEADLESS = "Graite runs as a server here, so it cannot set up apps on your computer."


def statuses(command: str, args: list[str], *, headless: bool) -> list[ClientStatus]:
    found = [
        _claude_status(command, args),
        _codex_status(command, args),
        _cursor_status(command, args),
    ]
    if headless:
        return [s.model_copy(update={"can_install": False, "note": HEADLESS}) for s in found]
    return found


async def install(client: str, command: str, args: list[str], *, headless: bool) -> ClientStatus:
    if headless:
        raise ValueError(HEADLESS)
    if client == "claude-code":
        await _claude_install(command, args)
    elif client == "codex":
        await _codex_install(command, args)
    elif client == "cursor":
        await _cursor_install(command, args)
    else:
        raise ValueError(f"Unknown app {client!r}.")
    return next(s for s in statuses(command, args, headless=False) if s.id == client)
