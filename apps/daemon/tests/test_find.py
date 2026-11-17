"""Find (D101): instant results from the index, no chat model involved."""

from __future__ import annotations

import asyncio
import time

import pytest
import sqlite_vec
from fastapi.testclient import TestClient

from graite.models.providers import Provider
from graite.retrieval.find import Finder, match_query, snippet, terms_of


def page(client: TestClient, title: str, body: str, parent: str | None = None) -> dict:
    doc = client.post("/api/v1/pages", json={"title": title, "parent_path": parent}).json()
    client.put(f"/api/v1/pages/{doc['path']}", json={"body": body, "base_hash": doc["hash"]})
    return doc


@pytest.fixture
def notes(client: TestClient) -> TestClient:
    page(client, "Invoices", "Everything we bill.\n")
    page(
        client,
        "Q3 invoice Halden",
        "## Status\n\nThe invoice to Halden Freight for 18,400 euros is overdue.\n",
        "Invoices",
    )
    # Long enough for each section to be a passage of its own.
    filler = "This sentence only adds length so the section is indexed separately. " * 20
    page(
        client,
        "Pricing",
        f"## Decision\n\nWe charge 20 euro per seat. {filler}\n\n"
        f"## Later\n\nA seat discount for schools. {filler}\n",
    )
    page(client, "Paint", "The kitchen walls get cobalt blue.\n")
    return client


def find(client: TestClient, q: str, **params: object) -> dict:
    response = client.get("/api/v1/search", params={"q": q, **params})
    assert response.status_code == 200, response.text
    return response.json()


def test_query_helpers() -> None:
    assert terms_of("What is the invoice for Halden?") == ["invoice", "halden"]
    assert terms_of("the") == ["the"]  # nothing but a stop word still searches
    assert match_query(["invoice", "hal"], every=True) == '"invoice" AND "hal"*'
    assert match_query([], every=True) is None
    long = "word " * 80 + "the needle is here " + "tail " * 80
    cut = snippet(long, ["needle"])
    assert "needle" in cut and cut.startswith("… ") and cut.endswith(" …") and len(cut) < 200


