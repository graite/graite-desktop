"""The single writer for the vault (CLAUDE.md rule 1, docs/design/editor-roundtrip.md §7).

Every mutation: per-path lock -> optional base-hash check -> version snapshot -> atomic
write -> index rescan -> activity row -> event. Nothing else in the daemon writes vault files.
"""

from __future__ import annotations

import asyncio
import contextlib
import hashlib
import json
import os
import re
import shutil
import sqlite3
import time
from collections import defaultdict
from collections.abc import AsyncIterator, Callable, Iterable
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from graite.dashboards import paths as dash_paths
from graite.dashboards.paths import DashboardPath
from graite.events import EventBus
from graite.tables import cache as table_cache
from graite.tables import csvio
from graite.tables import links as tbl_links
from graite.tables import paths as table_paths
from graite.tables import schema as tbl_schema
from graite.tables.cache import TablesCache
from graite.tables.edit import (
    ColumnOp,
    RowOp,
    TableConflict,
    apply_columns,
    apply_rows,
    effective_ids,
    ensure_ids,
    pk_index,
    reassign_duplicates,
)
from graite.tables.paths import TablePath
from graite.vault import frontmatter as fm
from graite.vault import indexer
from graite.vault.instructions import safe_file
from graite.vault.layouts import map_markdown
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


def _link_line(targets: list[str]) -> re.Pattern[str]:
    """A page-link block: `[[target]]` or `[[target|alias]]` alone on its line."""
    names = "|".join(re.escape(t) for t in targets)
    return re.compile(r"^[ \t]*\[\[(?:" + names + r")(?:\|[^\]\n]*)?\]\][ \t]*$", re.MULTILINE)


def has_page_link(body: str, targets: list[str]) -> bool:
    pattern = _link_line(targets)
    found = False

    def check(text: str) -> str:
        nonlocal found
        found = found or bool(pattern.search(text))
        return text

    map_markdown(body, check)
    return found


def drop_page_links(body: str, targets: list[str]) -> str:
    """`body` without the page-link blocks to `targets`; links inside prose stay."""
    pattern = _link_line(targets)

    def drop(text: str) -> str:
        kept = pattern.sub("", text)
        return text if kept == text else re.sub(r"\n{3,}", "\n\n", kept)

    new = map_markdown(body, drop)
    if new == body:
        return body
    new = new.lstrip("\n")
    return new.rstrip("\n") + "\n" if new.strip() else ""


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


# `graite:table` fences, their `source:` values and `![[name.csv]]` embeds (table renames).
_TABLE_FENCE = re.compile(r"^```graite:table[^\n]*\n.*?^```", re.MULTILINE | re.DOTALL)
_FENCE_VALUE = re.compile(r"^([ \t]*)((?:\"[^\"]*\"|'[^']*'|[^:\s][^:]*?))(:[ \t]*)(.*)$")
_TABLE_EMBEDS = re.compile(r"^[ \t]*!\[\[([^\]|#]+\.csv)\]\][ \t]*$", re.M | re.I)
_TABLE_EMBED_LINE = re.compile(r"^([ \t]*)!\[\[([^\]|#]+\.csv)\]\]([ \t]*)$", re.M | re.I)


def _set_cell(record: csvio.Record, index: int, text: str) -> None:
    if index >= len(record.values):
        record.values.extend([""] * (index + 1 - len(record.values)))
    if record.values[index] != text:
        record.values[index] = text
        record.raw = None


