"""Notice pages changed outside Graite (Obsidian, vim, sync clients) and index them.

Bursts are coalesced by watchfiles; writes the daemon made itself are dropped by matching
the file's mtime against what FileOps recorded. Only page files, `AGENTS.md` and the
definition folders matter; everything under `.graite/` and temp files is ignored.
"""

from __future__ import annotations

import asyncio
import logging
import os
import time
from collections.abc import AsyncIterator
from pathlib import Path

from watchfiles import Change, awatch

from graite.events import EventBus
from graite.vault import fileops as fileops_module
from graite.vault.fileops import FileOps
from graite.vault.paths import GRAITE_DIR, PAGE_FILE, VaultPathError, validate_rel

log = logging.getLogger("graite.watcher")

POLICY_FILE = "AGENTS.md"
DEFINITION_DIRS = ("_skills", "_agents", "_workflows")
SELF_WRITE_WINDOW = 3.0
STEP_MS = 100
STOP_TIMEOUT = 5.0


def _filter(change: Change, path: str) -> bool:
    name = os.path.basename(path)
    if name.startswith(".") and name not in (".graite",):
        return False
    parts = path.replace("\\", "/").split("/")
    if GRAITE_DIR in parts:
        return False
    if name.endswith((".part",)) or ".tmp-" in name:
        return False
    if name in ("NAVIGATION.md", "NAVIGATION-DEEP.md"):
        return False
    return True


def is_own_write(path: Path) -> bool:
    recorded = fileops_module.RECENT_WRITES.get(str(path))
    if not recorded:
        return False
    mtime_ns, when = recorded
    if time.monotonic() - when > SELF_WRITE_WINDOW:
        fileops_module.RECENT_WRITES.pop(str(path), None)
        return False
    try:
        return path.stat().st_mtime_ns == mtime_ns
    except OSError:
        return False


def changes_to_paths(vault: Path, changes: set[tuple[Change, str]]) -> tuple[list[str], list[str]]:
    """Map raw file events to (page paths to rescan, folders whose AGENTS.md changed)."""
    root = vault.resolve()
    pages: set[str] = set()
    policies: set[str] = set()
    for _change, raw in changes:
        path = Path(raw)
        try:
            rel_path = Path(os.path.relpath(path if path.is_absolute() else vault / path, root))
        except ValueError:
            continue
        parts = rel_path.parts
        if not parts or parts[0] == ".." or any(p.startswith(".") for p in parts):
            continue
        name = parts[-1]
        folder = "/".join(parts[:-1])
        if name == PAGE_FILE:
            if is_own_write(path):
                continue
            target = folder
        elif name == POLICY_FILE:
            policies.add(folder)
            continue
        elif any(p in DEFINITION_DIRS for p in parts):
            policies.add(
                "/".join(
                    p for p in parts[: next(i for i, p in enumerate(parts) if p in DEFINITION_DIRS)]
                )
            )
            continue
        elif path.is_dir() or not path.exists():
            # A folder appeared, moved or vanished: rescan it as a possible page subtree.
            target = "/".join(parts)
        else:
            continue  # attachments and other files do not affect the index
        if not target:
            continue
        try:
            pages.add(validate_rel(target))
        except VaultPathError:
            continue
    # Collapse nested paths: scanning "A" already covers "A/B".
    collapsed = [
        p for p in sorted(pages) if not any(p.startswith(q + "/") for q in pages if q != p)
    ]
    return collapsed, sorted(policies)


class Watcher:
    def __init__(
        self, vault: Path, fileops: FileOps, events: EventBus, *, debounce_ms: int = 600
    ) -> None:
        self.vault = vault
        self.fileops = fileops
        self.events = events
        self.debounce_ms = debounce_ms
        self.stop_event = asyncio.Event()
        self.task: asyncio.Task[None] | None = None
        self.stream: AsyncIterator[set[tuple[Change, str]]] | None = None
        self.batches = 0

    async def start(self) -> None:
        self.stop_event.clear()
        self.task = asyncio.create_task(self._run(), name="vault:watcher")

    async def stop(self) -> None:
        """Let the watch loop end on its own before cancelling.

        `watchfiles` runs its file-system watcher on a native thread. Cancelling mid-poll
        leaves that thread to be torn down during interpreter shutdown, which crashes; the
        stop event lets the stream close its thread first.
        """
        self.stop_event.set()
        task, self.task = self.task, None
        if task is not None:
            done, _ = await asyncio.wait({task}, timeout=STOP_TIMEOUT)
            if not done:
                task.cancel()
                await asyncio.gather(task, return_exceptions=True)
        stream, self.stream = self.stream, None
        if stream is not None:
            await stream.aclose()  # type: ignore[attr-defined]

    async def _run(self) -> None:
        self.stream = awatch(
            self.vault,
            watch_filter=_filter,
            debounce=self.debounce_ms,
            step=STEP_MS,
            stop_event=self.stop_event,
            recursive=True,
        )
        try:
            async for changes in self.stream:
                await self.handle(changes)
        except asyncio.CancelledError:
            raise
        except Exception:  # noqa: BLE001
            log.exception("vault watcher stopped")

    async def handle(self, changes: set[tuple[Change, str]]) -> None:
        pages, policies = changes_to_paths(self.vault, changes)
        self.batches += 1
        for folder in policies:
            self.fileops.bump()
            self.events.publish("policy_changed", {"path": folder or None})
        if pages:
            try:
                await self.fileops.rescan_paths(pages, actor="external")
            except Exception:  # noqa: BLE001
                log.exception("rescan after external change failed")
