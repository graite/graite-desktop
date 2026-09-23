from __future__ import annotations

import json
from pathlib import Path

from fastapi.testclient import TestClient

from graite.config import Settings
from tests.conftest import TOKEN


def _read(settings: Settings, rel: str) -> str:
    return (settings.vault / rel / "page.md").read_text(encoding="utf-8")


def test_create_root_and_child(client: TestClient, settings: Settings) -> None:
    r = client.post("/api/v1/pages", json={"title": "Projects", "icon": "📁"})
    assert r.status_code == 201, r.text
    root = r.json()
    assert root["path"] == "Projects" and root["icon"] == "📁" and root["body"] == ""
    text = _read(settings, "Projects")
    assert text.startswith("---\nid: ")
    assert set(root["frontmatter"]) == {"id", "title", "icon", "created", "updated"}
    assert "\ntitle: Projects\nicon: 📁\ncreated: '" in text

    r = client.post("/api/v1/pages", json={"parent_path": "Projects"})
    assert r.status_code == 201
    child = r.json()
    assert child["path"] == "Projects/Untitled" and child["title"] == "Untitled"

    tree = client.get("/api/v1/vault/tree").json()
    assert [n["path"] for n in tree] == ["Projects"]
    assert [c["path"] for c in tree[0]["children"]] == ["Projects/Untitled"]


def test_create_collision_gets_suffix(client: TestClient) -> None:
    client.post("/api/v1/pages", json={"title": "Dup"})
    r = client.post("/api/v1/pages", json={"title": "Dup"})
    assert r.json()["path"] == "Dup 2"


def test_create_missing_parent_404_and_bad_path_400(client: TestClient) -> None:
    assert client.post("/api/v1/pages", json={"parent_path": "Nope"}).status_code == 404
    assert client.post("/api/v1/pages", json={"parent_path": "../x"}).status_code == 400
    assert client.get("/api/v1/pages/.graite/index").status_code == 400
    assert client.get("/api/v1/pages/Missing").status_code == 404


def test_put_roundtrip_conflict_and_updated_bump(client: TestClient, settings: Settings) -> None:
    doc = client.post("/api/v1/pages", json={"title": "Notes"}).json()
    r = client.put(
        "/api/v1/pages/Notes", json={"body": "# Hello\n\nworld", "base_hash": doc["hash"]}
    )
    assert r.status_code == 200
    new_hash = r.json()["hash"]
    assert new_hash != doc["hash"]
    got = client.get("/api/v1/pages/Notes").json()
    assert got["body"] == "# Hello\n\nworld\n" and got["hash"] == new_hash
    assert got["frontmatter"]["updated"] >= doc["frontmatter"]["updated"]
    assert _read(settings, "Notes").endswith("---\n\n# Hello\n\nworld\n")

    # stale base hash -> 409 with the disk state
    r = client.put("/api/v1/pages/Notes", json={"body": "other", "base_hash": doc["hash"]})
    assert r.status_code == 409
    assert r.json() == {"detail": "conflict", "hash": new_hash, "body": "# Hello\n\nworld\n"}

    # identical body is a no-op: same hash, no version snapshot
    r = client.put(
        "/api/v1/pages/Notes", json={"body": "# Hello\n\nworld\n", "base_hash": new_hash}
    )
    assert r.json()["hash"] == new_hash


def test_versions_snapshot_on_body_change(client: TestClient, settings: Settings) -> None:
    doc = client.post("/api/v1/pages", json={"title": "V"}).json()
    client.put("/api/v1/pages/V", json={"body": "one"})
    client.put("/api/v1/pages/V", json={"body": "two"})
    versions = sorted((settings.graite_dir / "versions" / doc["id"]).glob("*.md"))
    assert len(versions) == 2
    assert versions[1].read_text().endswith("\n\none\n")


