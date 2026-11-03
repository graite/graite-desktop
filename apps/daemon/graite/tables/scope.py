"""Which tables and pages one read-only query may see, and the names SQL gives them (D72).

Charts and dashboards on a page read that page's tables, its subpages' tables, and every
table those link to through relations (followed transitively). An agent's `run_query_ro`
reads every table its scope allows. Either way a table is named by its name when it belongs
to the page asked about (`expenses`) and by its path otherwise (`"Projects/Atlas/expenses"`).
"""

from __future__ import annotations

import json
import re
import sqlite3
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import yaml

from graite.tables.cache import TableInfo, TablesCache
from graite.tables.readonly import QueryPage, QueryTable
from graite.vault.paths import VaultPathError, page_file
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
    seen = related(
        infos, [path for path, info in infos.items() if in_subtree(page, info.page_path)]
    )
    return [infos[path] for path in sorted(seen) if path in infos]


def query_tables(
    page: str, infos: list[TableInfo], near: set[str] | None = None
) -> list[QueryTable]:
    names = aliases(page, infos, near)
    return [
        QueryTable(
            names[info.path],
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
                tags="|".join(str(t) for t in tags or []),
                props=list(compact_values(parse_properties(meta.get("properties")), 100).items()),
            )
        )
    return out


# ----------------------------------------------------------------------------- shown tables
# A page shows a table with a `graite:table` fence or an `![[name.csv]]` embed. Since the
# templates (D81) a table usually lives on a root page and its subpages only show views of
# it, so "the tables of a page" for an AI means the ones it shows, not only its `_data/`.

_FENCE = re.compile(r"^```graite:table[^\n]*\n(.*?)^```", re.MULTILINE | re.DOTALL)
_EMBED = re.compile(r"^[ \t]*!\[\[([^\]|#]+\.csv)\]\][ \t]*$", re.MULTILINE | re.IGNORECASE)
VIEW_FIELDS = ("view", "filter", "sort", "columns", "group")
# (page, file hash) -> [(source as written, view or None)]; page files change rarely.
_SOURCES: dict[tuple[str, str, str], list[tuple[str, dict[str, Any] | None]]] = {}


@dataclass
class Shown:
    """A table a page shows, with the named views it shows it in."""

    path: str
    views: list[dict[str, Any]] = field(default_factory=list)


def fence_sources(text: str) -> list[tuple[str, dict[str, Any] | None]]:
    """Every (source, view) a page body shows; view is None for a plain embed."""
    out: list[tuple[str, dict[str, Any] | None]] = []
    for body in _FENCE.findall(text):
        try:
            value = yaml.safe_load(body)
        except yaml.YAMLError:
            continue
        if not isinstance(value, dict):
            continue
        top = value.get("source") if isinstance(value.get("source"), str) else None
        views = value.get("views")
        if isinstance(views, list) and views:
            for item in views:
                if not isinstance(item, dict):
                    continue
                source = item.get("source") if isinstance(item.get("source"), str) else top
                if source:
                    view = {k: item[k] for k in VIEW_FIELDS if item.get(k) not in (None, "")}
                    out.append((source, {"name": str(item.get("name") or source), **view}))
        elif top:
            view = {k: value[k] for k in VIEW_FIELDS if value.get(k) not in (None, "")}
            out.append((top, {"name": "Default", **view}))
        tabs = value.get("tabs")
        if isinstance(tabs, dict):
            for source, tab in tabs.items():
                tab = tab if isinstance(tab, dict) else {}
                view = {k: tab[k] for k in VIEW_FIELDS if tab.get(k) not in (None, "")}
                out.append((str(source), {"name": str(source), **view}))
    out.extend((name, None) for name in _EMBED.findall(text))
    return out


