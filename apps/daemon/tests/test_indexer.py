from __future__ import annotations

import os
import shutil
from pathlib import Path

from graite.index import db
from graite.vault import indexer
from graite.vault.frontmatter import join, new_meta


def write_page(vault: Path, rel: str, title: str, body: str, meta: dict | None = None) -> Path:
    directory = vault / rel
    directory.mkdir(parents=True, exist_ok=True)
    data = {**new_meta(title), **(meta or {})}
    (directory / "page.md").write_text(join(data, body), encoding="utf-8")
    return directory / "page.md"


def bump_mtime(path: Path) -> None:
    stat = path.stat()
    os.utime(path, (stat.st_atime + 5, stat.st_mtime + 5))


def test_full_scan_then_noop_rescan_touches_nothing(tmp_path: Path) -> None:
    vault = tmp_path / "vault"
    write_page(vault, "Projects", "Projects", "# Plan\n\nWe decided on 20 euro per seat.\n")
    write_page(vault, "Projects/Atlas", "Atlas", "Atlas is the prototype. [[Projects]] #proto\n")
    conn = db.connect(vault / ".graite" / "index.sqlite")
    first = indexer.scan(vault, conn)
    assert sorted(first.added) == ["Projects", "Projects/Atlas"]
    assert sorted(first.chunked) == ["Projects", "Projects/Atlas"]
    indexed = {r[0]: r[1] for r in conn.execute("SELECT path, indexed_at FROM pages")}
    chunk_count = conn.execute("SELECT count(*) FROM chunks").fetchone()[0]
    assert chunk_count >= 2
    second = indexer.scan(vault, conn)
    assert not second.added and not second.changed and not second.chunked
    assert {r[0]: r[1] for r in conn.execute("SELECT path, indexed_at FROM pages")} == indexed
    links = conn.execute(
        "SELECT kind, target, target_path FROM links WHERE src_path='Projects/Atlas'"
    ).fetchall()
    assert ("wiki", "Projects", "Projects") in {tuple(r) for r in links}
    assert ("tag", "proto", None) in {tuple(r) for r in links}
    hits = conn.execute(
        "SELECT page_path FROM chunk_fts JOIN chunks ON chunks.id = chunk_fts.rowid "
        "WHERE chunk_fts MATCH 'euro'"
    ).fetchall()
    assert [r[0] for r in hits] == ["Projects"]


def test_editing_one_page_rechunks_only_it_and_keeps_unchanged_sections(tmp_path: Path) -> None:
    vault = tmp_path / "vault"
    body = (
        "# One\n\n"
        + "First section text that stays the same. " * 10
        + "\n\n# Two\n\n"
        + "Second section. " * 20
        + "\n"
    )
    file = write_page(vault, "Notes", "Notes", body)
    write_page(vault, "Other", "Other", "Untouched page body.\n")
    conn = db.connect(vault / ".graite" / "index.sqlite")
    indexer.scan(vault, conn)
    before = {
        r["heading"]: r["id"]
        for r in conn.execute("SELECT id, heading FROM chunks WHERE page_path='Notes'")
    }
    conn.execute("UPDATE chunks SET embedded_model='m' WHERE page_path='Notes'")
    other_indexed = conn.execute("SELECT indexed_at FROM pages WHERE path='Other'").fetchone()[0]
    file.write_text(
        file.read_text().replace("Second section. " * 20, "Changed second section. " * 20),
        encoding="utf-8",
    )
    bump_mtime(file)
    result = indexer.scan(vault, conn)
    assert result.changed == ["Notes"] and result.chunked == ["Notes"]
    after = {
        r["heading"]: (r["id"], r["embedded_model"])
        for r in conn.execute(
            "SELECT id, heading, embedded_model FROM chunks WHERE page_path='Notes'"
        )
    }
    assert after["One"] == (before["One"], "m")  # kept its row and vector
    assert after["Two"][1] is None  # needs a new embedding
    assert (
        conn.execute("SELECT indexed_at FROM pages WHERE path='Other'").fetchone()[0]
        == other_indexed
    )


