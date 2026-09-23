from __future__ import annotations

import asyncio
from pathlib import Path
from types import SimpleNamespace

import pytest
import sqlite_vec

from graite.index import db
from graite.retrieval import answer, research
from graite.retrieval.context import Source, build
from graite.retrieval.scope import Scope
from graite.retrieval.scope import resolve as resolve_scope
from graite.retrieval.search import Searcher, fts_query
from graite.retrieval.strategy import classify
from graite.vault import indexer, policy
from tests.test_indexer import write_page

PAGES = {
    "Projects": ("Projects", "# Overview\n\nAll projects live here.\n", {}),
    "Projects/Pricing": (
        "Pricing",
        "# Decision\n\nWe decided on 20 euro per seat after the workshop in March.\n\n"
        "# Options\n\nThe alternatives were 15 and 25 euro.\n",
        {"cloud": "local-only"},
    ),
    "Projects/Atlas": (
        "Atlas",
        "Atlas is the prototype. See [[Pricing]] for the seat price. #proto\n",
        {},
    ),
    "Journal": ("Journal", "# 2026-03-01\n\nTalked about cobalt paint for the office walls.\n", {}),
    "Journal/Tasks": (
        "Tasks",
        "Open tasks.\n",
        {
            "properties": [
                {
                    "id": "s",
                    "name": "Status",
                    "type": "status",
                    "options": ["Todo", "Done"],
                    "value": "Todo",
                }
            ]
        },
    ),
    "Private": ("Private", "Salary numbers are private.\n", {}),
}


class FakeEmbedder:
    """Vectors: [pricing-ness, paint-ness, other]. Query maps by keyword."""

    def __init__(self, conn) -> None:  # type: ignore[no-untyped-def]
        self.conn = conn
        self.model = "fake"

    def vector(self, text: str) -> list[float]:
        t = text.lower()
        return [
            1.0 if "seat" in t or "euro" in t or "price" in t or "cost" in t else 0.0,
            1.0 if "paint" in t or "colour" in t or "color" in t or "cobalt" in t else 0.0,
            0.1,
        ]

    async def embed_query(self, text: str) -> list[float] | None:
        return self.vector(text)

    def status(self) -> dict:  # type: ignore[type-arg]
        return {"pending_chunks": 0, "embedding_model": self.model}


@pytest.fixture
def vault(tmp_path: Path):  # type: ignore[no-untyped-def]
    root = tmp_path / "vault"
    for path, (title, body, meta) in PAGES.items():
        write_page(root, path, title, body, meta)
    conn = db.connect(root / ".graite" / "index.sqlite")
    indexer.scan(root, conn)
    embedder = FakeEmbedder(conn)
    conn.execute("CREATE VIRTUAL TABLE chunk_vec USING vec0(embedding float[3])")
    conn.execute("INSERT OR REPLACE INTO meta VALUES ('embedding_model','fake')")
    conn.execute("INSERT OR REPLACE INTO meta VALUES ('embedding_dim','3')")
    for row in conn.execute("SELECT id, text FROM chunks").fetchall():
        conn.execute(
            "INSERT INTO chunk_vec(rowid, embedding) VALUES (?, ?)",
            (row["id"], sqlite_vec.serialize_float32(embedder.vector(row["text"]))),
        )
    conn.execute("UPDATE chunks SET embedded_model='fake'")
    yield SimpleNamespace(root=root, conn=conn, embedder=embedder)
    conn.close()


def test_scope_kinds_and_cloud_gate(vault) -> None:  # type: ignore[no-untyped-def]
    page = resolve_scope(
        vault.conn, vault.root, Scope("page", ["Projects/Atlas"]), cloud_provider=False
    )
    assert page.paths == ["Projects/Atlas"]
    folder = resolve_scope(
        vault.conn, vault.root, Scope("folder", ["Projects"]), cloud_provider=False
    )
    assert folder.paths == ["Projects", "Projects/Atlas", "Projects/Pricing"]
    whole = resolve_scope(
        vault.conn, vault.root, Scope("vault", [], ["Private"]), cloud_provider=False
    )
    assert "Private" not in whole.paths and whole.excluded_user == 1 and not whole.all_pages
    cloud = resolve_scope(vault.conn, vault.root, Scope("vault"), cloud_provider=True)
    assert cloud.excluded_local_only == ["Projects/Pricing"] and not cloud.contains(
        "Projects/Pricing"
    )
    assert cloud.all_pages is False
    with pytest.raises(FileNotFoundError):
        resolve_scope(vault.conn, vault.root, Scope("page", ["Nope"]), cloud_provider=False)
    assert Scope.parse('{"kind":"folder","roots":["Projects"]}').kind == "folder"
    assert Scope.parse({}, default_root="Journal").roots == ["Journal"]
    assert Scope.parse(None).kind == "vault"