def test_patch_icon_keeps_body_and_clear_icon(client: TestClient, settings: Settings) -> None:
    client.post("/api/v1/pages", json={"title": "Icons"})
    client.put("/api/v1/pages/Icons", json={"body": "body text"})
    before = _read(settings, "Icons").split("---\n\n", 1)[1]
    r = client.patch("/api/v1/pages/Icons", json={"icon": "🚀"})
    assert r.json()["icon"] == "🚀"
    assert "\nicon: 🚀\n" in _read(settings, "Icons")
    assert _read(settings, "Icons").split("---\n\n", 1)[1] == before
    r = client.patch("/api/v1/pages/Icons", json={"icon": None})
    assert r.json()["icon"] is None and "icon:" not in _read(settings, "Icons")
    # title omitted entirely -> untouched
    assert r.json()["title"] == "Icons"


def test_rename_moves_folder_and_rewrites_parent_link(
    client: TestClient, settings: Settings
) -> None:
    client.post("/api/v1/pages", json={"title": "Parent"})
    client.post("/api/v1/pages", json={"parent_path": "Parent", "title": "Old"})
    client.put(
        "/api/v1/pages/Parent",
        json={"body": "Intro\n\n[[Old]]\n\nSee [[Old|alias]] and [[Old#h]] and [[Older]]"},
    )
    r = client.patch("/api/v1/pages/Parent/Old", json={"title": "New Name"})
    assert r.status_code == 200
    assert r.json()["path"] == "Parent/New Name" and r.json()["title"] == "New Name"
    assert (settings.vault / "Parent" / "New Name" / "page.md").is_file()
    assert not (settings.vault / "Parent" / "Old").exists()
    parent = client.get("/api/v1/pages/Parent").json()["body"]
    assert (
        parent
        == "Intro\n\n[[New Name]]\n\nSee [[New Name|alias]] and [[New Name#h]] and [[Older]]\n"
    )
    tree = client.get("/api/v1/vault/tree").json()
    assert tree[0]["children"][0]["path"] == "Parent/New Name"


def test_trash_page(client: TestClient, settings: Settings) -> None:
    client.post("/api/v1/pages", json={"title": "Gone"})
    client.post("/api/v1/pages", json={"parent_path": "Gone", "title": "Child"})
    r = client.delete("/api/v1/pages/Gone")
    assert r.status_code == 200
    trash_id = r.json()["trash_id"]
    assert trash_id.endswith("-Gone")
    assert (settings.graite_dir / "trash" / trash_id / "Child" / "page.md").is_file()
    assert client.get("/api/v1/vault/tree").json() == []
    assert client.delete("/api/v1/pages/Gone").status_code == 404


def test_resolve_link(client: TestClient) -> None:
    client.post("/api/v1/pages", json={"title": "A"})
    client.post("/api/v1/pages", json={"parent_path": "A", "title": "Child: One"})
    client.post("/api/v1/pages", json={"title": "Elsewhere"})
    assert client.post("/api/v1/pages/A/resolve-link", json={"target": "Child: One"}).json() == {
        "path": "A/Child- One"
    }
    assert client.post("/api/v1/pages/A/resolve-link", json={"target": "child- one"}).json() == {
        "path": "A/Child- One"
    }
    assert client.post(
        "/api/v1/pages/A/resolve-link", json={"target": "Elsewhere#Heading"}
    ).json() == {"path": "Elsewhere"}
    assert (
        client.post("/api/v1/pages/A/resolve-link", json={"target": "Nowhere"}).status_code == 404
    )


def test_reserved_folders_are_not_pages(client: TestClient, settings: Settings) -> None:
    client.post("/api/v1/pages", json={"title": "P"})
    (settings.vault / "P" / "_attachments").mkdir()
    (settings.vault / "P" / "_attachments" / "page.md").write_text("---\ntitle: nope\n---\n")
    (settings.vault / "Plain").mkdir()
    (settings.vault / "Plain" / "Inner").mkdir()
    (settings.vault / "Plain" / "Inner" / "page.md").write_text("---\ntitle: Inner\n---\n\nhi\n")
    client.post("/api/v1/pages", json={"title": "Trigger rescan"})
    tree = client.get("/api/v1/vault/tree").json()
    paths = sorted(n["path"] for n in tree)
    assert paths == ["P", "Plain/Inner", "Trigger rescan"]
    assert tree[0]["children"] == []


