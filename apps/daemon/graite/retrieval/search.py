"""Hybrid search over the chunk index: FTS5 keywords + sqlite-vec vectors, fused with RRF."""

from __future__ import annotations

import json
import logging
import re
import sqlite3
import uuid
from dataclasses import dataclass, field
from typing import Any

import sqlite_vec

from graite.index.db import transaction
from graite.models.manager import EmbeddingBusy
from graite.retrieval.scope import ResolvedScope
from graite.retrieval.strategy import Plan, classify

log = logging.getLogger("graite.retrieval")

RRF_K = 60
# Frequent verbs and qualifiers: their absence from the notes says nothing useful, so they
# are never named in the "no page mentions …" limit line.
COMMON = {
    "actually",
    "again",
    "agree",
    "agreed",
    "already",
    "also",
    "another",
    "anything",
    "been",
    "being",
    "change",
    "changed",
    "could",
    "decide",
    "decided",
    "decision",
    "discuss",
    "discussed",
    "does",
    "doing",
    "everything",
    "gedaan",
    "gezegd",
    "give",
    "given",
    "happen",
    "happened",
    "have",
    "having",
    "just",
    "know",
    "kunnen",
    "less",
    "look",
    "looks",
    "made",
    "make",
    "maken",
    "many",
    "maybe",
    "mention",
    "mentioned",
    "moeten",
    "more",
    "most",
    "must",
    "need",
    "next",
    "other",
    "perhaps",
    "plan",
    "planned",
    "really",
    "said",
    "same",
    "say",
    "should",
    "some",
    "something",
    "still",
    "such",
    "take",
    "taken",
    "talk",
    "talked",
    "tell",
    "than",
    "their",
    "then",
    "there",
    "these",
    "think",
    "those",
    "use",
    "used",
    "using",
    "vorig",
    "want",
    "what",
    "which",
    "willen",
    "work",
    "worked",
    "works",
    "would",
}
STOPWORDS = {
    "the",
    "a",
    "an",
    "and",
    "or",
    "of",
    "to",
    "in",
    "on",
    "for",
    "is",
    "are",
    "was",
    "were",
    "what",
    "which",
    "who",
    "how",
    "when",
    "where",
    "why",
    "did",
    "do",
    "does",
    "we",
    "our",
    "about",
    "with",
    "that",
    "this",
    "it",
    "be",
    "as",
    "at",
    "by",
    "from",
    "have",
    "has",
    "had",
    "de",
    "het",
    "een",
    "en",
    "van",
    "wat",
    "hoe",
    "wie",
    "waar",
    "over",
    "met",
    "zijn",
}


@dataclass
class Candidate:
    chunk_id: int
    page_path: str
    page_id: str
    title: str
    heading_path: list[str]
    text: str
    start_line: int
    end_line: int
    file_hash: str
    score: float = 0.0
    fts_rank: int | None = None
    vec_rank: int | None = None
    reasons: list[str] = field(default_factory=list)


def fts_query(question: str, phrases: list[str]) -> str | None:
    terms = [t for t in re.findall(r"\w+", question.lower()) if t not in STOPWORDS and len(t) > 1]
    terms = list(dict.fromkeys(terms))[:12]
    parts = [f'"{p.replace(chr(34), " ")}"' for p in phrases]
    if terms:
        quoted = [f'"{t}"' for t in terms]
        quoted[-1] += "*"
        parts.append("(" + " OR ".join(quoted) + ")")
    return " AND ".join(parts) if parts else None