def test_strategy_classification() -> None:
    plain = classify("What did we decide about pricing?")
    assert plain.semantic and plain.exact and not plain.structured and not plain.research
    exact = classify('Where is "20 euro per seat" mentioned?')
    assert exact.phrases == ["20 euro per seat"] and exact.k == 16
    structured = classify("List all tasks with status Todo")
    assert structured.structured
    deep = classify(
        "Why did pricing evolve between March and June, and how does it compare to Atlas?"
    )
    assert deep.research and deep.max_rounds == 5
    assert fts_query("What did we decide about pricing?", []) == '("decide" OR "pricing"*)'
    assert fts_query("x", ["exact phrase"]) == '"exact phrase"'


async def test_hybrid_search_fuses_keywords_and_vectors(vault) -> None:  # type: ignore[no-untyped-def]
    searcher = Searcher(vault.conn, vault.embedder)
    scope = resolve_scope(vault.conn, vault.root, Scope("vault"), cloud_provider=False)
    hits = await searcher.search("What did we decide about the price per seat?", scope)
    assert hits[0].page_path == "Projects/Pricing" and hits[0].heading_path == ["Decision"]
    assert hits[0].fts_rank == 1 and hits[0].vec_rank is not None
    assert searcher.semantic_available
    # Keyword-only page still surfaces; vectors rank the semantically closer page first.
    hits = await searcher.search("what colour did we pick for the walls", scope)
    assert hits[0].page_path == "Journal"
    # Scope filtering applies to both signals.
    folder = resolve_scope(
        vault.conn, vault.root, Scope("folder", ["Journal"]), cloud_provider=False
    )
    hits = await searcher.search("price per seat euro", folder)
    assert all(h.page_path.startswith("Journal") for h in hits)
    # Cloud gate keeps local-only pages out even though they match best.
    cloud = resolve_scope(vault.conn, vault.root, Scope("vault"), cloud_provider=True)
    hits = await searcher.search("20 euro per seat", cloud)
    assert all(h.page_path != "Projects/Pricing" for h in hits)
    # Linked-page boost: Atlas links to Pricing.
    hits = await searcher.search("Atlas prototype seat price", scope)
    assert {h.page_path for h in hits[:3]} >= {"Projects/Atlas", "Projects/Pricing"}
    # Structured hits find the page by property value.
    plan = classify("list all tasks with status Todo")
    hits = await searcher.search("list all tasks with status Todo", scope, plan=plan)
    assert any(h.page_path == "Journal/Tasks" for h in hits)


async def test_search_degrades_without_vectors(vault) -> None:  # type: ignore[no-untyped-def]
    searcher = Searcher(vault.conn, None)
    scope = resolve_scope(vault.conn, vault.root, Scope("vault"), cloud_provider=False)
    hits = await searcher.search("cobalt", scope)
    assert hits[0].page_path == "Journal" and not searcher.semantic_available

    class Broken:
        async def embed_query(self, text: str) -> list[float]:
            raise RuntimeError("engine missing")

    searcher = Searcher(vault.conn, Broken())
    hits = await searcher.search("cobalt", scope)
    assert hits and searcher.last_semantic_error == "engine missing"


async def test_context_expands_sections_and_numbers_sources(vault) -> None:  # type: ignore[no-untyped-def]
    searcher = Searcher(vault.conn, vault.embedder)
    scope = resolve_scope(vault.conn, vault.root, Scope("vault"), cloud_provider=False)
    hits = await searcher.search("price per seat", scope)
    selection = Source(0, "selection", "Journal", None, "Selected text", [], "Paint it cobalt.")
    sources = build(vault.conn, hits, 4000, extra=[selection])
    assert [s.n for s in sources] == list(range(1, len(sources) + 1))
    assert sources[0].kind == "selection"
    pricing = next(s for s in sources if s.page_path == "Projects/Pricing")
    assert "20 euro" in pricing.text and pricing.hash and pricing.chunk_ids
    assert len({(s.page_path, tuple(s.heading_path)) for s in sources}) == len(sources)
    tiny = build(vault.conn, hits, 60)
    assert len(tiny) == 1 and len(tiny[0].text.encode()) <= 60


