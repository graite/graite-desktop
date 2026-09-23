from __future__ import annotations

import json

from fastapi.testclient import TestClient

from graite.config import Settings

H = {"Content-Type": "application/json"}


def _create(client: TestClient, title: str, parent: str | None = None) -> str:
    r = client.post("/api/v1/pages", json={"title": title, "parent_path": parent})
    assert r.status_code == 201, r.text
    return str(r.json()["path"])


def _tree_paths(client: TestClient) -> list[str]:
    out: list[str] = []

    def walk(nodes: list[dict]) -> None:
        for n in nodes:
            out.append(n["path"])
            walk(n["children"])

    walk(client.get("/api/v1/vault/tree").json())
    return sorted(out)


def test_trash_list_and_restore_to_origin(client: TestClient, settings: Settings) -> None:
    _create(client, "Projects")
    child = _create(client, "Atlas", "Projects")
    client.patch(f"/api/v1/pages/{child}", json={"icon": "🧭"})
    r = client.delete(f"/api/v1/pages/{child}")
    trash_id = r.json()["trash_id"]
    assert (settings.vault / ".graite" / "trash" / trash_id / ".origin.json").is_file()

    entries = client.get("/api/v1/trash").json()
    assert entries == [
        {
            "trash_id": trash_id,
            "path": "Projects/Atlas",
            "title": "Atlas",
            "trashed_at": entries[0]["trashed_at"],
            "kind": "page",
            "file": None,
            "page_id": None,
            "size": entries[0]["size"],
        }
    ]
    assert entries[0]["size"] > 0
    assert entries[0]["trashed_at"].endswith("Z")

    r = client.post(f"/api/v1/trash/{trash_id}/restore")
    assert r.status_code == 200, r.text
    assert r.json()["path"] == "Projects/Atlas"
    assert r.json()["icon"] == "🧭"
    assert "Projects/Atlas" in _tree_paths(client)
    assert client.get("/api/v1/trash").json() == []
    assert not (settings.vault / "Projects" / "Atlas" / ".origin.json").exists()


def test_restore_collision_gets_suffix(client: TestClient) -> None:
    p = _create(client, "Dup")
    trash_id = client.delete(f"/api/v1/pages/{p}").json()["trash_id"]
    _create(client, "Dup")  # a new page now occupies the origin
    r = client.post(f"/api/v1/trash/{trash_id}/restore", json={})
    assert r.status_code == 200
    assert r.json()["path"] == "Dup 2"
    assert "Dup 2" in _tree_paths(client)


def test_restore_to_explicit_target_and_missing_parent(client: TestClient) -> None:
    p = _create(client, "Moved")
    trash_id = client.delete(f"/api/v1/pages/{p}").json()["trash_id"]
    r = client.post(f"/api/v1/trash/{trash_id}/restore", json={"target_path": "Archive/Moved"})
    assert r.status_code == 200
    assert r.json()["path"] == "Archive/Moved"
    assert "Archive/Moved" in _tree_paths(client)


def test_restore_without_origin_file_uses_activities(
    client: TestClient, settings: Settings
) -> None:
    _create(client, "Parent")
    child = _create(client, "Legacy", "Parent")
    trash_id = client.delete(f"/api/v1/pages/{child}").json()["trash_id"]
    (settings.vault / ".graite" / "trash" / trash_id / ".origin.json").unlink()

    entries = client.get("/api/v1/trash").json()
    assert entries[0]["path"] == "Parent/Legacy"
    assert entries[0]["title"] == "Legacy"

    r = client.post(f"/api/v1/trash/{trash_id}/restore")
    assert r.status_code == 200
    assert r.json()["path"] == "Parent/Legacy"


