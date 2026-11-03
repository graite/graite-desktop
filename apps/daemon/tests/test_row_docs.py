"""Row documents (D80): `<page>/_data/<table>/<row id>.md`, and the panel schema."""

from __future__ import annotations

from fastapi.testclient import TestClient

from graite.config import Settings
from graite.tables import schema as sch

T = "CRM/_data/deals.csv"


def setup(client: TestClient, settings: Settings) -> None:
    client.post("/api/v1/pages", json={"title": "CRM"})
    data = settings.vault / "CRM" / "_data"
    data.mkdir()
    (data / "deals.csv").write_text("id;name\nd1;Pilot\nd2;Audit\n", encoding="utf-8")


def test_row_document_lifecycle(client: TestClient, settings: Settings) -> None:
    setup(client, settings)
    r = client.get("/api/v1/tables/row-doc", params={"path": T, "id": "d1"})
    assert r.json() == {"body": "", "hash": "", "exists": False}
    # Saving nothing makes no file.
    body = {"path": T, "id": "d1", "body": "", "base_hash": "", "title": "Pilot"}
    assert client.put("/api/v1/tables/row-doc", json=body).json()["exists"] is False
    assert not (settings.vault / "CRM/_data/deals").exists()

    body["body"] = "# Notes\n\nThey want a demo.\n"
    r = client.put("/api/v1/tables/row-doc", json=body)
    assert r.status_code == 200, r.text
    saved = r.json()
    f = settings.vault / "CRM/_data/deals/d1.md"
    text = f.read_text(encoding="utf-8")
    assert "title: Pilot" in text and "row: d1" in text and "They want a demo." in text
    # A stale hash is a conflict, with the text on disk.
    r = client.put("/api/v1/tables/row-doc", json={**body, "body": "x", "base_hash": "stale"})
    assert r.status_code == 409 and "demo" in r.json()["body"]
    r = client.put(
        "/api/v1/tables/row-doc", json={**body, "body": "v2", "base_hash": saved["hash"]}
    )
    assert r.status_code == 200 and r.json()["body"] == "v2\n"

    page = client.get("/api/v1/tables/rows", params={"path": T}).json()
    assert page["docs"] == ["d1"]

    # Paths cannot escape the folder.
    r = client.get("/api/v1/tables/row-doc", params={"path": T, "id": "../../page"})
    assert r.status_code == 400

    # Renaming the table takes its documents along.
    r = client.post("/api/v1/tables/rename", json={"path": T, "name": "opportunities"})
    assert r.status_code == 200, r.text
    assert (settings.vault / "CRM/_data/opportunities/d1.md").is_file()
    T2 = "CRM/_data/opportunities.csv"
    # Deleting the row moves its document to the trash.
    r = client.post("/api/v1/tables/rows", json={"path": T2, "ops": [{"op": "delete", "id": "d1"}]})
    assert r.status_code == 200, r.text
    assert not (settings.vault / "CRM/_data/opportunities/d1.md").exists()
    assert list((settings.vault / ".graite/trash/rows").rglob("*-d1.md"))


def test_panel_schema() -> None:
    good = (
        '{"columns": {"deal": {"type": "relation", "table": "deals",'
        ' "panel": {"as": "list", "show": ["stage"]}}}}'
    )
    schema, problems = sch.load(good)
    assert problems == []
    columns = sch.columns_for(["id", "deal"], [], schema)
    assert columns[1].panel == {"as": "list", "show": ["stage"]}
    _, problems = sch.load(
        '{"columns": {"d": {"type": "relation", "table": "x", "panel": {"as": "grid"}}}}'
    )
    assert problems and "panel" in problems[0]


def test_document_template_for_new_records(client: TestClient, settings: Settings) -> None:
    setup(client, settings)
    (settings.vault / "CRM/_data/deals.schema.json").write_text(
        '{"document_template": "## Goal\\n\\n## Next steps"}', encoding="utf-8"
    )
    r = client.get("/api/v1/tables/row-doc", params={"path": T, "id": "d2"})
    assert r.json() == {"body": "## Goal\n\n## Next steps\n", "hash": "", "exists": False}
    assert not (settings.vault / "CRM/_data/deals").exists()
    _, problems = sch.load('{"document_template": 3}')
    assert problems and "document_template" in problems[0]
