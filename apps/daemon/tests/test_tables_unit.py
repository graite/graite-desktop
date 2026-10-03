"""CSV tables (D68): parsing, id handling, row and column edits, the filter language, the cache."""

from __future__ import annotations

from pathlib import Path

import pytest

from graite.tables import csvio
from graite.tables import schema as sch
from graite.tables.cache import TablesCache
from graite.tables.edit import (
    ColumnOp,
    RowOp,
    TableConflict,
    apply_columns,
    apply_rows,
    effective_ids,
    ensure_ids,
)
from graite.tables.query import QueryError, compile_filter, parse_sort

# ------------------------------------------------------------------ csvio


@pytest.mark.parametrize(
    "text",
    [
        "a,b\n1,2\n",
        "a,b\r\n1,2\r\n",
        "a;b\n1;2",
        "﻿id\tname\n1\tAda\n",
        'a,b\n1,"multi\nline, with comma"\n\n2,"say ""hi"""\n',
        "only\n",
        "",
    ],
)
def test_csv_round_trips_byte_for_byte(text: str) -> None:
    assert csvio.serialize(csvio.parse(text)) == text


def test_edited_row_keeps_dialect_and_other_rows_untouched() -> None:
    table = csvio.parse('﻿id;name;note\r\n1;"Ada";x\r\n2;Bob;y')
    assert table.dialect.delimiter == ";" and table.dialect.bom
    record = table.rows[1]
    record.values[2], record.raw = "a;b", None
    assert csvio.serialize(table) == '﻿id;name;note\r\n1;"Ada";x\r\n2;Bob;"a;b"'


# ------------------------------------------------------------------ schema


def test_types_are_inferred_and_schema_file_wins() -> None:
    rows = [
        [
            "1",
            "2.5",
            "2026-01-02",
            "yes",
            "007",
            "https://x.org",
            "a@b.io",
            "25%",
            "€1,200.50",
            "hi",
        ]
    ]
    header = ["i", "n", "d", "b", "zip", "u", "e", "p", "c", "t"]
    columns = sch.columns_for(header, rows, sch.Schema())
    assert [c.type for c in columns] == [
        "number",
        "number",
        "date",
        "checkbox",
        "text",
        "url",
        "email",
        "percent",
        "currency",
        "text",
    ]
    assert columns[8].currency == "EUR"
    # Older names still work, and the schema's options come first.
    schema, problems = sch.load('{"columns": {"t": {"type": "select", "options": ["hi"]}}}')
    assert not problems
    column = sch.columns_for(header, rows, schema)[-1]
    assert (column.type, column.options) == ("single_select", ["hi"])


def test_choice_options_come_from_the_data_with_page_colors() -> None:
    schema, _ = sch.load('{"columns": {"s": {"type": "status", "colors": {"Done": "purple"}}}}')
    rows = [["Todo", "a; b"], ["Done", "b;c"], ["Blocked", ""]]
    schema.columns["m"] = {"type": "multi_select"}
    status, tags = sch.columns_for(["s", "m"], rows, schema)
    assert status.options == ["Todo", "Done", "Blocked"]
    assert status.colors == {"Todo": "gray", "Done": "purple", "Blocked": "red"}
    assert tags.options == ["a", "b", "c"]


@pytest.mark.parametrize(
    ("kind", "text", "value"),
    [
        ("currency", "€1,200.50", 1200.5),
        ("currency", "-$3", -3.0),
        ("currency", "12.5 €", 12.5),
        ("percent", "25%", 25.0),
        ("percent", "7.5", 7.5),
        ("number", "abc", "abc"),
        ("checkbox", "x", 1),
        ("date", "2026-01-02 10:30", "2026-01-02T10:30"),
    ],
)
def test_cells_convert_to_plain_values(kind: str, text: str, value: object) -> None:
    assert sch.to_sql(kind, text) == value


def test_money_and_percent_are_written_as_plain_numbers() -> None:
    assert sch.to_cell("currency", 1200.5) == "1200.5"
    assert sch.to_cell("percent", 25.0) == "25"
    with pytest.raises(ValueError):
        sch.to_cell("email", "not-an-address")


def test_broken_schema_is_a_warning_not_an_error() -> None:
    schema, problems = sch.load("{nope")
    assert schema.primary_key == "id" and problems
    _, problems = sch.load('{"columns": {"a": {"type": "wat"}}}')
    assert "unknown type" in problems[0]


def test_column_names_never_collide() -> None:
    assert sch.column_names(["a", "", "A", "_rid"]) == ["a", "column 2", "A 2", "_rid 2"]


# ------------------------------------------------------------------ ids and edits


