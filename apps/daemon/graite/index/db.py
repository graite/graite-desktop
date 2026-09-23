"""SQLite index: WAL, busy timeout, sqlite-vec loaded, schema applied.

Page indexes are derived; conversations, runs and configuration are durable. Schema upgrades
are additive. Unknown versions fail closed rather than deleting user history.
"""

from __future__ import annotations

import sqlite3
import threading
from collections.abc import Iterable, Iterator, Sequence
from contextlib import contextmanager
from pathlib import Path
from typing import Any, cast

import sqlite_vec

_LOCKS: dict[int, threading.RLock] = {}


class EagerCursor:
    """Rows fetched while the connection lock is held, so no thread steps a statement
    while another thread executes on the same connection."""

    def __init__(self, cursor: sqlite3.Cursor) -> None:
        self.rows: list[Any] = cursor.fetchall() if cursor.description else []
        self.lastrowid = cursor.lastrowid
        self.rowcount = cursor.rowcount
        self.description = cursor.description
        self._index = 0
        cursor.close()

    def fetchone(self) -> Any:
        if self._index >= len(self.rows):
            return None
        row = self.rows[self._index]
        self._index += 1
        return row

    def fetchall(self) -> list[Any]:
        rows = self.rows[self._index :]
        self._index = len(self.rows)
        return rows

    def fetchmany(self, size: int = 1) -> list[Any]:
        rows = self.rows[self._index : self._index + size]
        self._index += len(rows)
        return rows

    def __iter__(self) -> Iterator[Any]:
        while self._index < len(self.rows):
            yield self.fetchone()

    def close(self) -> None:
        self._index = len(self.rows)


class SafeConnection:
    """One shared sqlite3 connection, serialized across the event loop and worker threads."""

    def __init__(self, conn: sqlite3.Connection) -> None:
        self._conn = conn
        self.lock = threading.RLock()

    @property
    def raw(self) -> sqlite3.Connection:
        return self._conn

    def execute(self, sql: str, parameters: Sequence[Any] | dict[str, Any] = ()) -> EagerCursor:
        with self.lock:
            return EagerCursor(self._conn.execute(sql, parameters))

    def executemany(self, sql: str, parameters: Iterable[Any]) -> EagerCursor:
        with self.lock:
            return EagerCursor(self._conn.executemany(sql, parameters))

    def executescript(self, script: str) -> EagerCursor:
        with self.lock:
            return EagerCursor(self._conn.executescript(script))

    def commit(self) -> None:
        with self.lock:
            self._conn.commit()

    def rollback(self) -> None:
        with self.lock:
            self._conn.rollback()

    def close(self) -> None:
        with self.lock:
            self._conn.close()

    @property
    def in_transaction(self) -> bool:
        return self._conn.in_transaction

    @property
    def row_factory(self) -> Any:
        return self._conn.row_factory

    @row_factory.setter
    def row_factory(self, value: Any) -> None:
        self._conn.row_factory = value

    def __getattr__(self, name: str) -> Any:
        return getattr(self._conn, name)


def _lock_for(conn: Any) -> threading.RLock:
    lock = getattr(conn, "lock", None)
    if isinstance(lock, type(threading.RLock())):
        return lock
    return _LOCKS.setdefault(id(conn), threading.RLock())


@contextmanager
def transaction(conn: sqlite3.Connection) -> Iterator[None]:
    """`BEGIN IMMEDIATE` … `COMMIT` under the connection lock, so a transaction started
    on one thread cannot interleave with statements from another.

    Re-entrant: a nested block joins the outer transaction instead of committing it early.
    """
    with _lock_for(conn):
        if conn.in_transaction:
            yield  # the outer block owns the commit
            return
        conn.execute("BEGIN IMMEDIATE")
        try:
            yield
        except BaseException:
            conn.execute("ROLLBACK")
            raise
        conn.execute("COMMIT")


SCHEMA_PATH = Path(__file__).with_name("schema.sql")
SCHEMA_VERSION = "8"
KNOWN_VERSIONS = (None, "2", "3", "4", "5", "6", "7", SCHEMA_VERSION)

PROPOSAL_COLUMNS = {
    "page_title": "TEXT",
    "new_path": "TEXT",
    "snapshot": "TEXT",
    "trash_id": "TEXT",
    "applied_hash": "TEXT",
    "edited": "INTEGER NOT NULL DEFAULT 0",
    "reason_delivered": "INTEGER NOT NULL DEFAULT 0",
    "base_body_hash": "TEXT",
    "opt_in_source": "TEXT",
    "properties_json": "TEXT",
    "base_properties_json": "TEXT",
    "parent_proposal_id": "TEXT",
}