def test_answer_prompt_citations_and_limits(vault) -> None:  # type: ignore[no-untyped-def]
    effective = policy.Effective()
    effective.instructions.append({"source": "AGENTS.md", "text": "Be brief."})
    sources = [
        Source(1, "page", "P", "id", "P", ["H"], "Fact one."),
        Source(2, "page", "Q", "id2", "Q", [], "Fact two."),
    ]
    messages, included = answer.messages(
        effective,
        sources,
        [{"path": "P", "title": "P"}],
        [
            {"role": "assistant", "content": "old"},
            {"role": "user", "content": "earlier"},
            {"role": "assistant", "content": "reply"},
        ],
        "What?",
        8192,
        mode="draft",
        weak=True,
    )
    system = messages[0]["content"]
    assert included == 2 and "[1] P > H (P)\nFact one." in system and "Be brief." in system
    assert "Draft mode" in system and "matched only weakly" in system
    # Oversized and interrupted history is dropped; the newest question always survives and
    # the first conversational turn is a user one (Anthropic requires that).
    assert [m["content"] for m in messages[1:]] == ["earlier", "reply", "What?"]
    cited, text = answer.validate_citations("Fact [1] and [2, 7] and [9].", 2)
    assert cited == [1, 2] and text == "Fact [1] and [2] and."
    assert answer.clarification("CLARIFY: which project?") == ("which project?", "")
    assert answer.clarification("The plan is set [1].\n\nCLARIFY: which project?") == (
        "which project?",
        "The plan is set [1].",
    )
    assert answer.clarification("No.") == (None, "No.")
    scope = resolve_scope(vault.conn, vault.root, Scope("vault"), cloud_provider=True)
    lines = answer.limits(
        classify("x"),
        scope,
        [],
        [],
        provider_label="Claude",
        semantic_used=False,
        pending_chunks=5,
        embedding_model="m",
        researched=True,
    )
    assert any("local-only" in line and "Claude" in line for line in lines)
    assert any("still building" in line for line in lines)
    # Semantic search was planned but unavailable, so it is not claimed.
    assert lines[0].startswith("Searched 5 pages in your vault (keywords,")
    assert any("Silence in your notes" in line for line in lines)
    named = answer.limits(
        classify("x"),
        scope,
        [],
        [],
        provider_label="local",
        semantic_used=True,
        pending_chunks=0,
        embedding_model="m",
        researched=False,
        missing_terms=["berlin", "lease"],
    )
    assert any("\u201cberlin\u201d or \u201clease\u201d" in line for line in named)
    with pytest.raises(ValueError, match="too long"):
        answer.messages(effective, [], [], [], "x" * 16000, 2048)


async def test_missing_terms_are_named(vault) -> None:  # type: ignore[no-untyped-def]
    searcher = Searcher(vault.conn, vault.embedder)
    scope = resolve_scope(vault.conn, vault.root, Scope("vault"), cloud_provider=False)
    # Common verbs are never named: only distinctive words that genuinely do not occur.
    assert searcher.missing_terms("What did we decide about the Berlin lease?", scope) == [
        "berlin",
        "lease",
    ]
    assert searcher.missing_terms("What did we decide?", scope) == []
    assert searcher.missing_terms("What did we decide about pricing?", scope) == []
    folder = resolve_scope(
        vault.conn, vault.root, Scope("folder", ["Journal"]), cloud_provider=False
    )
    assert "workshop" in searcher.missing_terms("workshop cobalt", folder)


async def test_weak_evidence_allows_more_rounds(vault) -> None:  # type: ignore[no-untyped-def]
    searcher = Searcher(vault.conn, vault.embedder)
    scope = resolve_scope(vault.conn, vault.root, Scope("vault"), cloud_provider=False)
    plan = classify("price per seat")
    strong = await searcher.search("price per seat", scope, plan=plan)
    assert not research.weak(strong, plan) and research.rounds(strong, plan) == 2
    assert research.weak([], plan) and research.rounds([], plan) == 4
    deep = classify("Why did pricing change and how does it compare to Atlas?")
    assert research.rounds(strong, deep) == 5