def test_rows_without_ids_get_ephemeral_ids_and_a_warning() -> None:
    table = csvio.parse("name\nAda\nBob\n")
    assert effective_ids(table) == (["@1", "@2"], ["ids_missing"])
    table = csvio.parse("id,name\nx,Ada\n,Bob\nx,Cy\n")
    assert effective_ids(table) == (["x", "@2", "@3"], ["ids_blank:1", "ids_duplicate:1"])


def test_first_write_adds_the_id_column_and_ephemeral_ids_still_work() -> None:
    table = csvio.parse("name,age\nAda,36\nBob,40\n")
    kinds = {"name": "text", "age": "integer"}
    apply_rows(table, [RowOp("update", id="@2", values={"age": 41})], kinds, file_hash="h")
    assert table.header == ["id", "name", "age"]
    assert [r.values[1:] for r in table.rows] == [["Ada", "36"], ["Bob", "41"]]
    assert all(len(r.values[0]) == 36 for r in table.rows)


def test_insert_update_delete_by_id() -> None:
    table = csvio.parse("id,name,done\na,Ada,false\nb,Bob,false\n")
    kinds = {"id": "text", "name": "text", "done": "boolean"}
    ids = apply_rows(
        table,
        [
            RowOp("insert", values={"name": "Cy", "done": True}, after="a"),
            RowOp("update", id="b", values={"done": True}, base={"done": False}),
            RowOp("delete", id="a"),
        ],
        kinds,
        file_hash="h",
    )
    assert ids[1:] == ["b", "a"]
    assert [r.values[1:] for r in table.rows] == [["Cy", "true"], ["Bob", "true"]]
    assert csvio.serialize(table).splitlines()[0] == "id,name,done"


def test_stale_base_values_are_a_per_row_conflict() -> None:
    table = csvio.parse("id,amount\na,10\nb,20\n")
    kinds = {"id": "text", "amount": "number"}
    with pytest.raises(TableConflict) as info:
        apply_rows(
            table,
            [
                RowOp("update", id="a", values={"amount": 11}, base={"amount": 10.0}),
                RowOp("update", id="b", values={"amount": 21}, base={"amount": 19}),
                RowOp("delete", id="zz"),
            ],
            kinds,
            file_hash="h",
        )
    assert [(c.id, c.reason) for c in info.value.conflicts] == [
        ("b", "changed"),
        ("zz", "missing"),
    ]


def test_ids_and_unknown_columns_cannot_be_edited() -> None:
    table = csvio.parse("id,name\na,Ada\n")
    with pytest.raises(ValueError, match="ids cannot"):
        apply_rows(table, [RowOp("update", id="a", values={"id": "b"})], {}, file_hash="h")
    with pytest.raises(ValueError, match="no column"):
        apply_rows(table, [RowOp("update", id="a", values={"x": 1})], {}, file_hash="h")


def test_column_ops() -> None:
    table = csvio.parse("id,a,b\n1,x,y\n")
    ensure_ids(table)
    apply_columns(
        table,
        [
            ColumnOp("add", "c"),
            ColumnOp("rename", "a", to="alpha"),
            ColumnOp("move", "c", index=1),
            ColumnOp("delete", "b"),
        ],
    )
    assert csvio.serialize(table) == "id,c,alpha\n1,,x\n"
    with pytest.raises(ValueError):
        apply_columns(table, [ColumnOp("delete", "id")])


# ------------------------------------------------------------------ query language

COLUMNS = {
    "category": "text",
    "amount": "number",
    "done": "checkbox",
    "Project name": "text",
    "tags": "multi_select",
}


def resolve(name: str) -> tuple[str, str]:
    if name not in COLUMNS:
        raise QueryError(f"no column {name!r}")
    return f'"{name}"', COLUMNS[name]


def test_filter_compiles_to_bound_parameters() -> None:
    q = compile_filter('category = "Travel" and amount > 100', resolve)
    assert q.sql == '("category" COLLATE NOCASE = ? AND "amount" > ?)'
    assert q.params == ["Travel", 100]
    q = compile_filter("not (category in [a, 'b c']) or `Project name` contains x", resolve)
    assert "NOT" in q.sql and q.params == ["a", "b c", "x"]
    q = compile_filter("done = true and category is not empty", resolve)
    assert q.params == [1]


@pytest.mark.parametrize(
    "text",
    [
        "category = 'x'; DROP TABLE t",
        "missing = 1",
        "amount >",
        "(amount > 1",
        'category = "x" or',
        "amount = 1 1",
    ],
)
def test_bad_filters_are_refused(text: str) -> None:
    with pytest.raises(QueryError):
        compile_filter(text, resolve)


