"""Deciding what to do with a file version another device made, and doing it.

For each incoming version the engine compares version vectors with what this device holds:

- theirs follows ours        → take it;
- ours follows theirs        → nothing (they will take ours);
- made side by side          → every device keeps the same one of the two (the later change;
  `state.wins`), so all devices agree at once. The device whose own edit was not kept then
  works that edit back in: merged when the two do not overlap, otherwise as a proposal in the
  review queue. Nothing typed is lost: a replaced page is also kept as a version.

All writes go through `FileOps.sync_write` / `sync_delete` (hard rule 1), and the index hears
of them the way it hears of any change made outside the app.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import shutil
import sqlite3
import uuid
from collections.abc import Awaitable, Callable
from dataclasses import replace
from pathlib import Path
from typing import Any

from watchfiles import Change

from graite.review.proposals import Proposals
from graite.sync import merge
from graite.sync.state import Entry, State, compare, file_hash, merged, wins
from graite.tables.paths import DATA_DIR
from graite.vault import frontmatter as fm
from graite.vault.fileops import FileOps, StaleFile
from graite.vault.paths import GRAITE_DIR, PAGE_FILE
from graite.vault.watcher import DEFINITION_DIRS, POLICY_FILE, Watcher

log = logging.getLogger("graite.sync")

BASE_MAX = 1024 * 1024
Fetch = Callable[[], Awaitable[Path | None]]


class Unavailable(Exception):
    """The bytes of a version could not be had right now; the next sync tries again."""


class Engine:
    def __init__(
        self,
        *,
        vault: Path,
        db: sqlite3.Connection,
        fileops: FileOps,
        watcher: Watcher,
        proposals: Proposals,
        space_id: str,
        replica_id: str,
        device_name: Callable[[str], str] = lambda replica: "another device",
    ) -> None:
        self.vault = vault
        self.fileops = fileops
        self.watcher = watcher
        self.proposals = proposals
        self.replica_id = replica_id
        self.device_name = device_name
        self.state = State(db, vault, space_id, replica_id)
        self.work = vault / GRAITE_DIR / "sync"
        self.lock = asyncio.Lock()

    # ----------------------------------------------------------------- this device's changes

    async def scan(self) -> None:
        """Notice what changed on disk. New versions are recorded as not yet sent."""
        async with self.lock:
            await asyncio.to_thread(self.state.scan)

    def drain(self) -> list[Entry]:
        """The versions the other devices have not been told about, marked as told."""
        entries = self.state.unsent()
        for entry in entries:
            self.state.mark_sent(entry)
        return entries

    def content(self, entry: Entry) -> Path | None:
        """The file holding a version's bytes, when this device still has exactly that."""
        held = self.state.get(entry.path)
        path = self.vault / entry.path
        if held is None or held.deleted or held.hash != entry.hash or not path.is_file():
            return None
        return path

    def temp(self) -> Path:
        folder = self.work / "tmp"
        folder.mkdir(parents=True, exist_ok=True)
        return folder / uuid.uuid4().hex

    # ----------------------------------------------------------------- another device's

    async def receive(self, entry: Entry, fetch: Fetch) -> str:
        """Apply one version from another device. Returns what happened, for logs and tests:
        ignored | applied | same | kept | replaced."""
        async with self.lock:
            for _ in range(3):
                try:
                    return await self._receive(entry, fetch)
                except StaleFile:
                    continue  # the file changed under us: look again
            raise Unavailable(entry.path)

    async def _receive(self, entry: Entry, fetch: Fetch) -> str:
        await asyncio.to_thread(self.state.scan, entry.path)
        ours = self.state.get(entry.path)
        order = "newer" if ours is None else compare(entry.vector, ours.vector)
        if order in ("equal", "older"):
            return "ignored"
        if ours is not None and ours.deleted == entry.deleted and ours.hash == entry.hash:
            # The same bytes: only what the version is known to contain changes.
            self.state.set_vector(entry.path, merged(entry.vector, ours.vector))
            return "same"
        if ours is None or order == "newer":
            await self._take(entry, ours, fetch, entry.vector)
            return "applied"
        both = merged(entry.vector, ours.vector)
        if wins(ours, entry):
            # A version the others have not heard of yet goes out as it was made, so the
            # device whose version loses sees the two were side by side and saves its edit.
            if self.state.is_sent(entry.path):
                self.state.set_vector(entry.path, both)
            return "kept"
        mine = not ours.deleted and ours.author == self.replica_id
        lost = (self.vault / entry.path).read_bytes() if mine else None
        base = self._base_text(entry.path) if mine else None
        await self._take(entry, ours, fetch, both, keep=mine)
        if lost is not None:
            await self._work_back_in(entry, lost, base)
        return "replaced"

    async def _take(
        self,
        entry: Entry,
        ours: Entry | None,
        fetch: Fetch,
        vector: dict[str, int],
        *,
        keep: bool = False,
    ) -> None:
        expect = "" if ours is None or ours.deleted else ours.hash
        actor = f"device:{self.device_name(entry.author)}"
        if entry.deleted:
            if expect:
                await self.fileops.sync_delete(entry.path, expect, actor)
            self.state.put(replace(entry, vector=vector))
        else:
            source = await self._bytes_for(entry, fetch)
            if merge.mergeable(entry.path) and entry.size <= BASE_MAX:
                self._save_base(source, entry.hash)
            try:
                await self.fileops.sync_write(entry.path, source, expect, actor, keep=keep)
            finally:
                source.unlink(missing_ok=True)
            self.state.put(replace(entry, vector=vector), stat=(self.vault / entry.path).stat())
            self.state.set_base(entry.path, entry.hash)
        await self._announce(entry.path)

    async def _bytes_for(self, entry: Entry, fetch: Fetch) -> Path:
        """A temporary file with the version's bytes: from a file this device already has
        (a move or a copy), else from the other device."""
        held = self.state.holder(entry.hash)
        if held is not None and (self.vault / held).is_file():
            target = self.temp()
            await asyncio.to_thread(shutil.copyfile, self.vault / held, target)
            if await asyncio.to_thread(file_hash, target) == entry.hash:
                return target
            target.unlink(missing_ok=True)  # changed since it was indexed: ask the peer
        fetched = await fetch()
        if fetched is None:
            raise Unavailable(entry.path)
        if await asyncio.to_thread(file_hash, fetched) != entry.hash:
            fetched.unlink(missing_ok=True)
            raise Unavailable(entry.path)
        return fetched

    async def _announce(self, path: str) -> None:
        """Tell the index and the open app, as for a change made outside Graite."""
        parts = path.split("/")
        if (
            parts[-1] in (PAGE_FILE, POLICY_FILE)
            or DATA_DIR in parts
            or any(part in DEFINITION_DIRS for part in parts)
        ):
            await self.watcher.handle({(Change.modified, str(self.vault / path))})

    # ----------------------------------------------------------------- overlapping edits

    def _save_base(self, source: Path, content_hash: str) -> None:
        folder = self.work / "base"
        folder.mkdir(parents=True, exist_ok=True)
        if not (folder / content_hash).exists():
            shutil.copyfile(source, folder / content_hash)

    def _base_text(self, path: str) -> str | None:
        """The last version of a file this device knows another device also had."""
        base_hash = self.state.base_hash(path)
        if not base_hash:
            return None
        with contextlib.suppress(OSError, UnicodeDecodeError):
            return (self.work / "base" / base_hash).read_text(encoding="utf-8")
        return None

    def mark_agreed(self) -> None:
        """Another device holds exactly what this one does: every text file is now a base for
        later merges. Bases no file points at any more are removed."""
        wanted: set[str] = set()
        for entry in self.state.entries():
            if entry.deleted or not merge.mergeable(entry.path) or entry.size > BASE_MAX:
                continue
            wanted.add(entry.hash)
            if self.state.base_hash(entry.path) != entry.hash:
                with contextlib.suppress(OSError):
                    self._save_base(self.vault / entry.path, entry.hash)
                    self.state.set_base(entry.path, entry.hash)
        folder = self.work / "base"
        if folder.is_dir():
            for blob in folder.iterdir():
                if blob.name not in wanted:
                    blob.unlink(missing_ok=True)

    async def _work_back_in(self, kept: Entry, lost: bytes, base: str | None) -> None:
        """This device's own edit was replaced by a version from another device. Merge it
        back when the two do not overlap; file a proposal when they do. (The replaced file
        was already kept as a version by the writer.)"""
        if kept.deleted or not merge.mergeable(kept.path):
            return
        target = self.vault / kept.path
        try:
            mine = lost.decode("utf-8")
            theirs = target.read_text(encoding="utf-8")
        except OSError, UnicodeDecodeError:
            return
        combined = merge.three_way(kept.path, base, theirs, mine)
        if combined is not None:
            if combined == theirs:
                return
            source = self.temp()
            source.write_text(combined, encoding="utf-8")
            try:
                await self.fileops.sync_write(kept.path, source, kept.hash, "sync")
            finally:
                source.unlink(missing_ok=True)
            # A new version made here, on top of both: found and sent like any local edit.
            await asyncio.to_thread(self.state.scan, kept.path)
            await self._announce(kept.path)
            return
        if kept.path.rsplit("/", 1)[-1] == PAGE_FILE and "/" in kept.path:
            await self._propose(kept, theirs, mine)

    async def _propose(self, kept: Entry, theirs: str, mine: str) -> None:
        page = kept.path.rsplit("/", 1)[0]
        device = self.device_name(kept.author)
        their_body, my_body = fm.split(theirs)[1], fm.split(mine)[1]
        if their_body == my_body:
            return
        change: dict[str, Any] = (
            {"kind": "edit", "old_text": their_body, "new_text": my_body}
            if their_body.strip()
            else {"kind": "append", "new_text": my_body}
        )
        try:
            await self.proposals.create(
                change.pop("kind"),
                page,
                summary=(
                    f"This page was changed here and on {device} at the same time. "
                    f"The page now shows the version from {device}; accept to put back "
                    "what you wrote on this device."
                ),
                policy="propose",
                conversation_id=f"sync:{device}",
                **change,
            )
        except ValueError:
            log.info("an overlapping edit is kept as a page version only")
