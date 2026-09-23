"""Keep the `pages`, `chunks` and `links` tables in step with the vault on disk.

Scans are incremental: a page whose mtime and size are unchanged is skipped; an unchanged
file hash only refreshes stat columns; a changed body or title re-chunks that page, keeping
every section whose text hash still matches (so its vector survives). Moves are detected by
page id and re-path chunks without re-chunking. Everything happens in one transaction.
"""

from __future__ import annotations

import hashlib
import json
import re
import sqlite3
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from graite.index import chunker
from graite.index.db import transaction
from graite.vault import frontmatter as fm
from graite.vault.models import TreeNode
from graite.vault.paths import GRAITE_DIR, PAGE_FILE, is_reserved_name, slugify

VIEW_FENCE = re.compile(r"^```graite:view[ \t]*$", re.MULTILINE)


@dataclass
class ScanResult:
    added: list[str] = field(default_factory=list)
    changed: list[str] = field(default_factory=list)
    removed: list[str] = field(default_factory=list)
    moved: list[tuple[str, str]] = field(default_factory=list)
    chunked: list[str] = field(default_factory=list)
    total: int = 0

    @property
    def structure_changed(self) -> bool:
        return bool(self.added or self.removed or self.moved)

    @property
    def touched(self) -> list[str]:
        return [*self.added, *self.changed, *(new for _, new in self.moved)]


