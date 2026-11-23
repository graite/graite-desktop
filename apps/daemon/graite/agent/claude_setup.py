"""Set up Claude Code for the user without touching its sign-in.

Graite opens a terminal window with Claude Code's own command in it: Anthropic's installer,
or `claude auth login`. The user sees what runs, the browser opens from Claude Code, and the
sign-in completes between the user and Anthropic. Graite takes no part in it and afterwards
asks only "signed in or not" (`claude_code.status`). When no terminal can be opened the
command is returned so the settings card can show it to copy.
"""

from __future__ import annotations

import asyncio
import os
import shlex
import shutil
import stat
import subprocess
import sys
import tempfile
from pathlib import Path

from pydantic import BaseModel

from graite.agent.claude_code import INSTALL_URL, clean_env, find_cli
from graite.proc import NO_WINDOW

# Anthropic's published install commands (code.claude.com/docs/en/setup).
INSTALL_POSIX = "curl -fsSL https://claude.ai/install.sh | bash"
INSTALL_WINDOWS = "winget install Anthropic.ClaudeCode"

# Linux has no one way to open a terminal; these are tried in order. Each entry is the
# program and the arguments that come before the command to run.
_LINUX_TERMINALS: tuple[tuple[str, ...], ...] = (
    ("x-terminal-emulator", "-e"),
    ("gnome-terminal", "--"),
    ("konsole", "-e"),
    ("xfce4-terminal", "-x"),
    ("kitty",),
    ("alacritty", "-e"),
    ("xterm", "-e"),
)


class Launch(BaseModel):
    # Whether a terminal window was opened. When not, show `command` for the user to run.
    opened: bool
    command: str
    # Where to get Claude Code by hand, when Graite has no install command for this system.
    url: str = ""


def login_command(cli: str) -> str:
    quoted = f'"{cli}"' if sys.platform == "win32" else shlex.quote(cli)
    return f"{quoted} auth login --claudeai"


def install_command() -> str | None:
    """The install command for this system, or None when the user has to download it."""
    if sys.platform == "win32":
        return INSTALL_WINDOWS if shutil.which("winget") else None
    return INSTALL_POSIX if shutil.which("curl") else None


def _posix_script(command: str) -> str:
    # A sign-in that worked closes the window by itself; anything else stays to be read.
    return (
        f"{command} && exit 0\n"
        'echo\necho "That did not finish. You can close this window and try again."\n'
        "read -r _\n"
    )


def _spawn(argv: list[str]) -> bool:
    try:
        subprocess.Popen(  # noqa: S603 - fixed programs, our own command line
            argv,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            env=clean_env(),
            start_new_session=sys.platform != "win32",
            creationflags=NO_WINDOW,
        )
    except OSError:
        return False
    return True


def _open_terminal(command: str) -> bool:
    if sys.platform == "win32":
        # `start` gives the command a console window of its own; /k keeps it open.
        return _spawn(["cmd.exe", "/c", "start", "Claude Code", "cmd.exe", "/k", command])
    if sys.platform == "darwin":
        # A .command file opens in Terminal without Graite scripting Terminal, so macOS
        # asks for no "control Terminal" permission.
        folder = Path(tempfile.mkdtemp(prefix="graite-claude-"))
        script = folder / "Claude Code.command"
        script.write_text("#!/bin/sh\n" + _posix_script(command), encoding="utf-8")
        script.chmod(stat.S_IRWXU)
        return _spawn(["open", str(script)])
    if not (os.environ.get("DISPLAY") or os.environ.get("WAYLAND_DISPLAY")):
        return False
    for program, *flags in _LINUX_TERMINALS:
        path = shutil.which(program)
        if path and _spawn([path, *flags, "sh", "-c", _posix_script(command)]):
            return True
    return False


async def start_login(*, headless: bool) -> Launch:
    """Open Claude Code's own sign-in in a terminal window."""
    cli = await asyncio.to_thread(find_cli)
    if cli is None:
        raise ValueError("Claude Code is not installed yet.")
    command = login_command(cli)
    opened = False if headless else await asyncio.to_thread(_open_terminal, command)
    return Launch(opened=opened, command=command)


async def start_install(*, headless: bool) -> Launch:
    """Open Anthropic's installer in a terminal window, where the user can watch it."""
    command = install_command()
    if command is None:
        return Launch(opened=False, command="", url=INSTALL_URL)
    opened = False if headless else await asyncio.to_thread(_open_terminal, command)
    return Launch(opened=opened, command=command, url=INSTALL_URL)
