from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager
from pathlib import Path
from types import SimpleNamespace

import pytest

from graite.events import EventBus
from graite.index import db
from graite.index.embedder import Embedder
from graite.vault import indexer
from tests.test_indexer import bump_mtime, write_page


class FakeProvider:
    def __init__(self, dim: int) -> None:
        self.dim = dim
        self.calls: list[list[str]] = []

    async def embed(self, texts: list[str]) -> list[list[float]]:
        self.calls.append(texts)
        return [[float(len(t) % 7)] * self.dim for t in texts]


def make(tmp_path: Path, dim: int) -> tuple[Embedder, FakeProvider, Path]:
    vault = tmp_path / "vault"
    write_page(vault, "One", "One", "# A\n\nAlpha text.\n\n# B\n\nBeta text.\n")
    write_page(vault, "Two", "Two", "Gamma text.\n")
    conn = db.connect(vault / ".graite" / "index.sqlite")
    indexer.scan(vault, conn)
    provider = FakeProvider(dim)
    item = SimpleNamespace(
        id="fake-embed",
        role="embedding",
        status="installed",
        local_path="/m.gguf",
        pooling="mean",
        embedding_family="embeddinggemma",
    )
    downloads = SimpleNamespace(items={"fake-embed": item})
    manager = SimpleNamespace(lock=asyncio.Lock(), chat_waiting=asyncio.Event())

    @asynccontextmanager
    async def use_embedding(
        path: str, pooling: str, *, release: bool = False, evict_chat: bool = True
    ):  # type: ignore[no-untyped-def]  # noqa: E501
        yield provider

    manager.use_embedding = use_embedding
    return Embedder(conn, manager, downloads, EventBus()), provider, vault  # type: ignore[arg-type]


async def test_embeds_pending_chunks_and_creates_vec_table(tmp_path: Path) -> None:
    embedder, provider, vault = make(tmp_path, 4)
    assert not embedder.has_vec()
    result = await embedder.run_pending()
    assert result["done"] == embedder.db.execute("SELECT count(*) FROM chunks").fetchone()[0] > 0
    assert embedder.current_model() == ("fake-embed", 4)
    assert embedder.status()["pending_chunks"] == 0
    assert embedder.db.execute("SELECT count(*) FROM chunk_vec").fetchone()[0] == result["done"]
    assert provider.calls[1][0].startswith("title: none | text: ")
    query = await embedder.embed_query("alpha?")
    assert (
        query is not None
        and len(query) == 4
        and provider.calls[-1][0].startswith("task: search result | query: ")
    )
    # A no-op rescan re-embeds nothing.
    indexer.scan(vault, embedder.db)
    calls = len(provider.calls)
    assert (await embedder.run_pending())["done"] == 0 and len(provider.calls) == calls + 1
    # An edit re-embeds only that page's changed section.
    file = vault / "One" / "page.md"
    file.write_text(file.read_text().replace("Beta text.", "Beta changed."), encoding="utf-8")
    bump_mtime(file)
    indexer.scan(vault, embedder.db)
    assert (await embedder.run_pending())["done"] == 1


async def test_dimension_change_rebuilds_vectors(tmp_path: Path) -> None:
    embedder, provider, _ = make(tmp_path, 4)
    await embedder.run_pending()
    provider.dim = 8
    result = await embedder.run_pending()
    assert embedder.current_model() == ("fake-embed", 8)
    assert result["done"] == embedder.db.execute("SELECT count(*) FROM chunks").fetchone()[0]


async def test_yields_to_chat_between_batches(tmp_path: Path) -> None:
    embedder, provider, _ = make(tmp_path, 4)
    embedder.manager.chat_waiting.set()
    task = asyncio.create_task(embedder.run_pending())
    await asyncio.sleep(0.3)
    assert not task.done() and embedder.state == "paused"
    embedder.manager.chat_waiting.clear()
    assert (await asyncio.wait_for(task, 2))["done"] > 0


async def test_without_model_reports_idle(tmp_path: Path) -> None:
    embedder, _, _ = make(tmp_path, 4)
    embedder.downloads.items.clear()
    assert (await embedder.run_pending())["done"] == 0
    assert await embedder.embed_query("x") is None
    with pytest.raises(ValueError):
        await embedder.embed_texts(["x"])


async def test_a_chunk_rewritten_during_embedding_keeps_its_own_vector(tmp_path: Path) -> None:
    """SQLite reuses freed rowids, so a stale batch must not label the new text."""
    embedder, provider, vault = make(tmp_path, 4)
    await embedder.run_pending()
    row = embedder.db.execute("SELECT id, text_hash FROM chunks WHERE page_path='Two'").fetchone()
    # Simulate the race: the batch was read before the page was re-chunked under the same id.
    stale = [
        {
            "id": row["id"],
            "title": "Two",
            "heading_path": "[]",
            "text": "Gamma text.",
            "text_hash": row["text_hash"],
        }
    ]
    embedder.db.execute(
        "UPDATE chunks SET text='Delta text.', text_hash='new-hash', embedded_model=NULL "
        "WHERE id=?",
        (row["id"],),
    )
    embedder._pending = lambda limit: stale  # type: ignore[method-assign]
    written = await embedder.embed_batch(provider, embedder.item(), 8)
    assert written == 0
    after = embedder.db.execute(
        "SELECT embedded_model FROM chunks WHERE id=?", (row["id"],)
    ).fetchone()
    assert after["embedded_model"] is None  # still queued for a correct embedding


async def test_vectors_of_deleted_chunks_are_removed(tmp_path: Path) -> None:
    embedder, provider, vault = make(tmp_path, 4)
    await embedder.run_pending()
    total = embedder.db.execute("SELECT count(*) FROM chunk_vec").fetchone()[0]
    embedder.db.execute("DELETE FROM chunks WHERE page_path='Two'")
    assert embedder.db.execute("SELECT count(*) FROM chunk_vec").fetchone()[0] == total
    embedder.db.execute("UPDATE chunks SET embedded_model=NULL WHERE page_path='One'")
    await embedder.run_pending()
    assert embedder.db.execute("SELECT count(*) FROM chunk_vec").fetchone()[0] == total - 1
