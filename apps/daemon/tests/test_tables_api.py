"""Tables API and FileOps table writes (D68)."""

from __future__ import annotations

import json
from pathlib import Path

from fastapi.testclient import TestClient
from watchfiles import Change

from graite.config import Settings
from graite.vault.watcher import Watcher, changes_to_tables
from tests.conftest import TOKEN

T = "Atlas/_data/expenses.csv"


def setup_page(client: TestClient, settings: Settings) -> Path:
    client.post("/api/v1/pages", json={"title": "Atlas"})
    data = settings.vault / "Atlas" / "_data"
    data.mkdir()
    (data / "expenses.csv").write_text(
        "date,description,amount\n2026-01-03,Train,120.5\n2026-01-04,Lunch,12\n", encoding="utf-8"
    )
    return data / "expenses.csv"


def test_create_table_and_edit_rows(client: TestClient, settings: Settings) -> None:
    client.post("/api/v1/pages", json={"title": "Atlas"})
    r = client.post(
        "/api/v1/tables", json={"page_path": "Atlas", "name": "tasks", "columns": ["name", "due"]}
    )
    assert r.status_code == 200, r.text
    table = r.json()
    assert table["path"] == "Atlas/_data/tasks.csv" and table["warnings"] == []
    assert [c["name"] for c in table["columns"]] == ["id", "name", "due"]
    # A new table opens with one empty row to type into.
    page = client.get("/api/v1/tables/rows", params={"path": table["path"]}).json()
    assert page["total"] == 1 and page["rows"][0]["cells"][1:] == [None, None]
    first = page["rows"][0]["id"]

    r = client.post(
        "/api/v1/tables/rows",
        json={
            "path": table["path"],
            "base_hash": table["hash"],
            "ops": [
                {"op": "update", "id": first, "values": {"name": "Write spec", "due": "2026-10-01"}}
            ],
        },
    )
    assert r.status_code == 200, r.text
    text = (settings.vault / "Atlas" / "_data" / "tasks.csv").read_text(encoding="utf-8")
    assert text == f"id,name,due\n{first},Write spec,2026-10-01\n"
    assert client.get("/api/v1/tables", params={"page_path": "Atlas"}).json()[0]["row_count"] == 1

    # Adding a field needs no file hash: it never overwrites an edit made meanwhile.
    r = client.post(
        "/api/v1/tables/columns",
        json={"path": table["path"], "ops": [{"op": "add", "name": "Owner"}]},
    )
    assert r.status_code == 200, r.text

    # A taken name gets a number instead of overwriting.
    r = client.post("/api/v1/tables", json={"page_path": "Atlas", "name": "tasks"})
    assert r.json()["path"] == "Atlas/_data/tasks 2.csv"


def test_existing_csv_without_ids_is_untouched_until_edited(
    client: TestClient, settings: Settings
) -> None:
    csv_file = setup_page(client, settings)
    before = csv_file.read_bytes()
    page = client.get("/api/v1/tables/rows", params={"path": T, "sort": "amount"}).json()
    assert page["warnings"] == ["ids_missing"] and [r["id"] for r in page["rows"]] == ["@2", "@1"]
    assert csv_file.read_bytes() == before
    r = client.post(
        "/api/v1/tables/rows",
        json={
            "path": T,
            "base_hash": page["hash"],
            "ops": [{"op": "update", "id": "@2", "values": {"amount": 13}, "base": {"amount": 12}}],
        },
    )
    assert r.status_code == 200, r.text
    lines = csv_file.read_text(encoding="utf-8").splitlines()
    assert lines[0] == "id,date,description,amount" and lines[2].endswith(",2026-01-04,Lunch,13")
    assert client.get("/api/v1/tables/rows", params={"path": T}).json()["warnings"] == []
    versions = list((settings.vault / ".graite" / "versions" / "tables").rglob("*.csv"))
    assert [v.read_bytes() for v in versions] == [before]


