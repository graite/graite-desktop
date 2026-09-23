from __future__ import annotations

import pytest
from fastapi.testclient import TestClient


def page(client, title, parent=None):
    return client.post("/api/v1/pages", json={"title": title, "parent_path": parent}).json()


def properties(client, p, fields):
    return client.put(
        "/api/v1/workspace/properties",
        json={"page_id": p["id"], "base_hash": p["hash"], "properties": fields},
    )


def test_properties_require_nested_page_and_preserve_body(client: TestClient):
    parent = page(client, "Projects")
    child = page(client, "Task", parent["path"])
    value = {
        "id": "status",
        "name": "Status",
        "type": "status",
        "options": ["To do", "Done"],
        "value": "To do",
    }
    assert properties(client, parent, [value]).status_code == 400
    assert properties(client, child, [value]).status_code == 200
    changed = client.get("/api/v1/pages/Projects/Task").json()
    assert changed["frontmatter"]["properties"][0]["value"] == "To do"
    assert changed["body"] == child["body"]
    assert changed["id"] == child["id"]
    assert properties(client, child, [value]).status_code == 409
    children = client.get("/api/v1/workspace/children", params={"page_id": parent["id"]}).json()
    assert children[0]["id"] == child["id"]


@pytest.mark.parametrize(
    "kind,value,options",
    [
        ("date", "2026-02-30", []),
        ("email", "no-email", []),
        ("url", "javascript:alert(1)", []),
        ("checkbox", "true", []),
        ("single_select", "Missing", ["Yes"]),
        ("multi_select", ["Missing"], ["Yes"]),
        ("media", "../secret", []),
    ],
)
def test_invalid_properties_are_rejected(client, kind, value, options):
    parent = page(client, "Root")
    child = page(client, "Child", parent["path"])
    field = {"id": "p", "name": "Property", "type": kind, "value": value, "options": options}
    assert properties(client, child, [field]).status_code == 422


def test_move_subtree_keeps_ids_media_and_updates_links(client):
    root = page(client, "Projects")
    other = page(client, "Archive")
    child = page(client, "Task", root["path"])
    nested = page(client, "Notes", child["path"])
    client.put(
        "/api/v1/pages/Projects",
        json={"body": "[[Task]]\n\n[[Projects/Task/Notes|My notes]]", "base_hash": root["hash"]},
    )
    media = client.post(
        "/api/v1/media/upload",
        params={"page_id": nested["id"], "name": "voice.wav"},
        content=b"original",
    ).json()
    response = client.post(
        "/api/v1/workspace/move",
        json={"page_id": child["id"], "target_id": other["id"], "position": "inside"},
    )
    assert response.status_code == 200, response.text
    assert response.json()["path"] == "Archive/Task"
    assert response.json()["id"] == child["id"]
    assert client.get("/api/v1/pages/Archive/Task/Notes").json()["id"] == nested["id"]
    body = client.get("/api/v1/pages/Projects").json()["body"]
    assert "[[Archive/Task]]" in body
    assert "[[Archive/Task/Notes|My notes]]" in body
    assert (
        client.get(
            "/api/v1/media/file", params={"page_id": nested["id"], "file": media["file"]}
        ).content
        == b"original"
    )
    assert (
        client.post(
            "/api/v1/workspace/move",
            json={"page_id": child["id"], "target_id": nested["id"], "position": "inside"},
        ).status_code
        == 400
    )


def test_sidebar_order_persists_and_move_to_top_level(client):
    a = page(client, "A")
    b = page(client, "B")
    child = page(client, "Child", a["path"])
    assert (
        client.post(
            "/api/v1/workspace/move",
            json={"page_id": b["id"], "target_id": a["id"], "position": "before"},
        ).status_code
        == 200
    )
    assert [n["title"] for n in client.get("/api/v1/vault/tree").json()] == ["B", "A"]
    assert (
        client.post(
            "/api/v1/workspace/move",
            json={"page_id": child["id"], "target_id": None, "position": "inside"},
        ).json()["path"]
        == "Child"
    )


def test_computed_dates_cannot_be_overwritten(client):
    root = page(client, "Root")
    child = page(client, "Child", root["path"])
    result = properties(
        client, child, [{"id": "created", "name": "Created at", "type": "created", "value": "fake"}]
    )
    assert result.status_code == 200
    assert result.json()["frontmatter"]["created"] == child["frontmatter"]["created"]
    assert result.json()["frontmatter"]["properties"][0]["value"] is None


def test_layout_link_updates_skip_code_and_reach_columns():
    import yaml

    from graite.vault.layouts import map_markdown

    original = (
        "[[Old]]\n\n```text\n[[Old]]\n```\n\n```graite:columns\n"
        + yaml.safe_dump({"columns": ["[[Old]]\n", "Other\n"]})
        + "```\n"
    )
    updated = map_markdown(original, lambda text: text.replace("[[Old]]", "[[New]]"))
    assert "```text\n[[Old]]\n```" in updated
    assert updated.count("[[New]]") == 2


def test_number_and_option_colors_roundtrip(client):
    parent = page(client, "Numbers")
    child = page(client, "Task", parent["path"])
    fields = [
        {"id": "n", "name": "Budget", "type": "number", "value": 12.75},
        {
            "id": "s",
            "name": "Status",
            "type": "status",
            "options": ["Done"],
            "value": "Done",
            "colors": {"Done": "green"},
        },
    ]
    result = properties(client, child, fields)
    assert result.status_code == 200
    saved = client.get("/api/v1/pages/Numbers/Task").json()
    assert saved["frontmatter"]["properties"][0]["value"] == 12.75
    assert saved["frontmatter"]["properties"][1]["colors"] == {"Done": "green"}
    fields[0]["value"] = True
    assert properties(client, saved, fields).status_code == 422
    fields[0]["value"] = "12.75"
    assert properties(client, saved, fields).status_code == 422
    fields[0]["value"] = None
    fields[1]["colors"] = {"Done": "invalid-color"}
    assert properties(client, saved, fields).status_code == 422
