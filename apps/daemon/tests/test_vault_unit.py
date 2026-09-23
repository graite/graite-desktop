from __future__ import annotations

import pytest

from graite.vault import frontmatter as fm
from graite.vault.paths import VaultPathError, slugify, validate_rel


@pytest.mark.parametrize(
    "bad", ["", "/abs", "../x", "a/../../b", ".graite/x", "_attachments", "a/_data"]
)
def test_validate_rel_rejects(bad: str) -> None:
    with pytest.raises(VaultPathError):
        validate_rel(bad)


def test_validate_rel_normalizes() -> None:
    assert validate_rel("Projects/Atlas/") == "Projects/Atlas"
    assert validate_rel("Projects\\Atlas") == "Projects/Atlas"


def test_slugify() -> None:
    assert slugify("Meeting Notes 2026") == "Meeting Notes 2026"
    assert slugify('a/b:c*d?e"f<g>h|i') == "a-b-c-d-e-f-g-h-i"
    assert slugify("  ..hidden  ") == "hidden"
    assert slugify("_private") == "private"
    assert slugify("") == "Untitled"
    assert slugify("Café ☕") == "Café ☕"


def test_frontmatter_roundtrip_and_key_order() -> None:
    meta = {"zeta": 1, "updated": "2026-09-14T10:00:00Z", "title": "T", "id": "x", "tags": ["a"]}
    text = fm.join(meta, "Body\n")
    assert text.startswith(
        "---\nid: x\ntitle: T\nupdated: '2026-09-14T10:00:00Z'\ntags: [a]\nzeta: 1\n---\n\nBody\n"
    )
    parsed, body = fm.split(text)
    assert parsed == meta
    assert body == "Body\n"
    assert fm.join(parsed, body) == text


def test_frontmatter_empty_body() -> None:
    text = fm.join({"id": "x", "title": "T"}, "")
    assert text == "---\nid: x\ntitle: T\n---\n"
    assert fm.split(text) == ({"id": "x", "title": "T"}, "")


def test_uuid7_is_version_7() -> None:
    import uuid

    u = uuid.UUID(fm.uuid7())
    assert u.version == 7


async def test_snapshot_page_and_read_snapshot(tmp_path) -> None:  # type: ignore[no-untyped-def]
    from graite.events import EventBus
    from graite.index import db
    from graite.vault.fileops import FileOps

    vault = tmp_path / "vault"
    vault.mkdir()
    ops = FileOps(vault, db.connect(vault / ".graite" / "index.sqlite"), EventBus())
    doc = await ops.create_page(None, "Log", None, "ui")
    await ops.write_body(doc.path, "One\n", None, "ui")
    version = await ops.snapshot_page(doc.path)
    assert version and version.startswith(".graite/versions/")
    text = await ops.read_snapshot(version)
    assert text.endswith("\nOne\n") and "title: Log" in text
    with pytest.raises(VaultPathError):
        await ops.read_snapshot("../outside.md")
    with pytest.raises(FileNotFoundError):
        await ops.read_snapshot(".graite/versions/nope/1.md")


async def test_definitions_and_live_status_writes(tmp_path) -> None:  # type: ignore[no-untyped-def]
    from graite.events import EventBus
    from graite.index import db
    from graite.vault.fileops import FileOps

    vault = tmp_path / "vault"
    vault.mkdir()
    ops = FileOps(vault, db.connect(vault / ".graite" / "index.sqlite"), EventBus())
    projects = await ops.create_page(None, "Projects", None, "ui")
    before = ops.epoch
    rel = await ops.write_definition("Projects/_agents/weekly.md", "Do it.\n", "ui")
    assert rel == "Projects/_agents/weekly.md" and (vault / rel).read_text() == "Do it.\n"
    assert ops.epoch > before
    with pytest.raises(VaultPathError):
        await ops.write_definition("Projects/agents/x.md", "x", "ui")
    with pytest.raises(FileNotFoundError):
        await ops.write_definition("Nope/_agents/x.md", "x", "ui")
    await ops.delete_definition(rel, "ui")
    assert not (vault / rel).exists()
    with pytest.raises(FileNotFoundError):
        await ops.delete_definition(rel, "ui")
    doc = await ops.set_live_status(projects.path, run_at="2026-09-16T07:00:00+00:00")
    assert doc.frontmatter["live"] == {"last_run_at": "2026-09-16T07:00:00+00:00"}
    assert doc.body == "" and doc.title == "Projects"


def test_append_continues_a_list_without_gaps_or_markers() -> None:
    from graite.vault.fileops import append_markdown

    # What the assistant's Playbook looked like: appends spread the list out, and the editor
    # had left an empty-paragraph marker at the end of the page.
    playbook = (
        "- First lesson.\n\n\n<!-- graite:empty -->\n\n- Second lesson.\n\n<!-- graite:empty -->\n"
    )
    assert append_markdown(playbook, "- Third lesson.") == (
        "- First lesson.\n- Second lesson.\n- Third lesson.\n"
    )
    # Several bullets at once join too, and a tight list stays tight.
    assert append_markdown("- a\n- b\n", "\n- c\n\n- d\n") == "- a\n- b\n- c\n- d\n"
    # Only the final list is touched; the paragraph before it keeps its blank line.
    assert append_markdown("Intro.\n\n- a\n\n- b\n", "- c") == "Intro.\n\n- a\n- b\n- c\n"
    # Tasks are bullets; numbered lists continue numbered lists.
    assert append_markdown("- [ ] one\n", "- [ ] two") == "- [ ] one\n- [ ] two\n"
    assert append_markdown("1. one\n", "2. two") == "1. one\n2. two\n"


def test_append_keeps_a_blank_line_where_the_blocks_differ() -> None:
    from graite.vault.fileops import append_markdown

    assert append_markdown("", "- a") == "- a\n"
    assert append_markdown("<!-- graite:empty -->\n", "Hello") == "Hello\n"
    assert append_markdown("A paragraph.\n", "- a") == "A paragraph.\n\n- a\n"
    assert append_markdown("- a\n", "A paragraph.") == "- a\n\nA paragraph.\n"
    assert append_markdown("- a\n", "1. one") == "- a\n\n1. one\n"
    # Nested items are not flattened: left exactly as written, one blank line apart.
    assert append_markdown("- a\n  - nested\n", "- b") == "- a\n  - nested\n\n- b\n"
    assert append_markdown("## Journal\n\n2026-09-01: met Ann.\n", "2026-09-02: call.") == (
        "## Journal\n\n2026-09-01: met Ann.\n\n2026-09-02: call.\n"
    )