def test_multi_select_matches_whole_elements() -> None:
    import sqlite3

    conn = sqlite3.connect(":memory:")
    conn.execute('CREATE TABLE t ("tags" TEXT)')
    conn.executemany("INSERT INTO t VALUES (?)", [("Red; Blue",), ("Reddish",), (None,)])

    def count(text: str) -> int:
        q = compile_filter(text, resolve)
        return int(conn.execute(f"SELECT count(*) FROM t WHERE {q.sql}", q.params).fetchone()[0])

    assert count("tags = red") == 1  # not "Reddish"
    assert count("tags != blue") == 2  # the empty row too
    assert count("tags in [blue, reddish]") == 2
    assert count("tags contains red") == 2


def test_sort_forms() -> None:
    assert parse_sort("date desc, amount") == [("date", True), ("amount", False)]
    assert parse_sort(["-date", "`Project name` asc"]) == [
        ("date", True),
        ("Project name", False),
    ]


# ------------------------------------------------------------------ cache


def make_vault(tmp_path: Path) -> Path:
    vault = tmp_path / "vault"
    (vault / "Atlas" / "_data").mkdir(parents=True)
    (vault / "Atlas" / "page.md").write_text("---\nid: a\n---\n", encoding="utf-8")
    (vault / "Atlas" / "_data" / "expenses.csv").write_text(
        "date,description,amount,category\n"
        "2026-01-03,Train,120.5,Travel\n"
        "2026-01-04,Lunch,12,Food\n"
        "2026-02-01,Flight,300,Travel\n",
        encoding="utf-8",
    )
    return vault


def test_cache_imports_filters_sorts_and_pages(tmp_path: Path) -> None:
    vault = make_vault(tmp_path)
    csv_file = vault / "Atlas" / "_data" / "expenses.csv"
    before = csv_file.read_bytes()
    cache = TablesCache(vault, vault / ".graite" / "tables.sqlite")
    assert cache.sync(["Atlas"]) == ["Atlas/_data/expenses.csv"]
    page = cache.select(
        "Atlas/_data/expenses.csv", filter="category = travel", sort="amount desc", limit=1
    )
    assert page["total"] == 2 and page["warnings"] == ["ids_missing"]
    assert page["rows"] == [{"id": "@3", "cells": ["2026-02-01", "Flight", 300.0, "Travel"]}]
    page = cache.select("Atlas/_data/expenses.csv", columns=["amount"], search="lunch")
    assert page["visible"] == ["amount"] and page["rows"][0]["cells"] == [12.0]
    assert csv_file.read_bytes() == before  # reading never writes (rule 5)
    assert cache.sync(["Atlas"]) == []  # unchanged files are not re-imported


def test_cache_follows_file_changes_and_can_be_deleted(tmp_path: Path) -> None:
    vault = make_vault(tmp_path)
    db_path = vault / ".graite" / "tables.sqlite"
    cache = TablesCache(vault, db_path)
    cache.sync(["Atlas"])
    csv_file = vault / "Atlas" / "_data" / "expenses.csv"
    csv_file.write_text(csv_file.read_text() + "2026-03-01,Taxi,30,Travel\n", encoding="utf-8")
    (vault / "Atlas" / "_data" / "expenses.schema.json").write_text(
        '{"columns": {"category": {"type": "select", "options": ["Travel", "Food"]}}}'
    )
    info = cache.info("Atlas/_data/expenses.csv")  # reads check freshness themselves
    assert info.row_count == 4 and info.kinds["category"] == "single_select"
    cache.close()
    for suffix in ("", "-wal", "-shm"):
        Path(str(db_path) + suffix).unlink(missing_ok=True)
    cache = TablesCache(vault, db_path)
    assert cache.sync(["Atlas"]) == ["Atlas/_data/expenses.csv"]
    csv_file.unlink()
    assert cache.sync(["Atlas"]) == ["Atlas/_data/expenses.csv"]
    assert cache.tables() == []


def test_resolve_block_sources(tmp_path: Path) -> None:
    vault = make_vault(tmp_path)
    (vault / "Atlas" / "Sub").mkdir()
    (vault / "Atlas" / "Sub" / "page.md").write_text("", encoding="utf-8")
    cache = TablesCache(vault, vault / ".graite" / "tables.sqlite")
    cache.sync(["Atlas", "Atlas/Sub"])
    rel = "Atlas/_data/expenses.csv"
    assert cache.resolve("Atlas", "_data/expenses.csv") == rel
    assert cache.resolve("Atlas/Sub", "expenses.csv") == rel
    assert cache.resolve("Other", rel) == rel
    with pytest.raises(FileNotFoundError):
        cache.resolve("Atlas", "nope.csv")
