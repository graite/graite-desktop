"""What this device holds of a synced space: one row per file, with a version vector.

A version vector (`{replica: counter}`) says which devices' changes a file already contains.
Comparing two tells whether one version follows the other or they were made side by side.
Deleted files stay as tombstones so a device that was away learns of the deletion.

Changes are found by scanning (size and mtime first, then a hash), not by hooking the
writer: that also catches edits made in other editors.
"""

from __future__ import annotations

import hashlib
import json
import os
import sqlite3
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal

from graite.index.db import transaction
from graite.vault.paths import GRAITE_DIR

Order = Literal["equal", "newer", "older", "concurrent"]
GENERATED = frozenset({"NAVIGATION.md", "NAVIGATION-DEEP.md"})
SKILLS = f"{GRAITE_DIR}/skills"
TOMBSTONE_DAYS = 90


@dataclass(frozen=True)
class Entry:
    """One version of one file, as devices describe it to each other."""

    path: str
    hash: str  # sha256 of the bytes; "" for a deleted file
    size: int
    vector: dict[str, int]
    modified: int  # unix ms of the change, for picking between side-by-side versions
    author: str  # the replica that made this version
    deleted: bool = False

    def wire(self) -> dict[str, Any]:
        return {
            "path": self.path,
            "hash": self.hash,
            "size": self.size,
            "vector": self.vector,
            "modified": self.modified,
            "author": self.author,
            "deleted": self.deleted,
        }


def entry_from_wire(raw: Any) -> Entry:
    """Raises ValueError for anything that is not a well-formed entry."""
    if not isinstance(raw, dict):
        raise ValueError("Not a file entry.")
    vector = raw.get("vector")
    if not isinstance(vector, dict) or not all(
        isinstance(k, str) and isinstance(v, int) and v >= 0 for k, v in vector.items()
    ):
        raise ValueError("Not a version vector.")
    deleted = bool(raw.get("deleted"))
    content_hash = str(raw.get("hash") or "")
    if not deleted and len(content_hash) != 64:
        raise ValueError("Not a content hash.")
    return Entry(
        path=syncable(str(raw.get("path") or "")),
        hash="" if deleted else content_hash,
        size=max(0, int(raw.get("size") or 0)),
        vector=dict(vector),
        modified=int(raw.get("modified") or 0),
        author=str(raw.get("author") or ""),
        deleted=deleted,
    )


# --- which files sync -----------------------------------------------------------------------


def syncable(path: str) -> str:
    """The normalised vault-relative path of a file that may sync; ValueError otherwise.

    Every path another device names goes through here before it touches the disk."""
    if not path or path.startswith(("/", "\\")) or "\\" in path or "\0" in path or ":" in path[:3]:
        raise ValueError("Not a vault path.")
    parts = path.split("/")
    if any(part in ("", ".", "..") for part in parts):
        raise ValueError("Not a vault path.")
    if not is_synced(parts):
        raise ValueError("This file does not sync.")
    return "/".join(parts)


def is_synced(parts: list[str] | tuple[str, ...]) -> bool:
    name = parts[-1]
    if name in GENERATED and len(parts) == 1:
        return False
    if ".tmp-" in name or name.endswith(".part"):
        return False
    if parts[0] == GRAITE_DIR:
        # Device state stays on the device; only the vault's own skills travel.
        return len(parts) > 2 and parts[1] == "skills" and not _hidden(parts[2:])
    return not _hidden(parts)


def _hidden(parts: list[str] | tuple[str, ...]) -> bool:
    return any(part.startswith(".") for part in parts)


def _descend(rel: tuple[str, ...]) -> bool:
    """Whether a folder can hold files that sync."""
    if rel[0] == GRAITE_DIR:
        return len(rel) == 1 or (rel[1] == "skills" and not _hidden(rel[2:]))
    return not rel[-1].startswith(".")


def walk(vault: Path) -> dict[str, os.stat_result]:
    """Every file that syncs, by vault-relative path."""
    found: dict[str, os.stat_result] = {}
    stack = [vault]
    while stack:
        folder = stack.pop()
        try:
            children = list(os.scandir(folder))
        except OSError:
            continue
        for child in children:
            rel = Path(child.path).relative_to(vault).parts
            if child.is_symlink():
                continue
            if child.is_dir():
                if _descend(rel):
                    stack.append(Path(child.path))
            elif child.is_file() and is_synced(rel):
                try:
                    found["/".join(rel)] = child.stat()
                except OSError:
                    continue
    return found


