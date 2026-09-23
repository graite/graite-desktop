from __future__ import annotations

import hashlib
import json
from pathlib import Path

from fastapi.testclient import TestClient

from graite.config import Settings


def _page(client: TestClient, title: str, parent: str | None = None) -> dict:
    r = client.post("/api/v1/pages", json={"title": title, "parent_path": parent})
    assert r.status_code == 201, r.text
    return dict(r.json())


def _upload(client: TestClient, page_id: str, name: str, data: bytes = b"bytes") -> str:
    r = client.post("/api/v1/media/upload", params={"page_id": page_id, "name": name}, content=data)
    assert r.status_code == 200, r.text
    return str(r.json()["file"])


def _write(client: TestClient, path: str, body: str) -> None:
    base = client.get(f"/api/v1/pages/{path}").json()["hash"]
    r = client.put(f"/api/v1/pages/{path}", json={"body": body, "base_hash": base})
    assert r.status_code == 200, r.text


def _list(client: TestClient, page_id: str) -> dict[str, dict]:
    r = client.get("/api/v1/media/attachments", params={"page_id": page_id})
    assert r.status_code == 200, r.text
    return {item["file"]: item for item in r.json()}


def _media_fence(file: str, name: str) -> str:
    return f"```graite:media\nfile: {file}\nname: {name}\nkind: image\n```\n"


def _record_events(client: TestClient) -> list[tuple[str, dict]]:
    seen: list[tuple[str, dict]] = []
    bus = client.app.state.events  # type: ignore[attr-defined]
    original = bus.publish

    def record(type_: str, data: dict | None = None) -> None:
        seen.append((type_, data or {}))
        original(type_, data)

    bus.publish = record  # type: ignore[method-assign]
    return seen


def test_listing_shows_size_kind_name_and_usage(client: TestClient) -> None:
    page = _page(client, "Notes")
    used = _upload(client, page["id"], "pic.png", b"12345")
    orphan = _upload(client, page["id"], "scan.pdf", b"%PDF")
    _write(client, "Notes", "Intro\n\n" + _media_fence(used, "pic.png"))

    items = _list(client, page["id"])
    assert set(items) == {used, orphan}
    assert items[used] == {
        "file": used,
        "name": "pic.png",
        "kind": "image",
        "size": 5,
        "modified": items[used]["modified"],
        "referenced": True,
        "referenced_by": ["Notes"],
        "generated": False,
    }
    assert items[used]["modified"].endswith("Z")
    assert items[orphan]["kind"] == "pdf"
    assert items[orphan]["referenced"] is False
    assert items[orphan]["referenced_by"] == []


def test_usage_covers_derived_text_properties_and_subpage_links(
    client: TestClient, settings: Settings
) -> None:
    page = _page(client, "Owner")
    source = _upload(client, page["id"], "talk.wav")
    prop = _upload(client, page["id"], "cover.png")
    linked = _upload(client, page["id"], "paper.pdf")
    # An extraction result written next to the originals; nothing points at it.
    orphan = "0123456789abcdef0123456789abcdef-transcript.md"
    (settings.vault / "Owner" / "_assets" / orphan).write_bytes(b"# T\n")

    _write(
        client,
        "Owner",
        f"```graite:text\nfile: missing.md\nname: Transcript\nsource: {source}\n```\n",
    )
    child = _page(client, "Transcript", "Owner")
    _write(client, child["path"], f"Source: [paper](../_assets/{linked})\n")
    # A media-typed property lives in frontmatter, outside the body.
    page_md = settings.vault / "Owner" / "page.md"
    text = page_md.read_text(encoding="utf-8")
    page_md.write_text(text.replace("---\n", f"---\ncover: {prop}\n", 1), encoding="utf-8")

    items = _list(client, page["id"])
    assert items[source]["referenced_by"] == ["Owner"]
    assert items[prop]["referenced_by"] == ["Owner"]
    assert items[linked]["referenced_by"] == ["Owner/Transcript"]
    assert items[orphan]["kind"] == "text"
    assert items[orphan]["referenced"] is False


def test_hidden_partial_and_linked_files_are_not_listed(
    client: TestClient, settings: Settings, tmp_path: Path
) -> None:
    page = _page(client, "Tidy")
    kept = _upload(client, page["id"], "a.png")
    assets = settings.vault / "Tidy" / "_assets"
    (assets / ".b.png.part").write_bytes(b"x")
    outside = tmp_path / "secret.txt"
    outside.write_text("secret")
    (assets / "link.txt").symlink_to(outside)
    assert set(_list(client, page["id"])) == {kept}


def test_linked_assets_folder_is_rejected(
    client: TestClient, settings: Settings, tmp_path: Path
) -> None:
    page = _page(client, "Linked")
    elsewhere = tmp_path / "elsewhere"
    elsewhere.mkdir()
    (settings.vault / "Linked" / "_assets").symlink_to(elsewhere, target_is_directory=True)
    assert (
        client.get("/api/v1/media/attachments", params={"page_id": page["id"]}).status_code == 400
    )
    assert client.get("/api/v1/media/attachments", params={"page_id": "nope"}).status_code == 404