def _sha256(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def _row_for(vault: Path, page_dir: Path, parent_path: str | None) -> dict[str, Any]:
    text = (page_dir / PAGE_FILE).read_text(encoding="utf-8")
    meta, body = fm.split(text)
    stat = (page_dir / PAGE_FILE).stat()
    order = meta.get("order")
    return {
        "id": str(meta.get("id") or ""),
        "path": page_dir.relative_to(vault).as_posix(),
        "parent_path": parent_path,
        "title": str(meta.get("title") or page_dir.name),
        "icon": meta.get("icon") or None,
        "frontmatter_json": json.dumps(meta, ensure_ascii=False, default=str),
        "file_hash": _sha256(text),
        "body_hash": _sha256(body),
        "mtime": stat.st_mtime,
        "size": stat.st_size,
        "order_key": float(order) if isinstance(order, int | float) else None,
        "created": meta.get("created"),
        "updated": meta.get("updated"),
        "has_content": int(bool(body.strip())),
        "has_view": int(bool(VIEW_FENCE.search(body))),
        "_body": body,
    }


def _walk(
    vault: Path, folder: Path, parent_path: str | None, found: list[tuple[Path, str, str | None]]
) -> None:
    try:
        children = sorted(folder.iterdir(), key=lambda p: p.name.lower())
    except OSError:
        return
    for child in children:
        if (
            not child.is_dir()
            or child.is_symlink()
            or is_reserved_name(child.name)
            or child.name == GRAITE_DIR
        ):
            continue
        if (child / PAGE_FILE).is_file():
            rel = child.relative_to(vault).as_posix()
            found.append((child, rel, parent_path))
            _walk(vault, child, rel, found)
        else:
            # Plain folder (e.g. an Obsidian vault): descend; pages inside attach to the
            # nearest page ancestor.
            _walk(vault, child, parent_path, found)


def _nearest_page_ancestor(vault: Path, rel: str) -> str | None:
    parts = rel.split("/")
    for depth in range(len(parts) - 1, 0, -1):
        candidate = "/".join(parts[:depth])
        if (vault / Path(*parts[:depth]) / PAGE_FILE).is_file():
            return candidate
    return None


def _has_vec(conn: sqlite3.Connection) -> bool:
    return bool(conn.execute("SELECT 1 FROM sqlite_master WHERE name='chunk_vec'").fetchone())


def _delete_chunks(conn: sqlite3.Connection, ids: list[int], has_vec: bool) -> None:
    if not ids:
        return
    marks = ",".join("?" * len(ids))
    if has_vec:
        conn.execute(f"DELETE FROM chunk_vec WHERE rowid IN ({marks})", ids)
    conn.execute(f"DELETE FROM chunks WHERE id IN ({marks})", ids)


def _rechunk(conn: sqlite3.Connection, row: dict[str, Any], has_vec: bool) -> None:
    path, title = row["path"], row["title"]
    chunks = chunker.chunk_page(title, row["_body"])
    new_rows = chunker.rows_for(title, path, row["id"], row["body_hash"], chunks)
    old: dict[str, list[int]] = {}
    for r in conn.execute("SELECT id, text_hash FROM chunks WHERE page_path=?", (path,)):
        old.setdefault(r["text_hash"], []).append(r["id"])
    # Park existing ords out of the way so reordering never violates UNIQUE(page_path, ord).
    conn.execute("UPDATE chunks SET ord = -ord - 1 WHERE page_path=?", (path,))
    for new in new_rows:
        ids = old.get(new["text_hash"])
        if ids:
            conn.execute(
                "UPDATE chunks SET ord=?, heading=?, heading_path=?, kind=?, start_line=?, "
                "end_line=?, body_hash=?, page_id=? WHERE id=?",
                (
                    new["ord"],
                    new["heading"],
                    new["heading_path"],
                    new["kind"],
                    new["start_line"],
                    new["end_line"],
                    new["body_hash"],
                    new["page_id"],
                    ids.pop(0),
                ),
            )
        else:
            conn.execute(
                "INSERT INTO chunks (page_path, page_id, ord, title, heading, heading_path, kind, "
                "start_line, end_line, text, text_hash, body_hash) VALUES (:page_path, :page_id, "
                ":ord, :title, :heading, :heading_path, :kind, :start_line, :end_line, :text, "
                ":text_hash, :body_hash)",
                new,
            )
    leftovers = [i for ids in old.values() for i in ids]
    _delete_chunks(conn, leftovers, has_vec)
    conn.execute("DELETE FROM links WHERE src_path=?", (path,))
    _insert_links(conn, path, row["_body"])


def _insert_links(conn: sqlite3.Connection, path: str, body: str) -> None:
    for link in chunker.extract_links(body):
        target_path = (
            resolve_target(conn, path, link.target)
            if link.kind in ("wiki", "embed", "md")
            else None
        )
        if link.kind == "md" and target_path is None:
            candidate = link.target[:-3] if link.target.endswith(".md") else link.target
            target_path = resolve_target(conn, path, candidate.rsplit("/", 1)[-1])
        conn.execute(
            "INSERT OR REPLACE INTO links (src_path, target, target_path, kind, heading, alias) "
            "VALUES (?,?,?,?,?,?)",
            (path, link.target, target_path, link.kind, link.heading, link.alias),
        )


def _reresolve_links(conn: sqlite3.Connection) -> None:
    rows = conn.execute(
        "SELECT src_path, target, kind FROM links WHERE target_path IS NULL AND kind != 'tag'"
    ).fetchall()
    for r in rows:
        resolved = resolve_target(conn, r["src_path"], r["target"])
        if resolved:
            conn.execute(
                "UPDATE links SET target_path=? WHERE src_path=? AND target=? AND kind=?",
                (resolved, r["src_path"], r["target"], r["kind"]),
            )


def resolve_target(conn: sqlite3.Connection, from_path: str, target: str) -> str | None:
    """Resolve a wikilink target the way the editor does: child folder or title, then vault."""
    target = target.split("#", 1)[0].strip()
    if not target:
        return None
    if conn.execute("SELECT 1 FROM pages WHERE path=?", (target,)).fetchone():
        return target
    wanted = slugify(target).lower()
    for r in conn.execute(
        "SELECT path, title FROM pages WHERE parent_path=? ORDER BY lower(path)", (from_path,)
    ):
        if r["path"].rsplit("/", 1)[-1].lower() == wanted or r["title"].lower() == target.lower():
            return str(r["path"])
    return find_by_title(conn, target)


def scan(vault: Path, conn: sqlite3.Connection, *, paths: list[str] | None = None) -> ScanResult:
    """Incremental scan of the whole vault, or of the given page subtrees only."""
    result = ScanResult()
    found: list[tuple[Path, str, str | None]] = []
    if paths is None:
        _walk(vault, vault, None, found)
        stored = {r["path"]: r for r in conn.execute("SELECT * FROM pages")}
    else:
        stored = {}
        for rel in sorted(set(paths)):
            directory = vault / Path(*rel.split("/"))
            parent = _nearest_page_ancestor(vault, rel)
            if (directory / PAGE_FILE).is_file():
                found.append((directory, rel, parent))
                _walk(vault, directory, rel, found)
            for r in conn.execute(
                "SELECT * FROM pages WHERE path=? OR path LIKE ?", (rel, rel + "/%")
            ):
                stored[r["path"]] = r
    seen: dict[str, tuple[Path, str | None]] = {rel: (d, parent) for d, rel, parent in found}
    has_vec = _has_vec(conn)
    with transaction(conn):
        fresh: dict[str, dict[str, Any]] = {}
        for rel, (directory, parent) in seen.items():
            old = stored.get(rel)
            try:
                stat = (directory / PAGE_FILE).stat()
            except OSError:
                continue
            if (
                old is not None
                and old["mtime"] == stat.st_mtime
                and old["size"] == stat.st_size
                and old["parent_path"] == parent
                and old["body_hash"] is not None
            ):
                continue
            try:
                row = _row_for(vault, directory, parent)
            except Exception as exc:  # noqa: BLE001 - unreadable YAML must not stop the scan
                if old is not None:
                    conn.execute(
                        "UPDATE pages SET index_error=?, mtime=?, size=? WHERE path=?",
                        (str(exc)[:500], stat.st_mtime, stat.st_size, rel),
                    )
                continue
            fresh[rel] = row
        removed = [rel for rel in stored if rel not in seen]
        # Moves: a removed path whose id reappears under a new path. Duplicated page folders
        # share an id, so each old path may be claimed once and only by one new path.
        by_id: dict[str, list[str]] = {}
        for rel in removed:
            if stored[rel]["id"]:
                by_id.setdefault(stored[rel]["id"], []).append(rel)
        claimed: set[str] = set()
        for rel, row in list(fresh.items()):
            candidates = by_id.get(row["id"], []) if row["id"] and rel not in stored else []
            old_rel = next((c for c in candidates if c not in claimed), None)
            if old_rel:
                claimed.add(old_rel)
                removed.remove(old_rel)
                conn.execute(
                    "UPDATE pages SET path=?, parent_path=? WHERE path=?",
                    (rel, row["parent_path"], old_rel),
                )
                conn.execute("UPDATE chunks SET page_path=? WHERE page_path=?", (rel, old_rel))
                conn.execute("UPDATE links SET src_path=? WHERE src_path=?", (rel, old_rel))
                conn.execute("UPDATE links SET target_path=? WHERE target_path=?", (rel, old_rel))
                stored[rel] = stored.pop(old_rel)
                result.moved.append((old_rel, rel))
        for rel in removed:
            ids = [r["id"] for r in conn.execute("SELECT id FROM chunks WHERE page_path=?", (rel,))]
            _delete_chunks(conn, ids, has_vec)
            conn.execute("DELETE FROM links WHERE src_path=?", (rel,))
            conn.execute("UPDATE links SET target_path=NULL WHERE target_path=?", (rel,))
            conn.execute("DELETE FROM pages WHERE path=?", (rel,))
            result.removed.append(rel)
        for rel, row in fresh.items():
            old = stored.get(rel)
            if old is None:
                result.added.append(rel)
            elif rel not in {new for _, new in result.moved}:
                result.changed.append(rel)
            conn.execute(
                """INSERT INTO pages (id, path, parent_path, title, icon, frontmatter_json,
                   file_hash, body_hash, mtime, size, order_key, created, updated, has_content,
                   has_view, index_error)
                   VALUES (:id, :path, :parent_path, :title, :icon, :frontmatter_json,
                   :file_hash, :body_hash, :mtime, :size, :order_key, :created, :updated,
                   :has_content, :has_view, NULL)
                   ON CONFLICT(path) DO UPDATE SET id=excluded.id, parent_path=excluded.parent_path,
                   title=excluded.title, icon=excluded.icon,
                   frontmatter_json=excluded.frontmatter_json, file_hash=excluded.file_hash,
                   body_hash=excluded.body_hash, mtime=excluded.mtime, size=excluded.size,
                   order_key=excluded.order_key, created=excluded.created,
                   updated=excluded.updated, has_content=excluded.has_content,
                   has_view=excluded.has_view, index_error=NULL""",
                row,
            )
        # Chunk after every page row is current so links resolve against the new tree.
        for rel, row in fresh.items():
            old = stored.get(rel)
            if (
                old is None
                or old["body_hash"] != row["body_hash"]
                or old["title"] != row["title"]
                or old["id"] != row["id"]
            ):
                _rechunk(conn, row, has_vec)
                conn.execute("UPDATE pages SET indexed_at=? WHERE path=?", (fm.now_iso(), rel))
                result.chunked.append(rel)
        if result.structure_changed:
            _reresolve_links(conn)
    result.total = conn.execute("SELECT count(*) FROM pages").fetchone()[0]
    return result


def pending_embeddings(conn: sqlite3.Connection) -> int:
    return int(
        conn.execute("SELECT count(*) FROM chunks WHERE embedded_model IS NULL").fetchone()[0]
    )


def tree(conn: sqlite3.Connection) -> list[TreeNode]:
    rows = conn.execute(
        "SELECT path, id, title, icon, parent_path, order_key, has_content, has_view FROM pages "
        "ORDER BY (order_key IS NULL), order_key, lower(title), path"
    ).fetchall()
    nodes = {
        r["path"]: TreeNode(
            r["path"],
            r["id"],
            r["title"],
            r["icon"],
            has_content=bool(r["has_content"]),
            has_view=bool(r["has_view"]),
        )
        for r in rows
    }
    roots: list[TreeNode] = []
    for r in rows:
        node = nodes[r["path"]]
        parent = nodes.get(r["parent_path"]) if r["parent_path"] else None
        (parent.children if parent else roots).append(node)
    return roots


def find_by_title(conn: sqlite3.Connection, target: str) -> str | None:
    """Vault-wide lookup by exact title, then by alias (case-insensitive)."""
    row = conn.execute(
        "SELECT path FROM pages WHERE lower(title) = lower(?) ORDER BY path LIMIT 1", (target,)
    ).fetchone()
    if row:
        return str(row["path"])
    for r in conn.execute("SELECT path, frontmatter_json FROM pages").fetchall():
        aliases = json.loads(r["frontmatter_json"]).get("aliases") or []
        if any(str(a).lower() == target.lower() for a in aliases):
            return str(r["path"])
    return None
