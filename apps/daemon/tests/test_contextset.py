from __future__ import annotations

from pathlib import Path

from graite.index import db
from graite.retrieval.context import Source
from graite.retrieval.contextset import MAX_SOURCES, ContextSet
from graite.vault import indexer
from tests.test_indexer import bump_mtime, write_page


def src(path: str, heading: list[str], text: str, *chunks: int, kind: str = "page") -> Source:
    return Source(0, kind, path, None, path.rsplit("/", 1)[-1], heading, text, "h1", list(chunks))


def test_numbers_are_assigned_once_and_duplicates_collapse() -> None:
    ctx = ContextSet()
    ctx.begin_turn()
    a = ctx.add(src("Pricing", ["Decision"], "20 euro", 1, 2))
    b = ctx.add(src("Atlas", [], "prototype", 3))
    assert (a, b) == (1, 2)
    # A chunk subset of an existing source is the same source.
    assert ctx.add(src("Pricing", ["Decision"], "20 euro", 1)) == 1
    # A tool result for the same section without chunk ids is the same source.
    assert ctx.add(src("Pricing", ["Decision"], "20 euro")) == 1
    # Two different attachments with the same (empty) heading are distinct.
    first = Source(0, "attachment", None, None, "a.md", [], "alpha", "sha-a")
    second = Source(0, "attachment", None, None, "b.md", [], "beta", "sha-b")
    assert ctx.add(first) == 3 and ctx.add(second) == 4
    assert ctx.add(Source(0, "attachment", None, None, "a.md", [], "alpha", "sha-a")) == 3
    assert ctx.new_numbers() == [1, 2, 3, 4]
    ctx.begin_turn()
    assert ctx.add(src("Journal", [], "paint", 9)) == 5 and ctx.new_numbers() == [5]


def test_round_trip_keeps_text_numbers_and_turns() -> None:
    ctx = ContextSet()
    ctx.begin_turn()
    ctx.add(src("Pricing", ["Decision"], "20 euro", 1))
    ctx.mark_cited([1])
    ctx.begin_turn()
    ctx.add(src("Atlas", [], "prototype", 3))
    loaded = ContextSet.load(ctx.dump())
    assert [s.n for s in loaded.sources] == [1, 2]
    assert loaded.sources[0].text == "20 euro" and loaded.turn == 2
    assert loaded.entries[0].last_cited_turn == 1 and loaded.entries[1].added_turn == 2
    public = loaded.public()
    assert "text" not in public[0] and public[0]["snippet"] == "20 euro"
    assert ContextSet.load("not json").entries == [] and ContextSet.load(None).turn == 0


def test_fit_prefers_new_then_recently_cited_and_evicted_stay_citable() -> None:
    ctx = ContextSet()
    ctx.begin_turn()
    for i in range(4):
        ctx.add(src(f"P{i}", [], "x" * 100, i + 1))
    ctx.mark_cited([3])
    ctx.begin_turn()
    ctx.add(src("New", [], "y" * 100, 9))
    block = len(ctx.sources[0].prompt_block().encode()) + 2
    chosen = ctx.fit(block * 2 + 10)
    assert [s.n for s in chosen] == [3, 5]  # cited earlier, then this turn's, in number order
    assert not ctx.entries[0].in_prompt and ctx.entries[0].source.n == 1
    assert len(ctx) == 5  # nothing is forgotten
    ctx.drop_unseen()
    assert len(ctx) == 5  # the new one was shown, so it stays
    ctx.keep_only([3])
    ctx.drop_unseen()
    assert [s.n for s in ctx.sources] == [1, 2, 3, 4]


def test_set_is_capped_by_evicting_the_least_useful() -> None:
    ctx = ContextSet()
    ctx.begin_turn()
    for i in range(MAX_SOURCES):
        ctx.add(src(f"P{i}", [], "t", i + 1))
    ctx.mark_cited([1])
    ctx.begin_turn()
    n = ctx.add(src("Extra", [], "t", 999))
    assert n == MAX_SOURCES + 1 and len(ctx) == MAX_SOURCES
    numbers = [s.n for s in ctx.sources]
    assert 1 in numbers and 2 not in numbers  # the uncited one went first


def test_refresh_rereads_changed_pages_and_marks_vanished_sections(tmp_path: Path) -> None:
    vault = tmp_path / "vault"
    write_page(vault, "Pricing", "Pricing", "# Decision\n\nTwenty euro.\n\n# Options\n\nMore.\n")
    conn = db.connect(vault / ".graite" / "index.sqlite")
    indexer.scan(vault, conn)
    row = conn.execute(
        "SELECT id, page_path FROM chunks WHERE heading_path LIKE '%Decision%'"
    ).fetchone()
    file_hash = conn.execute("SELECT file_hash FROM pages WHERE path='Pricing'").fetchone()[0]
    ctx = ContextSet()
    ctx.begin_turn()
    decision = Source(
        0, "page", "Pricing", None, "Pricing", ["Decision"], "Twenty euro.", file_hash, [row["id"]]
    )
    options = Source(0, "page", "Pricing", None, "Pricing", ["Options"], "More.", file_hash, [])
    ctx.add(decision)
    ctx.add(options)
    ctx.refresh(conn)
    assert ctx.sources[0].text == "Twenty euro." and not ctx.entries[0].stale
    file = vault / "Pricing" / "page.md"
    file.write_text(
        file.read_text().replace("Twenty euro.", "Thirty euro.").replace("# Options\n\nMore.\n", "")
    )
    bump_mtime(file)
    indexer.scan(vault, conn)
    ctx.refresh(conn)
    assert ctx.sources[0].text == "Thirty euro." and ctx.sources[0].hash != file_hash
    assert ctx.entries[1].stale and ctx.sources[1].text == "More."
    conn.close()


def test_later_excerpts_get_their_own_citation_and_fuller_reads_update_the_source() -> None:
    ctx = ContextSet()
    ctx.begin_turn()
    first = ctx.add(src("Graite", [], "First task."))
    last = ctx.add(src("Graite", [], "Final task."))
    assert first != last
    assert ctx.add(src("Graite", [], "First task. More detail.")) == first
    assert ctx.sources[0].text == "First task. More detail."
    assert ctx.sources[1].text == "Final task."