def test_trash_needs_force_when_used_and_never_rewrites_the_page(
    client: TestClient, settings: Settings
) -> None:
    page = _page(client, "Doc")
    file = _upload(client, page["id"], "pic.png", b"pixels")
    _write(client, "Doc", _media_fence(file, "pic.png"))
    page_md = settings.vault / "Doc" / "page.md"
    before = hashlib.sha256(page_md.read_bytes()).hexdigest()
    params = {"page_id": page["id"], "file": file}
    seen = _record_events(client)

    r = client.delete("/api/v1/media/attachments", params=params)
    assert r.status_code == 409
    assert "Doc" in r.json()["detail"]
    assert (settings.vault / "Doc" / "_assets" / file).is_file()

    r = client.delete("/api/v1/media/attachments", params={**params, "force": "true"})
    assert r.status_code == 200, r.text
    trash_dir = settings.vault / ".graite" / "trash" / r.json()["trash_id"]
    assert (trash_dir / file).read_bytes() == b"pixels"
    origin = json.loads((trash_dir / ".origin.json").read_text())
    assert origin["kind"] == "attachment"
    assert origin["page_id"] == page["id"]
    assert origin["file"] == file
    assert not (settings.vault / "Doc" / "_assets" / file).exists()
    assert hashlib.sha256(page_md.read_bytes()).hexdigest() == before
    assert _list(client, page["id"]) == {}
    kinds = [(t, d.get("reason")) for t, d in seen]
    assert ("attachments_changed", "trash") in kinds
    assert ("trash_changed", "trash") in kinds
    assert client.delete("/api/v1/media/attachments", params=params).status_code == 404
    assert (
        client.delete(
            "/api/v1/media/attachments", params={**params, "file": "../page.md"}
        ).status_code
        == 400
    )


def test_trashed_attachment_is_listed_and_restored_after_rename(
    client: TestClient, settings: Settings
) -> None:
    page = _page(client, "Before")
    file = _upload(client, page["id"], "scan.pdf", b"%PDF-data")
    trash_id = client.delete(
        "/api/v1/media/attachments", params={"page_id": page["id"], "file": file}
    ).json()["trash_id"]

    entries = client.get("/api/v1/trash").json()
    assert entries == [
        {
            "trash_id": trash_id,
            "path": "Before",
            "title": "scan.pdf",
            "trashed_at": entries[0]["trashed_at"],
            "kind": "attachment",
            "file": file,
            "page_id": page["id"],
            "size": 9,
        }
    ]

    client.patch("/api/v1/pages/Before", json={"title": "After"})
    r = client.post(f"/api/v1/trash/{trash_id}/restore")
    assert r.status_code == 200, r.text
    assert r.json()["path"] == "After"
    assert (settings.vault / "After" / "_assets" / file).read_bytes() == b"%PDF-data"
    assert not (settings.vault / ".graite" / "trash" / trash_id).exists()
    assert client.get("/api/v1/trash").json() == []
    assert set(_list(client, page["id"])) == {file}


def test_restore_waits_for_a_trashed_owner_page(client: TestClient, settings: Settings) -> None:
    page = _page(client, "Owner")
    file = _upload(client, page["id"], "a.png")
    file_trash = client.delete(
        "/api/v1/media/attachments", params={"page_id": page["id"], "file": file}
    ).json()["trash_id"]
    page_trash = client.delete("/api/v1/pages/Owner").json()["trash_id"]

    r = client.post(f"/api/v1/trash/{file_trash}/restore")
    assert r.status_code == 400
    assert "Restore that page first" in r.json()["detail"]
    assert (settings.vault / ".graite" / "trash" / file_trash / file).is_file()

    assert client.post(f"/api/v1/trash/{page_trash}/restore").status_code == 200
    assert client.post(f"/api/v1/trash/{file_trash}/restore").status_code == 200
    assert (settings.vault / "Owner" / "_assets" / file).is_file()


def test_restore_never_overwrites_an_existing_file(client: TestClient, settings: Settings) -> None:
    page = _page(client, "Clash")
    file = _upload(client, page["id"], "a.png", b"old")
    trash_id = client.delete(
        "/api/v1/media/attachments", params={"page_id": page["id"], "file": file}
    ).json()["trash_id"]
    assets = settings.vault / "Clash" / "_assets"
    (assets / file).write_bytes(b"new")

    assert client.post(f"/api/v1/trash/{trash_id}/restore").status_code == 200
    contents = sorted(p.read_bytes() for p in assets.iterdir())
    assert contents == [b"new", b"old"]
    assert all(p.name.endswith("-a.png") for p in assets.iterdir())


def test_location_reports_the_file_path(client: TestClient, settings: Settings) -> None:
    page = _page(client, "Where")
    file = _upload(client, page["id"], "a.png")
    r = client.get("/api/v1/media/location", params={"page_id": page["id"], "file": file}).json()
    assert Path(r["path"]) == Path(r["folder"]) / file


def test_leftover_extraction_text_is_marked_as_generated(
    client: TestClient, settings: Settings
) -> None:
    page = _page(client, "Old")
    assets = settings.vault / "Old" / "_assets"
    _upload(client, page["id"], "scan.pdf")  # creates the folder
    prefix = "0123456789abcdef0123456789abcdef"
    names = {
        f"{prefix}-transcript.md": True,
        f"{prefix}-ocr.md": True,
        # Things a person could have attached: not ours to hide.
        f"{prefix}-notes.md": False,
        f"{prefix}-my-transcript.md": False,
        f"{prefix}-transcript.md.png": False,
    }
    for name in names:
        (assets / name).write_bytes(b"text")
    # An old derived-text block still reads its file: that one is in use.
    _write(client, "Old", f"```graite:text\nfile: {prefix}-ocr.md\nname: Document text\n```\n")

    items = _list(client, page["id"])
    assert {name: items[name]["generated"] for name in names} == names
    assert items[f"{prefix}-ocr.md"]["referenced"] is True
    assert items[f"{prefix}-transcript.md"]["referenced"] is False
    assert [i["generated"] for i in items.values() if i["name"] == "scan.pdf"] == [False]