def test_stale_edit_conflicts_per_row(client: TestClient, settings: Settings) -> None:
    csv_file = setup_page(client, settings)
    client.post("/api/v1/tables/ensure-ids", json={"path": T})
    page = client.get("/api/v1/tables/rows", params={"path": T}).json()
    first, second = (r["id"] for r in page["rows"])
    # Someone else changes the first row in another editor.
    csv_file.write_text(csv_file.read_text().replace("Train", "Tram"), encoding="utf-8")
    ok = client.post(
        "/api/v1/tables/rows",
        json={
            "path": T,
            "base_hash": page["hash"],
            "ops": [
                {"op": "update", "id": second, "values": {"amount": 1}, "base": {"amount": 12}}
            ],
        },
    )
    assert ok.status_code == 200, ok.text  # an untouched row still saves
    r = client.post(
        "/api/v1/tables/rows",
        json={
            "path": T,
            "base_hash": page["hash"],
            "ops": [
                {
                    "op": "update",
                    "id": first,
                    "values": {"description": "Bus"},
                    "base": {"description": "Train"},
                }
            ],
        },
    )
    assert r.status_code == 409
    assert r.json()["conflicts"] == [{"id": first, "reason": "changed", "column": "description"}]
    assert "Tram" in csv_file.read_text()


def test_bad_filter_and_paths_are_400(client: TestClient, settings: Settings) -> None:
    setup_page(client, settings)
    r = client.get("/api/v1/tables/rows", params={"path": T, "filter": "nope = 1"})
    assert r.status_code == 400 and "nope" in r.json()["detail"]
    r = client.get("/api/v1/tables/rows", params={"path": "Atlas/_data/../../x.csv"})
    assert r.status_code == 400
    r = client.get("/api/v1/tables/rows", params={"path": "Atlas/_data/missing.csv"})
    assert r.status_code == 404


def test_import_columns_schema_and_resolve(client: TestClient, settings: Settings) -> None:
    client.post("/api/v1/pages", json={"title": "Atlas"})
    r = client.post(
        "/api/v1/tables/import",
        params={"page_path": "Atlas", "name": "people.csv"},
        content=b"name;age\r\nAda;36\r\n",
    )
    assert r.status_code == 200, r.text
    rel = r.json()["path"]
    assert (settings.vault / rel).read_bytes().startswith(b"id;name;age\r\n")
    r = client.post(
        "/api/v1/tables/columns",
        json={"path": rel, "ops": [{"op": "rename", "name": "age", "to": "years"}]},
    )
    assert r.status_code == 200, r.text
    schema_file = settings.vault / "Atlas" / "_data" / "people.schema.json"
    schema_file.write_text('{"display": "name", "columns": {"years": {"type": "integer"}}}')
    r = client.patch(
        "/api/v1/tables/schema",
        json={"path": rel, "schema": {"columns": {"years": {"width": 90}, "name": {"wrap": True}}}},
    )
    assert r.status_code == 200, r.text
    assert r.json()["columns"][2] == {
        "name": "years",
        "type": "number",  # "integer" in the file, read as number
        "options": [],
        "colors": {},
        "currency": None,
        "width": 90,
        "wrap": False,
        "invalid": 0,
        "table": None,
        "table_id": None,
        "cardinality": None,
        "reverse": None,
        "via": None,
        "target": None,
    }
    assert json.loads(schema_file.read_text()) == {
        "display": "name",
        "columns": {"years": {"type": "integer", "width": 90}, "name": {"wrap": True}},
    }
    assert r.json()["columns"][1]["wrap"] is True
    r = client.get("/api/v1/tables/resolve", params={"page_path": "Atlas", "source": "people"})
    assert r.json() == {"path": rel}


def test_external_csv_edit_is_announced(client: TestClient, settings: Settings) -> None:
    csv_file = setup_page(client, settings)
    client.get("/api/v1/tables/rows", params={"path": T})
    state = client.app.state  # type: ignore[attr-defined]
    watcher = Watcher(settings.vault, state.fileops, state.events)
    schema = csv_file.with_name("expenses.schema.json")
    assert changes_to_tables(
        settings.vault,
        {
            (Change.modified, str(csv_file)),
            (Change.added, str(schema)),
            (Change.added, str(settings.vault / "Atlas" / "_assets" / "x.csv")),
        },
    ) == [T]
    with client.websocket_connect(f"/events?token={TOKEN}") as ws:
        csv_file.write_text(csv_file.read_text() + "2026-02-01,Taxi,30\n", encoding="utf-8")
        client.portal.call(watcher.handle, {(Change.modified, str(csv_file))})
        while True:
            event = json.loads(ws.receive_text())
            if event["type"] == "table_changed":
                break
    assert event["data"]["path"] == T and event["data"]["actor"] == "external"
    assert client.get("/api/v1/tables/rows", params={"path": T}).json()["total"] == 3


