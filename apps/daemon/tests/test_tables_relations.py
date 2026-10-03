"""Relations between tables (D71): links, reverse columns, labels, renames."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from fastapi.testclient import TestClient

from graite.config import Settings
from graite.tables import csvio
from graite.tables import schema as sch
from graite.tables.edit import RowOp, apply_rows
from graite.tables.links import Link, format_links, ids_of, is_links, parse_links

COMPANIES = "Clients/_data/companies.csv"
PROJECTS = "Clients/_data/projects.csv"

# ------------------------------------------------------------------ pure


def test_links_parse_and_format() -> None:
    assert parse_links("[[a|Acme BV]] [[b|Beta]]") == [Link("a", "Acme BV"), Link("b", "Beta")]
    assert parse_links("[[a]]") == [Link("a")]
    # The older id-column form, and repeats dropped.
    assert parse_links("a; b, a") == [Link("a"), Link("b")]
    assert parse_links("") == []
    assert format_links([Link("a", "Acme | [x]"), Link("b")]) == "[[a|Acme x]] [[b]]"
    assert is_links("[[a|A]] [[b]]") and is_links("a;b") and not is_links("Acme BV")
    assert not is_links("[[a|A]] trailing")
    assert ids_of(["a", {"id": "b", "label": "B"}, "[[c|C]]"]) == ["a", "b", "c"]


def test_reverse_columns_and_display_default() -> None:
    schema, problems = sch.load(
        json.dumps(
            {
                "columns": {
                    "projects": {"type": "relation", "table": "projects", "reverse": "client"},
                    "name": {"type": "text"},
                }
            }
        )
    )
    assert problems == []
    columns = sch.columns_for(["id", "name", "city"], [["1", "Acme", "Utrecht"]], schema)
    assert [c.name for c in columns] == ["id", "name", "city", "projects"]
    projects = columns[-1]
    assert projects.reverse == "client" and projects.type == "relation"
    assert sch.display_column(columns, schema) == "name"
    schema.display = "city"
    assert sch.display_column(columns, schema) == "city"


def test_schema_order_with_reverse_columns() -> None:
    schema, _ = sch.load(
        json.dumps(
            {
                "order": ["name", "id"],
                "columns": {"projects": {"type": "relation", "table": "p", "reverse": "c"}},
            }
        )
    )
    columns = sch.columns_for(["id", "name", "city"], [["1", "Acme", "X"]], schema)
    assert [c.name for c in columns] == ["name", "id", "city", "projects"]


def test_relation_values_compare_by_id() -> None:
    table = csvio.parse("id,client\nr1,[[c1|Old name]]\n")
    kinds = {"id": "text", "client": "relation"}
    # The label changed on disk since the client read it: no conflict, the ids match.
    apply_rows(
        table,
        [
            RowOp(
                "update",
                id="r1",
                values={"client": [{"id": "c2", "label": "Beta"}]},
                base={"client": [{"id": "c1", "label": "Acme"}]},
            )
        ],
        kinds,
        file_hash="h",
    )
    assert table.rows[0].values == ["r1", "[[c2|Beta]]"]


def test_duplicate_ids_are_not_reassigned_by_a_write() -> None:
    table = csvio.parse("id,name\nx,Ada\nx,Bob\n,Cy\n")
    apply_rows(table, [RowOp("update", id="@2", values={"name": "Bo"})], {}, file_hash="h")
    values = [r.values for r in table.rows]
    assert values[0] == ["x", "Ada"] and values[1] == ["x", "Bo"]
    assert values[2][0] and values[2][0] != "x"  # blank ids still get one


# ------------------------------------------------------------------ API


def rows(client: TestClient, path: str, **params: Any) -> dict[str, Any]:
    r = client.get("/api/v1/tables/rows", params={"path": path, **params})
    assert r.status_code == 200, r.text
    return dict(r.json())


def cells(page: dict[str, Any], column: str) -> dict[str, Any]:
    i = page["visible"].index(column)
    return {row["id"]: row["cells"][i] for row in page["rows"]}


def write(client: TestClient, path: str, ops: list[dict[str, Any]]) -> dict[str, Any]:
    r = client.post("/api/v1/tables/rows", json={"path": path, "ops": ops})
    assert r.status_code == 200, r.text
    return dict(r.json())


def setup(client: TestClient, settings: Settings) -> Path:
    client.post("/api/v1/pages", json={"title": "Clients"})
    data = settings.vault / "Clients" / "_data"
    data.mkdir()
    (data / "companies.csv").write_text("id,name,city\nc1,Acme,Utrecht\nc2,Beta,Delft\n")
    (data / "projects.csv").write_text("id,title,client\np1,Site,\np2,App,\np3,Audit,\n")
    r = client.post(
        "/api/v1/tables/relations",
        json={
            "path": PROJECTS,
            "column": "client",
            "target": COMPANIES,
            "cardinality": "one",
            "reverse": "projects",
        },
    )
    assert r.status_code == 200, r.text
    return data


def test_add_relation_writes_both_schemas(client: TestClient, settings: Settings) -> None:
    data = setup(client, settings)
    own = json.loads((data / "projects.schema.json").read_text())
    other = json.loads((data / "companies.schema.json").read_text())
    assert own["columns"]["client"] == {
        "type": "relation",
        "table": "companies",
        "table_id": other["id"],
        "cardinality": "one",
    }
    assert other["columns"]["projects"] == {
        "type": "relation",
        "table": "projects",
        "table_id": own["id"],
        "reverse": "client",
    }
    # The reverse column is in the schema only, never in the CSV.
    assert (data / "companies.csv").read_text().splitlines()[0] == "id,name,city"
    info = client.get("/api/v1/tables", params={"page_path": "Clients"}).json()
    companies = next(t for t in info if t["path"] == COMPANIES)
    projects = next(c for c in companies["columns"] if c["name"] == "projects")
    assert projects["reverse"] == "client" and projects["target"] == PROJECTS
    assert companies["label_column"] == "name"


def test_links_show_live_labels_and_reverse_rows(client: TestClient, settings: Settings) -> None:
    data = setup(client, settings)
    write(
        client,
        PROJECTS,
        [
            {"op": "update", "id": "p1", "values": {"client": ["c1"]}},
            {"op": "update", "id": "p2", "values": {"client": ["c1"]}},
        ],
    )
    text = (data / "projects.csv").read_text()
    assert "p1,Site,[[c1|Acme]]" in text and "p3,Audit,\n" in text
    assert cells(rows(client, PROJECTS), "client")["p1"] == [{"id": "c1", "label": "Acme"}]
    reverse = cells(rows(client, COMPANIES), "projects")
    assert [x["label"] for x in reverse["c1"]] == ["Site", "App"] and reverse["c2"] == []
    # One target only.
    r = client.post(
        "/api/v1/tables/rows",
        json={
            "path": PROJECTS,
            "ops": [{"op": "update", "id": "p3", "values": {"client": ["c1", "c2"]}}],
        },
    )
    assert r.status_code == 400
    # Unknown rows are refused.
    r = client.post(
        "/api/v1/tables/rows",
        json={
            "path": PROJECTS,
            "ops": [{"op": "update", "id": "p3", "values": {"client": ["zz"]}}],
        },
    )
    assert r.status_code == 400 and "zz" in r.text
    # Search and filters read link text.
    assert rows(client, PROJECTS, filter='client contains "acme"')["total"] == 2
    assert rows(client, PROJECTS, filter="client is empty")["total"] == 1
    assert rows(client, COMPANIES, ids=["c2"])["total"] == 1
    r = client.get("/api/v1/tables/rows", params={"path": COMPANIES, "sort": "projects"})
    assert r.status_code == 400


def test_display_edit_rewrites_labels_elsewhere(client: TestClient, settings: Settings) -> None:
    data = setup(client, settings)
    write(client, PROJECTS, [{"op": "update", "id": "p1", "values": {"client": ["c1"]}}])
    before = (data / "projects.csv").read_text().splitlines()
    write(client, COMPANIES, [{"op": "update", "id": "c1", "values": {"name": "Acme Group"}}])
    after = (data / "projects.csv").read_text().splitlines()
    assert after[1] == "p1,Site,[[c1|Acme Group]]"
    assert after[2:] == before[2:]  # untouched rows keep their bytes
    # A label edited outside Graite is fixed on request.
    (data / "projects.csv").write_text(
        (data / "projects.csv").read_text().replace("Acme Group", "x")
    )
    r = client.post("/api/v1/tables/link-labels", json={"path": COMPANIES})
    assert r.status_code == 200, r.text
    assert "[[c1|Acme Group]]" in (data / "projects.csv").read_text()


def test_reverse_edit_writes_the_forward_side(client: TestClient, settings: Settings) -> None:
    data = setup(client, settings)
    write(client, PROJECTS, [{"op": "update", "id": "p1", "values": {"client": ["c1"]}}])
    # From the company: Beta gets Site (taken from Acme, it links to one) and Audit.
    write(client, COMPANIES, [{"op": "update", "id": "c2", "values": {"projects": ["p1", "p3"]}}])
    text = (data / "projects.csv").read_text()
    assert "p1,Site,[[c2|Beta]]" in text and "p3,Audit,[[c2|Beta]]" in text
    assert (data / "companies.csv").read_text() == "id,name,city\nc1,Acme,Utrecht\nc2,Beta,Delft\n"
    write(client, COMPANIES, [{"op": "update", "id": "c2", "values": {"projects": ["p3"]}}])
    assert "p1,Site,\n" in (data / "projects.csv").read_text()


def test_deleted_and_missing_rows(client: TestClient, settings: Settings) -> None:
    data = setup(client, settings)
    write(
        client,
        PROJECTS,
        [
            {"op": "update", "id": "p1", "values": {"client": ["c1"]}},
            {"op": "update", "id": "p2", "values": {"client": ["c2"]}},
        ],
    )
    # Deleting in Graite removes the links to the row.
    write(client, COMPANIES, [{"op": "delete", "id": "c1"}])
    assert "p1,Site,\n" in (data / "projects.csv").read_text()
    # Deleted outside Graite: the link stays and is flagged, never guessed.
    (data / "companies.csv").write_text("id,name,city\n")
    page = rows(client, PROJECTS)
    assert cells(page, "client")["p2"] == [{"id": "c2", "label": "Beta", "broken": True}]
    assert "links_broken:1" in page["warnings"]
    # A broken link can stay while the cell is edited.
    write(client, PROJECTS, [{"op": "update", "id": "p2", "values": {"client": ["c2"]}}])


def test_rename_table_follows_everywhere(client: TestClient, settings: Settings) -> None:
    data = setup(client, settings)
    write(client, PROJECTS, [{"op": "update", "id": "p1", "values": {"client": ["c1"]}}])
    page = settings.vault / "Clients" / "page.md"
    body = (
        "```graite:table\nsource: _data/companies.csv\nsort: name\n"
        'tabs:\n  _data/projects.csv:\n    filter: title = "Site"\n```\n\n'
        "```graite:table\nsource: _data/projects.csv\ntabs:\n  _data/companies.csv:\n"
        "    sort: city\n```\n\n![[companies.csv]]\n\nSee ![[companies.csv]] inline.\n"
    )
    r = client.put("/api/v1/pages/Clients", json={"body": body})
    assert r.status_code == 200, r.text
    r = client.post("/api/v1/tables/rename", json={"path": COMPANIES, "name": "customers"})
    assert r.status_code == 200, r.text
    assert r.json()["path"] == "Clients/_data/customers.csv"
    assert not (data / "companies.csv").exists() and (data / "customers.schema.json").exists()
    own = json.loads((data / "projects.schema.json").read_text())
    assert own["columns"]["client"]["table"] == "customers"
    text = page.read_text()
    assert "source: _data/customers.csv\nsort: name" in text
    assert "  _data/customers.csv:\n    sort: city" in text
    assert "\n![[customers.csv]]\n" in text and "See ![[companies.csv]] inline." in text
    assert cells(rows(client, PROJECTS), "client")["p1"] == [{"id": "c1", "label": "Acme"}]
    # A taken name is refused.
    r = client.post("/api/v1/tables/rename", json={"path": PROJECTS, "name": "customers"})
    assert r.status_code == 400


def test_links_survive_page_moves(client: TestClient, settings: Settings) -> None:
    setup(client, settings)
    client.post("/api/v1/pages", json={"title": "Work"})
    data = settings.vault / "Work" / "_data"
    data.mkdir()
    (data / "tasks.csv").write_text("id,task\nt1,Call\n")
    client.portal.call(client.app.state.fileops.rescan)  # type: ignore[attr-defined]
    r = client.post(
        "/api/v1/tables/relations",
        json={"path": "Work/_data/tasks.csv", "column": "company", "target": COMPANIES},
    )
    assert r.status_code == 200, r.text
    write(
        client,
        "Work/_data/tasks.csv",
        [{"op": "update", "id": "t1", "values": {"company": ["c2"]}}],
    )
    clients = client.get("/api/v1/pages/Clients").json()
    work = client.get("/api/v1/pages/Work").json()
    r = client.post(
        "/api/v1/workspace/move", json={"page_id": clients["id"], "target_id": work["id"]}
    )
    assert r.status_code == 200, r.text
    # The schema still says Clients/_data/companies.csv; the table id finds it.
    page = rows(client, "Work/_data/tasks.csv")
    assert cells(page, "company")["t1"] == [{"id": "c2", "label": "Beta"}]
    assert not [w for w in page["warnings"] if w.startswith(("links_", "relation_"))]


def test_duplicate_ids_are_reassigned_on_request(client: TestClient, settings: Settings) -> None:
    data = setup(client, settings)
    (data / "companies.csv").write_text("id,name,city\nc1,Acme,Utrecht\nc1,Twin,Delft\n")
    assert "ids_duplicate:1" in rows(client, COMPANIES)["warnings"]
    write(client, COMPANIES, [{"op": "update", "id": "@2", "values": {"city": "Leiden"}}])
    assert (data / "companies.csv").read_text().splitlines()[2] == "c1,Twin,Leiden"
    r = client.post("/api/v1/tables/ensure-ids", json={"path": COMPANIES, "duplicates": True})
    assert r.status_code == 200, r.text
    assert list(r.json()["reassigned"]) == ["c1"]
    assert (data / "companies.csv").read_text().splitlines()[1] == "c1,Acme,Utrecht"
    assert "ids_duplicate:1" not in rows(client, COMPANIES)["warnings"]


def test_renaming_a_relation_column_updates_the_reverse(
    client: TestClient, settings: Settings
) -> None:
    data = setup(client, settings)
    r = client.post(
        "/api/v1/tables/columns",
        json={"path": PROJECTS, "ops": [{"op": "rename", "name": "client", "to": "customer"}]},
    )
    assert r.status_code == 200, r.text
    other = json.loads((data / "companies.schema.json").read_text())
    assert other["columns"]["projects"]["reverse"] == "customer"
    # Deleting the reverse column touches the schema only.
    r = client.post(
        "/api/v1/tables/columns",
        json={"path": COMPANIES, "ops": [{"op": "delete", "name": "projects"}]},
    )
    assert r.status_code == 200, r.text
    assert "projects" not in json.loads((data / "companies.schema.json").read_text())["columns"]
    assert (data / "companies.csv").read_text().startswith("id,name,city\n")
