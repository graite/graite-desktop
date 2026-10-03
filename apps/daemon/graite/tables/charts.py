"""`graite:chart` (D72): a compact chart spec, checked like the other fences and compiled to
read-only SQL over the tables a page may read (`tables/scope.py`).

    source: _data/expenses.csv   type: bar   x: month(date)   y: sum(amount)   series: status

`x` and `series` are a column, a date bucket (`day|week|month|quarter|year(col)`), a relation
column (its rows' names) or a relation path `relation.column`, followed in either direction
(a reverse column works too). `y` is `count`, `count(col)` or `sum|avg|min|max(col)`; a list
draws one series per entry. `sql:` replaces all of that: the first result column is the
category, every other column a series. Every name is checked against the table and every
value is a bound parameter, so nothing in a spec reaches SQL as text.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any

from graite.tables import schema as sch
from graite.tables.cache import TableInfo, TablesCache, quote
from graite.tables.query import QueryError, compile_filter
from graite.tables.readonly import run_query
from graite.tables.scope import page_tables, query_pages, query_tables, table_alias

TYPES = ("bar", "line", "area", "pie", "donut", "scatter", "number")
KEYS = (
    "title",
    "source",
    "sql",
    "type",
    "x",
    "y",
    "series",
    "filter",
    "sort",
    "limit",
    "stacked",
    "height",
    "palette",
)
PALETTES = ("vivid", "ocean", "sunset", "forest", "candy", "mono")
AGGREGATES = ("count", "sum", "avg", "min", "max")
BUCKETS = ("day", "week", "month", "quarter", "year")
MAX_CATEGORIES = 500
MAX_SERIES = 24
SQL_ROWS = 5000
_Y = re.compile(r"^\s*(count|sum|avg|min|max)\s*\(\s*(.+?)\s*\)\s*$", re.IGNORECASE)
_COUNT = re.compile(r"^\s*count\s*(?:\(\s*\))?\s*$", re.IGNORECASE)


def y_problem(y: str) -> str | None:
    """Why `y` is not a value to chart: count, agg(col), or a plain number column (D72)."""
    if _COUNT.match(y) or _Y.match(y):
        return None
    if "(" not in y and ")" not in y and y.strip():
        return None  # a column: its values, summed per label
    agg = re.match(r"^\s*(sum|avg|min|max)\s*\(\s*\)\s*$", y, re.IGNORECASE)
    if agg:
        return f"y: {agg.group(1)}() needs a number column, e.g. {agg.group(1)}(amount)."
    return f"y: {y!r} is not a number column, count, or sum|avg|min|max|count(column)."


_BUCKET = re.compile(r"^\s*(day|week|month|quarter|year)\s*\(\s*(.+?)\s*\)\s*$", re.IGNORECASE)
_SORT = re.compile(r"^\s*(x|y)\s+(asc|desc)\s*$", re.IGNORECASE)


class ChartError(ValueError):
    """The spec cannot be drawn; the message says why, in words a person or a model can fix."""


def _names(value: Any) -> list[str] | None:
    if isinstance(value, str) and value.strip():
        return [value]
    if isinstance(value, list) and value and all(isinstance(v, str) and v.strip() for v in value):
        return list(value)
    return None


def check_chart(value: dict[str, Any]) -> str | None:
    """Why a `graite:chart` fence body is not a chart, or None. Mirrors md-convert."""
    unknown = [k for k in value if k not in KEYS]
    if unknown:
        return f"{unknown[0]!r} is not a key of a graite:chart fence. Use {', '.join(KEYS)}."
    kind = value.get("type", "bar")
    if kind not in TYPES:
        return f"type: must be one of {', '.join(TYPES)}. Got {kind!r}."
    source, sql = value.get("source"), value.get("sql")
    if source is not None and sql is not None:
        return "A graite:chart fence takes source: (a table) or sql: (a SELECT), not both."
    if source is None and sql is None:
        # A chart still being set up in the editor: only its look may be set yet.
        extra = [k for k in value if k not in ("title", "type", "height", "palette")]
        if extra:
            return f"{extra[0]}: needs source: (the table to chart) or sql: (a SELECT)."
    if source is not None and (not isinstance(source, str) or not source.strip()):
        return "source: must be the table, e.g. _data/expenses.csv."
    if sql is not None:
        if not isinstance(sql, str) or not sql.strip():
            return "sql: must be one SELECT statement."
        extra = [k for k in ("x", "y", "series", "filter") if k in value]
        if extra:
            return f"{extra[0]}: does not go with sql:; the query's columns are the chart."
    elif source is not None:
        if kind != "number" and not (isinstance(value.get("x"), str) and value["x"].strip()):
            return "x: must name the column along the axis (or the slices of a pie)."
        ys = _names(value.get("y", "count"))
        if ys is None:
            return "y: must be a number column, count, sum(column) and the like, or a list."
        for y in ys:
            problem = None if kind == "scatter" else y_problem(y)
            if problem:
                return problem
        if "series" in value and not (isinstance(value["series"], str) and value["series"].strip()):
            return "series: must name one column to split by."
        if "series" in value and len(ys) > 1:
            return "Use series: or several y: values, not both."
        if "filter" in value and not isinstance(value["filter"], str):
            return 'filter: must be text, e.g. category = "Travel".'
        if isinstance(value.get("filter"), str):
            try:
                compile_filter(value["filter"], lambda name: ('"x"', "text"))
            except QueryError as exc:
                return f"The filter cannot be read: {exc}"
    if "sort" in value and not (isinstance(value["sort"], str) and _SORT.match(value["sort"])):
        return "sort: must be x asc, x desc, y asc or y desc."
    limit = value.get("limit")
    if limit is not None and (
        not isinstance(limit, int) or isinstance(limit, bool) or not 1 <= limit <= MAX_CATEGORIES
    ):
        return f"limit: must be a whole number from 1 to {MAX_CATEGORIES}."
    if "stacked" in value and not isinstance(value["stacked"], bool):
        return "stacked: must be true or false."
    height = value.get("height")
    if height is not None and (
        not isinstance(height, int) or isinstance(height, bool) or not 120 <= height <= 2000
    ):
        return "height: must be a whole number of pixels between 120 and 2000."
    if "title" in value and not isinstance(value["title"], str):
        return "title: must be text."
    if "palette" in value and value["palette"] not in PALETTES:
        return f"palette: must be one of {', '.join(PALETTES)}."
    return None


@dataclass
class _Builder:
    """Joins and expressions over one source table, named `s` in the query."""

    cache: TablesCache
    page: str
    source: TableInfo
    scope: dict[str, TableInfo]
    joins: list[str] = field(default_factory=list)
    params: list[Any] = field(default_factory=list)
    tables: set[str] = field(default_factory=set)
    _joined: dict[str, str] = field(default_factory=dict)

    def alias(self, info: TableInfo) -> str:
        return quote(table_alias(self.page, info))

    def column(self, info: TableInfo, name: str) -> sch.Column:
        found = next((c for c in info.columns if c.name == name), None) or next(
            (c for c in info.columns if c.name.lower() == name.lower()), None
        )
        if found is None:
            names = ", ".join(c.name for c in info.columns)
            raise ChartError(f"{info.name} has no column {name!r}. Its columns: {names}.")
        return found

    def related(self, relation: sch.Column) -> tuple[str, TableInfo]:
        """Join the rows `relation` links to (either direction); returns their SQL alias."""
        target = relation.target and self.scope.get(relation.target)
        if not target:
            raise ChartError(
                f"{relation.name!r} links to a table this page cannot read "
                "(only its own, its subpages' and the tables they link to)."
            )
        key = relation.name.lower()
        if key not in self._joined:
            n = len(self._joined) + 1
            link, other = f"l{n}", f"r{n}"
            pk = quote(self.source.primary_key)
            if relation.reverse:
                # The links are stored on the other table: its rows point at ours.
                self.joins.append(
                    f'LEFT JOIN links {link} ON {link}."table" = ? AND {link}.column = ? '
                    f"AND {link}.target_id = s.{pk}"
                )
                self.params += [table_alias(self.page, target), relation.reverse]
                other_key = f"{link}.row_id"
            else:
                self.joins.append(
                    f'LEFT JOIN links {link} ON {link}."table" = ? AND {link}.column = ? '
                    f"AND {link}.row_id = s.{pk}"
                )
                self.params += [table_alias(self.page, self.source), relation.name]
                other_key = f"{link}.target_id"
            self.joins.append(
                f"LEFT JOIN {self.alias(target)} {other} "
                f"ON {other}.{quote(target.primary_key)} = {other_key}"
            )
            self._joined[key] = other
            self.tables.add(target.path)
        return self._joined[key], target

    def expr(self, text: str) -> tuple[str, str]:
        """SQL for an x or series value, and the type it reads as (the column it reads is
        kept in `last`, for formatting values)."""
        self.last: sch.Column | None = None
        bucket = _BUCKET.match(text)
        if bucket:
            sql, kind = self.expr(bucket.group(2))
            if kind != "date":
                raise ChartError(
                    f"{bucket.group(1)}() needs a date column; {bucket.group(2)!r} is {kind}."
                )
            part = bucket.group(1).lower()
            return {
                "day": f"substr({sql}, 1, 10)",
                "week": f"strftime('%Y-W%W', substr({sql}, 1, 10))",
                "month": f"substr({sql}, 1, 7)",
                "quarter": f"substr({sql}, 1, 4) || '-Q' || "
                f"((CAST(substr({sql}, 6, 2) AS INTEGER) + 2) / 3)",
                "year": f"substr({sql}, 1, 4)",
            }[part], "bucket"
        name = text.strip()
        if "." in name and not any(c.name == name for c in self.source.columns):
            first, rest = name.split(".", 1)
            relation = self.column(self.source, first)
            if relation.type != "relation":
                raise ChartError(f"{first!r} is not a relation, so {name!r} cannot follow it.")
            other, target = self.related(relation)
            column = self.column(target, rest)
            if column.type == "relation":
                raise ChartError(f"Follow one relation at a time; {rest!r} is another relation.")
            self.last = column
            return f"{other}.{quote(column.name)}", column.type
        column = self.column(self.source, name)
        if column.type == "relation":
            other, target = self.related(column)
            label = target.label_column
            if not label:
                raise ChartError(f"{target.name} has no field that names its rows.")
            return f"{other}.{quote(label)}", "text"
        self.last = column
        return f"s.{quote(column.name)}", column.type

    def measure(self, text: str) -> tuple[str, str, str]:
        """SQL for one y value, its label, and how its values read (`number`,
        `currency:EUR`, `percent`)."""
        if _COUNT.match(text):
            return "count(*)", "Count", "number"
        problem = y_problem(text)
        if problem:
            raise ChartError(problem)
        match = _Y.match(text)
        agg, arg = (match.group(1).lower(), match.group(2).strip()) if match else ("", text.strip())
        sql, kind = self.expr(arg)
        if agg == "count":
            return f"count({sql})", f"Count of {arg}", "number"
        if agg in ("", "sum", "avg") and kind not in sch.NUMERIC:
            raise ChartError(
                f"{arg!r} is {kind}, not a number field; charts add up number fields "
                "(or count rows)."
            )
        column = self.last
        fmt = (
            f"currency:{column.currency or 'EUR'}"
            if column is not None and column.type == "currency"
            else "percent"
            if column is not None and column.type == "percent"
            else "number"
        )
        if not agg:
            # A plain column: its values, added up per label (the value itself when each
            # label is one row).
            return f"sum({sql})", arg, fmt
        word = {"sum": "Total", "avg": "Average", "min": "Minimum", "max": "Maximum"}[agg]
        return f"{agg}({sql})", f"{word} {arg}", fmt


def _label(value: Any) -> str:
    if value is None or value == "":
        return "(empty)"
    if isinstance(value, float) and value.is_integer():
        return str(int(value))
    return str(value)


def _number(value: Any) -> float | int | None:
    if value is None:
        return None
    if isinstance(value, bool):
        return int(value)
    if isinstance(value, int | float):
        return value
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def chart_data(cache: TablesCache, db: Any, page: str, spec: dict[str, Any]) -> dict[str, Any]:
    """The data a chart on `page` draws: `{categories, series: [{name, data}], tables}` (or
    `{value}` for a number), from the tables `page` may read."""
    problem = check_chart(spec)
    if problem:
        raise ChartError(problem)
    if spec.get("source") is None and spec.get("sql") is None:
        raise ChartError("Choose the table to chart (source:) or write a query (sql:).")
    infos = page_tables(cache, page, db)
    scope = {info.path: info for info in infos}
    tables = query_tables(page, infos)
    pages = query_pages(db, lambda path: path == page or path.startswith(page + "/"))
    kind = spec.get("type", "bar")
    if spec.get("sql") is not None:
        result = run_query(cache.db_path, tables, pages, str(spec["sql"]), max_rows=SQL_ROWS)
        columns, rows = result["columns"], result["rows"]
        if kind == "number":
            return {
                "value": _number(rows[0][0]) if rows and rows[0] else None,
                "tables": sorted(scope),
            }
        if len(columns) < 2:
            raise ChartError("The query needs a category column and at least one value column.")
        return {
            "categories": [_label(r[0]) for r in rows],
            "series": [
                {"name": name, "data": [_number(r[i]) for r in rows], "format": "number"}
                for i, name in enumerate(columns[1:], start=1)
            ][:MAX_SERIES],
            "truncated": result["truncated"],
            "tables": sorted(scope),
        }
    try:
        path = cache.resolve(page, str(spec["source"]))
    except (FileNotFoundError, ValueError) as exc:
        raise ChartError(str(exc) or f"No table {spec['source']!r}.") from exc
    source = scope.get(path)
    if source is None:
        raise ChartError(
            f"{path} is not one of the tables this page can chart (its own, its subpages' "
            "and the tables they link to)."
        )
    b = _Builder(cache, page, source, scope, tables={source.path})
    ys = _names(spec.get("y", "count")) or ["count"]

    def resolve(name: str) -> tuple[str, str]:
        column = b.column(source, name)
        if column.reverse:
            raise QueryError(f"{column.name!r} lists another table's rows; filter there instead.")
        return f"s.{quote(column.name)}", "text" if column.type == "relation" else column.type

    where = compile_filter(spec.get("filter"), resolve)
    if kind == "scatter":
        x_sql, _ = b.expr(spec["x"])
        y_sql, _ = b.expr(ys[0])
        sql = (
            f"SELECT {x_sql}, {y_sql} FROM {b.alias(source)} s {' '.join(b.joins)} "
            f"WHERE {where.sql} LIMIT {SQL_ROWS}"
        )
        rows = run_query(
            cache.db_path, tables, pages, sql, params=[*b.params, *where.params], max_rows=SQL_ROWS
        )["rows"]
        return {
            "points": [[_number(r[0]), _number(r[1])] for r in rows],
            "series": [{"name": ys[0], "data": []}],
            "tables": sorted(b.tables),
        }
    measures = [b.measure(y) for y in ys]
    if kind == "number":
        body = f"FROM {b.alias(source)} s {' '.join(b.joins)} WHERE {where.sql}"
        sql = f"SELECT {measures[0][0]} {body}"
        rows = run_query(cache.db_path, tables, pages, sql, params=[*b.params, *where.params])[
            "rows"
        ]
        return {
            "value": _number(rows[0][0]) if rows else None,
            "label": measures[0][1],
            "format": measures[0][2],
            "tables": sorted(b.tables),
        }
    x_sql, x_kind = b.expr(spec["x"])
    series_sql = b.expr(spec["series"])[0] if spec.get("series") else None
    select = [f"{x_sql} AS x"]
    group = ["x"]
    if series_sql:
        select.append(f"{series_sql} AS g")
        group.append("g")
    select += [f"{m} AS y{i}" for i, (m, *_) in enumerate(measures)]
    sql = (
        f"SELECT {', '.join(select)} FROM {b.alias(source)} s {' '.join(b.joins)} "
        f"WHERE {where.sql} GROUP BY {', '.join(group)}"
    )
    rows = run_query(
        cache.db_path, tables, pages, sql, params=[*b.params, *where.params], max_rows=SQL_ROWS
    )["rows"]
    # Yes/no fields read as words, not 1 and 0.
    words = {1: "Yes", 0: "No"}
    yes_no = [x_kind == "checkbox"]
    if series_sql:
        yes_no.append(b.expr(spec["series"])[1] == "checkbox")
    if any(yes_no):
        rows = [
            [words.get(v, v) if i < len(yes_no) and yes_no[i] else v for i, v in enumerate(r)]
            for r in rows
        ]
    offset = 2 if series_sql else 1
    totals: dict[str, float] = {}
    for r in rows:
        totals[_label(r[0])] = totals.get(_label(r[0]), 0) + (_number(r[offset]) or 0)
    sort = _SORT.match(spec.get("sort") or "")
    by, desc = (
        (sort.group(1).lower(), sort.group(2).lower() == "desc")
        if sort
        else (
            ("x", False)
            if x_kind in ("date", "bucket") or kind in ("line", "area")
            else ("y", True)
        )
    )
    if by == "x":
        raw = {_label(r[0]): r[0] for r in rows}
        categories = sorted(
            totals,
            key=lambda c: (raw[c] is None, raw[c] if raw[c] is not None else ""),
            reverse=desc,
        )
    else:
        categories = sorted(totals, key=lambda c: totals[c], reverse=desc)
    limit = spec.get("limit") or (12 if kind in ("pie", "donut") else 50)
    categories = categories[: min(int(limit), MAX_CATEGORIES)]
    index = {c: i for i, c in enumerate(categories)}
    if series_sql:
        names: list[str] = []
        for r in rows:
            if _label(r[1]) not in names:
                names.append(_label(r[1]))
        names = names[:MAX_SERIES]
        data: dict[str, list[Any]] = {n: [None] * len(categories) for n in names}
        for r in rows:
            c, n = _label(r[0]), _label(r[1])
            if c in index and n in data:
                data[n][index[c]] = _number(r[2])
        series = [{"name": n, "data": data[n], "format": measures[0][2]} for n in names]
    else:
        series = []
        for i, (_, label, fmt) in enumerate(measures):
            values: list[Any] = [None] * len(categories)
            for r in rows:
                c = _label(r[0])
                if c in index:
                    values[index[c]] = _number(r[1 + i])
            series.append({"name": label, "data": values, "format": fmt})
    return {"categories": categories, "series": series, "tables": sorted(b.tables)}
