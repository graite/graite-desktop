"""`.graite/tables.sqlite`: every table CSV materialized as a typed SQLite table.

Derived state (CLAUDE.md rule 6): deleting the file only costs a re-import. A table is
re-imported when its CSV or schema file changes (mtime/size fast path, then content hash),
and every read checks that fast path first, so a missed watcher event cannot serve stale rows.
"""

from __future__ import annotations

import csv
import hashlib
import json
import logging
import sqlite3
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, cast

from graite.index.db import SafeConnection, transaction
from graite.tables import csvio, edit
from graite.tables import links as lnk
from graite.tables import schema as sch
from graite.tables.paths import DATA_DIR, SUFFIX, TablePath, check_name, checked, parse
from graite.tables.query import QueryError, compile_filter, parse_sort
from graite.vault.paths import VaultPathError, page_dir

log = logging.getLogger("graite.tables")

MAX_LIMIT = 1000
# Bump when the stored shape changes (types, column JSON): an older cache is rebuilt.
CACHE_VERSION = 4
INDEX_FROM = 5000  # rows; smaller tables sort fast enough without an index

REGISTRY = """
CREATE TABLE IF NOT EXISTS _tables (
  path TEXT PRIMARY KEY,
  page_path TEXT NOT NULL,
  name TEXT NOT NULL,
  sql_name TEXT NOT NULL,
  file_hash TEXT NOT NULL,
  schema_hash TEXT NOT NULL,
  mtime_ns INTEGER NOT NULL,
  size INTEGER NOT NULL,
  schema_mtime_ns INTEGER NOT NULL,
  schema_size INTEGER NOT NULL,
  row_count INTEGER NOT NULL,
  primary_key TEXT NOT NULL,
  display TEXT,
  columns_json TEXT NOT NULL,
  warnings_json TEXT NOT NULL,
  imported_at TEXT NOT NULL,
  table_id TEXT,
  display_secondary TEXT
);
CREATE INDEX IF NOT EXISTS ix_tables_page ON _tables(page_path);
CREATE INDEX IF NOT EXISTS ix_tables_id ON _tables(table_id);
-- Every link in a relation column (D71): one row per link, rebuilt with its source table.
CREATE TABLE IF NOT EXISTS _links (
  src_path TEXT NOT NULL,
  column TEXT NOT NULL,
  src_rid TEXT NOT NULL,
  pos INTEGER NOT NULL,
  dst_rid TEXT NOT NULL,
  label TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_links_src ON _links(src_path, column, src_rid);
CREATE INDEX IF NOT EXISTS ix_links_dst ON _links(src_path, column, dst_rid);
"""


def quote(name: str) -> str:
    return '"' + name.replace('"', '""') + '"'


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def hint_path(page: str, hint: str | None) -> str | None:
    """The table a relation's `table:` names: a vault path, or a name in `page`'s `_data/`."""
    if not hint:
        return None
    hint = hint.strip().replace("\\", "/").lstrip("/")
    try:
        if f"/{DATA_DIR}/" in hint:
            return parse(hint).rel
        if hint.startswith(f"{DATA_DIR}/"):
            return parse(f"{page}/{hint}").rel
        return TablePath(page, check_name(hint)).rel
    except VaultPathError:
        return None


def label_text(value: Any) -> str:
    """A display cell as a link label."""
    if value is None:
        return ""
    if isinstance(value, float) and value.is_integer():
        value = int(value)
    return lnk.clean_label(str(value))


def _stat(path: Path) -> tuple[int, int]:
    try:
        st = path.stat()
    except OSError:
        return (-1, -1)
    return (st.st_mtime_ns, st.st_size)


@dataclass
class TableInfo:
    path: str
    page_path: str
    name: str
    sql_name: str
    file_hash: str
    row_count: int
    primary_key: str
    display: str | None
    columns: list[sch.Column]
    warnings: list[str] = field(default_factory=list)
    table_id: str | None = None
    display_secondary: str | None = None
    # The columns that name a row: the schema's choice or the default (sch.display_column).
    label_column: str | None = None
    secondary_column: str | None = None

    @property
    def kinds(self) -> dict[str, str]:
        return {c.name: c.type for c in self.columns if not c.reverse}

    @property
    def stored(self) -> list[sch.Column]:
        """Columns that are in the CSV (not reverse relations)."""
        return [c for c in self.columns if not c.reverse]

    def to_json(self) -> dict[str, Any]:
        return {
            "path": self.path,
            "page_path": self.page_path,
            "name": self.name,
            "hash": self.file_hash,
            "row_count": self.row_count,
            "primary_key": self.primary_key,
            "display": self.display,
            "display_secondary": self.display_secondary,
            "label_column": self.label_column,
            "secondary_column": self.secondary_column,
            "table_id": self.table_id,
            "columns": [c.to_json() for c in self.columns],
            "warnings": self.warnings,
        }


