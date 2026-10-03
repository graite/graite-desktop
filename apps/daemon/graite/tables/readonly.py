"""`run_query_ro`: one read-only SQL query over the tables and pages an agent may see (D69).

The query runs on its own `mode=ro` connection to `.graite/tables.sqlite`. Before it runs, the
connection gets a TEMP VIEW per table in scope, named for the model (`expenses`, or
`"Projects/Atlas/expenses"` for another page's table), and TEMP tables `pages` and
`page_props` holding only the pages in scope, and a view `links(table, column, row_id,
target_table, target_id)` with every relation link between tables in scope (D72). Then an
authorizer allows nothing but reads, a progress handler stops runaway queries, and at most
`max_rows` rows come back.
"""

from __future__ import annotations

import sqlite3
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from graite.tables.cache import quote

MAX_ROWS = 200
TIMEOUT_S = 2.0
_ALLOWED = {
    sqlite3.SQLITE_SELECT,
    sqlite3.SQLITE_READ,
    sqlite3.SQLITE_FUNCTION,
    sqlite3.SQLITE_RECURSIVE,
}


@dataclass
class QueryTable:
    alias: str  # the name the model writes in SQL
    sql_name: str  # the cache table (t_<hash>)
    columns: list[str]
    path: str = ""  # the table's vault path, for `links`
    # Relation column -> the vault path of the table it links to.
    relations: dict[str, str] = field(default_factory=dict)


@dataclass
class QueryPage:
    path: str
    title: str
    parent_path: str | None = None
    created: str | None = None
    updated: str | None = None
    tags: str = ""
    props: list[tuple[str, Any]] = field(default_factory=list)


def _plain(value: Any) -> Any:
    if isinstance(value, list):
        return "; ".join(str(v) for v in value)
    if isinstance(value, bool):
        return int(value)
    if value is None or isinstance(value, int | float | str):
        return value
    return str(value)


def _links_view(conn: sqlite3.Connection, tables: list[QueryTable]) -> None:
    """`links`: the relation links whose both ends are in scope, named like the tables."""
    if any(t.alias.lower() == "links" for t in tables):
        return  # a table of that name wins; its page can still join through its own columns
    has_links = conn.execute(
        "SELECT 1 FROM main.sqlite_master WHERE type='table' AND name='_links'"
    ).fetchone()
    conn.execute("CREATE TEMP TABLE _scope (path TEXT PRIMARY KEY, alias TEXT)")
    conn.execute("CREATE TEMP TABLE _relations (path TEXT, column TEXT, target TEXT)")
    conn.executemany(
        "INSERT OR IGNORE INTO temp._scope VALUES (?, ?)",
        [(t.path, t.alias) for t in tables if t.path],
    )
    conn.executemany(
        "INSERT INTO temp._relations VALUES (?, ?, ?)",
        [(t.path, column, target) for t in tables for column, target in t.relations.items()],
    )
    source = (
        "main._links"
        if has_links
        else (
            "(SELECT NULL AS src_path, NULL AS column, NULL AS src_rid, NULL AS pos, "
            "NULL AS dst_rid WHERE 0)"
        )
    )
    conn.execute(
        'CREATE TEMP VIEW links AS SELECT s.alias AS "table", l.column AS column, '
        "l.src_rid AS row_id, t.alias AS target_table, l.dst_rid AS target_id "
        f"FROM {source} l JOIN temp._scope s ON s.path = l.src_path "
        "JOIN temp._relations r ON r.path = l.src_path AND r.column = l.column "
        "JOIN temp._scope t ON t.path = r.target ORDER BY s.alias, l.src_rid, l.pos"
    )


def run_query(
    db_path: Path,
    tables: list[QueryTable],
    pages: list[QueryPage],
    sql: str,
    *,
    params: list[Any] | None = None,
    max_rows: int = MAX_ROWS,
    timeout_s: float = TIMEOUT_S,
) -> dict[str, Any]:
    if not sql.strip():
        raise ValueError("Write one SELECT statement.")
    conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True, check_same_thread=False)
    try:
        for table in tables:
            columns = ", ".join(quote(c) for c in table.columns) or "NULL AS empty"
            conn.execute(
                f"CREATE TEMP VIEW {quote(table.alias)} AS "
                f"SELECT {columns} FROM main.{quote(table.sql_name)} ORDER BY _row"
            )
        conn.execute(
            "CREATE TEMP TABLE pages (path TEXT PRIMARY KEY, title TEXT, parent_path TEXT, "
            "created TEXT, updated TEXT, tags TEXT)"
        )
        conn.execute("CREATE TEMP TABLE page_props (path TEXT, name TEXT, value)")
        _links_view(conn, tables)
        conn.executemany(
            "INSERT INTO temp.pages VALUES (?, ?, ?, ?, ?, ?)",
            [(p.path, p.title, p.parent_path, p.created, p.updated, p.tags) for p in pages],
        )
        conn.executemany(
            "INSERT INTO temp.page_props VALUES (?, ?, ?)",
            [(p.path, name, _plain(value)) for p in pages for name, value in p.props],
        )
        conn.set_authorizer(
            lambda code, *_: sqlite3.SQLITE_OK if code in _ALLOWED else sqlite3.SQLITE_DENY
        )
        deadline = time.monotonic() + timeout_s
        conn.set_progress_handler(lambda: int(time.monotonic() > deadline), 10_000)
        try:
            cursor = conn.execute(sql, params or [])
            rows = cursor.fetchmany(max_rows + 1)
        except sqlite3.OperationalError as exc:
            if "interrupted" in str(exc):
                raise ValueError(
                    f"The query took longer than {timeout_s:g}s; narrow it down."
                ) from exc
            raise ValueError(f"SQL error: {exc}") from exc
        except sqlite3.DatabaseError as exc:
            raise ValueError(
                f"Only reading is allowed ({exc}). Write one SELECT statement."
            ) from exc
        except sqlite3.ProgrammingError as exc:
            raise ValueError(f"{exc} Write one SELECT statement.") from exc
        if cursor.description is None:
            raise ValueError("Write one SELECT statement.")
        return {
            "columns": [d[0] for d in cursor.description],
            "rows": [list(r) for r in rows[:max_rows]],
            "truncated": len(rows) > max_rows,
        }
    finally:
        conn.close()
