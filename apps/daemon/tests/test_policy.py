from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from graite.index import db
from graite.vault import indexer, policy
from tests.test_indexer import write_page


def test_validate_rejects_bad_values() -> None:
    assert policy.validate({"autonomy": "none", "cloud": "local-only", "instructions": " x "}) == {
        "autonomy": "none",
        "cloud": "local-only",
        "instructions": "x",
    }
    assert policy.validate({"model": None, "instructions": "   "}) == {
        "model": None,
        "instructions": None,
    }
    for bad in (
        {"autonomy": "yes"},
        {"cloud": "maybe"},
        {"auto_apply_kinds": ["move"]},
        {"skills": "x"},
        {"nope": 1},
    ):
        with pytest.raises(ValueError):
            policy.validate(bad)


def test_cascade_accumulates_instructions_and_keeps_restrictions(tmp_path: Path) -> None:
    vault = tmp_path / "vault"
    write_page(
        vault,
        "Projects",
        "Projects",
        "",
        {"cloud": "local-only", "instructions": "Keep a status section."},
    )
    write_page(
        vault,
        "Projects/Atlas",
        "Atlas",
        "",
        {"cloud": "allowed", "autonomy": "auto-apply", "model": "qwen"},
    )
    write_page(
        vault,
        "Projects/Atlas/Notes",
        "Notes",
        "",
        {"autonomy": "none", "instructions": "Bullet points only."},
    )
    write_page(vault, "Other", "Other", "")
    (vault / "AGENTS.md").write_text(
        "---\nautonomy: propose\nskills: [summarise]\n---\n# Vault rules\nShort answers.\n"
    )
    (vault / "Projects" / "AGENTS.md").write_text("# Project rules\nEnglish only.\n")
    (vault / ".graite").mkdir(exist_ok=True)
    (vault / ".graite" / "config.toml").write_text(
        '[agents]\nautonomy = "propose"\nmodel = "default-model"\n'
    )
    conn = db.connect(vault / ".graite" / "index.sqlite")
    indexer.scan(vault, conn)

    leaf = policy.resolve(vault, conn, "Projects/Atlas/Notes")
    assert leaf.values["cloud"] == "local-only" and leaf.sources["cloud"] == "Projects"
    assert leaf.values["autonomy"] == "none" and leaf.sources["autonomy"] == "Projects/Atlas/Notes"
    assert "model" not in leaf.values
    assert leaf.values["skills"] == ["summarise"] and leaf.sources["skills"] == "AGENTS.md"
    assert [i["source"] for i in leaf.instructions] == [
        "AGENTS.md",
        "Projects/AGENTS.md",
        "Projects",
        "Projects/Atlas/Notes",
    ]
    assert [i["path"] for i in leaf.agents_md] == ["AGENTS.md", "Projects/AGENTS.md"]

    atlas = policy.resolve(vault, conn, "Projects/Atlas")
    assert atlas.values["autonomy"] == "auto-apply"  # propose -> auto-apply is allowed at a child
    assert not atlas.cloud_allowed

    other = policy.resolve(vault, conn, "Other")
    assert other.values == {
        "autonomy": "propose",
        "cloud": "allowed",
        "skills": ["summarise"],
    }
    assert "model" not in other.sources and other.sources["autonomy"] == "AGENTS.md"

    root = policy.resolve(vault, conn, None)
    assert root.values["autonomy"] == "propose" and root.instructions[0]["source"] == "AGENTS.md"
    many = policy.resolve_many(vault, conn, ["Other", "Projects/Atlas"])
    assert set(many) == {"Other", "Projects/Atlas"}


def test_descendant_cannot_widen_autonomy_or_cloud(tmp_path: Path) -> None:
    vault = tmp_path / "vault"
    write_page(vault, "Locked", "Locked", "", {"autonomy": "none", "cloud": "local-only"})
    write_page(vault, "Locked/Open", "Open", "", {"autonomy": "auto-apply", "cloud": "allowed"})
    conn = db.connect(vault / ".graite" / "index.sqlite")
    indexer.scan(vault, conn)
    child = policy.resolve(vault, conn, "Locked/Open")
    assert child.values["autonomy"] == "none" and child.sources["autonomy"] == "Locked"
    assert child.values["cloud"] == "local-only" and child.sources["cloud"] == "Locked"


def test_set_ai_settings_only_touches_ai_keys(client: TestClient) -> None:
    page = client.post("/api/v1/pages", json={"title": "Settings"}).json()
    client.put(
        f"/api/v1/pages/{page['path']}",
        json={"body": "# Body\n\nKeep me.\n", "base_hash": page["hash"]},
    )
    page = client.get(f"/api/v1/pages/{page['path']}").json()
    response = client.put(
        f"/api/v1/pages/{page['path']}/ai-settings",
        json={
            "values": {"instructions": "Use tables.", "autonomy": "none", "cloud": "local-only"},
            "base_hash": page["hash"],
        },
    )
    assert response.status_code == 200, response.text
    data = response.json()
    assert data["own"] == {"instructions": "Use tables.", "autonomy": "none", "cloud": "local-only"}
    assert (
        data["effective"]["values"]["autonomy"] == "none"
        and data["effective"]["sources"]["autonomy"] == "Settings"
    )
    assert data["effective"]["instructions"] == [{"source": "Settings", "text": "Use tables."}]
    text = (client.app.state.settings.vault / "Settings" / "page.md").read_text()
    assert text.endswith("---\n\n# Body\n\nKeep me.\n")
    assert (
        text.index("autonomy: none")
        < text.index("cloud: local-only")
        < text.index("instructions: Use tables.")
    )
    # Stale hash conflicts; unknown key is rejected; None removes a key.
    assert (
        client.put(
            f"/api/v1/pages/{page['path']}/ai-settings",
            json={"values": {"model": "x"}, "base_hash": page["hash"]},
        ).status_code
        == 409
    )
    assert (
        client.put(
            f"/api/v1/pages/{page['path']}/ai-settings", json={"values": {"nope": 1}}
        ).status_code
        == 400
    )
    cleared = client.put(
        f"/api/v1/pages/{page['path']}/ai-settings", json={"values": {"autonomy": None}}
    ).json()
    assert (
        "autonomy" not in cleared["own"] and cleared["effective"]["values"]["autonomy"] == "propose"
    )
    assert client.get(f"/api/v1/pages/{page['path']}/ai-settings").json()["own"] == {
        "instructions": "Use tables.",
        "cloud": "local-only",
    }
    activity = client.app.state.db.execute(
        "SELECT action FROM activities WHERE action='page.ai_settings'"
    ).fetchall()
    assert len(activity) == 2


def test_layers_record_which_file_set_what(tmp_path: Path) -> None:
    from graite.index import db as database
    from graite.vault import indexer

    vault = tmp_path / "vault"
    write_page(vault, "Projects", "Projects", "", {"autonomy": "none"})
    write_page(
        vault, "Projects/Atlas", "Atlas", "", {"instructions": "Use tables.", "model": "m_1"}
    )
    (vault / "Projects" / "AGENTS.md").write_text("---\ncloud: local-only\n---\nEnglish only.\n")
    conn = database.connect(vault / ".graite" / "index.sqlite")
    indexer.scan(vault, conn)
    effective = policy.resolve(vault, conn, "Projects/Atlas")
    assert effective.layers == [
        {"source": "Projects/AGENTS.md", "values": {"cloud": "local-only", "instructions": True}},
        {"source": "Projects", "values": {"autonomy": "none"}},
        {"source": "Projects/Atlas", "values": {"instructions": True}},
    ]
    assert effective.as_dict()["layers"] == effective.layers
    conn.close()
