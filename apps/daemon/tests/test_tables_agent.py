"""Agents and CSV tables (D69): read_tables, run_query_ro, propose_rows and the `rows` kind."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from graite.events import EventBus
from graite.index import db
from graite.retrieval.scope import Scope
from graite.retrieval.scope import resolve as resolve_scope
from graite.review import policy as review_policy
from graite.review.proposals import ProposalConflict, Proposals
from graite.skills.registry import Registry
from graite.tables.cache import TablesCache
from graite.tables.readonly import QueryPage, QueryTable, run_query
from graite.vault import indexer
from graite.vault.fileops import FileOps

CSV = (
    "id,date,description,amount,category\n"
    "1,2026-01-03,Train,120.5,Travel\n"
    "2,2026-01-04,Lunch,12,Food\n"
)
PAGE = "Projects/Atlas"
TABLE = "Projects/Atlas/_data/expenses.csv"
GROUPS = {"read", "search", "meta", "propose"}


async def make(tmp_path: Path) -> tuple[FileOps, Proposals]:
    vault = tmp_path / "vault"
    vault.mkdir()
    conn = db.connect(vault / ".graite" / "index.sqlite")
    events = EventBus()
    ops = FileOps(vault, conn, events)
    ops.tables = TablesCache(vault, vault / ".graite" / "tables.sqlite")
    root = await ops.create_page(None, "Projects", None, "ui")
    page = await ops.create_page(root.path, "Atlas", None, "ui")
    await ops.set_properties(
        page.id,
        [
            {
                "id": "status",
                "name": "Status",
                "type": "status",
                "options": ["Active", "Done"],
                "colors": {},
                "value": "Active",
            }
        ],
        page.hash,
        "ui",
    )
    data = vault / "Projects" / "Atlas" / "_data"
    data.mkdir()
    (data / "expenses.csv").write_text(CSV, encoding="utf-8")
    ops.sync_tables()
    return ops, Proposals(conn, ops, events)


def registry(ops: FileOps, queue: Proposals, *, cloud: bool = False) -> Registry:
    indexer.scan(ops.vault, ops.db)
    scope = resolve_scope(ops.db, ops.vault, Scope("vault", []), cloud_provider=cloud)
    reg = Registry(ops, scope, groups=GROUPS)
    reg.proposals = queue
    reg.turn = {"run_id": "r", "conversation_id": "c", "cloud_model": cloud}
    return reg


async def call(reg: Registry, name: str, **args: Any) -> dict[str, Any]:
    return dict(json.loads(await reg.invoke(name, json.dumps(args))))


# ------------------------------------------------------------------ reading and querying


async def test_read_tables_lists_types_and_samples(tmp_path: Path) -> None:
    ops, queue = await make(tmp_path)
    result = await call(registry(ops, queue), "read_tables", page_path=PAGE)
    [table] = result["tables"]
    assert table["path"] == TABLE and table["sql_name"] == "expenses"
    assert {c["name"]: c["type"] for c in table["columns"]}["amount"] == "number"
    assert table["sample"][0] == {
        "id": "1",
        "date": "2026-01-03",
        "description": "Train",
        "amount": 120.5,
        "category": "Travel",
    }


async def test_run_query_ro_joins_tables_with_page_properties(tmp_path: Path) -> None:
    ops, queue = await make(tmp_path)
    reg = registry(ops, queue)
    result = await call(
        reg,
        "run_query_ro",
        page_path=PAGE,
        sql="SELECT p.title, sum(e.amount) AS total FROM pages p "
        "JOIN page_props s ON s.path = p.path AND s.name = 'Status' AND s.value = 'Active' "
        "JOIN expenses e GROUP BY p.title",
    )
    assert result["columns"] == ["title", "total"] and result["rows"] == [["Atlas", 132.5]]
    # From another page, the table is named by its path.
    other = await ops.create_page(None, "Home", None, "ui")
    reg = registry(ops, queue)
    result = await call(
        reg,
        "run_query_ro",
        page_path=other.path,
        sql='SELECT count(*) FROM "Projects/Atlas/expenses"',
    )
    assert result["rows"] == [[2]]


@pytest.mark.parametrize(
    "sql",
    [
        "DELETE FROM expenses",
        "PRAGMA table_info(expenses)",
        "ATTACH 'x.db' AS x",
        "SELECT 1; SELECT 2",
        "CREATE TEMP TABLE t(a)",
        "",
    ],
)
async def test_run_query_ro_only_reads(tmp_path: Path, sql: str) -> None:
    ops, queue = await make(tmp_path)
    result = await call(registry(ops, queue), "run_query_ro", page_path=PAGE, sql=sql)
    assert "error" in result, result
    assert (ops.vault / TABLE).read_text() == CSV


def test_runaway_queries_stop_and_rows_are_capped(tmp_path: Path) -> None:
    ops_db = tmp_path / "t.sqlite"
    import sqlite3

    sqlite3.connect(ops_db).close()
    forever = "WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM n) SELECT max(x) FROM n"
    with pytest.raises(ValueError, match="longer than"):
        run_query(ops_db, [], [], forever, timeout_s=0.2)
    many = (
        "WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM n LIMIT 500) SELECT x FROM n"
    )
    result = run_query(ops_db, [], [], many)
    assert len(result["rows"]) == 200 and result["truncated"]
    pages = [QueryPage("A", "A", props=[("Tags", ["x", "y"])])]
    tables: list[QueryTable] = []
    assert run_query(ops_db, tables, pages, "SELECT value FROM page_props")["rows"] == [["x|y"]]


async def test_cloud_turns_never_see_tables_on_local_only_pages(tmp_path: Path) -> None:
    ops, queue = await make(tmp_path)
    doc = await ops.read_page(PAGE)
    await ops.set_ai_settings(PAGE, {"cloud": "local-only"}, doc.hash, "ui")
    home = await ops.create_page(None, "Home", None, "ui")
    reg = registry(ops, queue, cloud=True)
    result = await call(
        reg, "run_query_ro", page_path=home.path, sql='SELECT * FROM "Projects/Atlas/expenses"'
    )
    assert "no such table" in result["error"]
    result = await call(reg, "read_tables", page_path=PAGE)
    assert "error" in result


# ------------------------------------------------------------------ proposing rows


async def test_row_proposal_waits_applies_and_reverts(tmp_path: Path) -> None:
    ops, queue = await make(tmp_path)
    reg = registry(ops, queue)
    result = await call(
        reg,
        "propose_rows",
        table_path=TABLE,
        summary="Add the taxi and fix lunch",
        ops=[
            {"op": "insert", "values": {"description": "Taxi", "amount": 30, "category": "Travel"}},
            {"op": "update", "id": "2", "values": {"amount": 14}},
            {"op": "delete", "id": "1"},
        ],
    )
    assert result["status"] == "pending", result
    proposal = queue.get(result["proposal_id"])
    assert proposal is not None and proposal["page_path"] == PAGE
    assert proposal["rows"]["ops"][1]["base"] == {"amount": 12.0}
    assert proposal["rows"]["ops"][2]["base"]["description"] == "Train"
    csv_file = ops.vault / TABLE
    assert csv_file.read_text() == CSV  # nothing written yet

    applied = await queue.accept(result["proposal_id"])
    assert applied["status"] == "accepted" and applied["rows"]["applied"]
    lines = csv_file.read_text().splitlines()
    assert lines[1] == "2,2026-01-04,Lunch,14,Food" and lines[2].endswith(",,Taxi,30,Travel")
    assert len(lines) == 3

    await queue.revert(result["proposal_id"])
    assert csv_file.read_text() == CSV  # every row back, in place


async def test_rows_changed_by_hand_meanwhile_conflict(tmp_path: Path) -> None:
    ops, queue = await make(tmp_path)
    reg = registry(ops, queue)
    result = await call(
        reg,
        "propose_rows",
        table_path=TABLE,
        summary="Lunch was 14",
        ops=[{"op": "update", "id": "2", "values": {"amount": 14}}],
    )
    csv_file = ops.vault / TABLE
    csv_file.write_text(CSV.replace("Lunch,12", "Lunch,13"), encoding="utf-8")
    with pytest.raises(ProposalConflict):
        await queue.accept(result["proposal_id"])
    assert queue.get(result["proposal_id"])["status"] == "conflict"  # type: ignore[index]
    assert "Lunch,13" in csv_file.read_text()


@pytest.mark.parametrize(
    ("op", "error"),
    [
        ({"op": "update", "id": "2", "values": {"nope": 1}}, "no column"),
        ({"op": "update", "id": "2", "values": {"id": "9"}}, "ids cannot"),
        ({"op": "update", "id": "zz", "values": {"amount": 1}}, "no row"),
        ({"op": "update", "values": {"amount": 1}}, "needs the row's id"),
        ({"op": "upsert", "values": {}}, "insert, update or delete"),
    ],
)
async def test_bad_row_changes_are_refused_while_still_words(
    tmp_path: Path, op: dict[str, Any], error: str
) -> None:
    ops, queue = await make(tmp_path)
    result = await call(
        registry(ops, queue),
        "propose_rows",
        table_path=TABLE,
        summary="x",
        ops=[op],
    )
    assert error in result.get("error", ""), result


async def test_page_settings_decide_review_or_auto_apply(tmp_path: Path) -> None:
    ops, queue = await make(tmp_path)
    doc = await ops.read_page(PAGE)
    # Settings saved before tables existed list `edit`; that covers table rows too.
    await ops.set_ai_settings(
        PAGE, {"autonomy": "auto-apply", "auto_apply_kinds": ["edit"]}, doc.hash, "ui"
    )
    args = {
        "table_path": TABLE,
        "summary": "Taxi",
        "ops": [{"op": "insert", "values": {"description": "Taxi", "amount": 30}}],
    }
    result = await call(registry(ops, queue), "propose_rows", **args)
    assert result["status"] == "pending" and "one-time confirmation" in result["message"]
    review_policy.opt_in(ops.db, PAGE)
    result = await call(registry(ops, queue), "propose_rows", **args)
    assert result["status"] == "auto_applied", result
    assert "Taxi" in (ops.vault / TABLE).read_text()

    doc = await ops.read_page(PAGE)
    await ops.set_ai_settings(PAGE, {"autonomy": "none"}, doc.hash, "ui")
    result = await call(registry(ops, queue), "propose_rows", **args)
    assert "don't allow changes" in result["error"]


def test_rows_is_an_auto_apply_kind() -> None:
    from graite.vault import policy

    assert policy.validate({"auto_apply_kinds": ["rows", "edit"]}) == {
        "auto_apply_kinds": ["edit", "rows"]
    }


async def test_row_changes_name_their_rows_and_carry_column_types(tmp_path: Path) -> None:
    ops, queue = await make(tmp_path)
    (ops.vault / "Projects" / "Atlas" / "_data" / "expenses.schema.json").write_text(
        '{"columns": {"category": {"type": "single_select", "colors": {"Food": "orange"}}}}'
    )
    result = await call(
        registry(ops, queue),
        "propose_rows",
        table_path=TABLE,
        summary="Tidy up",
        ops=[
            {"op": "insert", "values": {"description": "Taxi", "amount": 30}},
            {"op": "insert", "values": {"amount": 1}},
            {"op": "update", "id": "2", "values": {"category": "Travel"}},
            {"op": "delete", "id": "1"},
        ],
    )
    rows = queue.get(result["proposal_id"])["rows"]  # type: ignore[index]
    # The first text column names a row; a row without one is numbered.
    assert [o["label"] for o in rows["ops"]] == ["Taxi", "New row 2", "Lunch", "Train"]
    assert rows["columns"]["category"]["type"] == "single_select"
    assert rows["columns"]["category"]["colors"]["Food"] == "orange"
    assert rows["columns"]["amount"] == {"type": "number"}
    # The display column wins when the schema names one.
    (ops.vault / "Projects" / "Atlas" / "_data" / "expenses.schema.json").write_text(
        '{"display": "date"}'
    )
    result = await call(
        registry(ops, queue),
        "propose_rows",
        table_path=TABLE,
        summary="x",
        ops=[{"op": "delete", "id": "2"}],
    )
    assert queue.get(result["proposal_id"])["rows"]["ops"][0]["label"] == "2026-01-04"  # type: ignore[index]


# ------------------------------------------------------------------ databases and fields


async def test_a_database_is_proposed_created_shown_and_undone(tmp_path: Path) -> None:
    ops, queue = await make(tmp_path)
    reg = registry(ops, queue)
    arguments = {
        "page_path": PAGE,
        "name": "Backlog",
        "summary": "A backlog",
        "fields": [
            {"name": "Name"},
            {"name": "Status", "type": "status", "options": ["Todo", "Done"]},
            {"name": "Points", "type": "number"},
        ],
        "rows": [{"Name": "Fix login", "Status": "Todo", "Points": 3}, {"Name": "Ship"}],
    }
    result = json.loads(await reg.invoke("propose_table", json.dumps(arguments)))
    assert result["status"] == "pending", result
    csv_file = ops.vault / PAGE / "_data" / "Backlog.csv"
    assert not csv_file.exists()  # nothing written before the decision
    proposal = queue.get(result["proposal_id"])
    assert proposal is not None and proposal["table"]["row_count"] == 2
    assert "Status (status: Todo, Done)" in proposal["new_text"]

    applied = await queue.accept(result["proposal_id"])
    assert applied["table"]["table"] == f"{PAGE}/_data/Backlog.csv"
    lines = csv_file.read_text().splitlines()
    assert lines[0] == "id;Name;Status;Points"
    assert lines[1].endswith(";Fix login;Todo;3") and len(lines) == 3
    schema = json.loads(csv_file.with_name("Backlog.schema.json").read_text())
    assert schema["columns"]["Status"] == {"type": "status", "options": ["Todo", "Done"]}
    assert "source: _data/Backlog.csv" in (await ops.read_page(PAGE)).body
    listed = await call(reg, "read_tables", page_path=PAGE)
    assert any(t["path"].endswith("Backlog.csv") for t in listed["tables"])

    await queue.revert(result["proposal_id"])
    assert not csv_file.exists()
    assert "Backlog.csv" not in (await ops.read_page(PAGE)).body


async def test_fields_are_added_renamed_retyped_and_removed_and_undone(tmp_path: Path) -> None:
    ops, queue = await make(tmp_path)
    reg = registry(ops, queue)
    result = await call(
        reg,
        "propose_columns",
        table_path=TABLE,
        summary="Tidy the fields",
        ops=[
            {"op": "add", "name": "Paid", "type": "checkbox"},
            {"op": "rename", "name": "description", "to": "What"},
            {"op": "set", "name": "category", "type": "single_select", "options": ["Travel"]},
            {"op": "delete", "name": "amount"},
        ],
    )
    assert result["status"] == "pending", result
    csv_file = ops.vault / TABLE
    assert csv_file.read_text() == CSV
    await queue.accept(result["proposal_id"])
    assert csv_file.read_text().splitlines()[0] == "id,date,What,category,Paid"
    schema = json.loads(csv_file.with_name("expenses.schema.json").read_text())
    assert schema["columns"]["Paid"]["type"] == "checkbox"
    assert schema["columns"]["category"]["options"] == ["Travel"]

    await queue.revert(result["proposal_id"])
    assert csv_file.read_text() == CSV  # the removed values are back where they were
    schema_file = csv_file.with_name("expenses.schema.json")
    assert not json.loads(schema_file.read_text()).get("columns")


async def test_field_changes_are_refused_while_still_words(tmp_path: Path) -> None:
    ops, queue = await make(tmp_path)
    reg = registry(ops, queue)
    missing = await call(
        reg, "propose_columns", table_path=TABLE, summary="x", ops=[{"op": "delete", "name": "x"}]
    )
    assert "no field 'x'" in missing["error"] and "amount" in missing["error"]
    taken = await call(
        reg, "propose_columns", table_path=TABLE, summary="x", ops=[{"op": "add", "name": "Date"}]
    )
    assert "already has a field" in taken["error"]
    ident = await call(
        reg, "propose_columns", table_path=TABLE, summary="x", ops=[{"op": "delete", "name": "id"}]
    )
    assert "id" in ident["error"]


async def test_a_row_for_a_missing_field_points_at_propose_columns(tmp_path: Path) -> None:
    ops, queue = await make(tmp_path)
    reg = registry(ops, queue)
    result = await call(
        reg,
        "propose_rows",
        table_path=TABLE,
        summary="x",
        ops=[{"op": "insert", "values": {"priority": "High"}}],
    )
    assert "propose_columns" in result["error"]


async def test_tool_arguments_sent_as_text_are_read(tmp_path: Path) -> None:
    ops, queue = await make(tmp_path)
    reg = registry(ops, queue)
    result = await call(
        reg,
        "propose_rows",
        table_path=TABLE,
        summary="x",
        ops=json.dumps([{"op": "update", "id": "2", "values": {"amount": 14}}]),
    )
    assert result.get("status") == "pending", result
    unknown = await call(reg, "read_rows", table="expenses", nonsense=1)
    assert "nonsense" in unknown["error"] and "table" in unknown["error"]
    paged = await call(reg, "read_rows", table="expenses", offset="1")
    assert "error" not in paged, paged


async def test_rows_can_follow_fields_that_still_wait_for_review(tmp_path: Path) -> None:
    ops, queue = await make(tmp_path)
    reg = registry(ops, queue)
    fields = await call(
        reg,
        "propose_columns",
        table_path=TABLE,
        summary="Who paid",
        ops=[{"op": "add", "name": "Owner"}],
    )
    assert fields["status"] == "pending"
    rows = await call(
        reg,
        "propose_rows",
        table_path=TABLE,
        summary="Add the taxi",
        ops=[{"op": "insert", "values": {"description": "Taxi", "Owner": "Rik"}}],
    )
    assert rows["status"] == "pending", rows
    assert fields["proposal_id"] in rows["message"]
    # A field nobody proposed is still refused.
    other = await call(
        reg,
        "propose_rows",
        table_path=TABLE,
        summary="x",
        ops=[{"op": "insert", "values": {"Priority": "High"}}],
    )
    assert "propose_columns" in other["error"]
    csv_file = ops.vault / TABLE
    assert csv_file.read_text() == CSV
    # Accepting the rows accepts the fields they need first; one review covers both.
    await queue.accept(rows["proposal_id"])
    assert queue.get(fields["proposal_id"])["status"] == "accepted"  # type: ignore[index]
    lines = csv_file.read_text().splitlines()
    assert lines[0].endswith(",Owner") and lines[-1].endswith(",Taxi,,,Rik")
    await queue.revert(rows["proposal_id"])
    assert len(csv_file.read_text().splitlines()) == 3


async def test_a_field_can_link_to_rows_of_another_database(tmp_path: Path) -> None:
    ops, queue = await make(tmp_path)
    data = ops.vault / PAGE / "_data"
    (data / "people.csv").write_text("id,name\np1,Ines\np2,Sam\n", encoding="utf-8")
    ops.sync_tables()
    reg = registry(ops, queue)
    people = f"{PAGE}/_data/people.csv"
    result = await call(
        reg,
        "propose_columns",
        table_path=TABLE,
        summary="Who paid",
        ops=[
            {
                "op": "add",
                "name": "Paid by",
                "type": "relation",
                "table": people,
                "reverse": "Expenses",
            }
        ],
    )
    assert result["status"] == "pending", result
    assert "link to one row of people" in queue.get(result["proposal_id"])["new_text"]  # type: ignore[index]
    rows = await call(
        reg,
        "propose_rows",
        table_path=TABLE,
        summary="Ines paid the train",
        ops=[{"op": "update", "id": "1", "values": {"Paid by": ["p1"]}}],
    )
    assert rows["status"] == "pending", rows
    await queue.accept(rows["proposal_id"])
    schema = json.loads((data / "expenses.schema.json").read_text())
    assert schema["columns"]["Paid by"]["type"] == "relation"
    assert "[[p1|Ines]]" in (ops.vault / TABLE).read_text()
    missing = await call(
        reg,
        "propose_columns",
        table_path=TABLE,
        summary="x",
        ops=[{"op": "add", "name": "X", "type": "relation", "table": f"{PAGE}/_data/no.csv"}],
    )
    assert "error" in missing