def test_events_on_mutations(client: TestClient) -> None:
    def next_event(ws):  # type: ignore[no-untyped-def]
        while True:
            event = json.loads(ws.receive_text())
            if event["type"] not in ("job_update", "index_progress"):
                return event

    with client.websocket_connect(f"/events?token={TOKEN}") as ws:
        client.post("/api/v1/pages", json={"title": "Ev"})
        assert next_event(ws) == {
            "type": "tree_changed",
            "data": {"reason": "create", "path": "Ev", "actor": "ui", "request_id": None},
        }
        r = client.put("/api/v1/pages/Ev", json={"body": "x"})
        assert next_event(ws) == {
            "type": "file_changed",
            "data": {"path": "Ev", "hash": r.json()["hash"], "actor": "ui", "request_id": None},
        }
        # The first text on an empty page flips its sidebar icon, so the tree is told too.
        assert next_event(ws) == {
            "type": "tree_changed",
            "data": {"reason": "content", "path": "Ev", "request_id": None},
        }
        client.patch("/api/v1/pages/Ev", json={"icon": "🍀"})
        assert next_event(ws)["data"]["reason"] == "icon"


def test_unknown_schema_preserves_activity_history(tmp_path: Path) -> None:
    import sqlite3

    import pytest

    from graite.index import db

    path = tmp_path / "index.sqlite"
    conn = db.connect(path)
    conn.execute("UPDATE meta SET value='0' WHERE key='schema_version'")
    conn.execute("INSERT INTO activities (ts, actor, action) VALUES ('t', 'a', 'x')")
    conn.close()
    with pytest.raises(ValueError, match="Unsupported"):
        db.connect(path)
    with sqlite3.connect(path) as preserved:
        assert preserved.execute("SELECT count(*) FROM activities").fetchone()[0] == 1


def test_tree_reports_whether_pages_have_content(client) -> None:
    page = client.post("/api/v1/pages", json={"title": "Note"}).json()
    assert client.get("/api/v1/vault/tree").json()[0]["has_content"] is False
    client.put(
        f"/api/v1/pages/{page['path']}", json={"body": "Hello", "base_hash": page["hash"]}
    ).raise_for_status()
    assert client.get("/api/v1/vault/tree").json()[0]["has_content"] is True


def test_tree_flags_pages_that_hold_a_view(client) -> None:
    page = client.post("/api/v1/pages", json={"title": "Projects"}).json()
    assert client.get("/api/v1/vault/tree").json()[0]["has_view"] is False
    client.put(
        f"/api/v1/pages/{page['path']}",
        json={"body": "Intro\n\n```graite:view\nview: kanban\n```\n", "base_hash": page["hash"]},
    ).raise_for_status()
    assert client.get("/api/v1/vault/tree").json()[0]["has_view"] is True


def test_page_location(client: TestClient, settings: Settings) -> None:
    client.post("/api/v1/pages", json={"title": "Projects"})
    client.post("/api/v1/pages", json={"parent_path": "Projects", "title": "location"})
    r = client.get("/api/v1/vault/location", params={"path": "Projects/location"})
    assert r.status_code == 200, r.text
    assert r.json() == {
        "folder": str(settings.vault / "Projects" / "location"),
        "file": str(settings.vault / "Projects" / "location" / "page.md"),
    }
    # A child page named "location" is still a page, not this route.
    assert client.get("/api/v1/pages/Projects/location").json()["title"] == "location"
    assert client.get("/api/v1/vault/location", params={"path": "Nope"}).status_code == 404
    assert client.get("/api/v1/vault/location", params={"path": "../etc"}).status_code == 400
