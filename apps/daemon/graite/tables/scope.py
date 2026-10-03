"""Which tables and pages one read-only query may see, and the names SQL gives them (D72).

Charts and dashboards on a page read that page's tables, its subpages' tables, and every
table those link to through relations (followed transitively). An agent's `run_query_ro`
reads every table its scope allows. Either way a table is named by its name when it belongs
to the page asked about (`expenses`) and by its path otherwise (`"Projects/Atlas/expenses"`).
"""

from __future__ import annotations

import json
import sqlite3
from collections.abc import Callable
from typing import Any

from graite.tables.cache import TableInfo, TablesCache
from graite.tables.readonly import QueryPage, QueryTable
from graite.vault.properties import compact_values, parse_properties


def table_alias(page: str, info: TableInfo) -> str:
    """How SQL names a table from `page`: its name on that page, else `Page/Path/name`."""
    return info.name if info.page_path == page else f"{info.page_path}/{info.name}"


def sql_name(alias: str) -> str:
    return alias if alias.isidentifier() else '"' + alias.replace('"', '""') + '"'


def in_subtree(page: str, path: str) -> bool:
    return path == page or path.startswith(page + "/")


def page_tables(
    cache: TablesCache, page: str, db: sqlite3.Connection | None = None
) -> list[TableInfo]:
    """The tables of `page` and its subpages, plus every table they link to. With the index
    `db`, tables of those pages the cache has not imported yet are imported first."""
    if db is not None:
        cache.discover(
            [row[0] for row in db.execute("SELECT path FROM pages") if in_subtree(page, row[0])]
        )
    infos = {info.path: info for info in cache.tables()}
    wanted = [path for path, info in infos.items() if in_subtree(page, info.page_path)]
    seen = set(wanted)
    while wanted:
        info = infos.get(wanted.pop())
        for column in info.columns if info else []:
            if column.type == "relation" and column.target and column.target not in seen:
                seen.add(column.target)
                wanted.append(column.target)
    return [infos[path] for path in sorted(seen) if path in infos]


def query_tables(page: str, infos: list[TableInfo]) -> list[QueryTable]:
    return [
        QueryTable(
            table_alias(page, info),
            info.sql_name,
            [c.name for c in info.stored],
            path=info.path,
            relations={
                c.name: c.target
                for c in info.stored
                if c.type == "relation" and c.target is not None
            },
        )
        for info in infos
    ]


def query_pages(db: sqlite3.Connection, contains: Callable[[str], bool]) -> list[QueryPage]:
    """The indexed pages `contains` admits, with their properties, for `pages`/`page_props`."""
    out: list[QueryPage] = []
    for row in db.execute(
        "SELECT path, title, parent_path, created, updated, frontmatter_json FROM pages"
    ).fetchall():
        if not contains(row["path"]):
            continue
        meta: dict[str, Any] = json.loads(row["frontmatter_json"] or "{}")
        tags = meta.get("tags") if isinstance(meta.get("tags"), list) else []
        out.append(
            QueryPage(
                path=row["path"],
                title=row["title"],
                parent_path=row["parent_path"],
                created=row["created"],
                updated=row["updated"],
                tags="; ".join(str(t) for t in tags or []),
                props=list(compact_values(parse_properties(meta.get("properties")), 100).items()),
            )
        )
    return out
