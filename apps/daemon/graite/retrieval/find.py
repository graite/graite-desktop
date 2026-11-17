"""Find: what the Cmd+K palette and "Find" in chat show while the user types (D101).

No chat model takes part and nothing waits for one. Every query runs the keyword index and
the page titles; vectors join in when the embedding model is already loaded (or the query was
embedded before), and are skipped, not waited for, when it is not. Results are pages: the
best passage of each, with its heading path and a snippet around the words that matched.

Unlike retrieval for a model, this is the user looking through their own notes, so every
page is searched, including pages that are local-only or have AI turned off.
"""

from __future__ import annotations

import asyncio
import json
import re
import sqlite3
import time
from dataclasses import asdict, dataclass, field
from typing import Any

import sqlite_vec

from graite.retrieval.search import RRF_K, STOPWORDS

SNIPPET = 180
# How long a keystroke waits for vectors. Past this the keyword results go out alone and the
# embedding finishes in the background, ready for the next keystroke.
VECTOR_WAIT = 0.12


@dataclass
class Hit:
    path: str
    id: str
    title: str
    icon: str | None
    heading_path: list[str]
    snippet: str
    score: float
    # How many passages of the page matched, and through what: "title", "text", "meaning".
    matches: int = 1
    via: list[str] = field(default_factory=list)
    start_line: int | None = None

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


def terms_of(query: str) -> list[str]:
    words = [w for w in re.findall(r"\w+", query.lower()) if len(w) > 1]
    kept = [w for w in words if w not in STOPWORDS] or words
    return list(dict.fromkeys(kept))[:12]


def match_query(terms: list[str], *, every: bool) -> str | None:
    """An FTS5 query for what has been typed so far: the last word is a prefix."""
    if not terms:
        return None
    quoted = [f'"{t}"' for t in terms]
    quoted[-1] += "*"
    return (" AND " if every else " OR ").join(quoted)