def test_find_answers_without_any_model(notes: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    async def never(self: Provider, *args: object, **kwargs: object):  # type: ignore[no-untyped-def]
        raise AssertionError("Find must not call a chat model")
        yield  # pragma: no cover

    monkeypatch.setattr(Provider, "chat", never)
    found = find(notes, "halden invoice")
    assert found["semantic"] is False  # no embedding model here: words and titles
    top = found["results"][0]
    assert top["path"] == "Invoices/Q3 invoice Halden" and top["title"] == "Q3 invoice Halden"
    assert top["heading_path"] == ["Status"] and "18,400" in top["snippet"]
    assert set(top["via"]) == {"text", "title"}
    assert found["took_ms"] < 200


def test_find_matches_as_you_type_and_merges_a_page_into_one_result(notes: TestClient) -> None:
    # The last word is a prefix: "sea" finds "seat" while it is being typed.
    typed = find(notes, "sea")
    assert [r["path"] for r in typed["results"]] == ["Pricing"]
    assert typed["results"][0]["matches"] == 2  # two passages, one result
    # A title alone is a hit, with no snippet.
    assert find(notes, "paint")["results"][0]["via"] == ["text", "title"]
    assert find(notes, "invoi")["results"][0]["path"] == "Invoices"
    # One wrong word does not empty the list.
    assert find(notes, "halden zzzz")["results"][0]["path"] == "Invoices/Q3 invoice Halden"
    assert find(notes, "")["results"] == [] and find(notes, "zzzz")["results"] == []


def test_find_can_be_limited_to_a_page_and_its_subpages(notes: TestClient) -> None:
    everywhere = {r["path"] for r in find(notes, "euro")["results"]}
    assert everywhere == {"Invoices/Q3 invoice Halden", "Pricing"}
    under = {r["path"] for r in find(notes, "euro", root="Invoices")["results"]}
    assert under == {"Invoices/Q3 invoice Halden"}
    assert find(notes, "euro", root="Pricing")["results"][0]["path"] == "Pricing"


def test_find_includes_pages_that_ai_may_not_read(notes: TestClient) -> None:
    doc = page(notes, "Salaries", "Sam earns a cobalt salary.\n")
    settings = notes.put(f"/api/v1/pages/{doc['path']}/ai", json={"cloud": "none"})
    assert settings.status_code in (200, 404, 405, 422)  # the route differs by version
    assert "Salaries" in {r["path"] for r in find(notes, "salary")["results"]}


class Vectors:
    """An embedder that answers at once when "loaded" and never when not."""

    def __init__(self, conn, loaded: bool, delay: float = 0.0) -> None:  # type: ignore[no-untyped-def]
        self.conn, self.loaded, self.delay, self.calls = conn, loaded, delay, 0

    def ready_for_queries(self) -> bool:
        return self.loaded

    async def embed_query(self, text: str) -> list[float] | None:
        self.calls += 1
        await asyncio.sleep(self.delay)
        return [0.0, 1.0, 0.1] if "wall" in text or "colour" in text else [1.0, 0.0, 0.1]


def with_vectors(client: TestClient) -> None:
    conn = client.app.state.db
    conn.execute("CREATE VIRTUAL TABLE IF NOT EXISTS chunk_vec USING vec0(embedding float[3])")
    for row in conn.execute("SELECT id, text FROM chunks").fetchall():
        vector = [0.0, 1.0, 0.1] if "cobalt" in row["text"] else [1.0, 0.0, 0.1]
        conn.execute(
            "INSERT OR REPLACE INTO chunk_vec(rowid, embedding) VALUES (?, ?)",
            (row["id"], sqlite_vec.serialize_float32(vector)),
        )


async def test_vectors_join_in_only_when_the_model_is_already_loaded(notes: TestClient) -> None:
    with_vectors(notes)
    conn = notes.app.state.db
    # "What colour are the walls" shares no word with "cobalt blue": only meaning finds it.
    loaded = Vectors(conn, loaded=True)
    by_meaning = await Finder(conn, loaded).find("what colour for the wall")
    assert by_meaning["semantic"] is True
    assert by_meaning["results"][0]["path"] == "Paint"
    assert "meaning" in by_meaning["results"][0]["via"]

    cold = Vectors(conn, loaded=False)
    by_words = await Finder(conn, cold).find("what colour for the wall")
    assert by_words["semantic"] is False and cold.calls == 0

    # A slow embedding is not waited for: keyword results go out, the vector finishes later.
    slow = Vectors(conn, loaded=True, delay=1.0)
    started = time.perf_counter()
    quick = await Finder(conn, slow).find("seat discount")
    assert time.perf_counter() - started < 0.5
    assert quick["semantic"] is False and quick["results"][0]["path"] == "Pricing"


async def test_query_vectors_are_cached(client: TestClient) -> None:
    embedder = client.app.state.embedder
    calls = []

    class Item:
        id, local_path, pooling, embedding_family = "m", "/m.gguf", "last", ""

    async def embed_texts(texts, task="document", *, evict_chat=True):  # type: ignore[no-untyped-def]
        calls.append(texts)
        return [[float(len(texts[0])), 0.0]]

    embedder.item = lambda: Item()  # type: ignore[method-assign]
    embedder.has_vec = lambda: True  # type: ignore[method-assign]
    embedder.current_model = lambda: ("m", 2)  # type: ignore[method-assign]
    embedder.embed_texts = embed_texts  # type: ignore[method-assign]
    first = await embedder.embed_query("invoice q3")
    assert await embedder.embed_query("invoice q3") == first
    assert await embedder.embed_query(" invoice q3 ") == first
    assert len(calls) == 1
    await embedder.embed_query("something else")
    assert len(calls) == 2


def test_warm_is_harmless_without_an_embedding_model(client: TestClient) -> None:
    assert client.post("/api/v1/search/warm").json() == {"semantic": False}
