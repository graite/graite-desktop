"""AI access to databases that live on a parent page (D84): the CRM template's tables sit in
`CRM/_data/` and its subpages only show views of them."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from graite.events import EventBus
from graite.index import db
from graite.retrieval.scope import Scope
from graite.retrieval.scope import resolve as resolve_scope
from graite.review.proposals import Proposals
from graite.skills.registry import PROPOSE_GROUPS, Registry
from graite.tables.cache import TablesCache
from graite.vault import indexer
from graite.vault.fileops import FileOps


async def crm(tmp_path: Path) -> tuple[FileOps, Proposals]:
    vault = tmp_path / "vault"
    vault.mkdir()
    conn = db.connect(vault / ".graite" / "index.sqlite")
    events = EventBus()
    ops = FileOps(vault, conn, events)
    ops.tables = TablesCache(vault, vault / ".graite" / "tables.sqlite")
    await ops.create_from_template(None, "crm", "CRM", True, "ui")
    indexer.scan(ops.vault, ops.db)
    return ops, Proposals(conn, ops, events)


def registry(ops: FileOps, queue: Proposals) -> Registry:
    scope = resolve_scope(ops.db, ops.vault, Scope("vault", []), cloud_provider=False)
    reg = Registry(ops, scope, groups=PROPOSE_GROUPS)
    reg.proposals = queue
    reg.turn = {"run_id": "r", "conversation_id": "c", "cloud_model": False}
    return reg


async def call(reg: Registry, name: str, **args: Any) -> Any:
    return json.loads(await reg.invoke(name, json.dumps(args)))


def company_names(ops: FileOps) -> list[str]:
    assert ops.tables is not None
    rows = ops.tables.select("CRM/_data/companies.csv", limit=100)
    i = rows["visible"].index("name")
    return sorted(r["cells"][i] for r in rows["rows"])


async def test_read_tables_on_a_subpage_finds_the_parent_table(tmp_path: Path) -> None:
    ops, queue = await crm(tmp_path)
    out = await call(registry(ops, queue), "read_tables", page_path="CRM/Companies")
    shown = {t["path"]: t for t in out["tables"]}
    companies = shown["CRM/_data/companies.csv"]
    assert companies["role"] == "shown"
    assert companies["sql_name"] == "companies"
    assert companies["rows"] == len(company_names(ops)) > 0
    assert {v["name"] for v in companies["views"]} == {"All companies", "By status"}
    assert companies["sample"] and "id" in companies["sample"][0]
    # Related tables come along without samples.
    assert any(t["role"] == "related" and "sample" not in t for t in out["tables"])


async def test_catalog_lists_every_database(tmp_path: Path) -> None:
    ops, queue = await crm(tmp_path)
    out = await call(registry(ops, queue), "read_tables", page_path="")
    by_name = {t["name"]: t for t in out["tables"]}
    assert {"companies", "contacts", "deals", "activities"} <= set(by_name)
    assert "CRM/Companies" in by_name["companies"]["shown_on"]


async def test_query_from_a_subpage_uses_short_names(tmp_path: Path) -> None:
    ops, queue = await crm(tmp_path)
    out = await call(
        registry(ops, queue),
        "run_query_ro",
        page_path="CRM/Companies",
        sql="SELECT name FROM companies ORDER BY name",
    )
    assert "error" not in out, out
    assert [r[0] for r in out["rows"]] == company_names(ops)


async def test_read_rows_by_name_view_and_id(tmp_path: Path) -> None:
    ops, queue = await crm(tmp_path)
    reg = registry(ops, queue)
    everything = await call(reg, "read_rows", table="companies")
    assert sorted(r["name"] for r in everything["rows"]) == company_names(ops)
    assert everything["total"] == len(company_names(ops))
    view = await call(reg, "read_rows", page_path="CRM/Companies", view="all companies")
    assert view["view"]["name"] == "All companies"
    assert [r["name"] for r in view["rows"]] == company_names(ops)  # sorted by name asc
    first = everything["rows"][0]
    one = await call(reg, "read_rows", table="CRM/_data/companies.csv", id=first["id"])
    assert [r["id"] for r in one["rows"]] == [first["id"]]
    missing = await call(reg, "read_rows", page_path="CRM/Companies", view="Nope")
    assert "All companies" in missing["error"]


async def test_read_page_points_at_the_database(tmp_path: Path) -> None:
    ops, queue = await crm(tmp_path)
    out = await call(registry(ops, queue), "read_page", path="CRM/Companies")
    assert out["databases"][0]["table"] == "CRM/_data/companies.csv"
    assert "read_rows" in out["databases_note"]


async def test_search_finds_rows(tmp_path: Path) -> None:
    ops, queue = await crm(tmp_path)
    name = company_names(ops)[0]
    out = await call(registry(ops, queue), "search_vault", query=name)
    assert any(r["cells"].get("name") == name for r in out["rows"])


async def test_update_and_delete_with_ids_from_read_rows(tmp_path: Path) -> None:
    ops, queue = await crm(tmp_path)
    reg = registry(ops, queue)
    rows = (await call(reg, "read_rows", table="companies"))["rows"]
    target = rows[0]
    proposal = await call(
        reg,
        "propose_rows",
        table_path="CRM/_data/companies.csv",
        summary="Tidy",
        ops=[
            {"op": "update", "id": target["id"], "values": {"city": "Utrecht"}},
            {"op": "delete", "id": rows[1]["id"]},
        ],
    )
    assert "error" not in proposal, proposal
    assert proposal["proposal_id"]


# ------------------------------------------------------------------ a chat turn reads data first


def test_a_question_about_records_reads_that_database_first(client: Any, monkeypatch: Any) -> None:
    from graite.models.providers import Provider
    from tests.test_ai import config
    from tests.test_chat_v2 import events_of

    config(client)
    monkeypatch.setattr("keyring.get_password", lambda *_: "")
    made = client.post(
        "/api/v1/templates/crm/use", json={"parent_path": None, "title": "CRM", "sample_data": True}
    )
    assert made.status_code == 201, made.text
    prompts: list[str] = []

    async def fake(self: Provider, messages: Any, tools: Any) -> Any:
        prompts.append(messages[0]["content"])
        yield {"content": "Here they are [1]."}

    monkeypatch.setattr(Provider, "chat", fake)
    c = client.post("/api/v1/ai/conversations", json={"scope": {"kind": "vault"}}).json()
    events = events_of(
        client.post(
            f"/api/v1/ai/conversations/{c['id']}/messages",
            json={"message": "Can you list all the companies I currently have in my crm"},
        ).text
    )
    sources = next(e for e in events if e["type"] == "sources")["sources"]
    table = next(s for s in sources if s["kind"] == "table")
    assert "companies" in table["title"]
    assert len(sources) <= 7
    blocks = [line for line in prompts[0].splitlines() if line.startswith("[")]
    assert blocks[0] == f"[{table['n']}] companies (CRM/_data/companies.csv) (CRM/Companies)"
    cache = client.app.state.fileops.tables
    rows = cache.select("CRM/_data/companies.csv", limit=100)
    name = rows["visible"].index("name")
    system = prompts[0]
    assert "## Your databases" in system
    assert all(r["cells"][name] in system for r in rows["rows"])


def test_match_tables_picks_the_database_a_question_is_about() -> None:
    from graite.retrieval.strategy import match_tables
    from graite.tables.scope import CatalogEntry

    def entry(name: str, page: str, shown: list[str], options: list[str]) -> CatalogEntry:
        return CatalogEntry(f"{page}/_data/{name}.csv", name, page, 3, ["name"], shown, [], options)

    catalog = [
        entry("companies", "CRM", ["CRM/Companies"], ["Lead", "Customer"]),
        entry("deals", "CRM", ["CRM/Deals", "CRM"], ["Won", "Lost"]),
        entry("weeks", "Planner", ["Planner/Weeks"], []),
    ]

    def names(q: str) -> list[str]:
        return [e.name for e in match_tables(q, catalog)]

    assert names("Can you list all the companies I currently have in my crm") == ["companies"]
    assert names("who are my customers now?") == ["companies"]
    assert names("which deals did we win") == ["deals"]
    assert names("what is the weather like") == []
