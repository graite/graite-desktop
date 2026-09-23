"""Where the running daemon can be found: `<app_dir>/daemon.json`.

The desktop app starts the daemon on a free port with a fresh token on every launch, so a
URL pasted into an MCP client would stop working at the next restart. The daemon records
its address here instead and the stdio bridge (`graite-daemon mcp`) looks it up per request.

This is app state in `~/.graite`, never a vault file. Owner-only, because it holds the token.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

FILE_NAME = "daemon.json"


def runtime_file(app_dir: Path) -> Path:
    return app_dir / FILE_NAME


def write(app_dir: Path, *, url: str, token: str, vault: Path, version: str) -> Path:
    app_dir.mkdir(parents=True, exist_ok=True)
    target = runtime_file(app_dir)
    payload = {
        "url": url,
        "token": token,
        "pid": os.getpid(),
        "vault": str(vault),
        "version": version,
    }
    temp = target.with_name(f".{FILE_NAME}.{os.getpid()}.tmp")
    # Created owner-only from the start; the token must never be world-readable, even briefly.
    descriptor = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            json.dump(payload, handle)
        os.replace(temp, target)
    finally:
        temp.unlink(missing_ok=True)
    return target


def read(app_dir: Path) -> dict[str, Any] | None:
    try:
        data = json.loads(runtime_file(app_dir).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    if not isinstance(data, dict) or not data.get("url") or not data.get("token"):
        return None
    return data


def clear(app_dir: Path, pid: int | None = None) -> None:
    """Remove the file on shutdown, unless a newer daemon has already replaced it."""
    data = read(app_dir)
    if data is not None and data.get("pid") != (pid if pid is not None else os.getpid()):
        return
    runtime_file(app_dir).unlink(missing_ok=True)