def file_hash(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while chunk := handle.read(1 << 20):
            digest.update(chunk)
    return digest.hexdigest()


# --- version vectors ------------------------------------------------------------------------


def compare(theirs: dict[str, int], ours: dict[str, int]) -> Order:
    """How `theirs` stands to `ours`: newer, older, equal, or made side by side."""
    ahead = any(count > ours.get(replica, 0) for replica, count in theirs.items())
    behind = any(count > theirs.get(replica, 0) for replica, count in ours.items())
    if ahead and behind:
        return "concurrent"
    if ahead:
        return "newer"
    return "older" if behind else "equal"


def merged(a: dict[str, int], b: dict[str, int]) -> dict[str, int]:
    return {replica: max(a.get(replica, 0), b.get(replica, 0)) for replica in {*a, *b}}


def bumped(vector: dict[str, int], replica: str) -> dict[str, int]:
    return {**vector, replica: vector.get(replica, 0) + 1}


def wins(a: Entry, b: Entry) -> bool:
    """Whether `a` is kept over `b` when they were made side by side. Every device reaches the
    same answer from the two entries alone: the later change, then the larger hash."""
    return (a.modified, a.hash) >= (b.modified, b.hash)


# --- the table ------------------------------------------------------------------------------


@dataclass
class State:
    """The `sync_files` rows of one space, and the scan that keeps them true to the disk."""

    db: sqlite3.Connection
    vault: Path
    space_id: str
    replica_id: str

    def get(self, path: str) -> Entry | None:
        row = self.db.execute(
            "SELECT * FROM sync_files WHERE space_id=? AND path=?", (self.space_id, path)
        ).fetchone()
        return _entry(row) if row else None

    def entries(self) -> list[Entry]:
        rows = self.db.execute(
            "SELECT * FROM sync_files WHERE space_id=? ORDER BY path", (self.space_id,)
        ).fetchall()
        return [_entry(row) for row in rows]

    def live(self) -> list[tuple[str, str]]:
        rows = self.db.execute(
            "SELECT path, hash FROM sync_files WHERE space_id=? AND deleted=0", (self.space_id,)
        ).fetchall()
        return [(row[0], row[1]) for row in rows]

    def holder(self, content_hash: str) -> str | None:
        """A file on this device that already has these bytes (a moved or copied file)."""
        row = self.db.execute(
            "SELECT path FROM sync_files WHERE space_id=? AND hash=? AND deleted=0 LIMIT 1",
            (self.space_id, content_hash),
        ).fetchone()
        return str(row[0]) if row else None

    def put(self, entry: Entry, *, stat: os.stat_result | None = None, sent: bool = True) -> None:
        """Record a version. `sent` is False for one this device made and has yet to tell
        the others about."""
        with transaction(self.db):
            self.db.execute(
                "INSERT INTO sync_files (space_id, path, hash, size, mtime_ns, vector_json, "
                "modified, author, deleted, sent) VALUES (?,?,?,?,?,?,?,?,?,?) "
                "ON CONFLICT(space_id, path) DO UPDATE SET hash=excluded.hash, "
                "size=excluded.size, mtime_ns=excluded.mtime_ns, "
                "vector_json=excluded.vector_json, modified=excluded.modified, "
                "author=excluded.author, deleted=excluded.deleted, sent=excluded.sent",
                (
                    self.space_id,
                    entry.path,
                    entry.hash,
                    entry.size,
                    stat.st_mtime_ns if stat else None,
                    json.dumps(entry.vector, sort_keys=True),
                    entry.modified,
                    entry.author,
                    int(entry.deleted),
                    int(sent),
                ),
            )

    def set_vector(self, path: str, vector: dict[str, int]) -> None:
        with transaction(self.db):
            self.db.execute(
                "UPDATE sync_files SET vector_json=? WHERE space_id=? AND path=?",
                (json.dumps(vector, sort_keys=True), self.space_id, path),
            )

    def unsent(self) -> list[Entry]:
        """Versions this device made that the other devices have not been told about."""
        rows = self.db.execute(
            "SELECT * FROM sync_files WHERE space_id=? AND sent=0 ORDER BY path", (self.space_id,)
        ).fetchall()
        return [_entry(row) for row in rows]

    def is_sent(self, path: str) -> bool:
        row = self.db.execute(
            "SELECT sent FROM sync_files WHERE space_id=? AND path=?", (self.space_id, path)
        ).fetchone()
        return bool(row and row[0])

    def mark_sent(self, entry: Entry) -> None:
        """The others were told of this version (unless the file changed again since)."""
        with transaction(self.db):
            self.db.execute(
                "UPDATE sync_files SET sent=1 WHERE space_id=? AND path=? AND vector_json=?",
                (self.space_id, entry.path, json.dumps(entry.vector, sort_keys=True)),
            )

    def base_hash(self, path: str) -> str | None:
        row = self.db.execute(
            "SELECT base_hash FROM sync_files WHERE space_id=? AND path=?", (self.space_id, path)
        ).fetchone()
        return str(row[0]) if row and row[0] else None

    def set_base(self, path: str, content_hash: str) -> None:
        with transaction(self.db):
            self.db.execute(
                "UPDATE sync_files SET base_hash=? WHERE space_id=? AND path=?",
                (content_hash, self.space_id, path),
            )

    def scan(self, only: str | None = None) -> list[Entry]:
        """Bring the rows in line with the disk; returns the versions this device just made
        (edits, new files, deletions). `only` limits the look to one path."""
        if only is None:
            on_disk = walk(self.vault)
            known = {row["path"]: row for row in self._rows()}
        else:
            target = self.vault / only
            on_disk = {}
            if target.is_file() and not target.is_symlink():
                on_disk[only] = target.stat()
            known = {row["path"]: row for row in self._rows(only)}
        changed: list[Entry] = []
        now = int(time.time() * 1000)
        for path, stat in on_disk.items():
            row = known.get(path)
            if (
                row is not None
                and not row["deleted"]
                and row["size"] == stat.st_size
                and row["mtime_ns"] == stat.st_mtime_ns
            ):
                continue
            try:
                content_hash = file_hash(self.vault / path)
            except OSError:
                continue
            if row is not None and not row["deleted"] and row["hash"] == content_hash:
                # Touched, not changed: remember the new mtime, keep the version.
                with transaction(self.db):
                    self.db.execute(
                        "UPDATE sync_files SET mtime_ns=?, size=? WHERE space_id=? AND path=?",
                        (stat.st_mtime_ns, stat.st_size, self.space_id, path),
                    )
                continue
            vector = json.loads(row["vector_json"]) if row is not None else {}
            entry = Entry(
                path=path,
                hash=content_hash,
                size=stat.st_size,
                vector=bumped(vector, self.replica_id),
                modified=min(now, stat.st_mtime_ns // 1_000_000) or now,
                author=self.replica_id,
            )
            self.put(entry, stat=stat, sent=False)
            changed.append(entry)
        for path, row in known.items():
            if path in on_disk or row["deleted"]:
                continue
            entry = Entry(
                path=path,
                hash="",
                size=0,
                vector=bumped(json.loads(row["vector_json"]), self.replica_id),
                modified=now,
                author=self.replica_id,
                deleted=True,
            )
            self.put(entry, sent=False)
            changed.append(entry)
        return changed

    def forget_old_tombstones(self) -> None:
        cutoff = int((time.time() - TOMBSTONE_DAYS * 86400) * 1000)
        with transaction(self.db):
            self.db.execute(
                "DELETE FROM sync_files WHERE space_id=? AND deleted=1 AND modified<?",
                (self.space_id, cutoff),
            )

    def _rows(self, only: str | None = None) -> list[sqlite3.Row]:
        if only is None:
            return list(
                self.db.execute(
                    "SELECT * FROM sync_files WHERE space_id=?", (self.space_id,)
                ).fetchall()
            )
        return list(
            self.db.execute(
                "SELECT * FROM sync_files WHERE space_id=? AND path=?", (self.space_id, only)
            ).fetchall()
        )


def _entry(row: sqlite3.Row) -> Entry:
    return Entry(
        path=row["path"],
        hash=row["hash"],
        size=row["size"],
        vector=json.loads(row["vector_json"]),
        modified=row["modified"],
        author=row["author"],
        deleted=bool(row["deleted"]),
    )
