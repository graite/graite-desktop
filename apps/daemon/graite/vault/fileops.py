"""The single writer for the vault (CLAUDE.md rule 1, docs/design/editor-roundtrip.md §7).

Every mutation: per-path lock -> optional base-hash check -> version snapshot -> atomic
write -> index rescan -> activity row -> event. Nothing else in the daemon writes vault files.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import os
import re
import shutil
import sqlite3
import time
from collections import defaultdict
from collections.abc import Callable
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from graite.events import EventBus
from graite.vault import frontmatter as fm
from graite.vault import indexer
from graite.vault.instructions import safe_file
from graite.vault.models import (
    AttachmentEntry,
    AttachmentInUse,
    ConflictError,
    PageDoc,
    PurgeResult,
    TrashEntry,
    TreeNode,
)
from graite.vault.paths import (
    GRAITE_DIR,
    PAGE_FILE,
    VaultPathError,
    is_page_dir,
    page_dir,
    page_file,
    parent_of,
    slugify,
    validate_rel,
)
from graite.vault.request_context import current_request_id

ORIGIN_FILE = ".origin.json"
ASSETS_DIR = "_assets"
_ATTACHMENT_NAME = re.compile(r"[a-zA-Z0-9][a-zA-Z0-9._-]{0,199}")
_UUID_PREFIX = re.compile(r"^[a-f0-9]{32}-")
# The only names extraction results were ever stored under (they now stay in the job record).
_GENERATED_TEXT = re.compile(r"[a-f0-9]{32}-(?:transcript|ocr)\.md")


# The converter's stand-in for an empty paragraph (packages/md-convert `fromBlocks`): the
# editor writes one wherever the user left a blank line, very often at the end of a page.
EMPTY_MARKER = "<!-- graite:empty -->"
_BULLET = re.compile(r"^([-*+])[ \t]+\S|^(\d+)[.)][ \t]+\S")


def _list_kind(line: str) -> str | None:
    """The marker ("-", "*", "+" or "1.") of a top-level single-line list item, else None."""
    match = _BULLET.match(line)
    if match is None:
        return None
    return match.group(1) or "1."


def _tighten(lines: list[str]) -> list[str]:
    """Drop blank lines and empty-paragraph markers between the items of one list."""
    kinds = {_list_kind(line) for line in lines if line.strip() and line.strip() != EMPTY_MARKER}
    if len(kinds) != 1 or None in kinds:
        return lines
    return [line for line in lines if line.strip() and line.strip() != EMPTY_MARKER]


def append_markdown(body: str, text: str) -> str:
    """`body` with `text` added at the end, the way an append proposal applies it.

    Appending bullets to a page that ends in a list continues that list: no blank line, no
    empty-paragraph marker left over from the editor in between, and the list the earlier
    appends spread out with blank lines is pulled back together. Anything else is separated
    from what precedes it by one blank line. Only the end of the page is touched.
    """
    text = text.strip("\n")
    lines = body.rstrip().split("\n") if body.strip() else []
    # A trailing empty paragraph is where the cursor was, not content: never keep it
    # between the old end of the page and what is appended.
    while lines and lines[-1].strip() in ("", EMPTY_MARKER):
        lines.pop()
    if not lines:
        return text + "\n"
    added = _tighten(text.split("\n"))
    kind = _list_kind(added[0]) if added else None
    if kind is not None and _list_kind(lines[-1]) == kind:
        # Walk back over the page's final list (single-line items, blanks and markers).
        start = len(lines)
        while start > 0 and (
            _list_kind(lines[start - 1]) == kind or lines[start - 1].strip() in ("", EMPTY_MARKER)
        ):
            start -= 1
        while lines[start].strip() in ("", EMPTY_MARKER):
            start += 1  # the blank line before the list separates it from a paragraph
        joined = _tighten(lines[start:]) + added
        if all(_list_kind(line) == kind for line in joined):
            return "\n".join([*lines[:start], *joined]) + "\n"
    return "\n".join(lines) + "\n\n" + "\n".join(added) + "\n"


def _iso(timestamp: float) -> str:
    moment = datetime.fromtimestamp(timestamp, tz=UTC).replace(microsecond=0)
    return moment.isoformat().replace("+00:00", "Z")


def _tree_size(root: Path) -> int:
    """Bytes under `root`, never following symlinks."""
    if root.is_symlink():
        return 0
    if root.is_file():
        return root.stat().st_size
    total = 0
    for directory, _, files in os.walk(root, followlinks=False):
        for name in files:
            item = Path(directory) / name
            try:
                if not item.is_symlink() and name != ORIGIN_FILE:
                    total += item.stat().st_size
            except OSError:
                continue
    return total


# Files this process wrote recently (absolute path -> (mtime_ns, monotonic)); the watcher
# uses it to ignore the daemon's own writes.
RECENT_WRITES: dict[str, tuple[int, float]] = {}


def _sha256(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def _record_write(path: Path) -> None:
    try:
        RECENT_WRITES[str(path)] = (path.stat().st_mtime_ns, time.monotonic())
    except OSError:
        return
    if len(RECENT_WRITES) > 2000:
        for key in list(RECENT_WRITES)[:1000]:
            RECENT_WRITES.pop(key, None)


def _atomic_write(path: Path, text: str) -> None:
    tmp = path.with_name(f".{path.name}.tmp-{os.getpid()}")
    tmp.write_text(text, encoding="utf-8")
    os.replace(tmp, path)
    _record_write(path)


class FileOps:
    def __init__(self, vault: Path, db: sqlite3.Connection, events: EventBus) -> None:
        self.vault = vault
        self.db = db
        self.events = events
        self._locks: dict[str, asyncio.Lock] = defaultdict(asyncio.Lock)
        # Set by the app: receives every ScanResult (used to queue embedding jobs).
        self.on_indexed: Callable[[indexer.ScanResult], None] | None = None
        # Bumped on every change the daemon knows about; caches keyed on it stay honest.
        self.epoch = 0

    def bump(self) -> None:
        self.epoch += 1

    # ----------------------------------------------------------------- helpers (sync)

    def _doc_from_text(self, rel: str, text: str) -> PageDoc:
        meta, body = fm.split(text)
        return PageDoc(
            path=rel,
            id=str(meta.get("id") or ""),
            title=str(meta.get("title") or rel.rsplit("/", 1)[-1]),
            icon=meta.get("icon") or None,
            frontmatter=meta,
            body=body,
            hash=_sha256(text),
        )

    def _read_sync(self, rel: str) -> PageDoc:
        f = page_file(self.vault, rel)
        if not f.is_file():
            raise FileNotFoundError(rel)
        return self._doc_from_text(rel, f.read_text(encoding="utf-8"))

    def _snapshot(self, doc_id: str, text: str) -> str | None:
        if not doc_id:
            return None
        target = self.vault / GRAITE_DIR / "versions" / doc_id / f"{int(time.time() * 1000)}.md"
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(text, encoding="utf-8")
        return target.relative_to(self.vault).as_posix()

    def _publish(self, type_: str, data: dict[str, Any]) -> None:
        """Publish an event stamped with the originating request id (None for internal writes)."""
        self.bump()
        self.events.publish(type_, {**data, "request_id": current_request_id.get()})

    def _activity(self, actor: str, action: str, path: str | None, detail: dict[str, Any]) -> None:
        self.db.execute(
            "INSERT INTO activities (ts, actor, action, path, detail_json) VALUES (?, ?, ?, ?, ?)",
            (fm.now_iso(), actor, action, path, json.dumps(detail, ensure_ascii=False)),
        )

    def _rescan(self, paths: list[str] | None = None) -> indexer.ScanResult:
        result = indexer.scan(self.vault, self.db, paths=paths)
        if self.on_indexed is not None:
            self.on_indexed(result)
        return result

    def _unique_dir(self, parent: Path, slug: str, *, ignore: Path | None = None) -> Path:
        candidate = parent / slug
        n = 2
        while candidate.exists() and candidate != ignore:
            candidate = parent / f"{slug} {n}"
            n += 1
        return candidate

    def _write_page_sync(
        self, rel: str, meta: dict[str, Any], body: str, *, old_text: str | None, actor: str
    ) -> PageDoc:
        """Write page.md for `rel`; snapshot the previous text when the body changed."""
        text = fm.join(meta, body)
        if old_text is not None and old_text != text:
            _, old_body = fm.split(old_text)
            if old_body != body:
                self._snapshot(str(meta.get("id") or ""), old_text)
        _atomic_write(page_file(self.vault, rel), text)
        return self._doc_from_text(rel, text)

    # ----------------------------------------------------------------- public (async)

    def _instruction_file(self, source: str) -> Path:
        parts = source.split("/")
        if parts[-1] != "AGENTS.md":
            raise VaultPathError("Instruction files must be named AGENTS.md.")
        folder = "/".join(parts[:-1])
        if folder:
            validate_rel(folder)
            if not is_page_dir(page_dir(self.vault, folder)):
                raise FileNotFoundError(folder)
        return safe_file(self.vault, source)

    async def read_instructions(self, source: str) -> dict[str, str]:
        target = self._instruction_file(source)

        def read() -> dict[str, str]:
            text = target.read_text(encoding="utf-8") if target.is_file() else ""
            _, body = fm.split(text)
            return {"source": source, "text": body, "hash": _sha256(text)}

        return await asyncio.to_thread(read)

    async def set_instructions(
        self, source: str, body: str, base_hash: str, *, actor: str
    ) -> dict[str, str]:
        target = self._instruction_file(source)
        if len(body) > 16000:
            raise ValueError("Keep shared instructions under 16,000 characters.")
        async with self._locks[source]:

            def write() -> dict[str, str]:
                old = target.read_text(encoding="utf-8") if target.is_file() else ""
                meta, old_body = fm.split(old)
                if _sha256(old) != base_hash:
                    raise ConflictError(_sha256(old), old_body)
                text = fm.join(meta, body) if meta else body
                if text != old:
                    self._snapshot("instructions-" + _sha256(source)[:16], old)
                    _atomic_write(target, text)
                    self._activity(actor, "instructions.write", source, {})
                    self._publish(
                        "policy_changed", {"path": "/".join(source.split("/")[:-1]) or None}
                    )
                return {"source": source, "text": body, "hash": _sha256(text)}

            return await asyncio.to_thread(write)

    async def write_definition(self, rel: str, text: str, actor: str) -> str:
        """Write an agent or workflow file (`<folder>/_agents/<name>.md`); returns its path."""
        parts = rel.replace("\\", "/").split("/")
        if len(parts) < 2 or parts[-2] not in ("_agents", "_workflows") or not rel.endswith(".md"):
            raise VaultPathError("definitions live in _agents/ or _workflows/")
        folder = "/".join(parts[:-2])
        if folder:
            validate_rel(folder)
            if not is_page_dir(page_dir(self.vault, folder)):
                raise FileNotFoundError(folder)
        target = safe_file(self.vault, rel)

        def write() -> str:
            target.parent.mkdir(parents=True, exist_ok=True)
            _atomic_write(target, text)
            self._activity(actor, "definition.write", rel, {})
            self._publish("policy_changed", {"path": folder or None})
            return rel

        return await asyncio.to_thread(write)

    async def delete_definition(self, rel: str, actor: str) -> None:
        parts = rel.replace("\\", "/").split("/")
        if len(parts) < 2 or parts[-2] not in ("_agents", "_workflows"):
            raise VaultPathError("definitions live in _agents/ or _workflows/")
        target = safe_file(self.vault, rel)
        if not target.is_file():
            raise FileNotFoundError(rel)

        def remove() -> None:
            target.unlink()
            self._activity(actor, "definition.delete", rel, {})
            self._publish("policy_changed", {"path": "/".join(parts[:-2]) or None})

        await asyncio.to_thread(remove)

    async def set_live_status(self, rel: str, *, run_at: str) -> PageDoc:
        """Record `live.last_run_at` on a page; nothing else in the file changes."""
        rel = validate_rel(rel)
        async with self._locks[rel]:

            def write() -> PageDoc:
                f = page_file(self.vault, rel)
                old_text = f.read_text(encoding="utf-8")
                current = self._doc_from_text(rel, old_text)
                meta = dict(current.frontmatter)
                live = dict(meta.get("live") or {}) if isinstance(meta.get("live"), dict) else {}
                live["last_run_at"] = run_at
                meta["live"] = live
                doc = self._write_page_sync(
                    rel, meta, current.body, old_text=old_text, actor="agent"
                )
                self._rescan([rel])
                self._publish("file_changed", {"path": rel, "hash": doc.hash, "actor": "agent"})
                return doc

            return await asyncio.to_thread(write)

    async def snapshot_page(self, rel: str) -> str | None:
        """Keep a copy of the page as it is now (`.graite/versions/<id>/`); returns its path."""
        rel = validate_rel(rel)

        def snap() -> str | None:
            doc = self._read_sync(rel)
            return self._snapshot(doc.id, page_file(self.vault, rel).read_text(encoding="utf-8"))

        return await asyncio.to_thread(snap)

    async def read_snapshot(self, version_rel: str) -> str:
        """The text of a kept version, addressed by the path `snapshot_page` returned."""
        parts = version_rel.replace("\\", "/").split("/")
        if parts[:2] != [GRAITE_DIR, "versions"] or any(p in ("", ".", "..") for p in parts):
            raise VaultPathError("not a version path")
        target = self.vault / version_rel
        if not target.is_file():
            raise FileNotFoundError(version_rel)
        return await asyncio.to_thread(target.read_text, "utf-8")

    async def read_page(self, rel: str) -> PageDoc:
        rel = validate_rel(rel)
        return await asyncio.to_thread(self._read_sync, rel)

    def page_by_id(self, page_id: str) -> str:
        row = self.db.execute("SELECT path FROM pages WHERE id=?", (page_id,)).fetchone()
        if not row:
            raise FileNotFoundError("This page no longer exists.")
        rel = validate_rel(row[0])
        directory = page_dir(self.vault, rel)
        if (
            directory.resolve() != self.vault.resolve() / rel
            or directory.is_symlink()
            or (directory / PAGE_FILE).is_symlink()
        ):
            raise VaultPathError("Linked page folders cannot contain media.")
        return rel

    def attachment_path(self, page_id: str, name: str) -> Path:
        rel = self.page_by_id(page_id)
        if not _ATTACHMENT_NAME.fullmatch(name):
            raise VaultPathError("Invalid attachment name.")
        directory = page_dir(self.vault, rel) / ASSETS_DIR
        target = directory / name
        if directory.is_symlink() or target.is_symlink():
            raise VaultPathError("Linked attachments are not allowed.")
        return target

    async def add_attachment(self, page_id: str, filename: str, data: bytes) -> str:
        """Immutable, page-owned originals/results; renaming a page moves its files too."""
        import uuid

        safe = re.sub(r"[^a-zA-Z0-9._-]", "-", filename)[:140].strip(".-") or "file"
        name = f"{uuid.uuid4().hex}-{safe}"
        async with self._locks[self.page_by_id(page_id)]:

            def write() -> None:
                target = self.attachment_path(page_id, name)
                target.parent.mkdir(exist_ok=True)
                # Exclusive creation prevents collisions; no existing vault file is overwritten.
                temp = target.with_name("." + name + ".part")
                try:
                    with temp.open("xb") as handle:
                        handle.write(data)
                        handle.flush()
                        os.fsync(handle.fileno())
                    os.replace(temp, target)
                finally:
                    temp.unlink(missing_ok=True)
                self._activity(
                    "user",
                    "attachment.create",
                    self.page_by_id(page_id),
                    {"file": name, "bytes": len(data)},
                )
                self._publish(
                    "attachments_changed",
                    {"page_id": page_id, "path": self.page_by_id(page_id), "reason": "create"},
                )

            await asyncio.to_thread(write)
        return name

    def _attachment_refs_sync(self, rel: str, names: list[str]) -> dict[str, list[str]]:
        """Pages that mention each stored filename: the owning page and its descendants.

        Stored names start with a unique uuid, so a substring match on the raw page.md is
        exact. It covers graite:media/graite:text fences, media properties in frontmatter and
        `../_assets/<file>` links from transcript subpages.
        """
        refs: dict[str, list[str]] = {name: [] for name in names}
        if not names:
            return refs
        rows = self.db.execute("SELECT path FROM pages ORDER BY path").fetchall()
        for row in rows:
            path = str(row[0])
            if path != rel and not path.startswith(rel + "/"):
                continue
            try:
                text = page_file(self.vault, path).read_text(encoding="utf-8")
            except (OSError, ValueError):
                continue
            for name in names:
                if name in text:
                    refs[name].append(path)
        return refs

    def _list_attachments_sync(self, page_id: str) -> list[AttachmentEntry]:
        rel = self.page_by_id(page_id)
        directory = page_dir(self.vault, rel) / ASSETS_DIR
        if directory.is_symlink():
            raise VaultPathError("Linked attachments are not allowed.")
        if not directory.is_dir():
            return []
        files = sorted(
            (
                item
                for item in directory.iterdir()
                # Hidden names are in-flight `.part` uploads; symlinks never count as ours.
                if _ATTACHMENT_NAME.fullmatch(item.name)
                and not item.is_symlink()
                and item.is_file()
            ),
            key=lambda item: item.stat().st_mtime,
            reverse=True,
        )
        refs = self._attachment_refs_sync(rel, [item.name for item in files])
        return [
            AttachmentEntry(
                file=item.name,
                name=_UUID_PREFIX.sub("", item.name) or item.name,
                size=item.stat().st_size,
                modified=_iso(item.stat().st_mtime),
                referenced_by=refs[item.name],
                generated=bool(_GENERATED_TEXT.fullmatch(item.name)),
            )
            for item in files
        ]

    async def list_attachments(self, page_id: str) -> list[AttachmentEntry]:
        return await asyncio.to_thread(self._list_attachments_sync, page_id)

    async def trash_attachment(
        self, page_id: str, file: str, actor: str, *, force: bool = False
    ) -> str:
        """Move one page attachment to the trash. The page itself is never rewritten."""
        async with self._locks[self.page_by_id(page_id)]:
            return await asyncio.to_thread(self._trash_attachment_sync, page_id, file, actor, force)

    def _trash_attachment_sync(self, page_id: str, file: str, actor: str, force: bool) -> str:
        rel = self.page_by_id(page_id)
        source = self.attachment_path(page_id, file)
        if not source.is_file():
            raise FileNotFoundError("The local attachment is missing.")
        referenced_by = self._attachment_refs_sync(rel, [file])[file]
        if referenced_by and not force:
            raise AttachmentInUse(referenced_by)
        display = _UUID_PREFIX.sub("", file) or file
        trash_root = self._trash_root()
        trash_root.mkdir(parents=True, exist_ok=True)
        stamp = int(time.time() * 1000)
        while True:
            dest = trash_root / f"{stamp}-{slugify(display)}"
            try:
                dest.mkdir()
                break
            except FileExistsError:
                stamp += 1
        shutil.move(str(source), str(dest / file))
        (dest / ORIGIN_FILE).write_text(
            json.dumps(
                {
                    "kind": "attachment",
                    "page_id": page_id,
                    "path": rel,
                    "file": file,
                    "name": display,
                    "trashed_at": fm.now_iso(),
                },
                ensure_ascii=False,
            ),
            encoding="utf-8",
        )
        self._activity(
            actor,
            "attachment.trash",
            rel,
            {"file": file, "trash_id": dest.name, "referenced_by": referenced_by},
        )
        self._publish("attachments_changed", {"page_id": page_id, "path": rel, "reason": "trash"})
        self._publish("trash_changed", {"reason": "trash"})
        return dest.name

    def chat_dir(self, conversation_id: str) -> Path:
        if not re.fullmatch(r"[a-f0-9]{32}", conversation_id):
            raise VaultPathError("Invalid conversation id.")
        return self.vault / GRAITE_DIR / "chat" / conversation_id

    async def store_chat_attachment(
        self, conversation_id: str, attachment_id: str, filename: str, data: bytes
    ) -> str:
        """Keep a chat upload under .graite/chat/<conversation>/ (derivable state)."""
        safe = re.sub(r"[^a-zA-Z0-9._-]", "-", filename)[:140].strip(".-") or "file"
        name = f"{attachment_id}-{safe}"
        directory = self.chat_dir(conversation_id)

        def write() -> None:
            directory.mkdir(parents=True, exist_ok=True)
            target = directory / name
            temp = target.with_name("." + name + ".part")
            try:
                with temp.open("xb") as handle:
                    handle.write(data)
                    handle.flush()
                    os.fsync(handle.fileno())
                os.replace(temp, target)
            finally:
                temp.unlink(missing_ok=True)

        await asyncio.to_thread(write)
        return (directory / name).relative_to(self.vault).as_posix()

    async def remove_chat_attachment(self, rel_path: str) -> None:
        target = (self.vault / rel_path).resolve()
        root = (self.vault / GRAITE_DIR / "chat").resolve()
        if not target.is_relative_to(root):
            raise VaultPathError("Not a chat attachment.")
        await asyncio.to_thread(lambda: target.unlink(missing_ok=True))

    async def remove_chat_folder(self, conversation_id: str) -> None:
        directory = self.chat_dir(conversation_id)
        await asyncio.to_thread(lambda: shutil.rmtree(directory, ignore_errors=True))

    async def create_media_page(self, page_id: str, title: str, body: str) -> PageDoc:
        rel = self.page_by_id(page_id)
        async with self._locks[rel]:

            def write() -> PageDoc:
                current = self.page_by_id(page_id)
                doc = self._create_sync(current, title, None, "user")
                return self._write_body_sync(doc.path, body, doc.hash, "user")

            return await asyncio.to_thread(write)

    async def tree(self) -> list[TreeNode]:
        return await asyncio.to_thread(indexer.tree, self.db)

    async def rescan(self) -> int:
        return (await asyncio.to_thread(self._rescan)).total

    async def rescan_paths(self, paths: list[str], actor: str = "external") -> indexer.ScanResult:
        """Index pages changed outside Graite (watcher) and tell clients what moved."""

        def run() -> indexer.ScanResult:
            known = {row[0] for row in self.db.execute("SELECT path FROM pages")}
            result = self._rescan(paths or None)
            for rel in result.touched:
                row = self.db.execute("SELECT file_hash FROM pages WHERE path=?", (rel,)).fetchone()
                if row and rel not in known:
                    self._publish("tree_changed", {"reason": "create", "path": rel, "actor": actor})
                elif row:
                    self._publish(
                        "file_changed", {"path": rel, "hash": row["file_hash"], "actor": actor}
                    )
            if result.structure_changed:
                self._publish("tree_changed", {"reason": actor, "path": None})
            return result

        return await asyncio.to_thread(run)

    async def write_body(self, rel: str, body: str, base_hash: str | None, actor: str) -> PageDoc:
        rel = validate_rel(rel)
        async with self._locks[rel]:
            return await asyncio.to_thread(self._write_body_sync, rel, body, base_hash, actor)

    def _write_body_sync(self, rel: str, body: str, base_hash: str | None, actor: str) -> PageDoc:
        f = page_file(self.vault, rel)
        if not f.is_file():
            raise FileNotFoundError(rel)
        old_text = f.read_text(encoding="utf-8")
        current = self._doc_from_text(rel, old_text)
        if base_hash is not None and base_hash != current.hash:
            raise ConflictError(current.hash, current.body)
        body = body.strip("\n")
        body = body + "\n" if body else ""
        if body == current.body:
            return current
        meta = dict(current.frontmatter)
        meta.setdefault("id", fm.uuid7())
        meta.setdefault("title", current.title)
        meta.setdefault("created", fm.now_iso())
        meta["updated"] = fm.now_iso()
        doc = self._write_page_sync(rel, meta, body, old_text=old_text, actor=actor)
        self._rescan()
        self._activity(actor, "page.write", rel, {"hash": doc.hash})
        self._publish("file_changed", {"path": rel, "hash": doc.hash, "actor": actor})
        if bool(current.body.strip()) != bool(body.strip()):
            # The sidebar shows whether a page has any text; tell it when that flips.
            self._publish("tree_changed", {"reason": "content", "path": rel})
        return doc

    async def create_page(
        self, parent_rel: str | None, title: str, icon: str | None, actor: str
    ) -> PageDoc:
        parent_rel = validate_rel(parent_rel) if parent_rel else None
        lock_key = parent_rel or ""
        async with self._locks[lock_key]:
            return await asyncio.to_thread(self._create_sync, parent_rel, title, icon, actor)

    def _create_sync(
        self, parent_rel: str | None, title: str, icon: str | None, actor: str
    ) -> PageDoc:
        parent_dir = page_dir(self.vault, parent_rel) if parent_rel else self.vault
        if parent_rel and not is_page_dir(parent_dir):
            raise FileNotFoundError(parent_rel)
        title = title.strip() or "Untitled"
        target = self._unique_dir(parent_dir, slugify(title))
        target.mkdir(parents=True, exist_ok=False)
        rel = target.relative_to(self.vault).as_posix()
        doc = self._write_page_sync(rel, fm.new_meta(title, icon), "", old_text=None, actor=actor)
        self._rescan()
        self._activity(actor, "page.create", rel, {"parent": parent_rel})
        self._publish("tree_changed", {"reason": "create", "path": rel, "actor": actor})
        return doc

    async def update_meta(
        self,
        rel: str,
        *,
        title: str | None = None,
        icon: str | None = None,
        clear_icon: bool = False,
        actor: str,
    ) -> PageDoc:
        rel = validate_rel(rel)
        async with self._locks[rel]:
            return await asyncio.to_thread(
                self._update_meta_sync, rel, title, icon, clear_icon, actor
            )

    def _update_meta_sync(
        self, rel: str, title: str | None, icon: str | None, clear_icon: bool, actor: str
    ) -> PageDoc:
        f = page_file(self.vault, rel)
        if not f.is_file():
            raise FileNotFoundError(rel)
        old_text = f.read_text(encoding="utf-8")
        current = self._doc_from_text(rel, old_text)
        meta = dict(current.frontmatter)
        meta.setdefault("id", fm.uuid7())
        changed: dict[str, Any] = {}
        old_title = current.title
        if title is not None and title.strip() and title.strip() != current.title:
            meta["title"] = title.strip()
            changed["title"] = meta["title"]
        if clear_icon:
            if meta.pop("icon", None) is not None:
                changed["icon"] = None
        elif icon is not None and icon != current.icon:
            meta["icon"] = icon
            changed["icon"] = icon
        if not changed:
            return current
        meta["updated"] = fm.now_iso()
        doc = self._write_page_sync(rel, meta, current.body, old_text=old_text, actor=actor)

        new_rel = rel
        if "title" in changed:
            new_slug = slugify(meta["title"])
            current_dir = page_dir(self.vault, rel)
            if new_slug != current_dir.name:
                target = self._unique_dir(current_dir.parent, new_slug, ignore=current_dir)
                os.replace(current_dir, target)
                new_rel = target.relative_to(self.vault).as_posix()
                doc = self._read_sync(new_rel)
            parent_rel = parent_of(new_rel)
            if parent_rel:
                self._rewrite_parent_links(parent_rel, old_title, meta["title"], actor)

        self._rescan()
        self._activity(actor, "page.meta", new_rel, {**changed, "from": rel})
        self._publish(
            "tree_changed",
            {"reason": "rename" if "title" in changed else "icon", "path": new_rel, "from": rel},
        )
        return doc

    def _rewrite_parent_links(self, parent_rel: str, old: str, new: str, actor: str) -> None:
        """Rewrite `[[old]]` / `[[old|alias]]` / `[[old#h]]` to the new title in the parent."""
        f = page_file(self.vault, parent_rel)
        if not f.is_file() or old == new:
            return
        old_text = f.read_text(encoding="utf-8")
        pattern = re.compile(r"\[\[" + re.escape(old) + r"(?=[\]|#])")
        new_text = pattern.sub("[[" + new.replace("\\", "\\\\"), old_text)
        if new_text == old_text:
            return
        meta, body = fm.split(new_text)
        meta["updated"] = fm.now_iso()
        doc = self._write_page_sync(parent_rel, meta, body, old_text=old_text, actor=actor)
        self._activity(actor, "page.write", parent_rel, {"hash": doc.hash, "link_rewrite": True})
        self._publish("file_changed", {"path": parent_rel, "hash": doc.hash, "actor": actor})

    async def trash_page(self, rel: str, actor: str) -> str:
        rel = validate_rel(rel)
        async with self._locks[rel]:
            return await asyncio.to_thread(self._trash_sync, rel, actor)

    def _trash_sync(self, rel: str, actor: str) -> str:
        current_dir = page_dir(self.vault, rel)
        if not is_page_dir(current_dir):
            raise FileNotFoundError(rel)
        trash_root = self.vault / GRAITE_DIR / "trash"
        trash_root.mkdir(parents=True, exist_ok=True)
        trash_id = f"{int(time.time() * 1000)}-{slugify(current_dir.name)}"
        dest = trash_root / trash_id
        shutil.move(str(current_dir), str(dest))
        (dest / ORIGIN_FILE).write_text(
            json.dumps({"path": rel, "trashed_at": fm.now_iso()}, ensure_ascii=False),
            encoding="utf-8",
        )
        self._rescan()
        self._activity(actor, "page.trash", rel, {"trash_id": trash_id})
        self._publish("tree_changed", {"reason": "trash", "path": rel})
        return trash_id

    # ----------------------------------------------------------------- trash

    def _trash_root(self) -> Path:
        return self.vault / GRAITE_DIR / "trash"

    def _trash_meta(self, trash_dir: Path) -> dict[str, Any]:
        origin_file = trash_dir / ORIGIN_FILE
        if origin_file.is_file() and not origin_file.is_symlink():
            try:
                data = json.loads(origin_file.read_text(encoding="utf-8"))
                if isinstance(data, dict):
                    return data
            except (OSError, ValueError):
                pass
        return {}

    def _trash_origin(self, trash_dir: Path) -> tuple[str | None, str | None]:
        """(origin path, trashed_at) from .origin.json, else from the activities table."""
        data = self._trash_meta(trash_dir)
        if data:
            return (data.get("path") or None, data.get("trashed_at") or None)
        row = self.db.execute(
            "SELECT path, ts FROM activities WHERE action = 'page.trash' "
            "AND detail_json LIKE ? ORDER BY id DESC LIMIT 1",
            (f'%"trash_id": "{trash_dir.name}"%',),
        ).fetchone()
        if row is not None:
            return (row["path"], row["ts"])
        return (None, None)

    def _trash_entry(self, trash_dir: Path) -> TrashEntry:
        origin, trashed_at = self._trash_origin(trash_dir)
        ms_prefix, _, rest = trash_dir.name.partition("-")
        title = rest or trash_dir.name
        page = trash_dir / PAGE_FILE
        if page.is_file():
            try:
                meta, _ = fm.split(page.read_text(encoding="utf-8"))
                title = str(meta.get("title") or title)
            except (OSError, ValueError):
                pass
        if trashed_at is None:
            try:
                trashed_at = (
                    datetime.fromtimestamp(int(ms_prefix) / 1000, tz=UTC)
                    .replace(microsecond=0)
                    .isoformat()
                    .replace("+00:00", "Z")
                )
            except ValueError:
                trashed_at = ""
        entry = TrashEntry(
            trash_id=trash_dir.name,
            path=origin,
            title=title,
            trashed_at=trashed_at,
            size=_tree_size(trash_dir),
        )
        meta = self._trash_meta(trash_dir)
        if meta.get("kind") == "attachment":
            entry.kind = "attachment"
            entry.file = str(meta.get("file") or "") or None
            entry.page_id = str(meta.get("page_id") or "") or None
            entry.title = str(meta.get("name") or entry.file or title)
        return entry

    def _list_trash_sync(self) -> list[TrashEntry]:
        root = self._trash_root()
        if not root.is_dir():
            return []

        def key(p: Path) -> int:
            head = p.name.partition("-")[0]
            return int(head) if head.isdigit() else 0

        dirs = sorted((p for p in root.iterdir() if p.is_dir()), key=key, reverse=True)
        return [self._trash_entry(d) for d in dirs]

    async def list_trash(self) -> list[TrashEntry]:
        return await asyncio.to_thread(self._list_trash_sync)

    async def restore(self, trash_id: str, actor: str, target_rel: str | None = None) -> PageDoc:
        if "/" in trash_id or "\\" in trash_id or trash_id in ("", ".", ".."):
            raise VaultPathError("invalid trash id")
        if target_rel is not None:
            target_rel = validate_rel(target_rel)
        meta = await asyncio.to_thread(self._trash_meta, self._trash_root() / trash_id)
        if meta.get("kind") == "attachment":
            owner = await asyncio.to_thread(self._attachment_owner, meta, target_rel)
            async with self._locks[owner]:
                return await asyncio.to_thread(
                    self._restore_attachment_sync, trash_id, actor, target_rel
                )
        return await asyncio.to_thread(self._restore_sync, trash_id, actor, target_rel)

    def _attachment_owner(self, meta: dict[str, Any], target_rel: str | None) -> str:
        """The page a trashed attachment returns to; the stable id survives renames and moves."""
        if target_rel is not None:
            if not is_page_dir(page_dir(self.vault, target_rel)):
                raise VaultPathError("Choose an existing page for this file.")
            return target_rel
        try:
            return self.page_by_id(str(meta.get("page_id") or ""))
        except FileNotFoundError as exc:
            raise VaultPathError(
                "The page this file belonged to is gone. Restore that page first."
            ) from exc

    def _restore_attachment_sync(
        self, trash_id: str, actor: str, target_rel: str | None
    ) -> PageDoc:
        import uuid

        trash_dir = self._trash_root() / trash_id
        meta = self._trash_meta(trash_dir)
        file = str(meta.get("file") or "")
        source = trash_dir / file
        if (
            trash_dir.is_symlink()
            or not _ATTACHMENT_NAME.fullmatch(file)
            or source.is_symlink()
            or not source.is_file()
        ):
            raise FileNotFoundError(trash_id)
        owner = self._attachment_owner(meta, target_rel)
        doc = self._read_sync(owner)
        dest = self.attachment_path(doc.id, file)
        if dest.exists():
            # Never overwrite: the restored copy gets a fresh unique prefix.
            file = f"{uuid.uuid4().hex}-{_UUID_PREFIX.sub('', file) or file}"
            dest = self.attachment_path(doc.id, file)
        dest.parent.mkdir(exist_ok=True)
        shutil.move(str(source), str(dest))
        shutil.rmtree(trash_dir, ignore_errors=True)
        self._activity(actor, "attachment.restore", owner, {"file": file, "trash_id": trash_id})
        self._publish(
            "attachments_changed", {"page_id": doc.id, "path": owner, "reason": "restore"}
        )
        self._publish("trash_changed", {"reason": "restore"})
        return doc

    async def purge_trash(self, trash_id: str | None, actor: str) -> PurgeResult:
        """Permanently delete one trash entry, or every entry when `trash_id` is None."""
        if trash_id is not None and (
            "/" in trash_id or "\\" in trash_id or trash_id in ("", ".", "..")
        ):
            raise VaultPathError("invalid trash id")
        return await asyncio.to_thread(self._purge_sync, trash_id, actor)

    def _purge_sync(self, trash_id: str | None, actor: str) -> PurgeResult:
        root = self._trash_root()
        if root.is_symlink():
            raise VaultPathError("The trash folder cannot be a link.")
        if trash_id is None:
            targets = list(root.iterdir()) if root.is_dir() else []
        else:
            target = root / trash_id
            if not target.is_symlink() and not target.exists():
                raise FileNotFoundError(trash_id)
            targets = [target]
        freed = 0
        for target in targets:
            if target.is_symlink() or target.is_file():
                # A link is removed, never followed.
                freed += 0 if target.is_symlink() else target.stat().st_size
                target.unlink()
            else:
                freed += _tree_size(target)
                shutil.rmtree(target)
        if trash_id is None:
            self._activity(actor, "trash.empty", None, {"entries": len(targets), "bytes": freed})
        else:
            self._activity(actor, "trash.purge", None, {"trash_id": trash_id, "bytes": freed})
        if targets:
            self._publish("trash_changed", {"reason": "purge"})
        return PurgeResult(entries=len(targets), bytes=freed)

    def _restore_sync(self, trash_id: str, actor: str, target_rel: str | None) -> PageDoc:
        trash_dir = self._trash_root() / trash_id
        if not trash_dir.is_dir():
            raise FileNotFoundError(trash_id)
        dest_rel = target_rel
        if dest_rel is None:
            origin, _ = self._trash_origin(trash_dir)
            if not origin:
                raise VaultPathError("origin of this trash entry is unknown; pass target_path")
            dest_rel = validate_rel(origin)
        parent_rel = parent_of(dest_rel)
        parent_dir = page_dir(self.vault, parent_rel) if parent_rel else self.vault
        parent_dir.mkdir(parents=True, exist_ok=True)
        dest_dir = self._unique_dir(parent_dir, dest_rel.rsplit("/", 1)[-1])
        shutil.move(str(trash_dir), str(dest_dir))
        origin_file = dest_dir / ORIGIN_FILE
        if origin_file.exists():
            origin_file.unlink()
        final_rel = dest_dir.relative_to(self.vault).as_posix()
        self._rescan()
        self._activity(actor, "page.restore", final_rel, {"trash_id": trash_id})
        self._publish("tree_changed", {"reason": "restore", "path": final_rel})
        return self._read_sync(final_rel)

    async def resolve_link(self, from_rel: str, target: str) -> str | None:
        from_rel = validate_rel(from_rel)
        return await asyncio.to_thread(self._resolve_sync, from_rel, target)

    def _resolve_sync(self, from_rel: str, target: str) -> str | None:
        return indexer.resolve_target(self.db, from_rel, target)

    async def attach_recording(self, page_id: str, file: str, name: str) -> None:
        """Keep a stopped recording discoverable if its editor was closed during upload."""
        import yaml

        rel = self.page_by_id(page_id)
        async with self._locks[rel]:

            def write() -> None:
                current = self.page_by_id(page_id)
                if not self.attachment_path(page_id, file).is_file():
                    raise FileNotFoundError(file)
                doc = self._read_sync(current)
                if file in doc.body:
                    return
                fence = (
                    "```graite:media\n"
                    + yaml.safe_dump(
                        {"file": file, "name": name, "kind": "audio"},
                        allow_unicode=True,
                        sort_keys=False,
                    )
                    + "```\n"
                )
                self._write_body_sync(current, doc.body.rstrip() + "\n\n" + fence, doc.hash, "user")

            await asyncio.to_thread(write)

    async def move_media_block(
        self, source_id: str, target_rel: str, file: str, block: str, base_hash: str
    ) -> dict[str, str]:
        """Move one saved media block, preserving shared originals and pending edits."""
        import re
        import uuid
        from contextlib import AsyncExitStack

        import yaml

        source_rel = self.page_by_id(source_id)
        target_rel = validate_rel(target_rel)
        if source_rel == target_rel:
            raise ValueError("Choose another page.")
        match = re.fullmatch(r"```graite:media\n(.*?)\n```\s*", block.strip(), re.S)
        if not match:
            raise ValueError("Only a single media block can be moved this way.")
        props = yaml.safe_load(match.group(1))
        if not isinstance(props, dict) or props.get("file") != file or props.get("job"):
            raise ValueError("Finish or cancel transcription before moving this file.")
        if props.get("kind") not in ("audio", "image", "pdf"):
            raise ValueError("Upload this media before moving it.")
        async with AsyncExitStack() as stack:
            for rel in sorted((source_rel, target_rel)):
                await stack.enter_async_context(self._locks[rel])

            def move() -> dict[str, str]:
                source = self._read_sync(source_rel)
                target = self._read_sync(target_rel)
                if self.page_by_id(source_id) != source_rel:
                    raise ValueError("The source page moved. Try again.")
                self.page_by_id(target.id)  # Reject linked page folders.
                if source.hash != base_hash:
                    raise ConflictError(source.hash, source.body)
                fragment = block.strip()
                if source.body.count(fragment) != 1:
                    raise ValueError("The media block changed. Save the page and try again.")
                original = self.attachment_path(source_id, file)
                if not original.is_file():
                    raise FileNotFoundError(file)
                name = uuid.uuid4().hex + "-" + original.name[-140:]
                destination = self.attachment_path(target.id, name)
                destination.parent.mkdir(parents=True, exist_ok=True)
                # Retain the original: another transcript or block may reference it.
                temp = destination.with_name("." + name + ".part")
                try:
                    with original.open("rb") as reader, temp.open("xb") as writer:
                        shutil.copyfileobj(reader, writer)
                        writer.flush()
                        os.fsync(writer.fileno())
                    os.replace(temp, destination)
                finally:
                    temp.unlink(missing_ok=True)
                props["file"] = name
                moved = (
                    "```graite:media\n"
                    + yaml.safe_dump(props, allow_unicode=True, sort_keys=False)
                    + "```\n"
                )
                saved_target = self._write_body_sync(
                    target_rel, target.body.rstrip() + "\n\n" + moved, target.hash, "ui"
                )
                try:
                    saved_source = self._write_body_sync(
                        source_rel, source.body.replace(fragment, "", 1), source.hash, "ui"
                    )
                except Exception:
                    self._write_body_sync(target_rel, target.body, saved_target.hash, "ui")
                    raise
                return {"path": target_rel, "source_hash": saved_source.hash}

            return await asyncio.to_thread(move)

    async def set_properties(
        self, page_id: str, values: list[dict[str, Any]], base_hash: str, actor: str = "ui"
    ) -> PageDoc:
        from graite.vault.properties import PageProperty

        rel = self.page_by_id(page_id)
        if parent_of(rel) is None:
            raise ValueError("Properties are available on nested pages only.")
        fields = [PageProperty.model_validate(value).model_dump() for value in values]
        if (
            len(fields) > 100
            or len({f["id"] for f in fields}) != len(fields)
            or len({f["name"].casefold() for f in fields}) != len(fields)
        ):
            raise ValueError("Use unique property names and IDs, with no more than 100 properties.")
        async with self._locks[rel]:

            def write() -> PageDoc:
                current = self._read_sync(self.page_by_id(page_id))
                if current.hash != base_hash:
                    raise ConflictError(current.hash, current.body)
                for field in fields:
                    if field["type"] == "media" and field["value"]:
                        if not self.attachment_path(page_id, field["value"]).is_file():
                            raise ValueError("The attachment does not exist on this page.")
                meta = dict(current.frontmatter)
                meta["properties"] = fields
                meta["updated"] = fm.now_iso()
                result = self._write_page_sync(
                    rel,
                    meta,
                    current.body,
                    old_text=page_file(self.vault, rel).read_text(),
                    actor=actor,
                )
                self._rescan()
                self._activity(actor, "page.properties", rel, {"hash": result.hash})
                self._publish("file_changed", {"path": rel, "hash": result.hash, "actor": actor})
                return result

            return await asyncio.to_thread(write)

    async def set_ai_settings(
        self, rel: str, values: dict[str, Any], base_hash: str | None, actor: str
    ) -> PageDoc:
        """Write only the AI settings keys of a page's frontmatter (vault/policy.py)."""
        from graite.vault import policy

        rel = validate_rel(rel)
        clean = policy.validate(values)
        async with self._locks[rel]:

            def write() -> PageDoc:
                f = page_file(self.vault, rel)
                if not f.is_file():
                    raise FileNotFoundError(rel)
                old_text = f.read_text(encoding="utf-8")
                current = self._doc_from_text(rel, old_text)
                if base_hash is not None and base_hash != current.hash:
                    raise ConflictError(current.hash, current.body)
                meta = dict(current.frontmatter)
                for key, value in clean.items():
                    if value is None:
                        meta.pop(key, None)
                    else:
                        meta[key] = value
                if {k: meta.get(k) for k in policy.KEYS} == {
                    k: current.frontmatter.get(k) for k in policy.KEYS
                }:
                    return current
                meta.setdefault("id", fm.uuid7())
                meta["updated"] = fm.now_iso()
                doc = self._write_page_sync(rel, meta, current.body, old_text=old_text, actor=actor)
                self._rescan()
                self._activity(actor, "page.ai_settings", rel, {"keys": sorted(clean)})
                self._publish("file_changed", {"path": rel, "hash": doc.hash, "actor": actor})
                self._publish("policy_changed", {"path": rel})
                return doc

            return await asyncio.to_thread(write)

    async def child_pages(self, parent_id: str) -> list[PageDoc]:
        rel = self.page_by_id(parent_id)
        paths = [
            r[0]
            for r in self.db.execute(
                "SELECT path FROM pages WHERE parent_path=? "
                "ORDER BY (order_key IS NULL), order_key, lower(title)",
                (rel,),
            )
        ]
        return await asyncio.to_thread(lambda: [self._read_sync(path) for path in paths])

    async def relocate_page(self, page_id: str, target_id: str | None, position: str) -> PageDoc:
        """Reparent/reorder pages; preserve IDs, descendants, originals and resolved wikilinks."""
        from contextlib import AsyncExitStack

        if position not in ("before", "after", "inside"):
            raise ValueError("Choose before, after, or inside.")
        async with self._locks["__page_structure__"]:
            source = self.page_by_id(page_id)
            target = self.page_by_id(target_id) if target_id else None
            if target == source or (target and target.startswith(source + "/")):
                raise ValueError("A page cannot be moved into itself or its descendants.")
            parent = target if position == "inside" else parent_of(target) if target else None
            destination = (parent + "/" if parent else "") + source.rsplit("/", 1)[-1]
            if destination != source and page_dir(self.vault, destination).exists():
                raise ValueError(
                    "A page with this folder name already exists there. Rename it first."
                )
            paths: list[str] = [str(r[0]) for r in self.db.execute("SELECT path FROM pages")]
            mapping: dict[str, str] = {
                p: destination + p[len(source) :]
                for p in paths
                if p == source or p.startswith(source + "/")
            }
            async with AsyncExitStack() as stack:
                for path in sorted(set(paths + list(mapping.values()))):
                    await stack.enter_async_context(self._locks[path])

                def move() -> PageDoc:
                    for row in self.db.execute("SELECT id FROM pages"):
                        self.page_by_id(row[0])  # No linked page folders.
                    docs = {p: self._read_sync(p) for p in paths}
                    originals = {
                        p: page_file(self.vault, p).read_text(encoding="utf-8") for p in paths
                    }
                    siblings = [
                        r[0]
                        for r in self.db.execute(
                            "SELECT path FROM pages WHERE parent_path IS ? "
                            "ORDER BY (order_key IS NULL), order_key, lower(title)",
                            (parent,),
                        )
                        if r[0] != source
                    ]
                    insertion = (
                        (siblings.index(target) + (position == "after"))
                        if target in siblings and position != "inside"
                        else len(siblings)
                    )
                    siblings.insert(insertion, destination)
                    orders = {p: i for i, p in enumerate(siblings)}
                    rewrites: dict[str, str] = {}
                    if destination != source:
                        for path, doc in docs.items():
                            from graite.vault.layouts import map_markdown

                            def replace_link(match: re.Match[str], from_path: str = path) -> str:
                                target_text, tail = match.group(1), match.group(2)
                                resolved = (
                                    target_text
                                    if target_text in docs
                                    else self._resolve_sync(from_path, target_text)
                                )
                                if resolved in mapping:
                                    return "[[" + mapping[resolved] + tail + "]]"
                                return match.group(0)

                            rewrites[path] = map_markdown(
                                doc.body,
                                lambda text: re.sub(
                                    r"\[\[([^\]|#]+)((?:#[^\]|]*)?(?:\|[^\]]*)?)\]\]",
                                    replace_link,
                                    text,
                                ),
                            )
                    moved = False
                    written: list[str] = []
                    try:
                        if destination != source:
                            os.replace(
                                page_dir(self.vault, source), page_dir(self.vault, destination)
                            )
                            moved = True
                        for old, doc in docs.items():
                            new = mapping.get(old, old)
                            meta = dict(doc.frontmatter)
                            body = rewrites.get(old, doc.body)
                            if new in orders:
                                meta["order"] = orders[new]
                            if meta == doc.frontmatter and body == doc.body:
                                continue
                            meta["updated"] = fm.now_iso()
                            self._write_page_sync(
                                new, meta, body, old_text=originals[old], actor="ui"
                            )
                            written.append(old)
                    except Exception:
                        for old in written:
                            _atomic_write(
                                page_file(self.vault, mapping.get(old, old)), originals[old]
                            )
                        if moved:
                            os.replace(
                                page_dir(self.vault, destination), page_dir(self.vault, source)
                            )
                        self._rescan()
                        raise
                    self._rescan()
                    self._activity("ui", "page.move", destination, {"from": source})
                    self._publish(
                        "tree_changed", {"reason": "move", "from": source, "path": destination}
                    )
                    return self._read_sync(destination)

                return await asyncio.to_thread(move)
