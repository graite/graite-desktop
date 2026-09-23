"""Built-in skills: what Graite knows how to teach a model before any vault says anything."""

from __future__ import annotations

from pathlib import Path

from graite.skills.library import BUILTIN_DIR, discover


def test_a_fresh_vault_already_knows_how_to_build_a_board(tmp_path: Path) -> None:
    """There is nowhere else for this to come from: a new vault has no _skills folder, and the
    model cannot guess the graite:view contract."""
    found = discover(tmp_path, None)
    assert "page-views" in found
    assert found["page-views"]["source"] == "builtin"
    assert "kanban" in found["page-views"]["description"].lower()


def test_the_board_skill_teaches_the_fence_the_converter_actually_accepts() -> None:
    body = discover(Path("/nonexistent"), None)["page-views"]["body"]
    assert "```graite:view" in body
    assert "view: kanban" in body and "group: Status" in body
    assert "groupBy" in body  # named as a mistake, so the model recognises it as one


def test_the_board_skill_claims_no_allowed_tools() -> None:
    """load_skill intersects the registry with `allowed-tools`; an incomplete list here would
    amputate the very tools the skill goes on to tell the model to call."""
    assert discover(Path("/nonexistent"), None)["page-views"]["allowed_tools"] is None


def test_a_vault_skill_of_the_same_name_wins(tmp_path: Path) -> None:
    folder = tmp_path / "_skills" / "page-views"
    folder.mkdir(parents=True)
    (folder / "SKILL.md").write_text(
        "---\nname: page-views\ndescription: Mine.\n---\n\nDo it my way.\n", encoding="utf-8"
    )
    found = discover(tmp_path, None)
    assert found["page-views"]["source"] == "vault"
    assert found["page-views"]["body"].strip() == "Do it my way."


def test_every_built_in_skill_has_a_name_and_a_description() -> None:
    for file in BUILTIN_DIR.glob("*/SKILL.md"):
        found = discover(Path("/nonexistent"), None)
        assert any(s["body"].strip() for s in found.values()), file
    assert all(s["description"] and s["name"] for s in discover(Path("/none"), None).values())