def _atomic_write(path: Path, text: str, *, newline: str | None = None) -> None:
    tmp = path.with_name(f".{path.name}.tmp-{os.getpid()}")
    tmp.write_text(text, encoding="utf-8", newline=newline)
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
        # Set by the app: the derived table cache (`.graite/tables.sqlite`).
        self.tables: TablesCache | None = None

    def bump(self) -> None:
        self.epoch += 1

    # ----------------------------------------------------------------- helpers (sync)

    def _doc_from_text(self, rel: str, text: str) -> PageDoc:
        meta, body = fm.split(text)
        return PageDoc(
            path=rel,
            id=str(meta.get("id") or fm.path_id(rel)),
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
        """Index after a write. A write rescans only what it touched where it can, so pages
        changed outside Graite in the meantime are left for the watcher, which announces them."""
        result = indexer.scan(self.vault, self.db, paths=paths)
        if self.on_indexed is not None:
            self.on_indexed(result)
        if result.structure_changed:
            self.sync_tables()
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
        meta.setdefault("id", fm.path_id(rel))
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

    # ----------------------------------------------------------------- tables (D68)

    def _table(self, rel: str) -> TablePath:
        return table_paths.checked(self.vault, table_paths.parse(rel))

    def _table_changed(self, rel: str, actor: str, **extra: Any) -> None:
        info = None
        if self.tables is not None:
            self.tables.refresh(rel)
            with contextlib.suppress(FileNotFoundError, VaultPathError):
                info = self.tables.info(rel)
        self._publish(
            "table_changed",
            {"path": rel, "hash": info.file_hash if info else None, "actor": actor, **extra},
        )

    def _read_table_sync(self, table: TablePath) -> tuple[csvio.Table, str, bytes]:
        target = table.file(self.vault)
        if not target.is_file():
            raise FileNotFoundError(table.rel)
        data = target.read_bytes()
        return csvio.parse(csvio.decode(data)), table_cache.sha256(data), data

    def _schema_sync(self, table: TablePath) -> tuple[tbl_schema.Schema, str]:
        target = table.schema_file(self.vault)
        text = target.read_text(encoding="utf-8") if target.is_file() else ""
        return tbl_schema.load(text)[0], text

    def _columns_sync(self, table: TablePath, parsed: csvio.Table) -> list[tbl_schema.Column]:
        schema, _ = self._schema_sync(table)
        names = tbl_schema.column_names(parsed.header)
        return tbl_schema.columns_for(names, [r.values for r in parsed.rows], schema)

    def _kinds_sync(self, table: TablePath, parsed: csvio.Table) -> dict[str, str]:
        return {c.name: c.type for c in self._columns_sync(table, parsed)}

    def _write_table_sync(
        self,
        table: TablePath,
        parsed: csvio.Table,
        old: bytes | None,
        actor: str,
        action: str,
        detail: dict[str, Any],
    ) -> str:
        """Snapshot the old file, write the new one atomically, refresh the cache, announce."""
        text = csvio.serialize(parsed)
        if old is not None:
            if text.encode("utf-8") == old:
                return table_cache.sha256(old)
            snap = (
                self.vault
                / GRAITE_DIR
                / "versions"
                / "tables"
                / hashlib.sha256(table.rel.encode("utf-8")).hexdigest()[:16]
                / f"{int(time.time() * 1000)}.csv"
            )
            snap.parent.mkdir(parents=True, exist_ok=True)
            snap.write_bytes(old)
        target = table.file(self.vault)
        target.parent.mkdir(exist_ok=True)
        # newline="": the table keeps its own line endings on every platform.
        _atomic_write(target, text, newline="")
        new_hash = _sha256(text)
        self._activity(actor, action, table.rel, {"hash": new_hash, **detail})
        self._table_changed(table.rel, actor)
        return new_hash

    @contextlib.asynccontextmanager
    async def _table_locks(self, rels: Iterable[str]) -> AsyncIterator[None]:
        """Hold the locks of several tables, always taken in path order (no deadlocks)."""
        async with contextlib.AsyncExitStack() as stack:
            for rel in sorted(set(rels)):
                await stack.enter_async_context(self._locks[rel])
            yield

    def _related_sync(self, rel: str) -> list[str]:
        """Tables a write to `rel` may also write: those that link to it (their labels,
        links to deleted rows, reverse edits) and those it links to (their reverse columns)."""
        if self.tables is None:
            return []
        out = [src for src, _ in self.tables.inbound(rel)]
        with contextlib.suppress(FileNotFoundError, VaultPathError):
            out += [c.target for c in self.tables.info(rel).columns if c.target]
        return out

    async def _related(self, rel: str) -> list[str]:
        return await asyncio.to_thread(self._related_sync, rel)

    def _relation_values_sync(
        self,
        table: TablePath,
        parsed: csvio.Table,
        columns: list[tbl_schema.Column],
        ops: list[RowOp],
    ) -> tuple[list[RowOp], list[tuple[int, tbl_schema.Column, str, list[str]]]]:
        """Relation values as links with the target rows' labels, and reverse-column values
        split off: `(op index, column, source table, source row ids)`. Unknown row ids are an
        error, except links a cell already holds (a broken link stays until removed)."""
        by_name = {c.name: c for c in columns}
        if not any(
            by_name.get(n) is not None and by_name[n].type == "relation"
            for op in ops
            for n in op.values
        ):
            return ops, []
        if self.tables is None:
            raise ValueError("Relations are not available here.")
        schema, _ = self._schema_sync(table)
        ids, _ = effective_ids(parsed, schema.primary_key)
        records = dict(zip(ids, parsed.rows, strict=True))
        names = tbl_schema.column_names(parsed.header)
        out: list[RowOp] = []
        reverse: list[tuple[int, tbl_schema.Column, str, list[str]]] = []
        for index, op in enumerate(ops):
            values: dict[str, Any] = {}
            for name, value in op.values.items():
                column = by_name.get(name)
                if column is None or column.type != "relation":
                    values[name] = value
                    continue
                wanted = tbl_links.ids_of(value)
                if column.cardinality == "one" and not column.reverse and len(wanted) > 1:
                    raise ValueError(f"{name!r} links to one row only.")
                target = self.tables.resolve_target(table.page, column.table, column.table_id)
                if target is None:
                    raise ValueError(f"The table that {name!r} links to cannot be found.")
                labels = self.tables.labels(target, wanted)
                held: dict[str, str] = {}
                record = records.get(op.id or "")
                if record is not None and not column.reverse and name in names:
                    i = names.index(name)
                    cell = record.values[i] if i < len(record.values) else ""
                    held = {link.id: link.label for link in tbl_links.parse_links(cell)}
                unknown = [w for w in wanted if w not in labels and w not in held]
                if unknown:
                    raise ValueError(f"{target} has no row with id {unknown[0]!r}.")
                if column.reverse:
                    if op.op != "delete":
                        reverse.append((index, column, target, wanted))
                    continue
                values[name] = [
                    {"id": w, "label": labels[w][0] if w in labels else held[w]} for w in wanted
                ]
            base = op.base
            if base is not None:
                base = {k: v for k, v in base.items() if not (k in by_name and by_name[k].reverse)}
            out.append(
                RowOp(op=op.op, id=op.id, values=values, base=base, after=op.after, first=op.first)
            )
        return out, reverse

    def _relink_sync(
        self,
        source: str,
        column: str,
        target_row: str,
        label: str,
        wanted: list[str],
        actor: str,
    ) -> None:
        """Make exactly the rows `wanted` of `source` link to `target_row` in `column` (a
        reverse-column edit stores the change on the forward side)."""
        assert self.tables is not None
        current = {src for src, _ in self.tables.links_to(source, column, [target_row])}
        add, remove = set(wanted) - current, current - set(wanted)
        if not add and not remove:
            return
        table = self._table(source)
        parsed, _, old = self._read_table_sync(table)
        info = self.tables.info(source)
        one = next((c.cardinality == "one" for c in info.columns if c.name == column), False)
        schema, _ = self._schema_sync(table)
        ids, _ = effective_ids(parsed, schema.primary_key)
        i = tbl_schema.column_names(parsed.header).index(column)
        for rid, record in zip(ids, parsed.rows, strict=True):
            if rid not in add and rid not in remove:
                continue
            cell = record.values[i] if i < len(record.values) else ""
            links = [link for link in tbl_links.parse_links(cell) if link.id != target_row]
            if rid in add:
                links = [*([] if one else links), tbl_links.Link(target_row, label)]
            _set_cell(record, i, tbl_links.format_links(links))
        self._write_table_sync(
            table, parsed, old, actor, "table.links", {"column": column, "row": target_row}
        )

    def _fix_inbound_sync(
        self, rel: str, ids: list[str] | None, deleted: list[str], actor: str
    ) -> None:
        """In every table that links to `rel`: write the current label of the rows `ids`
        (every row when None), and drop links to the rows `deleted`."""
        if self.tables is None or (ids is not None and not ids and not deleted):
            return
        gone = set(deleted)
        for source, column in self.tables.inbound(rel):
            pairs = self.tables.links_to(source, column, None if ids is None else [*ids, *deleted])
            if not pairs:
                continue
            labels = self.tables.labels(rel, [d for _, d in pairs])
            touched = {s for s, _ in pairs}
            table = self._table(source)
            parsed, _, old = self._read_table_sync(table)
            schema, _ = self._schema_sync(table)
            row_ids, _ = effective_ids(parsed, schema.primary_key)
            i = tbl_schema.column_names(parsed.header).index(column)
            for rid, record in zip(row_ids, parsed.rows, strict=True):
                if rid not in touched:
                    continue
                cell = record.values[i] if i < len(record.values) else ""
                links = [
                    tbl_links.Link(link.id, labels[link.id][0] if link.id in labels else link.label)
                    for link in tbl_links.parse_links(cell)
                    if link.id not in gone
                ]
                _set_cell(record, i, tbl_links.format_links(links))
            self._write_table_sync(
                table, parsed, old, actor, "table.labels", {"column": column, "target": rel}
            )

    async def write_table_rows(
        self, rel: str, ops: list[RowOp], base_hash: str | None, actor: str
    ) -> dict[str, Any]:
        """Insert, update and delete rows by id. A stale `base_hash` is fine as long as the
        rows an op touches still hold the values the client saw (`RowOp.base`).

        Relations (D71): link values get their target rows' labels; a reverse column's
        change is written to the forward column of the other table; a changed display value
        is rewritten in the labels of tables that link here; deleted rows lose their links."""
        table = self._table(rel)
        related = await self._related(table.rel)
        async with self._table_locks([table.rel, *related]):

            def write() -> dict[str, Any]:
                parsed, current, old = self._read_table_sync(table)
                columns = self._columns_sync(table, parsed)
                kinds: dict[str, str] = {c.name: c.type for c in columns if not c.reverse}
                schema, _ = self._schema_sync(table)
                checked_ops, reverse = self._relation_values_sync(table, parsed, columns, ops)
                if base_hash == current:
                    checked_ops = [
                        RowOp(op=o.op, id=o.id, values=o.values, base=None, after=o.after)
                        for o in checked_ops
                    ]
                ids = apply_rows(
                    parsed, checked_ops, kinds, file_hash=current, primary_key=schema.primary_key
                )
                new_hash = self._write_table_sync(
                    table, parsed, old, actor, "table.rows", {"ops": len(ops)}
                )
                if self.tables is None:
                    return {"path": table.rel, "hash": new_hash, "ids": ids}
                label = tbl_schema.display_column(columns, schema)
                for index, column, source, wanted in reverse:
                    names = self.tables.labels(table.rel, [ids[index]])
                    self._relink_sync(
                        source,
                        column.reverse or "",
                        ids[index],
                        names.get(ids[index], ("", None))[0],
                        wanted,
                        actor,
                    )
                relabel = [
                    ids[i]
                    for i, o in enumerate(ops)
                    if o.op == "update" and label is not None and label in o.values
                ]
                deleted = [ids[i] for i, o in enumerate(ops) if o.op == "delete"]
                self._fix_inbound_sync(table.rel, relabel, deleted, actor)
                if self.tables is not None and (reverse or relabel or deleted):
                    new_hash = self.tables.info(table.rel).file_hash
                return {"path": table.rel, "hash": new_hash, "ids": ids}

            return await asyncio.to_thread(write)

    async def prepare_table_rows(
        self, rel: str, ops: list[RowOp]
    ) -> tuple[list[dict[str, Any]], str, dict[str, dict[str, Any]]]:
        """Check ops against the table as it is now, without writing (a proposal's dry run).

        Returns the ops as JSON with `base` filled in (the touched cells of an update, every
        cell of a deleted row) and a `label` naming each row for the reviewer, the file hash
        they were checked against, and the touched columns' types, options and colors.
        Raises ValueError for unknown columns, id edits and missing rows."""
        table = self._table(rel)

        def check() -> tuple[list[dict[str, Any]], str, dict[str, dict[str, Any]]]:
            parsed, current, _ = self._read_table_sync(table)
            columns = self._columns_sync(table, parsed)
            kinds: dict[str, str] = {c.name: c.type for c in columns if not c.reverse}
            schema, _ = self._schema_sync(table)
            names = tbl_schema.column_names(parsed.header)
            rows = self._rows_by_id_sync(parsed, names, kinds, schema.primary_key)
            # The column that names a row for a reviewer: the display column, else the next
            # text column (never the id).
            pk = schema.primary_key.lower()
            candidates = [
                c.name
                for c in columns
                if c.name.lower() != pk
                and not c.reverse
                and c.type in ("text", "single_select", "status")
            ]
            label_column = tbl_schema.display_column(columns, schema)
            if label_column:
                candidates.insert(0, label_column)
            # Relation values: checked against the target (unknown ids are an error).
            relations, _ = self._relation_values_sync(table, parsed, columns, ops)
            reverse_names = {c.name for c in columns if c.reverse}

            def label(values: dict[str, Any], fallback: str) -> str:
                for name in candidates:
                    value = values.get(name)
                    if value not in (None, "", []):
                        return str(value)[:80]
                return fallback

            out: list[dict[str, Any]] = []
            for number, op in enumerate(ops, start=1):
                entry: dict[str, Any] = {"op": op.op, "values": dict(op.values)}
                if op.id:
                    entry["id"] = op.id
                if op.after:
                    entry["after"] = op.after
                if op.op in ("update", "delete"):
                    found = rows.get(op.id or "")
                    if found is None:
                        raise ValueError(f"The table has no row with id {op.id!r}.")
                    cells = found["values"]
                    entry["base"] = (
                        {k: cells.get(k) for k in op.values} if op.op == "update" else dict(cells)
                    )
                    entry["label"] = label(cells, f"Row {op.id}")
                else:
                    entry["label"] = label(op.values, f"New row {number}")
                out.append(entry)
            trial = csvio.parse(csvio.serialize(parsed))
            try:
                apply_rows(
                    trial,
                    [
                        RowOp(
                            op=o["op"],
                            id=o.get("id"),
                            after=o.get("after"),
                            values={
                                k: v
                                for k, v in relations[n].values.items()
                                if k not in reverse_names
                            },
                        )
                        for n, o in enumerate(out)
                    ],
                    kinds,
                    file_hash=current,
                    primary_key=schema.primary_key,
                )
            except TableConflict as exc:
                missing = ", ".join(c.id for c in exc.conflicts)
                raise ValueError(f"These rows do not exist: {missing}.") from exc
            touched = {name for o in out for name in [*o["values"], *(o.get("base") or {})]}
            meta = {
                c.name: {
                    k: v
                    for k, v in c.to_json().items()
                    if k in ("type", "options", "colors", "currency")
                }
                for c in columns
                if c.name in touched
            }
            return out, current, meta

        return await asyncio.to_thread(check)

    def _rows_by_id_sync(
        self, parsed: csvio.Table, names: list[str], kinds: dict[str, str], primary_key: str
    ) -> dict[str, dict[str, Any]]:
        """Each row's values (as the API shows them) and the id of the row before it."""
        from graite.tables.edit import effective_ids, pk_index

        ids, _ = effective_ids(parsed, primary_key)
        pk = pk_index(parsed.header, primary_key)
        out: dict[str, dict[str, Any]] = {}
        previous: str | None = None
        for rid, record in zip(ids, parsed.rows, strict=True):
            values = {
                name: tbl_schema.to_json(
                    kinds.get(name, "text"),
                    tbl_schema.to_sql(
                        kinds.get(name, "text"),
                        record.values[i] if i < len(record.values) else "",
                    ),
                )
                for i, name in enumerate(names)
                if i != pk
            }
            out[rid] = {"values": values, "after": previous}
            previous = rid
        return out

    async def read_table_rows(self, rel: str, ids: list[str]) -> dict[str, dict[str, Any]]:
        """`{id: {"values": {...}, "after": previous id}}` for the rows that exist."""
        table = self._table(rel)

        def read() -> dict[str, dict[str, Any]]:
            parsed, _, _ = self._read_table_sync(table)
            kinds = self._kinds_sync(table, parsed)
            schema, _ = self._schema_sync(table)
            names = tbl_schema.column_names(parsed.header)
            rows = self._rows_by_id_sync(parsed, names, kinds, schema.primary_key)
            return {i: rows[i] for i in ids if i in rows}

        return await asyncio.to_thread(read)

    async def create_table(
        self, page_rel: str, name: str, columns: list[str], actor: str, *, data: bytes | None = None
    ) -> str:
        """Create `<page>/_data/<name>.csv` (from `columns`, or an imported file) with an id
        column; a taken name gets a number. Returns the table path."""
        page_rel = validate_rel(page_rel)
        base = table_paths.check_name(name)
        async with self._locks[page_rel]:

            def write() -> str:
                n, table_name = 2, base
                while True:
                    table = table_paths.checked(self.vault, TablePath(page_rel, table_name))
                    if not table.file(self.vault).exists():
                        break
                    table_name, n = f"{base} {n}", n + 1
                if data is None:
                    names = [c.strip() for c in columns if c.strip()] or ["name"]
                    # One empty row, so the new table can be typed into straight away.
                    parsed = csvio.Table(
                        header=["id", *names],
                        records=[csvio.Record(values=[fm.uuid7(), *[""] * len(names)])],
                    )
                    if len({c.lower() for c in parsed.header}) != len(parsed.header):
                        raise ValueError("Column names must be unique.")
                else:
                    parsed = csvio.parse(csvio.decode(data))
                    if not parsed.header:
                        raise ValueError("This file has no header row.")
                    parsed.dialect.bom = False
                    ensure_ids(parsed)
                self._write_table_sync(
                    table, parsed, None, actor, "table.create", {"imported": data is not None}
                )
                self._publish("tables_changed", {"page_path": page_rel, "path": table.rel})
                return table.rel

            return await asyncio.to_thread(write)

    async def ensure_table_ids(self, rel: str, actor: str) -> str:
        """Give every row a real id, adding the id column if the file has none."""
        table = self._table(rel)
        async with self._locks[table.rel]:

            def write() -> str:
                parsed, _, old = self._read_table_sync(table)
                schema, _ = self._schema_sync(table)
                ensure_ids(parsed, schema.primary_key)
                return self._write_table_sync(table, parsed, old, actor, "table.ids", {})

            return await asyncio.to_thread(write)

    async def alter_table_columns(
        self, rel: str, ops: list[ColumnOp], base_hash: str | None, actor: str
    ) -> str:
        """Add, rename, delete or move columns; the schema file follows renames and deletes.
        A reverse relation column lives in the schema only, so its ops change nothing else;
        renaming or deleting a forward relation updates the reverse column of its target."""
        table = self._table(rel)
        related = await self._related(table.rel)
        async with self._table_locks([table.rel, *related]):

            def write() -> str:
                parsed, current, old = self._read_table_sync(table)
                if base_hash is not None and base_hash != current:
                    raise TableConflict(current, [])
                schema, schema_text = self._schema_sync(table)
                columns = {c.name: c for c in self._columns_sync(table, parsed)}
                virtual = {n for n, c in columns.items() if c.reverse}
                csv_ops = [op for op in ops if op.name not in virtual or op.op == "add"]
                ensure_ids(parsed, schema.primary_key)
                apply_columns(parsed, csv_ops, schema.primary_key)
                if schema_text.strip():
                    raw = json.loads(schema_text)
                    specs = raw.get("columns") if isinstance(raw, dict) else None
                    order = raw.get("order") if isinstance(raw, dict) else None
                    if isinstance(specs, dict) or isinstance(order, list):
                        for op in ops:
                            if op.op == "rename" and op.to and op.name in virtual:
                                to = op.to.strip()
                                if to.lower() in (n.lower() for n in columns if n != op.name):
                                    raise ValueError(f"Choose a new column name (not {to!r}).")
                            if isinstance(specs, dict) and op.name in specs:
                                if op.op == "rename" and op.to:
                                    specs[op.to.strip()] = specs.pop(op.name)
                                elif op.op == "delete":
                                    specs.pop(op.name)
                            if isinstance(order, list) and op.name in order:
                                if op.op == "rename" and op.to:
                                    order[order.index(op.name)] = op.to.strip()
                                elif op.op == "delete":
                                    order.remove(op.name)
                        self._write_schema_sync(table, raw, actor)
                # The other side of a forward relation follows its rename or delete.
                for op in ops:
                    column = columns.get(op.name)
                    if (
                        op.op not in ("rename", "delete")
                        or column is None
                        or column.type != "relation"
                        or column.reverse
                        or self.tables is None
                    ):
                        continue
                    found = self.tables.resolve_target(table.page, column.table, column.table_id)
                    if found is None:
                        continue
                    target = self._table(found)
                    raw_target = self._raw_schema_sync(target)
                    changed = False
                    for name, spec in list((raw_target.get("columns") or {}).items()):
                        if (
                            isinstance(spec, dict)
                            and spec.get("reverse") == op.name
                            and (
                                table_cache.hint_path(target.page, spec.get("table")) == table.rel
                                or (schema.id is not None and spec.get("table_id") == schema.id)
                            )
                        ):
                            if op.op == "delete":
                                raw_target["columns"].pop(name)
                            else:
                                spec["reverse"] = (op.to or "").strip()
                            changed = True
                    if changed:
                        self._write_schema_sync(target, raw_target, actor)
                        if target != table:
                            self._table_changed(target.rel, actor)
                new_hash = self._write_table_sync(
                    table, parsed, old, actor, "table.columns", {"ops": len(ops)}
                )
                self._table_changed(table.rel, actor)
                return new_hash

            return await asyncio.to_thread(write)

    def _write_schema_sync(self, table: TablePath, schema: dict[str, Any], actor: str) -> None:
        target = table.schema_file(self.vault)
        text = json.dumps(schema, ensure_ascii=False, indent=2) + "\n"
        if target.is_file() and target.read_text(encoding="utf-8") == text:
            return
        target.parent.mkdir(exist_ok=True)
        _atomic_write(target, text)
        self._activity(actor, "table.schema", table.rel, {})

    async def update_table_schema(self, rel: str, patch: dict[str, Any], actor: str) -> None:
        """Merge `patch` into `<name>.schema.json`: `columns.<name>` entries merge key by key,
        other keys replace; a null value removes the key. Hand-written entries survive."""
        table = self._table(rel)
        async with self._locks[table.rel]:

            def write() -> None:
                if not table.file(self.vault).is_file():
                    raise FileNotFoundError(table.rel)
                _, text = self._schema_sync(table)
                raw: dict[str, Any] = {}
                if text.strip():
                    try:
                        loaded = json.loads(text)
                    except json.JSONDecodeError as exc:
                        raise ValueError("Fix the schema file's JSON before changing it.") from exc
                    raw = loaded if isinstance(loaded, dict) else {}
                for key, value in patch.items():
                    if key == "columns" and isinstance(value, dict):
                        columns = raw.get("columns")
                        columns = dict(columns) if isinstance(columns, dict) else {}
                        for name, spec in value.items():
                            if spec is None:
                                columns.pop(name, None)
                                continue
                            merged = dict(columns.get(name) or {})
                            for k, v in (spec or {}).items():
                                if v is None:
                                    merged.pop(k, None)
                                else:
                                    merged[k] = v
                            if merged:
                                columns[name] = merged
                            else:
                                columns.pop(name, None)
                        raw["columns"] = columns
                    elif value is None:
                        raw.pop(key, None)
                    else:
                        raw[key] = value
                problems = tbl_schema.load(json.dumps(raw))[1]
                if problems:
                    raise ValueError(problems[0])
                self._write_schema_sync(table, raw, actor)
                self._table_changed(table.rel, actor)

            await asyncio.to_thread(write)

    async def replace_table_values(
        self, rel: str, column: str, old: str, new: str | None, actor: str
    ) -> str:
        """Rename (`new`) or remove (`None`) one select option in every row and in the
        schema file. In a multi-select cell only that element changes."""
        table = self._table(rel)
        old = old.strip()
        new = new.strip() if new is not None else None
        if not old or new == "":
            raise ValueError("Option names cannot be empty.")
        async with self._locks[table.rel]:

            def write() -> str:
                parsed, _, data = self._read_table_sync(table)
                schema, schema_text = self._schema_sync(table)
                names = tbl_schema.column_names(parsed.header)
                if column not in names:
                    raise ValueError(f"The table has no column {column!r}.")
                multi = self._kinds_sync(table, parsed).get(column) == "multi_select"
                ensure_ids(parsed, schema.primary_key)
                index = tbl_schema.column_names(parsed.header).index(column)
                for record in parsed.rows:
                    cell = record.values[index] if index < len(record.values) else ""
                    if multi:
                        parts = [p.strip() for p in cell.split(tbl_schema.MULTI_SEPARATOR)]
                        if old not in parts:
                            continue
                        kept: list[str] = []
                        for part in parts:
                            value = (new if part == old else part) or ""
                            if value and value not in kept:
                                kept.append(value)
                        text = f"{tbl_schema.MULTI_SEPARATOR} ".join(kept)
                    elif cell.strip() == old:
                        text = new or ""
                    else:
                        continue
                    record.values[index] = text
                    record.raw = None
                if schema_text.strip():
                    raw = json.loads(schema_text)
                    spec = (raw.get("columns") or {}).get(column) if isinstance(raw, dict) else None
                    if isinstance(spec, dict):
                        options = spec.get("options")
                        if isinstance(options, list) and old in options:
                            at = options.index(old)
                            if new is None or new in options:
                                options.pop(at)
                            else:
                                options[at] = new
                        colors = spec.get("colors")
                        if isinstance(colors, dict) and old in colors:
                            color = colors.pop(old)
                            if new is not None:
                                colors.setdefault(new, color)
                        self._write_schema_sync(table, raw, actor)
                detail = {"column": column, "old": old, "new": new}
                return self._write_table_sync(table, parsed, data, actor, "table.options", detail)

            return await asyncio.to_thread(write)

    async def check_table_type(
        self, rel: str, column: str, kind: str, target: str | None = None
    ) -> dict[str, Any]:
        """Counts of the column's cells that would not read as `kind` (a read, no write).
        For a relation to `target`, a cell fits when every id in it is a row there."""
        table = self._table(rel)
        normalized = tbl_schema.normalize_type(kind)
        if normalized is None:
            raise ValueError(f"Unknown field type {kind!r}.")

        def read() -> dict[str, Any]:
            parsed, _, _ = self._read_table_sync(table)
            names = tbl_schema.column_names(parsed.header)
            if column not in names:
                raise ValueError(f"The table has no column {column!r}.")
            i = names.index(column)
            cells = [r.values[i] if i < len(r.values) else "" for r in parsed.rows]
            if normalized == "relation" and target and self.tables is not None:
                known = self.tables.labels(
                    self._table(target).rel,
                    [link.id for c in cells for link in tbl_links.parse_links(c)],
                )
                filled = [c for c in cells if c.strip()]
                bad = [
                    c
                    for c in filled
                    if not tbl_links.is_links(c)
                    or any(link.id not in known for link in tbl_links.parse_links(c))
                ]
                return {
                    "total": len(filled),
                    "invalid": len(bad),
                    "examples": list(dict.fromkeys(bad))[:3],
                }
            return tbl_schema.check(normalized, cells)

        return await asyncio.to_thread(read)

    # ----------------------------------------------------------------- relations (D71)

    def _raw_schema_sync(self, table: TablePath) -> dict[str, Any]:
        """The schema file as JSON (empty when there is none); a broken file is an error."""
        _, text = self._schema_sync(table)
        if not text.strip():
            return {}
        try:
            loaded = json.loads(text)
        except json.JSONDecodeError as exc:
            raise ValueError(f"Fix the JSON of {table.schema_rel} first.") from exc
        return loaded if isinstance(loaded, dict) else {}

    @staticmethod
    def _hint(owner: TablePath, target: TablePath) -> str:
        """How `owner`'s schema names `target`: its name in the same `_data/`, else the path."""
        return target.name if target.page == owner.page else target.rel

    async def add_relation(
        self,
        rel: str,
        column: str,
        target_rel: str,
        cardinality: str,
        reverse: str | None,
        actor: str,
    ) -> str:
        """Make `column` of `rel` a relation to `target_rel` (adding the column if needed),
        with an optional reverse column on the target. Both tables get a schema id. Cells that
        already hold ids of target rows are rewritten as labeled links."""
        table, target = self._table(rel), self._table(target_rel)
        column = column.strip()
        reverse = reverse.strip() if reverse else None
        if not column:
            raise ValueError("Name the relation field.")
        if cardinality not in ("one", "many"):
            raise ValueError("cardinality must be one or many.")
        async with self._table_locks([table.rel, target.rel]):

            def write() -> str:
                if not target.file(self.vault).is_file():
                    raise FileNotFoundError(target.rel)
                parsed, _, old = self._read_table_sync(table)
                schema, _ = self._schema_sync(table)
                own = self._raw_schema_sync(table)
                other = own if target == table else self._raw_schema_sync(target)
                own.setdefault("id", fm.uuid7())
                other.setdefault("id", fm.uuid7())
                ensure_ids(parsed, schema.primary_key)
                names = tbl_schema.column_names(parsed.header)
                if column not in names:
                    apply_columns(parsed, [ColumnOp(op="add", name=column)], schema.primary_key)
                elif names.index(column) == pk_index(parsed.header, schema.primary_key):
                    raise ValueError("The id column cannot be a relation.")
                columns = own.setdefault("columns", {})
                spec = {
                    k: v for k, v in (columns.get(column) or {}).items() if k in ("width", "wrap")
                }
                spec.update(
                    type="relation",
                    table=self._hint(table, target),
                    table_id=other["id"],
                    cardinality=cardinality,
                )
                columns[column] = spec
                if reverse:
                    target_parsed = parsed if target == table else self._read_table_sync(target)[0]
                    taken = {n.lower() for n in tbl_schema.column_names(target_parsed.header)}
                    if target == table:
                        taken.add(column.lower())
                    others = other.setdefault("columns", {})
                    existing = others.get(reverse)
                    if reverse.lower() in taken or (
                        isinstance(existing, dict) and existing.get("reverse") not in (None, column)
                    ):
                        raise ValueError(f"{target.name} already has a field named {reverse!r}.")
                    others[reverse] = {
                        "type": "relation",
                        "table": self._hint(target, table),
                        "table_id": own["id"],
                        "reverse": column,
                    }
                for owner, raw in ((table, own), (target, other)):
                    if tbl_schema.load(json.dumps(raw))[1]:
                        raise ValueError(tbl_schema.load(json.dumps(raw))[1][0])
                    self._write_schema_sync(owner, raw, actor)
                    if owner == target and target == table:
                        break
                if self.tables is not None:
                    self.tables.refresh(target.rel)
                    self.tables.refresh(table.rel)
                    # Ids already in the column become labeled links.
                    i = tbl_schema.column_names(parsed.header).index(column)
                    cells = {
                        n: tbl_links.parse_links(r.values[i] if i < len(r.values) else "")
                        for n, r in enumerate(parsed.rows)
                    }
                    labels = self.tables.labels(
                        target.rel, [link.id for found in cells.values() for link in found]
                    )
                    for n, record in enumerate(parsed.rows):
                        found = cells[n]
                        if found and all(link.id in labels for link in found):
                            if cardinality == "one":
                                found = found[:1]
                            _set_cell(
                                record,
                                i,
                                tbl_links.format_links(
                                    [tbl_links.Link(x.id, labels[x.id][0]) for x in found]
                                ),
                            )
                new_hash = self._write_table_sync(
                    table,
                    parsed,
                    old,
                    actor,
                    "table.relation",
                    {"column": column, "target": target.rel},
                )
                self._table_changed(table.rel, actor)
                if target != table:
                    self._table_changed(target.rel, actor)
                return new_hash

            return await asyncio.to_thread(write)

    async def refresh_link_labels(self, rel: str, actor: str) -> None:
        """Write the current display value into every link to `rel` in other tables (labels
        edited outside Graite go stale; this is the explicit fix)."""
        table = self._table(rel)
        related = await self._related(table.rel)
        async with self._table_locks([table.rel, *related]):
            await asyncio.to_thread(self._fix_inbound_sync, table.rel, None, [], actor)

    async def reassign_duplicate_ids(self, rel: str, actor: str) -> dict[str, Any]:
        """Give rows that repeat an earlier id a new one; the first row keeps the id and with
        it every link to it. Only on the user's request (D71)."""
        table = self._table(rel)
        async with self._locks[table.rel]:

            def write() -> dict[str, Any]:
                parsed, _, old = self._read_table_sync(table)
                schema, _ = self._schema_sync(table)
                changed = reassign_duplicates(parsed, schema.primary_key)
                new_hash = self._write_table_sync(
                    table, parsed, old, actor, "table.ids", {"duplicates": len(changed)}
                )
                return {"hash": new_hash, "reassigned": changed}

            return await asyncio.to_thread(write)

    async def rename_table(self, rel: str, new_name: str, actor: str) -> str:
        """Rename `<name>.csv` (and its schema file) in place. Relations that name it, and
        `graite:table` fences and `![[name.csv]]` embeds that show it, follow."""
        table = self._table(rel)
        renamed = table_paths.checked(
            self.vault, TablePath(table.page, table_paths.check_name(new_name))
        )
        if renamed == table:
            return table.rel
        if renamed.file(self.vault).exists() or (
            renamed.name.lower() != table.name.lower() and renamed.schema_file(self.vault).exists()
        ):
            raise ValueError(f"{table.page} already has a table named {renamed.name!r}.")
        related = await self._related(table.rel)
        async with self._table_locks([table.rel, renamed.rel, *related]):

            def write() -> str:
                if not table.file(self.vault).is_file():
                    raise FileNotFoundError(table.rel)
                pages = self._table_pages_sync(table)
                # Schemas that name this table by path: find them while the cache knows it.
                refs: list[TablePath] = []
                if self.tables is not None:
                    for info in self.tables.tables():
                        if any(
                            c.type == "relation" and c.target == table.rel for c in info.columns
                        ):
                            refs.append(table_paths.parse(info.path))
                os.replace(table.file(self.vault), renamed.file(self.vault))
                if table.schema_file(self.vault).is_file():
                    os.replace(table.schema_file(self.vault), renamed.schema_file(self.vault))
                self._activity(actor, "table.rename", renamed.rel, {"from": table.rel})
                for owner in refs:
                    owner = renamed if owner == table else owner
                    raw = self._raw_schema_sync(owner)
                    changed = False
                    for spec in (raw.get("columns") or {}).values():
                        if (
                            isinstance(spec, dict)
                            and spec.get("type") == "relation"
                            and table_cache.hint_path(owner.page, spec.get("table")) == table.rel
                        ):
                            spec["table"] = self._hint(owner, renamed)
                            changed = True
                    if changed:
                        self._write_schema_sync(owner, raw, actor)
                        if owner != renamed:
                            self._table_changed(owner.rel, actor)
                for page, sources in pages.items():
                    self._rewrite_table_refs_sync(page, sources, table, renamed, actor)
                if self.tables is not None:
                    self.tables.refresh(table.rel)
                self._table_changed(renamed.rel, actor)
                self._publish("table_renamed", {"from": table.rel, "to": renamed.rel})
                self._publish("tables_changed", {"page_path": table.page, "path": renamed.rel})
                return renamed.rel

            return await asyncio.to_thread(write)

    def _table_pages_sync(self, table: TablePath) -> dict[str, set[str]]:
        """Pages whose text shows `table`, with the sources that mean it there: a fence's
        `source:`, a key of its `tabs:`, or an `![[name.csv]]` embed."""
        out: dict[str, set[str]] = {}
        if self.tables is None:
            return out
        for (page,) in self.db.execute("SELECT path FROM pages").fetchall():
            try:
                text = page_file(self.vault, page).read_text(encoding="utf-8")
            except OSError:
                continue
            if table.name.lower() not in text.lower():
                continue
            candidates: set[str] = set(_TABLE_EMBEDS.findall(text))
            for block in _TABLE_FENCE.findall(text):
                for line in block.split("\n")[1:]:
                    m = _FENCE_VALUE.match(line)
                    if not m:
                        continue
                    indent, key, _, value = m.groups()
                    if key == "source" and not indent:
                        candidates.add(value.strip().strip("\"'"))
                    elif indent and not value.strip():
                        candidates.add(key.strip("\"'"))
            found: set[str] = set()
            for value in candidates:
                if table.name.lower() not in value.lower():
                    continue
                with contextlib.suppress(VaultPathError, FileNotFoundError):
                    if self.tables.resolve(page, value) == table.rel:
                        found.add(value)
            if found:
                out[page] = found
        return out

    def _rewrite_table_refs_sync(
        self, page: str, sources: set[str], old: TablePath, new: TablePath, actor: str
    ) -> None:
        f = page_file(self.vault, page)
        if not f.is_file():
            return
        old_text = f.read_text(encoding="utf-8")

        def renamed(value: str) -> str:
            for tail in (old.name + table_paths.SUFFIX, old.name):
                if value.endswith(tail):
                    return (
                        value[: -len(tail)]
                        + new.name
                        + (table_paths.SUFFIX if tail.endswith(table_paths.SUFFIX) else "")
                    )
            return value

        def fence(match: re.Match[str]) -> str:
            lines = match.group(0).split("\n")
            for n, line in enumerate(lines):
                m = _FENCE_VALUE.match(line)
                if not m:
                    continue
                indent, key, sep, value = m.groups()
                # `source:` and the keys of `tabs:` name tables.
                bare_key = key.strip("\"'")
                if key == "source" and not indent:
                    raw = value.strip()
                    quote = raw[:1] if raw[:1] in "\"'" else ""
                    inner = raw.strip("\"'")
                    if inner in sources:
                        lines[n] = f"{key}{sep}{quote}{renamed(inner)}{quote}"
                elif indent and bare_key in sources and not value.strip():
                    q = key[:1] if key[:1] in "\"'" else ""
                    lines[n] = f"{indent}{q}{renamed(bare_key)}{q}{sep}{value}"
            return "\n".join(lines)

        text = _TABLE_FENCE.sub(fence, old_text)
        text = _TABLE_EMBED_LINE.sub(
            lambda m: (
                f"{m.group(1)}![[{renamed(m.group(2))}]]{m.group(3)}"
                if m.group(2) in sources
                else m.group(0)
            ),
            text,
        )
        if text == old_text:
            return
        meta, body = fm.split(text)
        meta["updated"] = fm.now_iso()
        doc = self._write_page_sync(page, meta, body, old_text=old_text, actor=actor)
        self._rescan([page])
        self._activity(actor, "page.write", page, {"hash": doc.hash, "table_rename": True})
        self._publish("file_changed", {"path": page, "hash": doc.hash, "actor": actor})

    # ----------------------------------------------------------------- dashboards (D72)

    def _dashboard(self, page: str, src: str) -> DashboardPath:
        return dash_paths.checked(self.vault, dash_paths.parse(page, src))

    async def read_dashboard(self, page: str, src: str) -> str | None:
        """The dashboard's HTML, or None when the file does not exist yet."""
        dashboard = self._dashboard(page, src)

        def read() -> str | None:
            target = dashboard.file(self.vault)
            return target.read_text(encoding="utf-8") if target.is_file() else None

        return await asyncio.to_thread(read)

    async def write_dashboard(
        self, page: str, src: str, html: str, actor: str, *, base: str | None | bool = False
    ) -> str:
        """Write `<page>/_dashboards/<name>.html`. With `base` (the HTML the writer saw, None
        for "must not exist yet"), a file that changed meanwhile is a conflict. The old file
        keeps a snapshot in `.graite/versions/dashboards/`."""
        dashboard = self._dashboard(page, src)
        if len(html.encode("utf-8")) > dash_paths.MAX_BYTES:
            raise ValueError("A dashboard can be at most 1 MB of HTML.")
        async with self._locks[dashboard.rel]:

            def write() -> str:
                target = dashboard.file(self.vault)
                old = target.read_text(encoding="utf-8") if target.is_file() else None
                if base is not False and base != old:
                    raise ValueError(
                        f"{dashboard.src} changed since it was read; read it again first."
                        if old is not None
                        else f"{dashboard.src} no longer exists."
                        if base is not None
                        else f"{dashboard.src} already exists; change it instead."
                    )
                if old == html:
                    return dashboard.rel
                if old is not None:
                    self._snapshot_dashboard_sync(dashboard, old)
                target.parent.mkdir(exist_ok=True)
                _atomic_write(target, html)
                self._activity(actor, "dashboard.write", dashboard.rel, {"created": old is None})
                self._publish(
                    "dashboard_changed", {"path": dashboard.rel, "page_path": page, "actor": actor}
                )
                return dashboard.rel

            return await asyncio.to_thread(write)

    async def remove_dashboard(self, page: str, src: str, actor: str) -> None:
        """Remove a dashboard file (a reverted proposal that created it); a snapshot stays."""
        dashboard = self._dashboard(page, src)
        async with self._locks[dashboard.rel]:

            def remove() -> None:
                target = dashboard.file(self.vault)
                if not target.is_file():
                    return
                self._snapshot_dashboard_sync(dashboard, target.read_text(encoding="utf-8"))
                target.unlink()
                self._activity(actor, "dashboard.remove", dashboard.rel, {})
                self._publish(
                    "dashboard_changed", {"path": dashboard.rel, "page_path": page, "actor": actor}
                )

            await asyncio.to_thread(remove)

    def _snapshot_dashboard_sync(self, dashboard: DashboardPath, text: str) -> None:
        snap = (
            self.vault
            / GRAITE_DIR
            / "versions"
            / "dashboards"
            / hashlib.sha256(dashboard.rel.encode("utf-8")).hexdigest()[:16]
            / f"{int(time.time() * 1000)}.html"
        )
        snap.parent.mkdir(parents=True, exist_ok=True)
        snap.write_text(text, encoding="utf-8")

    async def refresh_tables(self, rels: list[str], actor: str = "external") -> list[str]:
        """Re-import tables changed outside Graite (watcher) and tell clients."""

        def run() -> list[str]:
            if self.tables is None:
                return []
            changed = [rel for rel in rels if self.tables.refresh(rel)]
            for rel in changed:
                self._table_changed(rel, actor)
            return changed

        return await asyncio.to_thread(run)

    def sync_tables(self) -> None:
        """Pages appeared, moved or vanished: their `_data/` tables did too."""
        if self.tables is None:
            return
        pages = [row[0] for row in self.db.execute("SELECT path FROM pages")]
        for rel in self.tables.sync(pages):
            self._table_changed(rel, "system")

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
            if result.tree_changed:
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
        meta.setdefault("id", fm.path_id(rel))
        meta.setdefault("title", current.title)
        meta.setdefault("created", fm.now_iso())
        meta["updated"] = fm.now_iso()
        doc = self._write_page_sync(rel, meta, body, old_text=old_text, actor=actor)
        self._rescan([rel])
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
        meta.setdefault("id", fm.path_id(rel))
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

    async def trash_page(self, rel: str, actor: str, *, unlink: bool = False) -> str:
        """Move a page to the trash. With `unlink`, also drop its [[link]] block from the parent
        (restoring it puts the block back). The editor removes that block itself, so it
        trashes without."""
        rel = validate_rel(rel)
        parent = parent_of(rel) if unlink else None
        async with self._locks[parent or ""] if parent else contextlib.nullcontext():
            async with self._locks[rel]:
                return await asyncio.to_thread(self._trash_sync, rel, actor, unlink)

    def _parent_link_targets(self, rel: str) -> list[str]:
        """How a parent may link to `rel` as a block: folder name, full path or title."""
        targets = [rel.rsplit("/", 1)[-1], rel]
        try:
            title = self._read_sync(rel).title
        except (OSError, ValueError):
            return targets
        return [*targets, title] if title and title not in targets else targets

    def _write_parent_body(self, parent: str, change: Callable[[str], str], actor: str) -> None:
        f = page_file(self.vault, parent)
        if not f.is_file():
            return
        old_text = f.read_text(encoding="utf-8")
        current = self._doc_from_text(parent, old_text)
        body = change(current.body)
        if body == current.body:
            return
        meta = dict(current.frontmatter)
        meta["updated"] = fm.now_iso()
        doc = self._write_page_sync(parent, meta, body, old_text=old_text, actor=actor)
        self._activity(actor, "page.write", parent, {"hash": doc.hash})
        self._publish("file_changed", {"path": parent, "hash": doc.hash, "actor": actor})

    def _trash_sync(self, rel: str, actor: str, unlink: bool = False) -> str:
        current_dir = page_dir(self.vault, rel)
        if not is_page_dir(current_dir):
            raise FileNotFoundError(rel)
        parent = parent_of(rel) if unlink else None
        targets = self._parent_link_targets(rel) if parent else []
        trash_root = self.vault / GRAITE_DIR / "trash"
        trash_root.mkdir(parents=True, exist_ok=True)
        trash_id = f"{int(time.time() * 1000)}-{slugify(current_dir.name)}"
        dest = trash_root / trash_id
        shutil.move(str(current_dir), str(dest))
        (dest / ORIGIN_FILE).write_text(
            json.dumps(
                {"path": rel, "trashed_at": fm.now_iso(), **({"unlinked": True} if parent else {})},
                ensure_ascii=False,
            ),
            encoding="utf-8",
        )
        if parent:
            self._write_parent_body(parent, lambda b: drop_page_links(b, targets), actor)
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
        relink = bool(self._trash_meta(trash_dir).get("unlinked"))
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
        if relink and parent_rel:
            folder = dest_dir.name

            def add_link(body: str) -> str:
                if indexer.VIEW_FENCE.search(body) or has_page_link(body, [folder, final_rel]):
                    return body
                return append_markdown(body, f"[[{folder}]]")

            self._write_parent_body(parent_rel, add_link, actor)
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
                    old_text=page_file(self.vault, rel).read_text(encoding="utf-8"),
                    actor=actor,
                )
                self._rescan([rel])
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
                meta.setdefault("id", fm.path_id(rel))
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
                    old_parent = parent_of(source)
                    if parent != old_parent:
                        # A normal page lists its subpages as [[link]] blocks: move that block
                        # along with the page. A page with a view lists its children itself.
                        folder = destination.rsplit("/", 1)[-1]
                        if old_parent in docs:
                            rewrites[old_parent] = drop_page_links(
                                rewrites.get(old_parent, docs[old_parent].body), [destination]
                            )
                        if parent in docs:
                            body = rewrites.get(parent, docs[parent].body)
                            if not indexer.VIEW_FENCE.search(body) and not has_page_link(
                                body, [destination, folder]
                            ):
                                rewrites[parent] = append_markdown(body, f"[[{folder}]]")
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
