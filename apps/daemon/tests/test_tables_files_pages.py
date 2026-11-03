"""File and page columns (D76): attachments and page links in table cells."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

from graite.config import Settings
from graite.tables import schema as sch

T = "Books/_data/receipts.csv"


def test_cells_read_and_write() -> None:
    stored = "0" * 32 + "-receipt.pdf"
    cell = sch.to_cell("file", [{"file": stored, "name": "Receipt | March.pdf"}])
    assert cell == f"[[{stored}|Receipt March.pdf]]"
    assert sch.to_json("file", cell) == [{"file": stored, "name": "Receipt March.pdf"}]
    # Without a label, the name is the stored name minus its unique prefix.
    assert sch.to_json("file", f"[[{stored}]]") == [{"file": stored, "name": "receipt.pdf"}]
    with pytest.raises(ValueError, match="not an attachment"):
        sch.to_cell("file", ["../../etc/passwd"])

    cell = sch.to_cell("page", [{"path": "Clients/Acme", "title": "Acme"}, "Notes/Kickoff"])
    assert cell == "[[Clients/Acme|Acme]] [[Notes/Kickoff]]"
    assert sch.to_json("page", cell) == [
        {"path": "Clients/Acme", "title": "Acme"},
        {"path": "Notes/Kickoff", "title": "Kickoff"},
    ]
    with pytest.raises(ValueError, match="not a page path"):
        sch.to_cell("page", ["../outside"])
    assert sch.fits("page", "[[A|B]] [[C]]") and not sch.fits("page", "plain words here")


def setup(client: TestClient, settings: Settings) -> Path:
    client.post("/api/v1/pages", json={"title": "Books"})
    client.post("/api/v1/pages", json={"title": "Clients"})
    client.post("/api/v1/pages", json={"title": "Acme", "parent_path": "Clients"})
    data = settings.vault / "Books" / "_data"
    data.mkdir()
    (data / "receipts.csv").write_text("id;supplier;scan;client\nr1;Shop;;\n", encoding="utf-8")
    (data / "receipts.schema.json").write_text(
        json.dumps({"columns": {"scan": {"type": "file"}, "client": {"type": "page"}}}),
        encoding="utf-8",
    )
    return data / "receipts.csv"


def cells(client: TestClient) -> dict[str, Any]:
    page = client.get("/api/v1/tables/rows", params={"path": T}).json()
    return dict(zip(page["visible"], page["rows"][0]["cells"], strict=True))


def test_attach_a_file(client: TestClient, settings: Settings) -> None:
    csv = setup(client, settings)
    r = client.post(
        "/api/v1/tables/files",
        params={"path": T, "name": "Bonnetje 2026-03 Albert Heijn.pdf"},
        content=b"%PDF-1.4 test",
    )
    assert r.status_code == 200, r.text
    stored = r.json()["file"]
    assert r.json()["name"] == "Bonnetje 2026-03 Albert Heijn.pdf"
    assert (settings.vault / "Books" / "_assets" / stored).read_bytes() == b"%PDF-1.4 test"

    r = client.post(
        "/api/v1/tables/rows",
        json={"path": T, "ops": [{"op": "update", "id": "r1", "values": {"scan": [r.json()]}}]},
    )
    assert r.status_code == 200, r.text
    assert f"[[{stored}|Bonnetje 2026-03 Albert Heijn.pdf]]" in csv.read_text(encoding="utf-8")
    assert cells(client)["scan"] == [{"file": stored, "name": "Bonnetje 2026-03 Albert Heijn.pdf"}]

    # The page's attachments list counts the table as a use of the file.
    page_id = client.get("/api/v1/pages/Books").json()["id"]
    listed = client.get("/api/v1/media/attachments", params={"page_id": page_id}).json()
    assert [(a["file"], a["referenced"]) for a in listed] == [(stored, True)]

    r = client.get("/api/v1/tables/files/location", params={"path": T, "file": stored})
    assert r.status_code == 200 and r.json()["path"].endswith(stored)
    r = client.get("/api/v1/tables/files/content", params={"path": T, "file": stored})
    assert r.content == b"%PDF-1.4 test"

    r = client.post("/api/v1/tables/files", params={"path": T, "name": "run.exe"}, content=b"MZ")
    assert r.status_code == 400
    r = client.get("/api/v1/tables/files/content", params={"path": T, "file": "../page.md"})
    assert r.status_code == 400


def test_page_links_show_live_titles_and_follow_moves(
    client: TestClient, settings: Settings
) -> None:
    csv = setup(client, settings)
    r = client.post(
        "/api/v1/tables/rows",
        json={
            "path": T,
            "ops": [{"op": "update", "id": "r1", "values": {"client": ["Clients/Acme"]}}],
        },
    )
    assert r.status_code == 200, r.text
    assert cells(client)["client"][0]["title"] == "Acme"

    # Renaming the page renames its folder; the cell follows with the new title.
    r = client.patch("/api/v1/pages/Clients/Acme", json={"title": "Acme BV"})
    assert r.status_code == 200, r.text
    assert "[[Clients/Acme BV|Acme BV]]" in csv.read_text(encoding="utf-8")
    assert cells(client)["client"] == [{"path": "Clients/Acme BV", "title": "Acme BV"}]

    # Moving it to the top level: the link follows again.
    acme = client.get("/api/v1/pages/Clients/Acme BV").json()["id"]
    r = client.post(
        "/api/v1/workspace/move", json={"page_id": acme, "target_id": None, "position": "inside"}
    )
    assert r.status_code == 200, r.text
    assert "[[Acme BV|Acme BV]]" in csv.read_text(encoding="utf-8")

    # A page that is gone is a broken link, and SQL sees page links.
    client.delete("/api/v1/pages/Acme BV")
    assert cells(client)["client"][0].get("broken") is True
    r = client.post(
        "/api/v1/tables/query",
        json={"page_path": "Books", "sql": "SELECT row_id, page_path FROM page_links"},
    )
    assert r.json()["rows"] == [["r1", "Acme BV"]]
