"""Embed pending chunks into `chunk_vec` and embed queries for search.

The vector table is created here, from the first vector's dimension, because the user can
pick any embedding model. When the model or dimension changes every chunk is re-embedded.
"""

from __future__ import annotations

import asyncio
import json
import sqlite3
import time
from typing import Any

import sqlite_vec

from graite.events import EventBus
from graite.index.db import transaction
from graite.models.config import load_config
from graite.models.downloader import CatalogModel, Downloader
from graite.models.manager import Manager

BATCH = 32
MAX_CHARS = 6000
HOT_LIMIT = 20


class Embedder:
    def __init__(
        self, db: sqlite3.Connection, manager: Manager, downloads: Downloader, events: EventBus
    ) -> None:
        self.db = db
        self.manager = manager
        self.downloads = downloads
        self.events = events
        # Recently chatted-about roots, newest last; their chunks embed first.
        self.hot_paths: dict[str, float] = {}
        self.state = "idle"
        self.last_error: str | None = None

    # ------------------------------------------------------------------ model

    def item(self) -> CatalogModel | None:
        wanted = load_config(self.db).embedding_model_id
        installed = [
            m
            for m in self.downloads.items.values()
            if m.role == "embedding" and m.status == "installed" and m.local_path
        ]
        if wanted:
            return next((m for m in installed if m.id == wanted), None)
        return installed[0] if installed else None

    @staticmethod
    def prefix(item: CatalogModel, task: str) -> str:
        if item.embedding_family == "embeddinggemma":
            return "task: search result | query: " if task == "query" else "title: none | text: "
        return ""

    def has_vec(self) -> bool:
        return bool(
            self.db.execute("SELECT 1 FROM sqlite_master WHERE name='chunk_vec'").fetchone()
        )

    def _drop_orphan_vectors(self) -> None:
        """Vectors whose chunk is gone; their rowids can be handed to a different chunk."""
        if not self.has_vec():
            return
        self.db.execute(
            "DELETE FROM chunk_vec WHERE rowid IN "
            "(SELECT rowid FROM chunk_vec LEFT JOIN chunks ON chunks.id = chunk_vec.rowid "
            "WHERE chunks.id IS NULL)"
        )

    def current_model(self) -> tuple[str | None, int | None]:
        row = {
            r["key"]: r["value"]
            for r in self.db.execute(
                "SELECT key, value FROM meta WHERE key IN ('embedding_model','embedding_dim')"
            )
        }
        dim = row.get("embedding_dim")
        return row.get("embedding_model"), int(dim) if dim else None

    def ensure_vec_table(self, model_id: str, dim: int) -> bool:
        """Create the vector table for this model; rebuild when the model or size changed."""
        current, current_dim = self.current_model()
        if self.has_vec() and current == model_id and current_dim == dim:
            return False
        with transaction(self.db):
            if self.has_vec():
                self.db.execute("DROP TABLE chunk_vec")
            self.db.execute(f"CREATE VIRTUAL TABLE chunk_vec USING vec0(embedding float[{dim}])")
            self.db.execute("UPDATE chunks SET embedded_model=NULL")
            self.db.execute(
                "INSERT OR REPLACE INTO meta VALUES ('embedding_model', ?)", (model_id,)
            )
            self.db.execute("INSERT OR REPLACE INTO meta VALUES ('embedding_dim', ?)", (str(dim),))
        self.publish()
        return True

    # ------------------------------------------------------------------ status

    def status(self) -> dict[str, Any]:
        item = self.item()
        model, dim = self.current_model()
        counts = self.db.execute(
            "SELECT count(*) AS chunks, sum(embedded_model IS NULL) AS pending FROM chunks"
        ).fetchone()
        pages = self.db.execute(
            "SELECT count(*) AS pages, sum(index_error IS NOT NULL) AS failed FROM pages"
        ).fetchone()
        return {
            "embedding_model": item.id if item else None,
            "vector_model": model,
            "dim": dim,
            "pages": int(pages["pages"] or 0),
            "failed_pages": int(pages["failed"] or 0),
            "chunks": int(counts["chunks"] or 0),
            "pending_chunks": int(counts["pending"] or 0) if item else int(counts["chunks"] or 0),
            "worker": self.state,
            "last_error": self.last_error,
        }

    def publish(self, **extra: Any) -> None:
        self.events.publish("index_progress", {**self.status(), **extra})

    # ------------------------------------------------------------------ embedding

    async def embed_texts(
        self, texts: list[str], task: str = "document", *, evict_chat: bool = True
    ) -> list[list[float]]:
        item = self.item()
        if item is None:
            raise ValueError("Download an embedding model under Settings → Search first.")
        prefix = self.prefix(item, task)
        async with self.manager.use_embedding(
            item.local_path, item.pooling, evict_chat=evict_chat
        ) as provider:
            return await provider.embed([prefix + t[:MAX_CHARS] for t in texts])

    async def embed_query(self, text: str) -> list[float] | None:
        """A query vector, or None when semantic search is not available yet."""
        item = self.item()
        if item is None or not self.has_vec():
            return None
        model, _ = self.current_model()
        if model != item.id:
            return None
        vectors = await self.embed_texts([text], "query", evict_chat=False)
        return vectors[0]

    def touch(self, roots: list[str]) -> None:
        """Remember the roots of a conversation as hot without forgetting other chats'."""
        now = time.monotonic()
        for root in roots:
            self.hot_paths[root] = now
        while len(self.hot_paths) > HOT_LIMIT:
            oldest = min(self.hot_paths, key=lambda r: self.hot_paths[r])
            del self.hot_paths[oldest]

    def hot_roots(self) -> list[str]:
        return sorted(self.hot_paths, key=lambda r: -self.hot_paths[r])[:HOT_LIMIT]

    def _pending(self, limit: int) -> list[sqlite3.Row]:
        rows: list[sqlite3.Row] = []
        for root in self.hot_roots():
            rows.extend(
                self.db.execute(
                    "SELECT id, title, heading_path, text, text_hash FROM chunks "
                    "WHERE embedded_model IS NULL AND (page_path=? OR page_path LIKE ?) "
                    "ORDER BY id LIMIT ?",
                    (root, root + "/%", limit - len(rows)),
                ).fetchall()
            )
            if len(rows) >= limit:
                return rows[:limit]
        seen = {r["id"] for r in rows}
        for r in self.db.execute(
            "SELECT id, title, heading_path, text, text_hash FROM chunks "
            "WHERE embedded_model IS NULL ORDER BY id LIMIT ?",
            (limit,),
        ):
            if r["id"] not in seen:
                rows.append(r)
            if len(rows) >= limit:
                break
        return rows[:limit]

    async def embed_batch(self, provider: Any, item: CatalogModel, limit: int = BATCH) -> int:
        rows = self._pending(limit)
        if not rows:
            return 0
        prefix = self.prefix(item, "document")
        texts = []
        for r in rows:
            head = " > ".join([r["title"], *json.loads(r["heading_path"])])
            body = r["text"][:MAX_CHARS]
            texts.append(prefix + (f"{head}\n{body}" if body else head))
        vectors = await provider.embed(texts)
        if vectors and self.ensure_vec_table(item.id, len(vectors[0])):
            # A rebuild cleared every embedded_model marker; these rows are still valid.
            pass
        written = 0
        with transaction(self.db):
            for r, vector in zip(rows, vectors, strict=True):
                # The page may have been re-chunked while the model ran, and SQLite reuses
                # freed rowids: only write the vector if this row still holds that text.
                updated = self.db.execute(
                    "UPDATE chunks SET embedded_model=? WHERE id=? AND text_hash=? "
                    "AND embedded_model IS NULL",
                    (item.id, r["id"], r["text_hash"]),
                ).rowcount
                if not updated:
                    continue
                self.db.execute("DELETE FROM chunk_vec WHERE rowid=?", (r["id"],))
                self.db.execute(
                    "INSERT INTO chunk_vec(rowid, embedding) VALUES (?, ?)",
                    (r["id"], sqlite_vec.serialize_float32(vector)),
                )
                written += 1
            self._drop_orphan_vectors()
        return written

    async def run_pending(self, ctx: Any = None) -> dict[str, Any]:
        """Embed every pending chunk, yielding to chat between batches."""
        item = self.item()
        if item is None:
            self.state = "idle"
            self.publish()
            return {"done": 0, "skipped": "no embedding model"}
        done = 0
        attempts = 0
        self.state = "indexing"
        self.last_error = None
        try:
            async with self.manager.use_embedding(item.local_path, item.pooling) as provider:
                # Probe once so the table exists (and is rebuilt) before the first batch.
                first = await provider.embed([self.prefix(item, "document") + "graite"])
                self.ensure_vec_table(item.id, len(first[0]))
                while True:
                    if ctx is not None and ctx.cancelled.is_set():
                        break
                    while self.manager.chat_waiting.is_set() or self.manager.lock.locked():
                        self.state = "paused"
                        self.publish()
                        await asyncio.sleep(0.2)
                    self.state = "indexing"
                    count = await self.embed_batch(provider, item)
                    if not count:
                        # Either nothing is pending, or every row in the batch was superseded
                        # while the model ran; the next scan re-queues those.
                        if not self.status()["pending_chunks"] or attempts > 3:
                            break
                        attempts += 1
                        continue
                    attempts = 0
                    done += count
                    if ctx is not None:
                        ctx.progress(done=done, pending=self.status()["pending_chunks"])
                    self.publish(done=done)
        except Exception as exc:
            self.last_error = str(exc)[:500]
            raise
        finally:
            self.state = "idle"
            self.publish(done=done)
        return {"done": done}