def _page_sources(
    vault: Path, page: str, file_hash: str | None
) -> list[tuple[str, dict[str, Any] | None]]:
    key = (str(vault), page, file_hash or "")
    if file_hash and key in _SOURCES:
        return _SOURCES[key]
    try:
        text = page_file(vault, page).read_text(encoding="utf-8")
    except (OSError, ValueError):
        return []
    found = fence_sources(text) if "graite:table" in text or ".csv]]" in text else []
    if file_hash:
        if len(_SOURCES) > 5000:
            _SOURCES.clear()
        _SOURCES[key] = found
    return found


def shown_tables(
    cache: TablesCache, vault: Path, page: str, file_hash: str | None = None
) -> list[Shown]:
    """The tables `page` shows, resolved as the editor resolves them, in page order."""
    out: dict[str, Shown] = {}
    for source, view in _page_sources(vault, page, file_hash):
        try:
            rel = cache.resolve(page, source)
        except (VaultPathError, FileNotFoundError, ValueError):
            continue
        shown = out.setdefault(rel, Shown(rel))
        if view is not None and not any(v["name"] == view["name"] for v in shown.views):
            shown.views.append(view)
    return list(out.values())


def related(infos: dict[str, TableInfo], start: list[str]) -> set[str]:
    """`start` and every table their relations reach, transitively."""
    seen = set(start)
    wanted = list(start)
    while wanted:
        info = infos.get(wanted.pop())
        for column in info.columns if info else []:
            if column.type == "relation" and column.target and column.target not in seen:
                seen.add(column.target)
                wanted.append(column.target)
    return seen


def aliases(page: str, infos: list[TableInfo], near: set[str] | None = None) -> dict[str, str]:
    """SQL names from `page`: its own tables and the `near` ones (tables it shows and their
    relations) by name when that is unambiguous, every other table by `Page/Path/name`."""
    out = {info.path: table_alias(page, info) for info in infos}
    taken = {out[i.path].lower() for i in infos if i.page_path == page}
    counts: dict[str, int] = {}
    for info in infos:
        if near and info.path in near and info.page_path != page:
            counts[info.name.lower()] = counts.get(info.name.lower(), 0) + 1
    for info in infos:
        name = info.name.lower()
        if near and info.path in near and info.page_path != page:
            if name not in taken and counts.get(name) == 1:
                out[info.path] = info.name
    return out


@dataclass
class CatalogEntry:
    path: str
    name: str
    page: str  # the page whose _data/ holds it
    rows: int
    columns: list[str]
    shown_on: list[str]
    views: list[str]
    options: list[str] = field(default_factory=list)  # select and status values

    def line(self) -> str:
        where = ", ".join(self.shown_on[:3]) or self.page
        cols = ", ".join(self.columns[:8]) + (", …" if len(self.columns) > 8 else "")
        return f"- {self.name} ({self.rows} rows) on {where}: {cols}"


def data_catalog(
    cache: TablesCache,
    pages: list[tuple[str, str | None]],
    vault: Path,
    contains: Callable[[str], bool],
) -> list[CatalogEntry]:
    """Every table in scope, with the in-scope pages that show it and their view names.
    `pages` are the indexed (path, file hash) pairs."""
    cache.discover([p for p, _ in pages if contains(p)])
    infos = {info.path: info for info in cache.tables() if contains(info.page_path)}
    shown: dict[str, list[str]] = {path: [] for path in infos}
    views: dict[str, list[str]] = {path: [] for path in infos}
    for page, file_hash in pages:
        if not contains(page):
            continue
        for item in shown_tables(cache, vault, page, file_hash):
            if item.path not in infos:
                continue
            if page not in shown[item.path]:
                shown[item.path].append(page)
            views[item.path] += [v["name"] for v in item.views if v["name"] not in views[item.path]]
    return [
        CatalogEntry(
            path=info.path,
            name=info.name,
            page=info.page_path,
            rows=info.row_count,
            columns=[c.name for c in info.columns],
            shown_on=sorted(shown[info.path], key=lambda p: (p == info.page_path, len(p), p)),
            views=views[info.path],
            options=[
                str(o)
                for c in info.columns
                if c.type in ("select", "status", "multi_select")
                for o in c.options
            ][:60],
        )
        for info in infos.values()
    ]