def test_title_change_rechunks_and_move_repaths_without_new_rows(tmp_path: Path) -> None:
    vault = tmp_path / "vault"
    write_page(vault, "A", "A", "Parent.\n")
    write_page(vault, "A/Child", "Child", "Child body with some words.\n")
    write_page(vault, "B", "B", "Other parent. [[Child]]\n")
    conn = db.connect(vault / ".graite" / "index.sqlite")
    indexer.scan(vault, conn)
    child_id = conn.execute("SELECT id FROM chunks WHERE page_path='A/Child'").fetchone()[0]
    conn.execute("UPDATE chunks SET embedded_model='m'")
    shutil.move(vault / "A" / "Child", vault / "B" / "Child")
    result = indexer.scan(vault, conn)
    assert result.moved == [("A/Child", "B/Child")] and not result.chunked
    row = conn.execute(
        "SELECT id, page_path, embedded_model FROM chunks WHERE page_path='B/Child'"
    ).fetchone()
    assert row["id"] == child_id and row["embedded_model"] == "m"
    assert conn.execute("SELECT parent_path FROM pages WHERE path='B/Child'").fetchone()[0] == "B"
    assert (
        conn.execute(
            "SELECT target_path FROM links WHERE src_path='B' AND target='Child'"
        ).fetchone()[0]
        == "B/Child"
    )
    file = vault / "B" / "Child" / "page.md"
    file.write_text(file.read_text().replace("title: Child", "title: Kid"), encoding="utf-8")
    bump_mtime(file)
    result = indexer.scan(vault, conn)
    assert result.chunked == ["B/Child"]
    assert (
        conn.execute("SELECT embedded_model FROM chunks WHERE page_path='B/Child'").fetchone()[0]
        is None
    )


def test_rebuild_after_deleting_graite_and_removed_pages(tmp_path: Path) -> None:
    vault = tmp_path / "vault"
    write_page(vault, "Keep", "Keep", "# H\n\nKept body.\n")
    write_page(vault, "Gone", "Gone", "Gone body. [[Keep]]\n")
    write_page(vault, "Keep/Deep", "Deep", "Deep body.\n")
    conn = db.connect(vault / ".graite" / "index.sqlite")
    indexer.scan(vault, conn)
    count = conn.execute("SELECT count(*) FROM chunks").fetchone()[0]
    conn.close()
    shutil.rmtree(vault / ".graite")
    conn = db.connect(vault / ".graite" / "index.sqlite")
    indexer.scan(vault, conn)
    assert conn.execute("SELECT count(*) FROM chunks").fetchone()[0] == count
    shutil.rmtree(vault / "Gone")
    result = indexer.scan(vault, conn)
    assert result.removed == ["Gone"]
    assert conn.execute("SELECT count(*) FROM chunks WHERE page_path='Gone'").fetchone()[0] == 0
    assert conn.execute("SELECT count(*) FROM links WHERE src_path='Gone'").fetchone()[0] == 0


def test_corrupt_page_records_error_and_scan_continues(tmp_path: Path) -> None:
    vault = tmp_path / "vault"
    write_page(vault, "Good", "Good", "Fine.\n")
    bad = write_page(vault, "Bad", "Bad", "Fine too.\n")
    conn = db.connect(vault / ".graite" / "index.sqlite")
    indexer.scan(vault, conn)
    bad.write_text("---\ntitle: [unclosed\n---\nbody\n", encoding="utf-8")
    bump_mtime(bad)
    result = indexer.scan(vault, conn)
    assert result.total == 2
    assert conn.execute("SELECT index_error FROM pages WHERE path='Bad'").fetchone()[0]


def test_subtree_scan_only_reads_that_subtree(tmp_path: Path) -> None:
    vault = tmp_path / "vault"
    write_page(vault, "A", "A", "A body.\n")
    write_page(vault, "A/Inner", "Inner", "Inner body.\n")
    other = write_page(vault, "B", "B", "B body.\n")
    conn = db.connect(vault / ".graite" / "index.sqlite")
    indexer.scan(vault, conn)
    other.write_text(other.read_text() + "\nMore.\n", encoding="utf-8")
    bump_mtime(other)
    write_page(vault, "A/New", "New", "New body.\n")
    result = indexer.scan(vault, conn, paths=["A"])
    assert result.added == ["A/New"] and not result.changed
    assert conn.execute("SELECT parent_path FROM pages WHERE path='A/New'").fetchone()[0] == "A"
    result = indexer.scan(vault, conn)
    assert result.changed == ["B"]


def test_duplicated_page_ids_do_not_break_the_scan(tmp_path: Path) -> None:
    """A folder copied outside Graite gives two pages the same id; moving both must work."""
    vault = tmp_path / "vault"
    write_page(vault, "A1", "A1", "First copy.\n", {"id": "dup-id"})
    write_page(vault, "A2", "A2", "Second copy.\n", {"id": "dup-id"})
    write_page(vault, "Parent", "Parent", "Home.\n")
    conn = db.connect(vault / ".graite" / "index.sqlite")
    indexer.scan(vault, conn)
    shutil.move(vault / "A1", vault / "Parent" / "A1")
    shutil.move(vault / "A2", vault / "Parent" / "A2")
    result = indexer.scan(vault, conn)
    assert sorted(new for _, new in result.moved) == ["Parent/A1", "Parent/A2"]
    assert not result.removed
    paths = {r[0] for r in conn.execute("SELECT path FROM pages")}
    assert paths == {"Parent", "Parent/A1", "Parent/A2"}
    assert (
        conn.execute("SELECT count(*) FROM chunks WHERE page_path LIKE 'Parent/%'").fetchone()[0]
        == 2
    )


