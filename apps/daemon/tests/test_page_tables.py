"""Tables that belong to a page follow it (D83): a table named like its page is renamed with
the page, and trashing a page drops the relations other tables have to its tables (restoring
the page brings them back)."""

from __future__ import annotations

import json
from typing import Any

from fastapi.testclient import TestClient

from graite.config import Settings


def page(client: TestClient, title: str, parent: str | None = None) -> dict[str, Any]:
    r = client.post("/api/v1/pages", json={"title": title, "parent_path": parent})
    assert r.status_code in (200, 201), r.text
    return dict(r.json())


def table(client: TestClient, page_path: str, name: str, columns: list[str]) -> str:
    r = client.post(
        "/api/v1/tables", json={"page_path": page_path, "name": name, "columns": columns}
    )
    assert r.status_code in (200, 201), r.text
    return str(r.json()["path"])


def test_a_table_named_like_its_page_follows_a_rename(
    client: TestClient, settings: Settings
) -> None:
    doc = page(client, "Untitled")
    rel = table(client, "Untitled", "Untitled", ["name", "notes"])
    other = table(client, "Untitled", "extra", ["name"])
    body = "```graite:table\nviews:\n  - name: Table\n    source: _data/Untitled.csv\n```\n"
    r = client.put(f"/api/v1/pages/{doc['path']}", json={"body": body, "base_hash": doc["hash"]})
    assert r.status_code == 200, r.text
    r = client.patch("/api/v1/pages/Untitled", json={"title": "Books"})
    assert r.status_code == 200, r.text
    assert r.json()["path"] == "Books"
    data = settings.vault / "Books" / "_data"
    assert (data / "Books.csv").is_file() and not (data / "Untitled.csv").exists()
    assert (data / "extra.csv").is_file(), other
    text = (settings.vault / "Books" / "page.md").read_text(encoding="utf-8")
    assert "source: _data/Books.csv" in text, text
    assert rel.endswith("Untitled.csv")


def link_books_to_authors(client: TestClient) -> tuple[str, str]:
    page(client, "Authors")
    page(client, "Library")
    authors = table(client, "Authors", "authors", ["name"])
    books = table(client, "Library", "books", ["name", "year"])
    r = client.post(
        "/api/v1/tables/relations",
        json={
            "path": books,
            "column": "author",
            "target": authors,
            "cardinality": "one",
            "reverse": "books",
        },
    )
    assert r.status_code == 200, r.text
    r = client.post(
        "/api/v1/tables/rows",
        json={"path": authors, "ops": [{"op": "insert", "id": "a1", "values": {"name": "Ada"}}]},
    )
    assert r.status_code == 200, r.text
    r = client.post(
        "/api/v1/tables/rows",
        json={
            "path": books,
            "ops": [
                {
                    "op": "insert",
                    "id": "b1",
                    "values": {"name": "Notes", "year": 1843, "author": ["a1"]},
                }
            ],
        },
    )
    assert r.status_code == 200, r.text
    return authors, books


def columns_of(client: TestClient, rel: str) -> dict[str, Any]:
    r = client.get("/api/v1/tables/rows", params={"path": rel})
    assert r.status_code == 200, r.text
    body = r.json()
    names = [c["name"] for c in body["columns"]]
    rows = {
        row["id"]: dict(zip(body["visible"], row["cells"], strict=False)) for row in body["rows"]
    }
    return {"names": names, "rows": rows, "warnings": body["warnings"]}


def trash(client: TestClient, path: str) -> str:
    r = client.delete(f"/api/v1/pages/{path}")
    assert r.status_code == 200, r.text
    return str(r.json()["trash_id"])


def restore(client: TestClient, trash_id: str) -> None:
    r = client.post(f"/api/v1/trash/{trash_id}/restore")
    assert r.status_code == 200, r.text


def test_trashing_a_page_drops_links_to_its_tables_and_restore_brings_them_back(
    client: TestClient, settings: Settings
) -> None:
    authors, books = link_books_to_authors(client)
    assert "author" in columns_of(client, books)["names"]

    trash_id = trash(client, "Authors")
    after = columns_of(client, books)
    assert "author" not in after["names"] and after["warnings"] == []
    assert after["rows"]["b1"]["name"] == "Notes" and after["rows"]["b1"]["year"] == 1843
    header = (settings.vault / books).read_text(encoding="utf-8").splitlines()[0]
    assert "author" not in header
    schema = json.loads((settings.vault / "Library/_data/books.schema.json").read_text())
    assert "author" not in schema.get("columns", {})

    restore(client, trash_id)
    back = columns_of(client, books)
    assert "author" in back["names"] and back["warnings"] == []
    assert [link["id"] for link in back["rows"]["b1"]["author"]] == ["a1"]
    reverse = columns_of(client, authors)
    assert [link["id"] for link in reverse["rows"]["a1"]["books"]] == ["b1"]


def test_trashing_the_linking_page_drops_the_back_links(client: TestClient) -> None:
    authors, _ = link_books_to_authors(client)
    assert "books" in columns_of(client, authors)["names"]
    trash_id = trash(client, "Library")
    after = columns_of(client, authors)
    assert "books" not in after["names"] and after["warnings"] == []
    restore(client, trash_id)
    assert "books" in columns_of(client, authors)["names"]


def test_links_within_the_trashed_page_are_kept(client: TestClient) -> None:
    page(client, "Shelf")
    authors = table(client, "Shelf", "authors", ["name"])
    books = table(client, "Shelf", "books", ["name"])
    r = client.post(
        "/api/v1/tables/relations",
        json={"path": books, "column": "author", "target": authors, "reverse": "books"},
    )
    assert r.status_code == 200, r.text
    restore(client, trash(client, "Shelf"))
    assert "author" in columns_of(client, books)["names"]
    assert "books" in columns_of(client, authors)["names"]