def snippet(text: str, terms: list[str], width: int = SNIPPET) -> str:
    """A window of `text` around the first word that matched, on word boundaries."""
    flat = re.sub(r"\s+", " ", text).strip()
    if len(flat) <= width:
        return flat
    lower = flat.lower()
    at = min((p for p in (lower.find(t) for t in terms) if p >= 0), default=0)
    start = max(0, at - width // 3)
    if start:
        start = flat.find(" ", start) + 1 or start
    end = min(len(flat), start + width)
    if end < len(flat):
        end = flat.rfind(" ", start, end) or end
    return ("… " if start else "") + flat[start:end] + (" …" if end < len(flat) else "")


def _under(root: str | None) -> tuple[str, list[str]]:
    """SQL and parameters limiting `page_path` to a page and everything below it."""
    if not root:
        return "", []
    escaped = root.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
    return " AND (page_path = ? OR page_path LIKE ? ESCAPE '\\')", [root, escaped + "/%"]


class Finder:
    def __init__(self, conn: sqlite3.Connection, embedder: Any | None) -> None:
        self.conn = conn
        self.embedder = embedder

    def _keywords(self, terms: list[str], root: str | None, pool: int) -> list[int]:
        where, params = _under(root)
        where = where.replace("page_path", "chunks.page_path")
        # All words first; any word only when that finds too little, so a typo in one word
        # does not empty the list.
        ids: list[int] = []
        for every in (True, False):
            query = match_query(terms, every=every)
            if query is None:
                break
            try:
                rows = self.conn.execute(
                    "SELECT chunks.id FROM chunk_fts JOIN chunks ON chunks.id = chunk_fts.rowid "
                    f"WHERE chunk_fts MATCH ?{where} "
                    "ORDER BY bm25(chunk_fts, 1.0, 2.0, 1.5) LIMIT ?",
                    (query, *params, pool),
                ).fetchall()
            except sqlite3.OperationalError:
                rows = []
            ids += [r["id"] for r in rows if r["id"] not in ids]
            if len(ids) >= pool // 2 or len(terms) == 1:
                break
        return ids[:pool]

    def _titles(self, terms: list[str], root: str | None, pool: int) -> list[sqlite3.Row]:
        if not terms:
            return []
        where, params = _under(root)
        where = where.replace("page_path", "path")
        likes = " AND ".join("lower(title) LIKE ? ESCAPE '\\'" for _ in terms)
        values = [
            "%" + t.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"
            for t in terms
        ]
        return self.conn.execute(
            f"SELECT path, id, title, icon FROM pages WHERE {likes}{where} "
            "ORDER BY length(title), path LIMIT ?",
            (*values, *params, pool),
        ).fetchall()

    async def _vectors(self, query: str, root: str | None, pool: int) -> list[int] | None:
        """Passage ids by meaning, or None when vectors were not used for this query."""
        embedder = self.embedder
        if embedder is None or not embedder.ready_for_queries():
            return None
        task = asyncio.ensure_future(embedder.embed_query(query))
        try:
            vector = await asyncio.wait_for(asyncio.shield(task), VECTOR_WAIT)
        except TimeoutError:
            # Let it finish: the result lands in the cache for the next keystroke.
            task.add_done_callback(lambda t: t.exception() if not t.cancelled() else None)
            return None
        except Exception:  # noqa: BLE001 - find must degrade to keywords, not fail
            return None
        if vector is None:
            return None
        where, params = _under(root)
        filter_sql = f" AND rowid IN (SELECT id FROM chunks WHERE 1=1{where})" if where else ""
        try:
            rows = self.conn.execute(
                "SELECT rowid FROM chunk_vec WHERE embedding MATCH ? AND k = ?" + filter_sql,
                (sqlite_vec.serialize_float32(vector), pool, *params),
            ).fetchall()
        except sqlite3.OperationalError:
            return None
        return [r["rowid"] for r in rows]

    async def find(self, query: str, *, k: int = 10, root: str | None = None) -> dict[str, Any]:
        started = time.perf_counter()
        terms = terms_of(query)
        pool = max(k * 4, 24)
        if not terms:
            return {"query": query, "results": [], "semantic": False, "took_ms": 0}
        keyword_ids = self._keywords(terms, root, pool)
        vector_ids = await self._vectors(query, root, pool)
        scores: dict[int, float] = {}
        via: dict[int, set[str]] = {}
        for label, ids in (("text", keyword_ids), ("meaning", vector_ids or [])):
            for rank, chunk_id in enumerate(ids, start=1):
                scores[chunk_id] = scores.get(chunk_id, 0.0) + 1.0 / (RRF_K + rank)
                via.setdefault(chunk_id, set()).add(label)
        pages: dict[str, Hit] = {}
        if scores:
            marks = ",".join("?" * len(scores))
            rows = self.conn.execute(
                "SELECT chunks.id, chunks.page_path, chunks.page_id, chunks.title, "
                "chunks.heading_path, chunks.text, chunks.start_line, pages.icon FROM chunks "
                f"JOIN pages ON pages.path = chunks.page_path WHERE chunks.id IN ({marks})",
                list(scores),
            ).fetchall()
            for row in sorted(rows, key=lambda r: -scores[r["id"]]):
                hit = pages.get(row["page_path"])
                if hit is None:
                    pages[row["page_path"]] = Hit(
                        path=row["page_path"],
                        id=row["page_id"],
                        title=row["title"],
                        icon=row["icon"],
                        heading_path=json.loads(row["heading_path"]),
                        snippet=snippet(row["text"], terms),
                        score=scores[row["id"]],
                        via=sorted(via[row["id"]]),
                        start_line=row["start_line"],
                    )
                else:
                    # Several passages of one page are one result, ranked a little higher.
                    hit.matches += 1
                    hit.score += scores[row["id"]] * 0.25
                    hit.via = sorted(set(hit.via) | via[row["id"]])
        # A page whose title has every word is what was meant more often than not.
        for rank, row in enumerate(self._titles(terms, root, pool), start=1):
            boost = 2.0 / (RRF_K + rank)
            hit = pages.get(row["path"])
            if hit is None:
                pages[row["path"]] = Hit(
                    path=row["path"],
                    id=row["id"],
                    title=row["title"],
                    icon=row["icon"],
                    heading_path=[],
                    snippet="",
                    score=boost,
                    via=["title"],
                )
            else:
                hit.score += boost
                hit.via = sorted({*hit.via, "title"})
        results = sorted(pages.values(), key=lambda h: (-h.score, h.path))[:k]
        return {
            "query": query,
            "results": [h.to_dict() for h in results],
            "semantic": vector_ids is not None,
            "took_ms": round((time.perf_counter() - started) * 1000, 1),
        }