class TablesCache:
    def __init__(self, vault: Path, db_path: Path) -> None:
        self.vault = vault
        self.db_path = db_path
        self.conn = self._connect()

    def _connect(self) -> sqlite3.Connection:
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        for attempt in range(2):
            try:
                raw = sqlite3.connect(self.db_path, check_same_thread=False, isolation_level=None)
                raw.row_factory = sqlite3.Row
                raw.execute("PRAGMA journal_mode=WAL")
                raw.execute("PRAGMA busy_timeout=5000")
                if raw.execute("PRAGMA user_version").fetchone()[0] != CACHE_VERSION:
                    tables = raw.execute(
                        "SELECT name FROM sqlite_master WHERE type='table'"
                    ).fetchall()
                    for (name,) in tables:
                        raw.execute(f"DROP TABLE IF EXISTS {quote(name)}")
                    raw.execute(f"PRAGMA user_version={CACHE_VERSION}")
                raw.executescript(REGISTRY)
                return cast(sqlite3.Connection, SafeConnection(raw))
            except sqlite3.DatabaseError:
                if attempt:
                    raise
                # A damaged cache is only a cache: start over.
                log.warning("tables cache unreadable, rebuilding %s", self.db_path)
                for suffix in ("", "-wal", "-shm"):
                    Path(str(self.db_path) + suffix).unlink(missing_ok=True)
        raise AssertionError("unreachable")

    def close(self) -> None:
        self.conn.close()

    # ------------------------------------------------------------------ import

    def _row(self, rel: str) -> sqlite3.Row | None:
        return cast(
            "sqlite3.Row | None",
            self.conn.execute("SELECT * FROM _tables WHERE path=?", (rel,)).fetchone(),
        )

    def _drop(self, rel: str) -> bool:
        row = self._row(rel)
        if row is None:
            return False
        with transaction(self.conn):
            self.conn.execute(f"DROP TABLE IF EXISTS {quote(row['sql_name'])}")
            self.conn.execute("DELETE FROM _tables WHERE path=?", (rel,))
            self.conn.execute("DELETE FROM _links WHERE src_path=?", (rel,))
        return True

    def refresh(self, rel: str) -> bool:
        """Bring one table up to date with its files; True when the cached rows changed."""
        try:
            table = checked(self.vault, parse(rel))
        except (VaultPathError, FileNotFoundError):
            return self._drop(rel)
        csv_file, schema_file = table.file(self.vault), table.schema_file(self.vault)
        if not csv_file.is_file():
            return self._drop(rel)
        stat, schema_stat = _stat(csv_file), _stat(schema_file)
        row = self._row(rel)
        if (
            row is not None
            and (row["mtime_ns"], row["size"]) == stat
            and (row["schema_mtime_ns"], row["schema_size"]) == schema_stat
        ):
            return False
        data = csv_file.read_bytes()
        schema_text = schema_file.read_text(encoding="utf-8") if schema_file.is_file() else ""
        file_hash, schema_hash = sha256(data), sha256(schema_text.encode("utf-8"))
        if row is not None and (row["file_hash"], row["schema_hash"]) == (file_hash, schema_hash):
            self.conn.execute(
                "UPDATE _tables SET mtime_ns=?, size=?, schema_mtime_ns=?, schema_size=? "
                "WHERE path=?",
                (*stat, *schema_stat, rel),
            )
            return False
        self._import(
            table, csvio.decode(data), schema_text, file_hash, schema_hash, stat, schema_stat
        )
        return True

    def _import(
        self,
        table: TablePath,
        text: str,
        schema_text: str,
        file_hash: str,
        schema_hash: str,
        stat: tuple[int, int],
        schema_stat: tuple[int, int],
    ) -> None:
        parsed = csvio.parse(text)
        schema, warnings = sch.load(schema_text)
        names = sch.column_names(parsed.header)
        rows = [r.values for r in parsed.rows]
        columns = sch.columns_for(names, rows, schema)
        position = {name: i for i, name in enumerate(names)}
        ids, id_warnings = edit.effective_ids(parsed, schema.primary_key)
        warnings += id_warnings
        pk = edit.pk_index(parsed.header, schema.primary_key)
        primary_key = names[pk] if pk is not None else schema.primary_key
        ragged = sum(1 for r in rows if len(r) > len(names))
        if ragged:
            warnings.append(f"rows_long:{ragged}")
        sql_name = "t_" + sha256(table.rel.encode("utf-8"))[:16]
        stored = [c for c in columns if not c.reverse]
        definitions = ", ".join(
            f"{quote(c.name)} {sch.SQL_TYPES.get(c.type, 'TEXT')}" for c in stored
        )
        placeholders = ", ".join("?" for _ in range(len(stored) + 2))
        order = [position[c.name] for c in stored]
        kinds = [c.type for c in stored]
        relations = [(c.name, position[c.name]) for c in stored if c.type == "relation"]

        def links() -> Any:
            for rid, record in zip(ids, rows, strict=True):
                for name, i in relations:
                    cell = record[i] if i < len(record) else ""
                    for pos, link in enumerate(lnk.parse_links(cell)):
                        yield (table.rel, name, rid, pos, link.id, link.label)

        def values() -> Any:
            for n, (rid, record) in enumerate(zip(ids, rows, strict=True)):
                yield (
                    rid,
                    n,
                    *(
                        sch.to_sql(kind, record[i] if i < len(record) else "")
                        for i, kind in zip(order, kinds, strict=True)
                    ),
                )

        with transaction(self.conn):
            self.conn.execute(f"DROP TABLE IF EXISTS {quote(sql_name)}")
            self.conn.execute(
                f"CREATE TABLE {quote(sql_name)} (_rid TEXT NOT NULL, _row INTEGER NOT NULL"
                + (f", {definitions}" if definitions else "")
                + ")"
            )
            self.conn.executemany(
                f"INSERT INTO {quote(sql_name)} VALUES ({placeholders})", values()
            )
            self.conn.execute(
                f"CREATE UNIQUE INDEX {quote(sql_name + '_rid')} ON {quote(sql_name)}(_rid)"
            )
            self.conn.execute(f"CREATE INDEX {quote(sql_name + '_row')} ON {quote(sql_name)}(_row)")
            self.conn.execute("DELETE FROM _links WHERE src_path=?", (table.rel,))
            self.conn.executemany("INSERT INTO _links VALUES (?, ?, ?, ?, ?, ?)", links())
            self.conn.execute(
                "INSERT OR REPLACE INTO _tables VALUES "
                "(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), ?, ?)",
                (
                    table.rel,
                    table.page,
                    table.name,
                    sql_name,
                    file_hash,
                    schema_hash,
                    *stat,
                    *schema_stat,
                    len(rows),
                    primary_key,
                    schema.display,
                    json.dumps([c.to_json() for c in columns], ensure_ascii=False),
                    json.dumps(warnings, ensure_ascii=False),
                    schema.id,
                    schema.display_secondary,
                ),
            )

    def discover(self, pages: list[str]) -> None:
        """Import the tables of `pages` the cache has not seen yet (others stay as they are)."""
        for rel in self._found(pages):
            try:
                self.refresh(rel)
            except (OSError, sqlite3.Error, csv.Error) as exc:
                log.warning("could not import %s: %s", rel, exc)

    def _found(self, pages: list[str]) -> set[str]:
        found: set[str] = set()
        for page in pages:
            data = page_dir(self.vault, page) / DATA_DIR
            if not data.is_dir() or data.is_symlink():
                continue
            for item in sorted(data.iterdir()):
                if (
                    item.suffix.lower() == SUFFIX
                    and item.is_file()
                    and not item.name.startswith(".")
                ):
                    try:
                        found.add(TablePath(page, check_name(item.name)).rel)
                    except VaultPathError:
                        continue
        return found

    def sync(self, pages: list[str]) -> list[str]:
        """Match the cache to every `_data/*.csv` under `pages`; returns tables that changed
        (imported, re-imported or dropped). Used at startup and when pages move."""
        found = self._found(pages)
        known = {row[0] for row in self.conn.execute("SELECT path FROM _tables")}
        changed = [rel for rel in sorted(known - found) if self._drop(rel)]
        for rel in sorted(found):
            try:
                if self.refresh(rel):
                    changed.append(rel)
            except (OSError, sqlite3.Error, csv.Error) as exc:
                log.warning("could not import %s: %s", rel, exc)
        return changed

    # ------------------------------------------------------------------ read

    def _base_info(self, rel: str) -> TableInfo:
        """A table as imported, without resolving its relations."""
        self.refresh(rel)
        row = self._row(parse(rel).rel)
        if row is None:
            raise FileNotFoundError(rel)
        columns = [sch.Column(**c) for c in json.loads(row["columns_json"])]
        schema = sch.Schema(
            primary_key=row["primary_key"],
            display=row["display"],
            display_secondary=row["display_secondary"],
        )
        return TableInfo(
            path=row["path"],
            page_path=row["page_path"],
            name=row["name"],
            sql_name=row["sql_name"],
            file_hash=row["file_hash"],
            row_count=row["row_count"],
            primary_key=row["primary_key"],
            display=row["display"],
            columns=columns,
            warnings=json.loads(row["warnings_json"]),
            table_id=row["table_id"],
            display_secondary=row["display_secondary"],
            label_column=sch.display_column(columns, schema),
            secondary_column=sch.secondary_column(columns, schema),
        )

    def info(self, rel: str) -> TableInfo:
        info = self._base_info(rel)
        if info.table_id:
            twins = self.conn.execute(
                "SELECT count(*) FROM _tables WHERE table_id=?", (info.table_id,)
            ).fetchone()[0]
            if twins > 1:
                info.warnings.append("table_id_duplicate")
        broken = 0
        for column in info.columns:
            if column.type != "relation":
                continue
            column.target = self.resolve_target(info.page_path, column.table, column.table_id)
            if column.target is None:
                info.warnings.append(f"relation_target_missing:{column.name}")
            elif not column.reverse:
                broken += self._broken(info.path, column.name, column.target)
        if broken:
            info.warnings.append(f"links_broken:{broken}")
        return info

    # ------------------------------------------------------------------ relations (D71)

    def resolve_target(self, page: str, hint: str | None, table_id: str | None) -> str | None:
        """The table a relation points at: by its schema id (so links survive moves and
        renames), else by the `table:` path."""
        by_hint = hint_path(page, hint)
        if table_id:
            found = [
                str(r[0])
                for r in self.conn.execute(
                    "SELECT path FROM _tables WHERE table_id=? ORDER BY path", (table_id,)
                )
            ]
            if found:
                path = by_hint if by_hint in found else found[0]
                # Current rows, so links to rows deleted meanwhile read as broken.
                self.refresh(path)
                if self._row(path) is not None:
                    return path
        if by_hint is None:
            return None
        self.refresh(by_hint)
        return by_hint if self._row(by_hint) is not None else None

    def _broken(self, src: str, column: str, target: str) -> int:
        row = self._row(target)
        if row is None:
            return 0
        return int(
            self.conn.execute(
                f"SELECT count(*) FROM _links l WHERE src_path=? AND column=? AND NOT EXISTS "
                f"(SELECT 1 FROM {quote(row['sql_name'])} t WHERE t._rid = l.dst_rid)",
                (src, column),
            ).fetchone()[0]
        )

    def labels(self, rel: str, ids: list[str]) -> dict[str, tuple[str, str | None]]:
        """`{row id: (label, secondary)}` for the rows of `rel` that exist."""
        info = self._base_info(rel)
        wanted = list(dict.fromkeys(i for i in ids if i))
        if not wanted:
            return {}
        cols = [info.label_column, info.secondary_column]
        picked = ", ".join(quote(c) if c else "NULL" for c in cols)
        out: dict[str, tuple[str, str | None]] = {}
        for start in range(0, len(wanted), 500):
            chunk = wanted[start : start + 500]
            marks = ", ".join("?" for _ in chunk)
            for row in self.conn.execute(
                f"SELECT _rid, {picked} FROM {quote(info.sql_name)} WHERE _rid IN ({marks})",
                chunk,
            ):
                secondary = label_text(row[2]) if cols[1] else None
                out[row[0]] = (label_text(row[1]), secondary or None)
        return out

    def inbound(self, rel: str) -> list[tuple[str, str]]:
        """`(source table, forward column)` of every relation that points at `rel`."""
        out: list[tuple[str, str]] = []
        for (path,) in self.conn.execute("SELECT path FROM _tables ORDER BY path").fetchall():
            try:
                info = self._base_info(path)
            except (FileNotFoundError, VaultPathError):
                continue
            for column in info.columns:
                if column.type == "relation" and not column.reverse:
                    target = self.resolve_target(info.page_path, column.table, column.table_id)
                    if target == rel:
                        out.append((info.path, column.name))
        return out

    def links_to(self, src: str, column: str, ids: list[str] | None) -> list[tuple[str, str]]:
        """`(source row id, target row id)` of the links in `src.column` to any of `ids`
        (every link when None)."""
        self.refresh(src)
        if ids is None:
            return [
                (r[0], r[1])
                for r in self.conn.execute(
                    "SELECT src_rid, dst_rid FROM _links WHERE src_path=? AND column=? "
                    "ORDER BY src_rid, pos",
                    (src, column),
                )
            ]
        out: list[tuple[str, str]] = []
        for start in range(0, len(ids), 500):
            chunk = ids[start : start + 500]
            marks = ", ".join("?" for _ in chunk)
            out += [
                (r[0], r[1])
                for r in self.conn.execute(
                    f"SELECT src_rid, dst_rid FROM _links WHERE src_path=? AND column=? "
                    f"AND dst_rid IN ({marks}) ORDER BY src_rid, pos",
                    (src, column, *chunk),
                )
            ]
        return out

    def _reverse_cells(
        self, info: TableInfo, column: sch.Column, rids: list[str]
    ) -> dict[str, list[dict[str, Any]]]:
        source = column.target
        if source is None or not column.reverse or not rids:
            return {}
        try:
            src = self._base_info(source)
        except (FileNotFoundError, VaultPathError):
            return {}
        pairs = self.links_to(source, column.reverse, rids)
        # In the source table's row order, so the list reads like that table.
        order = {
            r[0]: r[1]
            for r in self.conn.execute(
                f"SELECT _rid, _row FROM {quote(src.sql_name)} WHERE _rid IN "
                f"(SELECT src_rid FROM _links WHERE src_path=? AND column=?)",
                (source, column.reverse),
            )
        }
        pairs.sort(key=lambda p: order.get(p[0], 1 << 30))
        names = self.labels(source, [p[0] for p in pairs])
        out: dict[str, list[dict[str, Any]]] = {}
        for src_rid, dst_rid in pairs:
            label, secondary = names.get(src_rid, ("", None))
            item: dict[str, Any] = {"id": src_rid, "label": label}
            if secondary:
                item["secondary"] = secondary
            out.setdefault(dst_rid, []).append(item)
        return out

    def _forward_cell(
        self, value: Any, names: dict[str, tuple[str, str | None]] | None
    ) -> list[dict[str, Any]]:
        out: list[dict[str, Any]] = []
        for link in lnk.parse_links(value if isinstance(value, str) else ""):
            item: dict[str, Any] = {"id": link.id, "label": link.label}
            if names is None or link.id not in names:
                # No target table, or no such row there: shown as a broken link.
                item["broken"] = True
            else:
                label, secondary = names[link.id]
                item["label"] = label
                if secondary:
                    item["secondary"] = secondary
            out.append(item)
        return out

    def tables(self, page: str | None = None) -> list[TableInfo]:
        sql = "SELECT path FROM _tables"
        params: tuple[str, ...] = ()
        if page is not None:
            sql, params = sql + " WHERE page_path=?", (page,)
        out = []
        for row in self.conn.execute(sql + " ORDER BY path", params).fetchall():
            try:
                out.append(self.info(row[0]))
            except FileNotFoundError:
                continue
        return out

    def resolve(self, page: str, source: str) -> str:
        """The table a block on `page` means by `source`: `_data/x.csv` (this page), a vault
        path, or a bare name as in `![[x.csv]]` (this page first, then the nearest page up,
        then anywhere if the name is unique)."""
        source = source.strip().replace("\\", "/").lstrip("/")
        if source.startswith(f"{DATA_DIR}/"):
            return parse(f"{page}/{source}").rel
        if f"/{DATA_DIR}/" in source:
            return parse(source).rel
        name = check_name(source)
        rows = self.conn.execute(
            "SELECT path, page_path FROM _tables WHERE lower(name)=lower(?)", (name,)
        ).fetchall()
        own = TablePath(page, name)
        if own.file(self.vault).is_file():
            return own.rel
        by_page = {row["page_path"]: row["path"] for row in rows}
        parts = page.split("/")
        for depth in range(len(parts) - 1, 0, -1):
            ancestor = "/".join(parts[:depth])
            if ancestor in by_page:
                return str(by_page[ancestor])
        if len(rows) == 1:
            return str(rows[0]["path"])
        if rows:
            raise VaultPathError(
                f"Several tables are named {name!r}; use the full path, e.g. {rows[0]['path']}."
            )
        raise FileNotFoundError(f"No table named {name!r}.")

    def select(
        self,
        rel: str,
        *,
        filter: str | None = None,
        sort: str | list[str] | None = None,
        columns: list[str] | None = None,
        search: str | None = None,
        ids: list[str] | None = None,
        offset: int = 0,
        limit: int = 200,
    ) -> dict[str, Any]:
        info = self.info(rel)
        by_name = {c.name: c for c in info.columns}
        table = quote(info.sql_name)

        def find(name: str) -> sch.Column:
            column = by_name.get(name) or next(
                (c for c in info.columns if c.name.lower() == name.lower()), None
            )
            if column is None:
                raise QueryError(f"The table has no column {name!r}.")
            return column

        def resolve(name: str) -> tuple[str, str]:
            column = find(name)
            if column.reverse:
                raise QueryError(
                    f"{column.name!r} lists rows of another table; "
                    "filter or sort on the column in that table instead."
                )
            # Relation cells are link text: `contains` matches labels, `is empty` works.
            return quote(column.name), "text" if column.type == "relation" else column.type

        where = compile_filter(filter, resolve)
        clauses, params = [where.sql], list(where.params)
        if ids is not None:
            clauses.append(f"_rid IN ({', '.join('?' for _ in ids) or 'NULL'})")
            params += ids
        if search and search.strip():
            text_cols = [
                quote(c.name) for c in info.columns if c.type != "checkbox" and not c.reverse
            ]
            if text_cols:
                clauses.append(
                    "("
                    + " OR ".join(
                        f"instr(lower(CAST({c} AS TEXT)), lower(?)) > 0" for c in text_cols
                    )
                    + ")"
                )
                params += [search.strip()] * len(text_cols)
        where_sql = " AND ".join(clauses)
        order: list[str] = []
        for name, desc in parse_sort(sort):
            col, _ = resolve(name)
            if info.row_count >= INDEX_FROM and not order:
                self._index(info, col)
            order.append(f"{col} IS NULL, {col} {'DESC' if desc else 'ASC'}")
        order.append("_row")
        picked = info.columns
        if columns:
            wanted = [find(name).name for name in columns]
            picked = [c for n in wanted for c in info.columns if c.name == n]
        stored = [c for c in picked if not c.reverse]
        select_cols = ", ".join(["_rid", *(quote(c.name) for c in stored)])
        limit = max(0, min(limit, MAX_LIMIT))
        total = self.conn.execute(
            f"SELECT count(*) FROM {table} WHERE {where_sql}", params
        ).fetchone()[0]
        rows = self.conn.execute(
            f"SELECT {select_cols} FROM {table} WHERE {where_sql} "
            f"ORDER BY {', '.join(order)} LIMIT ? OFFSET ?",
            [*params, limit, max(0, offset)],
        ).fetchall()
        raw = [{c.name: row[i + 1] for i, c in enumerate(stored)} for row in rows]
        rids = [row[0] for row in rows]
        derived: dict[str, Any] = {}
        for column in picked:
            if column.type != "relation":
                continue
            if column.reverse:
                derived[column.name] = self._reverse_cells(info, column, rids)
                continue
            wanted_ids = [
                link.id for values in raw for link in lnk.parse_links(values.get(column.name) or "")
            ]
            names = self.labels(column.target, wanted_ids) if column.target else None
            derived[column.name] = [self._forward_cell(v.get(column.name), names) for v in raw]

        def cell(n: int, column: sch.Column) -> Any:
            if column.type == "relation":
                if column.reverse:
                    return derived[column.name].get(rids[n], [])
                return derived[column.name][n]
            return sch.to_json(column.type, raw[n][column.name])

        return {
            **info.to_json(),
            "visible": [c.name for c in picked],
            "total": total,
            "offset": max(0, offset),
            "rows": [
                {"id": rid, "cells": [cell(n, c) for c in picked]} for n, rid in enumerate(rids)
            ],
        }

    def _index(self, info: TableInfo, column: str) -> None:
        name = quote(f"{info.sql_name}_ix_{sha256(column.encode())[:8]}")
        self.conn.execute(f"CREATE INDEX IF NOT EXISTS {name} ON {quote(info.sql_name)}({column})")