PAGE_COLUMNS = {
    "has_content": "INTEGER NOT NULL DEFAULT 0",
    "has_view": "INTEGER NOT NULL DEFAULT 0",
    "body_hash": "TEXT",
    "indexed_at": "TEXT",
    "index_error": "TEXT",
    "summary": "TEXT",
    "summary_hash": "TEXT",
}


def _open(db_path: Path) -> sqlite3.Connection:
    conn = sqlite3.connect(db_path, check_same_thread=False, isolation_level=None)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA busy_timeout=5000")
    conn.execute("PRAGMA foreign_keys=ON")
    conn.enable_load_extension(True)
    sqlite_vec.load(conn)
    conn.enable_load_extension(False)
    return conn


def _stored_version(conn: sqlite3.Connection) -> str | None:
    has_meta = conn.execute(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='meta'"
    ).fetchone()
    if not has_meta:
        return None
    row = conn.execute("SELECT value FROM meta WHERE key='schema_version'").fetchone()
    return str(row[0]) if row else None


def _columns(conn: sqlite3.Connection, table: str) -> dict[str, sqlite3.Row]:
    return {row[1]: row for row in conn.execute(f"PRAGMA table_info({table})")}


def _rebuild_conversations(conn: sqlite3.Connection) -> None:
    """v4 -> v5: `page_id` becomes nullable so vault-wide conversations can exist."""
    with transaction(conn):
        conn.execute("ALTER TABLE conversations RENAME TO conversations_v4")
        conn.execute("DROP INDEX IF EXISTS ix_conversations_page")
        conn.execute(
            """CREATE TABLE conversations (
              id TEXT PRIMARY KEY, page_id TEXT, title TEXT NOT NULL,
              messages_json TEXT NOT NULL DEFAULT '[]',
              scope_json TEXT NOT NULL DEFAULT '{"kind":"vault","roots":[],"excluded":[]}',
              mode TEXT NOT NULL DEFAULT 'ask', created_at TEXT, updated_at TEXT NOT NULL)"""
        )
        conn.execute(
            """INSERT INTO conversations (id, page_id, title, messages_json, scope_json, mode,
               created_at, updated_at)
               SELECT id, page_id, title, messages_json, '{"kind":"folder"}', 'ask',
               updated_at, updated_at FROM conversations_v4"""
        )
        conn.execute("DROP TABLE conversations_v4")
        conn.execute(
            "CREATE INDEX IF NOT EXISTS ix_conversations_page ON conversations(page_id, updated_at)"
        )


def migrate(conn: sqlite3.Connection) -> None:
    stored = _stored_version(conn)
    if stored not in KNOWN_VERSIONS:
        raise ValueError(
            f"Unsupported vault index schema {stored}. Back up .graite before migrating it."
        )
    # The conversations table predates schema.sql; rebuild it before the script would
    # skip it with CREATE TABLE IF NOT EXISTS.
    existing = _columns(conn, "conversations")
    if existing and existing["page_id"][3]:  # notnull
        _rebuild_conversations(conn)
    conn.executescript(SCHEMA_PATH.read_text())
    # Additive migrations: CREATE TABLE IF NOT EXISTS does not add columns to existing tables.
    columns = _columns(conn, "pages")
    for name, definition in PAGE_COLUMNS.items():
        if name not in columns:
            conn.execute(f"ALTER TABLE pages ADD COLUMN {name} {definition}")
    if "has_view" not in columns:
        # Existing rows need the flag computed: clearing mtime makes the next scan re-read
        # them, and an unchanged body_hash keeps their chunks and embeddings.
        conn.execute("UPDATE pages SET mtime=NULL")
    columns = _columns(conn, "conversations")
    for name, definition in (
        ("scope_json", 'TEXT NOT NULL DEFAULT \'{"kind":"vault","roots":[],"excluded":[]}\''),
        ("mode", "TEXT NOT NULL DEFAULT 'ask'"),
        ("created_at", "TEXT"),
        ("context_json", "TEXT NOT NULL DEFAULT '[]'"),
        ("kind", "TEXT NOT NULL DEFAULT 'chat'"),
    ):
        if name not in columns:
            conn.execute(f"ALTER TABLE conversations ADD COLUMN {name} {definition}")
    columns = _columns(conn, "proposals")
    for name, definition in PROPOSAL_COLUMNS.items():
        if name not in columns:
            conn.execute(f"ALTER TABLE proposals ADD COLUMN {name} {definition}")
    conn.execute(
        "INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', ?)", (SCHEMA_VERSION,)
    )


def connect(db_path: Path) -> sqlite3.Connection:
    db_path.parent.mkdir(parents=True, exist_ok=True)
    conn = cast(sqlite3.Connection, SafeConnection(_open(db_path)))
    try:
        migrate(conn)
    except Exception:
        conn.close()
        raise
    return conn


def vec_version(conn: sqlite3.Connection) -> str:
    row = conn.execute("SELECT vec_version()").fetchone()
    return str(row[0])