async def test_concurrent_searches_keep_their_own_scope(vault) -> None:  # type: ignore[no-untyped-def]
    """Two turns share one connection; their scope tables must not collide."""
    narrow = resolve_scope(
        vault.conn, vault.root, Scope("folder", ["Journal"]), cloud_provider=False
    )
    wide = resolve_scope(
        vault.conn, vault.root, Scope("folder", ["Projects"]), cloud_provider=False
    )
    a, b = Searcher(vault.conn, vault.embedder), Searcher(vault.conn, vault.embedder)
    assert a.table != b.table
    try:
        hits_a, hits_b = await asyncio.gather(
            a.search("cobalt paint", narrow), b.search("seat price", wide)
        )
        assert hits_a and all(h.page_path.startswith("Journal") for h in hits_a)
        assert hits_b and all(h.page_path.startswith("Projects") for h in hits_b)
    finally:
        a.release()
        b.release()
    tables = {r[0] for r in vault.conn.execute("SELECT name FROM temp.sqlite_master")}
    assert a.table not in tables and b.table not in tables


def test_citations_leave_code_and_indexes_alone() -> None:
    cited, text = answer.validate_citations(
        "Use `rows[0]` and see [2]. Also matrix[1][3] and [9].\n```\nx[1]\n```\n", 3
    )
    assert cited == [2]
    assert "`rows[0]`" in text and "matrix[1][3]" in text and "x[1]" in text
    assert "see [2]." in text and "[9]" not in text
    assert answer.validate_citations("Both [1, 2] here.", 2) == ([1, 2], "Both [1, 2] here.")


def test_local_only_roots_match_the_full_cascade(vault) -> None:  # type: ignore[no-untyped-def]
    (vault.root / "Journal" / "AGENTS.md").write_text("---\ncloud: local-only\n---\n")
    resolver = policy.Resolver(vault.root, vault.conn)
    roots = resolver.local_only_roots()
    assert roots == ["Journal", "Projects/Pricing"]
    paths = [r["path"] for r in vault.conn.execute("SELECT path FROM pages")]
    slow = {p: not policy.resolve(vault.root, vault.conn, p).cloud_allowed for p in paths}
    fast = {p: any(p == r or p.startswith(r + "/") for r in roots) for p in paths}
    assert slow == fast
    cloud = resolve_scope(vault.conn, vault.root, Scope("vault"), cloud_provider=True)
    assert cloud.excluded_local_only == ["Journal", "Journal/Tasks", "Projects/Pricing"]
    assert cloud.policy_for("Projects/Pricing").cloud_allowed is False
    (vault.root / "AGENTS.md").write_text("---\ncloud: local-only\n---\n")
    assert policy.Resolver(vault.root, vault.conn).local_only_roots() == [""]
    assert resolve_scope(vault.conn, vault.root, Scope("vault"), cloud_provider=True).paths == []


async def test_a_busy_embedding_model_is_reported_not_hidden(vault) -> None:  # type: ignore[no-untyped-def]
    from graite.models.manager import EmbeddingBusy

    class Busy(FakeEmbedder):
        async def embed_query(self, text: str) -> list[float] | None:
            raise EmbeddingBusy("the chat model stays loaded")

    scope = resolve_scope(vault.conn, vault.root, Scope("vault"), cloud_provider=False)
    searcher = Searcher(vault.conn, Busy(vault.conn))
    hits = await searcher.search("seat price", scope)
    assert hits and not searcher.semantic_available and searcher.semantic_skipped
    lines = answer.limits(
        classify("seat price"),
        scope,
        [],
        [],
        provider_label="the local model",
        semantic_used=False,
        pending_chunks=0,
        embedding_model="fake",
        researched=False,
        semantic_skipped=searcher.semantic_skipped,
    )
    assert any("Semantic search was skipped" in line for line in lines)
    searcher.release()


def test_history_is_clipped_not_dropped() -> None:
    effective = policy.Effective()
    long = "x" * 20000
    history = [
        {"role": "user", "content": "first"},
        {"role": "assistant", "content": "kept"},
        {"role": "user", "content": long},
        {"role": "assistant", "content": "last"},
    ]
    messages, _ = answer.messages(effective, [], [], history, "next?", 8192)
    roles = [m["role"] for m in messages[1:-1]]
    assert roles == ["user", "assistant", "user", "assistant"]
    assert messages[1]["content"] == "first" and len(messages[3]["content"]) <= 4000
    assert answer.validate_citations("see [2] and [5].", {2, 3}) == ([2], "see [2] and.")