def test_restore_unknown_origin_needs_target(client: TestClient, settings: Settings) -> None:
    trash_dir = settings.vault / ".graite" / "trash" / "1700000000000-Orphan"
    trash_dir.mkdir(parents=True)
    (trash_dir / "page.md").write_text("---\ntitle: Orphan\n---\n\nhi\n")
    entries = client.get("/api/v1/trash").json()
    assert entries[0] == {
        "trash_id": "1700000000000-Orphan",
        "path": None,
        "title": "Orphan",
        "trashed_at": "2023-11-14T22:13:20Z",
        "kind": "page",
        "file": None,
        "page_id": None,
        "size": 26,
    }
    r = client.post("/api/v1/trash/1700000000000-Orphan/restore")
    assert r.status_code == 400
    r = client.post("/api/v1/trash/1700000000000-Orphan/restore", json={"target_path": "Orphan"})
    assert r.status_code == 200
    assert r.json()["title"] == "Orphan"


def test_restore_unknown_id_and_bad_id(client: TestClient) -> None:
    assert client.post("/api/v1/trash/nope/restore").status_code == 404
    assert client.post("/api/v1/trash/..%2Fx/restore").status_code in (400, 404)


def test_restore_publishes_tree_changed_with_request_id(client: TestClient) -> None:
    p = _create(client, "Ev")
    trash_id = client.delete(f"/api/v1/pages/{p}").json()["trash_id"]
    seen: list[tuple[str, dict]] = []
    bus = client.app.state.events  # type: ignore[attr-defined]
    original = bus.publish

    def record(type_: str, data: dict | None = None) -> None:
        seen.append((type_, data or {}))
        original(type_, data)

    bus.publish = record  # type: ignore[method-assign]
    client.post(f"/api/v1/trash/{trash_id}/restore", headers={"X-Graite-Request": "r-9"})
    assert ("tree_changed", "restore", "r-9") in {
        (t, d.get("reason"), d.get("request_id")) for t, d in seen
    }
    assert json.dumps(seen[0][1])  # serialisable


def test_purge_one_entry_and_empty_all(client: TestClient, settings: Settings) -> None:
    trash_root = settings.vault / ".graite" / "trash"
    page = client.post("/api/v1/pages", json={"title": "Holder"}).json()
    file = client.post(
        "/api/v1/media/upload", params={"page_id": page["id"], "name": "a.png"}, content=b"12345"
    ).json()["file"]
    file_trash = client.delete(
        "/api/v1/media/attachments", params={"page_id": page["id"], "file": file}
    ).json()["trash_id"]
    first = client.delete(f"/api/v1/pages/{_create(client, 'One')}").json()["trash_id"]
    client.delete(f"/api/v1/pages/{_create(client, 'Two')}")
    kinds = {e["trash_id"]: e["kind"] for e in client.get("/api/v1/trash").json()}
    assert kinds[file_trash] == "attachment"
    assert kinds[first] == "page"

    r = client.delete(f"/api/v1/trash/{file_trash}")
    assert r.status_code == 200, r.text
    assert r.json() == {"entries": 1, "bytes": 5}
    assert not (trash_root / file_trash).exists()
    assert client.delete(f"/api/v1/trash/{file_trash}").status_code == 404

    r = client.delete("/api/v1/trash")
    assert r.json()["entries"] == 2
    assert r.json()["bytes"] > 0
    assert client.get("/api/v1/trash").json() == []
    assert client.delete("/api/v1/trash").json() == {"entries": 0, "bytes": 0}
    # The vault itself is untouched.
    assert "Holder" in _tree_paths(client)


def test_purge_rejects_bad_ids_and_never_follows_links(
    client: TestClient, settings: Settings, tmp_path_factory
) -> None:
    assert client.delete("/api/v1/trash/nope").status_code == 404
    assert client.delete("/api/v1/trash/..").status_code in (400, 404, 405)
    outside = tmp_path_factory.mktemp("outside")
    (outside / "keep.txt").write_text("keep")
    trash_root = settings.vault / ".graite" / "trash"
    trash_root.mkdir(parents=True, exist_ok=True)
    (trash_root / "1700000000000-link").symlink_to(outside, target_is_directory=True)

    assert client.delete("/api/v1/trash/1700000000000-link").status_code == 200
    assert (outside / "keep.txt").read_text() == "keep"
    assert not (trash_root / "1700000000000-link").is_symlink()
