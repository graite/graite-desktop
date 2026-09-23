from __future__ import annotations

from pathlib import Path

from graite.index import db


def test_connect_applies_schema_and_loads_vec(tmp_path: Path) -> None:
    conn = db.connect(tmp_path / ".graite" / "index.sqlite")
    try:
        assert conn.execute("PRAGMA journal_mode").fetchone()[0] == "wal"
        row = conn.execute("SELECT value FROM meta WHERE key='schema_version'").fetchone()
        assert row["value"] == db.SCHEMA_VERSION
        assert db.vec_version(conn).startswith("v")
    finally:
        conn.close()


def test_upgrade_preserves_conversations(tmp_path: Path) -> None:
    from graite.models.config import initialize

    path = tmp_path / "index.sqlite"
    conn = db.connect(path)
    initialize(conn, "token")
    conn.execute(
        "INSERT INTO conversations (id, page_id, title, updated_at) "
        "VALUES ('c','p','Saved conversation','now')"
    )
    conn.execute("UPDATE meta SET value='2' WHERE key='schema_version'")
    conn.close()
    upgraded = db.connect(path)
    assert upgraded.execute("SELECT title FROM conversations").fetchone()[0] == "Saved conversation"
    upgraded.close()


def test_unknown_schema_does_not_delete_data(tmp_path: Path) -> None:
    import pytest

    path = tmp_path / "index.sqlite"
    conn = db.connect(path)
    conn.execute("UPDATE meta SET value='future' WHERE key='schema_version'")
    conn.close()
    with pytest.raises(ValueError, match="Unsupported"):
        db.connect(path)
    assert path.exists()


def test_upgrade_adds_has_view_and_rescans_rows(tmp_path: Path) -> None:
    conn = db.connect(tmp_path / "index.db")
    conn.execute("ALTER TABLE pages DROP COLUMN has_view")
    conn.execute(
        "INSERT INTO pages (id, path, title, frontmatter_json, file_hash, mtime) "
        "VALUES ('i', 'P', 'P', '{}', 'h', 1.0)"
    )
    conn.close()
    conn = db.connect(tmp_path / "index.db")
    assert "has_view" in {row[1] for row in conn.execute("PRAGMA table_info(pages)")}
    assert conn.execute("SELECT mtime FROM pages").fetchone()[0] is None


def test_upgrade_adds_has_content_column(tmp_path: Path) -> None:
    conn = db.connect(tmp_path / "index.db")
    conn.execute("ALTER TABLE pages DROP COLUMN has_content")
    conn.execute("UPDATE meta SET value='3' WHERE key='schema_version'")
    conn.close()
    conn = db.connect(tmp_path / "index.db")
    assert "has_content" in {row[1] for row in conn.execute("PRAGMA table_info(pages)")}
    assert (
        conn.execute("SELECT value FROM meta WHERE key='schema_version'").fetchone()[0]
        == db.SCHEMA_VERSION
    )


def test_v4_conversations_become_nullable_and_keep_rows(tmp_path: Path) -> None:
    import sqlite3

    path = tmp_path / "index.sqlite"
    raw = sqlite3.connect(path)
    raw.executescript(
        """CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        INSERT INTO meta VALUES ('schema_version', '4');
        CREATE TABLE conversations (
          id TEXT PRIMARY KEY, page_id TEXT NOT NULL, title TEXT NOT NULL,
          messages_json TEXT NOT NULL DEFAULT '[]', updated_at TEXT NOT NULL);
        INSERT INTO conversations
          VALUES ('c', 'p', 'Saved', '[{"role":"user","content":"hi"}]', 'now');"""
    )
    raw.close()
    conn = db.connect(path)
    try:
        row = conn.execute("SELECT * FROM conversations").fetchone()
        assert row["title"] == "Saved" and row["page_id"] == "p" and row["mode"] == "ask"
        assert conn.execute("PRAGMA table_info(conversations)").fetchall()[1][3] == 0
        conn.execute(
            "INSERT INTO conversations (id, title, updated_at) VALUES ('v', 'Vault', 'now')"
        )
        assert conn.execute("SELECT page_id FROM conversations WHERE id='v'").fetchone()[0] is None
        assert (
            conn.execute("SELECT value FROM meta WHERE key='schema_version'").fetchone()[0]
            == db.SCHEMA_VERSION
        )
        assert (
            conn.execute("SELECT context_json FROM conversations WHERE id='c'").fetchone()[0]
            == "[]"
        )
    finally:
        conn.close()


def test_v5_conversations_gain_a_context_column(tmp_path: Path) -> None:
    import sqlite3

    path = tmp_path / "index.sqlite"
    raw = sqlite3.connect(path)
    raw.executescript(
        """CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        INSERT INTO meta VALUES ('schema_version', '5');
        CREATE TABLE conversations (
          id TEXT PRIMARY KEY, page_id TEXT, title TEXT NOT NULL,
          messages_json TEXT NOT NULL DEFAULT '[]',
          scope_json TEXT NOT NULL DEFAULT '{"kind":"vault","roots":[],"excluded":[]}',
          mode TEXT NOT NULL DEFAULT 'ask', created_at TEXT, updated_at TEXT NOT NULL);
        INSERT INTO conversations (id, title, updated_at) VALUES ('c', 'Saved', 'now');"""
    )
    raw.close()
    conn = db.connect(path)
    try:
        row = conn.execute("SELECT * FROM conversations").fetchone()
        assert row["title"] == "Saved" and row["context_json"] == "[]"
        assert (
            conn.execute("SELECT value FROM meta WHERE key='schema_version'").fetchone()[0]
            == db.SCHEMA_VERSION
        )
        assert "reason_delivered" in {r[1] for r in conn.execute("PRAGMA table_info(proposals)")}
    finally:
        conn.close()


def test_fresh_database_has_index_and_runtime_tables(tmp_path: Path) -> None:
    conn = db.connect(tmp_path / "index.sqlite")
    try:
        names = {r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        for table in (
            "chunks",
            "chunk_fts",
            "links",
            "jobs",
            "runs",
            "run_steps",
            "attachments",
            "proposals",
            "cron",
            "entities",
            "entity_mentions",
            "tokens",
        ):
            assert table in names, table
        assert "chunk_vec" not in names  # created by the embedder once the dimension is known
        columns = {row[1] for row in conn.execute("PRAGMA table_info(pages)")}
        assert {"body_hash", "indexed_at", "summary"} <= columns
    finally:
        conn.close()


def test_transactions_are_serialized_and_reentrant(tmp_path: Path) -> None:
    import threading

    conn = db.connect(tmp_path / "index.sqlite")
    try:
        conn.execute("CREATE TABLE counter (n INTEGER)")
        conn.execute("INSERT INTO counter VALUES (0)")

        def bump() -> None:
            for _ in range(50):
                with db.transaction(conn):
                    current = conn.execute("SELECT n FROM counter").fetchone()[0]
                    conn.execute("UPDATE counter SET n=?", (current + 1,))

        threads = [threading.Thread(target=bump) for _ in range(4)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        assert conn.execute("SELECT n FROM counter").fetchone()[0] == 200
        # A nested block must not commit the outer one early.
        with db.transaction(conn):
            conn.execute("UPDATE counter SET n=1000")
            with db.transaction(conn):
                conn.execute("UPDATE counter SET n=1001")
            assert conn.in_transaction
        assert conn.execute("SELECT n FROM counter").fetchone()[0] == 1001
    finally:
        conn.close()