def test_subtree_scan_of_a_plain_folder_finds_the_pages_inside(tmp_path: Path) -> None:
    """`mkdir -p Notes/Idea` plus a page.md: the watcher rescans `Notes`, which has no page."""
    vault = tmp_path / "vault"
    write_page(vault, "Home", "Home", "")
    conn = db.connect(vault / ".graite" / "index.sqlite")
    indexer.scan(vault, conn)
    write_page(vault, "Notes/Idea", "Idea", "Something.\n")
    write_page(vault, "Notes/Idea/Detail", "Detail", "")
    result = indexer.scan(vault, conn, paths=["Notes"])
    assert sorted(result.added) == ["Notes/Idea", "Notes/Idea/Detail"]
    parents = dict(conn.execute("SELECT path, parent_path FROM pages").fetchall())
    assert parents["Notes/Idea"] is None and parents["Notes/Idea/Detail"] == "Notes/Idea"


def test_pages_without_frontmatter_get_distinct_stable_ids(tmp_path: Path) -> None:
    vault = tmp_path / "vault"
    for name in ("One", "Two"):
        (vault / name).mkdir(parents=True)
        (vault / name / "page.md").write_text("Plain text.\n", encoding="utf-8")
    conn = db.connect(vault / ".graite" / "index.sqlite")
    indexer.scan(vault, conn)
    ids = dict(conn.execute("SELECT path, id FROM pages").fetchall())
    assert ids["One"] and ids["Two"] and ids["One"] != ids["Two"]
    # Opening never rewrites the file; the id is derived again the same way.
    assert (vault / "One" / "page.md").read_text(encoding="utf-8") == "Plain text.\n"
    conn.close()  # Windows cannot delete an open database file.
    shutil.rmtree(vault / ".graite")
    conn = db.connect(vault / ".graite" / "index.sqlite")
    indexer.scan(vault, conn)
    assert dict(conn.execute("SELECT path, id FROM pages").fetchall()) == ids


def test_a_new_page_that_cannot_be_read_still_appears_with_its_error(tmp_path: Path) -> None:
    vault = tmp_path / "vault"
    (vault / "Broken").mkdir(parents=True)
    (vault / "Broken" / "page.md").write_text("---\ntitle: [unclosed\n---\nBody\n")
    conn = db.connect(vault / ".graite" / "index.sqlite")
    assert indexer.scan(vault, conn).added == ["Broken"]
    row = conn.execute("SELECT title, index_error FROM pages WHERE path='Broken'").fetchone()
    assert row["title"] == "Broken" and row["index_error"]
    page = vault / "Broken" / "page.md"
    page.write_text("---\ntitle: Fixed\n---\nBody\n")
    bump_mtime(page)
    result = indexer.scan(vault, conn)
    assert result.changed == ["Broken"] and result.tree_changed
    assert conn.execute("SELECT title FROM pages WHERE path='Broken'").fetchone()[0] == "Fixed"


def test_a_byte_order_mark_does_not_hide_the_frontmatter(tmp_path: Path) -> None:
    vault = tmp_path / "vault"
    (vault / "Bom").mkdir(parents=True)
    (vault / "Bom" / "page.md").write_text("﻿---\ntitle: Titled\n---\nBody\n", encoding="utf-8")
    conn = db.connect(vault / ".graite" / "index.sqlite")
    indexer.scan(vault, conn)
    assert conn.execute("SELECT title FROM pages WHERE path='Bom'").fetchone()[0] == "Titled"


def test_an_outside_title_change_counts_as_a_tree_change(tmp_path: Path) -> None:
    vault = tmp_path / "vault"
    page = write_page(vault, "Page", "Old", "Body.\n")
    conn = db.connect(vault / ".graite" / "index.sqlite")
    indexer.scan(vault, conn)
    page.write_text(page.read_text(encoding="utf-8").replace("Old", "New"), encoding="utf-8")
    bump_mtime(page)
    result = indexer.scan(vault, conn, paths=["Page"])
    assert result.relabeled == ["Page"] and not result.structure_changed