class Searcher:
    def __init__(self, conn: sqlite3.Connection, embedder: Any | None) -> None:
        self.conn = conn
        self.embedder = embedder
        self.semantic_available = False
        self.last_semantic_error: str | None = None
        self.semantic_skipped: str | None = None  # set when vectors were possible but not used
        # The connection is shared, so two turns searching at once must not share the
        # temporary table that holds their scope: one would answer with the other's pages.
        self.table = "scope_" + uuid.uuid4().hex[:12]
        self._filled = False

    def release(self) -> None:
        if self._filled:
            self.conn.execute(f"DROP TABLE IF EXISTS temp.{self.table}")
            self._filled = False

    # ------------------------------------------------------------- scope filter

    def _scope_clause(self, scope: ResolvedScope) -> str:
        if scope.all_pages and not scope.excluded_local_only:
            return ""
        if not self._filled:
            with transaction(self.conn):
                self.conn.execute(
                    f"CREATE TEMP TABLE IF NOT EXISTS {self.table} (path TEXT PRIMARY KEY)"
                )
                self.conn.execute(f"DELETE FROM {self.table}")
                self.conn.executemany(
                    f"INSERT INTO {self.table} (path) VALUES (?)", [(p,) for p in scope.paths]
                )
            self._filled = True
        return f" AND chunks.page_path IN (SELECT path FROM {self.table})"

    # ------------------------------------------------------------- signals

    def fts(self, query: str, scope_clause: str, k: int) -> list[tuple[int, float]]:
        try:
            rows = self.conn.execute(
                "SELECT chunks.id, bm25(chunk_fts, 1.0, 2.0, 1.5) AS rank FROM chunk_fts "
                "JOIN chunks ON chunks.id = chunk_fts.rowid "
                f"WHERE chunk_fts MATCH ?{scope_clause} ORDER BY rank LIMIT ?",
                (query, k),
            ).fetchall()
        except sqlite3.OperationalError as exc:
            log.debug("fts query failed: %s", exc)
            return []
        return [(r["id"], r["rank"]) for r in rows]

    async def vector(self, question: str, scope_clause: str, k: int) -> list[tuple[int, float]]:
        self.semantic_available = False
        if self.embedder is None:
            return []
        try:
            embedding = await self.embedder.embed_query(question)
        except EmbeddingBusy:
            self.semantic_skipped = "the chat model stayed loaded"
            return []
        except Exception as exc:  # noqa: BLE001 - search must degrade, not fail
            self.last_semantic_error = str(exc)[:300]
            return []
        if embedding is None:
            return []
        self.semantic_available = True
        where = scope_clause.replace("chunks.page_path", "page_path")
        filter_sql = f" AND rowid IN (SELECT id FROM chunks WHERE 1=1{where})" if where else ""
        try:
            rows = self.conn.execute(
                "SELECT rowid, distance FROM chunk_vec WHERE embedding MATCH ? AND k = ?"
                + filter_sql,
                (sqlite_vec.serialize_float32(embedding), k),
            ).fetchall()
        except sqlite3.OperationalError as exc:
            self.last_semantic_error = str(exc)[:300]
            return []
        return [(r["rowid"], r["distance"]) for r in rows]

    def missing_terms(self, question: str, scope: ResolvedScope, limit: int = 4) -> list[str]:
        """Distinctive words of the question that appear nowhere in scope.

        This is what lets an answer say "no page mentions Berlin" instead of implying that
        nothing happened: absence in the index is a fact, absence in the world is not.
        """
        clause = self._scope_clause(scope)
        proper = {
            m.group(0).lower() for m in re.finditer(r"(?<![.!?]\s)(?<!^)\b[A-Z][\w-]{2,}", question)
        }
        terms = [
            t
            for t in dict.fromkeys(re.findall(r"\w+", question.lower()))
            if t not in STOPWORDS
            and len(t) > 3
            and not t.isdigit()
            and (t in proper or t not in COMMON)
        ]
        missing: list[str] = []
        for term in terms[:8]:
            row = self.conn.execute(
                "SELECT 1 FROM chunk_fts JOIN chunks ON chunks.id = chunk_fts.rowid "
                f"WHERE chunk_fts MATCH ?{clause} LIMIT 1",
                (f'"{term}"',),
            ).fetchone()
            if row is None:
                missing.append(term)
            if len(missing) >= limit:
                break
        return missing

    def structured(self, question: str, scope: ResolvedScope, k: int) -> list[tuple[int, float]]:
        """Pages whose properties, tags or status match question words (page-level hits)."""
        tokens = {
            t for t in re.findall(r"\w+", question.lower()) if t not in STOPWORDS and len(t) > 2
        }
        if not tokens:
            return []
        hits: list[tuple[int, float]] = []
        rows = self.conn.execute(
            "SELECT path, frontmatter_json FROM pages"
            + (f" WHERE path IN (SELECT path FROM {self.table})" if self._filled else "")
        ).fetchall()
        tags: dict[str, set[str]] = {}
        for r in self.conn.execute("SELECT src_path, target FROM links WHERE kind='tag'"):
            tags.setdefault(r["src_path"], set()).add(r["target"].lower())
        for r in rows:
            try:
                meta = json.loads(r["frontmatter_json"])
            except ValueError:
                continue
            words: set[str] = set(tags.get(r["path"], set()))
            for prop in meta.get("properties") or []:
                if not isinstance(prop, dict):
                    continue
                words.update(re.findall(r"\w+", str(prop.get("name", "")).lower()))
                value = prop.get("value")
                for v in value if isinstance(value, list) else [value]:
                    if isinstance(v, str | int | float | bool) and v is not None:
                        words.update(re.findall(r"\w+", str(v).lower()))
            overlap = len(words & tokens)
            if overlap:
                first = self.conn.execute(
                    "SELECT id FROM chunks WHERE page_path=? ORDER BY ord LIMIT 1", (r["path"],)
                ).fetchone()
                if first:
                    hits.append((first["id"], float(overlap)))
        hits.sort(key=lambda h: -h[1])
        return hits[:k]

    # ------------------------------------------------------------- fusion

    def _load(self, ids: list[int]) -> dict[int, Candidate]:
        if not ids:
            return {}
        marks = ",".join("?" * len(ids))
        rows = self.conn.execute(
            "SELECT chunks.*, pages.file_hash FROM chunks "
            "JOIN pages ON pages.path = chunks.page_path "
            f"WHERE chunks.id IN ({marks})",
            ids,
        ).fetchall()
        return {
            r["id"]: Candidate(
                chunk_id=r["id"],
                page_path=r["page_path"],
                page_id=r["page_id"],
                title=r["title"],
                heading_path=json.loads(r["heading_path"]),
                text=r["text"],
                start_line=r["start_line"],
                end_line=r["end_line"],
                file_hash=r["file_hash"],
            )
            for r in rows
        }

    async def search(
        self, question: str, scope: ResolvedScope, *, k: int | None = None, plan: Plan | None = None
    ) -> list[Candidate]:
        plan = plan or classify(question)
        k = k or plan.k
        if not scope.paths:
            return []
        clause = self._scope_clause(scope)
        pool = max(k * 3, 20)
        scores: dict[int, float] = {}
        ranks: dict[int, dict[str, int]] = {}

        def add(signal: str, hits: list[tuple[int, float]]) -> None:
            for rank, (chunk_id, _) in enumerate(hits, start=1):
                scores[chunk_id] = scores.get(chunk_id, 0.0) + 1.0 / (RRF_K + rank)
                ranks.setdefault(chunk_id, {})[signal] = rank

        query = fts_query(question, plan.phrases) if plan.exact else None
        if query:
            add("fts", self.fts(query, clause, pool))
        if plan.semantic:
            add("vec", await self.vector(question, clause, pool))
        if plan.structured:
            add("structured", self.structured(question, scope, pool))  # after _scope_clause
        if not scores:
            return []
        candidates = self._load(list(scores))
        tokens = {
            t for t in re.findall(r"\w+", question.lower()) if len(t) > 3 and t not in STOPWORDS
        }
        top_pages = [
            candidates[c].page_path
            for c in sorted(scores, key=lambda c: -scores[c])[:3]
            if c in candidates
        ]
        linked: set[str] = set()
        if top_pages:
            marks = ",".join("?" * len(top_pages))
            for r in self.conn.execute(
                f"SELECT target_path FROM links WHERE src_path IN ({marks}) "
                "AND target_path IS NOT NULL",
                top_pages,
            ):
                linked.add(r["target_path"])
        for chunk_id, candidate in candidates.items():
            score = scores[chunk_id]
            title_words = set(re.findall(r"\w+", candidate.title.lower()))
            if any(
                t == w or (len(t) >= 4 and len(w) >= 4 and (w.startswith(t) or t.startswith(w)))
                for t in tokens
                for w in title_words
            ):
                score *= 1.3
                candidate.reasons.append("title")
            if candidate.page_path in linked and candidate.page_path not in top_pages:
                score *= 1.1
                candidate.reasons.append("linked")
            candidate.score = score
            candidate.fts_rank = ranks[chunk_id].get("fts")
            candidate.vec_rank = ranks[chunk_id].get("vec")
        ordered = sorted(candidates.values(), key=lambda c: (-c.score, c.page_path, c.chunk_id))
        return ordered[: k * 2]