def test_tables_follow_page_moves(client: TestClient, settings: Settings) -> None:
    setup_page(client, settings)
    client.post("/api/v1/pages", json={"title": "Archive"})
    state = client.app.state  # type: ignore[attr-defined]
    client.portal.call(state.fileops.rescan)
    assert [t["path"] for t in client.get("/api/v1/tables").json()] == [T]
    atlas = client.get("/api/v1/pages/Atlas").json()
    archive = client.get("/api/v1/pages/Archive").json()
    r = client.post(
        "/api/v1/workspace/move", json={"page_id": atlas["id"], "target_id": archive["id"]}
    )
    assert r.status_code == 200, r.text
    assert [t["path"] for t in client.get("/api/v1/tables").json()] == [
        "Archive/Atlas/_data/expenses.csv"
    ]


def test_renaming_and_removing_an_option_updates_every_row(
    client: TestClient, settings: Settings
) -> None:
    client.post("/api/v1/pages", json={"title": "Atlas"})
    data = settings.vault / "Atlas" / "_data"
    data.mkdir()
    csv_file = data / "tasks.csv"
    csv_file.write_bytes(b"id,name,status,tags\r\n1,A,Doing,x; y\r\n2,B,Done,y\r\n3,C,Todo,\r\n")
    (data / "tasks.schema.json").write_text(
        '{"columns": {"status": {"type": "status", "options": ["Todo", "Doing", "Done"],'
        ' "colors": {"Doing": "blue"}}, "tags": {"type": "multi_select"}}}'
    )
    path = "Atlas/_data/tasks.csv"
    r = client.post(
        "/api/v1/tables/options",
        json={"path": path, "column": "status", "old": "Doing", "new": "In progress"},
    )
    assert r.status_code == 200, r.text
    r = client.post("/api/v1/tables/options", json={"path": path, "column": "tags", "old": "y"})
    assert r.status_code == 200, r.text
    assert csv_file.read_bytes() == (
        b"id,name,status,tags\r\n1,A,In progress,x\r\n2,B,Done,\r\n3,C,Todo,\r\n"
    )
    schema = json.loads((data / "tasks.schema.json").read_text())
    assert schema["columns"]["status"]["options"] == ["Todo", "In progress", "Done"]
    assert schema["columns"]["status"]["colors"] == {"In progress": "blue"}
    info = client.get("/api/v1/tables/rows", params={"path": path}).json()
    status = next(c for c in info["columns"] if c["name"] == "status")
    assert status["colors"]["In progress"] == "blue" and status["colors"]["Done"] == "green"
    r = client.get("/api/v1/tables/rows", params={"path": path, "filter": "tags = x"})
    assert r.json()["total"] == 1


def test_type_check_counts_values_that_do_not_fit(client: TestClient, settings: Settings) -> None:
    client.post("/api/v1/pages", json={"title": "Atlas"})
    data = settings.vault / "Atlas" / "_data"
    data.mkdir()
    (data / "t.csv").write_text("id,v\n1,12\n2,abc\n3,\n4,€3\n5,n/a\n", encoding="utf-8")
    path = "Atlas/_data/t.csv"
    r = client.get(
        "/api/v1/tables/check-type", params={"path": path, "column": "v", "type": "number"}
    )
    assert r.json() == {"total": 4, "invalid": 2, "examples": ["abc", "n/a"]}
    r = client.get("/api/v1/tables/check-type", params={"path": path, "column": "v", "type": "wat"})
    assert r.status_code == 400
    client.patch(
        "/api/v1/tables/schema",
        json={"path": path, "schema": {"columns": {"v": {"type": "number"}}}},
    )
    column = client.get("/api/v1/tables/rows", params={"path": path}).json()["columns"][1]
    assert column["type"] == "number" and column["invalid"] == 2
    # Nothing in the file changed.
    assert (data / "t.csv").read_text(encoding="utf-8").endswith("5,n/a\n")
