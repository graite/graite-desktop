"""Turn ranked chunks into numbered sources that fit a byte budget."""

from __future__ import annotations

import json
import sqlite3
from dataclasses import dataclass, field
from typing import Any

from graite.retrieval.search import Candidate

SECTION_LIMIT = 3000
SHORT_CHUNK = 300
PAGE_SHARE = 0.4


@dataclass
class Source:
    n: int
    kind: str  # page | attachment | selection
    page_path: str | None
    page_id: str | None
    title: str
    heading_path: list[str]
    text: str
    hash: str | None = None
    chunk_ids: list[int] = field(default_factory=list)
    start_line: int | None = None
    end_line: int | None = None

    @property
    def heading(self) -> str:
        return " > ".join(self.heading_path)

    def to_dict(self, *, snippet_chars: int = 240) -> dict[str, Any]:
        return {
            "n": self.n,
            "kind": self.kind,
            "page_path": self.page_path,
            "page_id": self.page_id,
            "title": self.title,
            "heading_path": self.heading_path,
            "snippet": self.text[:snippet_chars],
            "hash": self.hash,
            "chunk_ids": self.chunk_ids,
            "start_line": self.start_line,
            "end_line": self.end_line,
        }

    def prompt_block(self) -> str:
        where = self.title + (" > " + self.heading if self.heading_path else "")
        location = f" ({self.page_path})" if self.page_path else ""
        return f"[{self.n}] {where}{location}\n{self.text.strip()}"


def _page_chunks(
    conn: sqlite3.Connection, cache: dict[str, list[sqlite3.Row]], path: str
) -> list[sqlite3.Row]:
    if path not in cache:
        cache[path] = conn.execute(
            "SELECT id, ord, heading_path, text, start_line, end_line FROM chunks "
            "WHERE page_path=? ORDER BY ord",
            (path,),
        ).fetchall()
    return cache[path]


def expand(
    conn: sqlite3.Connection, candidate: Candidate, cache: dict[str, list[sqlite3.Row]]
) -> Source:
    """The candidate's whole section (same heading path), plus neighbours for tiny chunks."""
    rows = _page_chunks(conn, cache, candidate.page_path)
    by_id = {r["id"]: i for i, r in enumerate(rows)}
    index = by_id.get(candidate.chunk_id)
    if index is None:
        return Source(
            0,
            "page",
            candidate.page_path,
            candidate.page_id,
            candidate.title,
            candidate.heading_path,
            candidate.text,
            candidate.file_hash,
            [candidate.chunk_id],
            candidate.start_line,
            candidate.end_line,
        )
    same = [
        i for i, r in enumerate(rows) if json.loads(r["heading_path"]) == candidate.heading_path
    ]
    chosen = [index]
    budget = SECTION_LIMIT - len(candidate.text)
    for i in sorted(same, key=lambda i: abs(i - index)):
        if i == index:
            continue
        size = len(rows[i]["text"])
        if size <= budget:
            chosen.append(i)
            budget -= size
    if len(candidate.text) < SHORT_CHUNK:
        for i in (index - 1, index + 1):
            if 0 <= i < len(rows) and i not in chosen and len(rows[i]["text"]) <= budget:
                chosen.append(i)
                budget -= len(rows[i]["text"])
    chosen.sort()
    text = "\n\n".join(rows[i]["text"] for i in chosen if rows[i]["text"])
    return Source(
        0,
        "page",
        candidate.page_path,
        candidate.page_id,
        candidate.title,
        candidate.heading_path,
        text or candidate.text,
        candidate.file_hash,
        [rows[i]["id"] for i in chosen],
        rows[chosen[0]]["start_line"],
        rows[chosen[-1]]["end_line"],
    )


def build(
    conn: sqlite3.Connection,
    candidates: list[Candidate],
    budget_bytes: int,
    *,
    extra: list[Source] | None = None,
) -> list[Source]:
    """Numbered sources: explicit attachments/selection first, then expanded page hits."""
    sources: list[Source] = []
    used = 0
    for source in extra or []:
        sources.append(source)
        used += len(source.text.encode("utf-8"))
    cache: dict[str, list[sqlite3.Row]] = {}
    seen: set[tuple[str, str]] = set()
    per_page: dict[str, int] = {}
    page_cap = int(budget_bytes * PAGE_SHARE)
    for candidate in candidates:
        key = (candidate.page_path, json.dumps(candidate.heading_path))
        if key in seen:
            continue
        source = expand(conn, candidate, cache)
        if any(c in s.chunk_ids for s in sources for c in source.chunk_ids):
            seen.add(key)
            continue
        size = len(source.text.encode("utf-8"))
        if used + size > budget_bytes:
            if used == 0 and not sources:
                source.text = source.text.encode("utf-8")[:budget_bytes].decode("utf-8", "ignore")
                size = len(source.text.encode("utf-8"))
            else:
                continue
        if per_page.get(candidate.page_path, 0) + size > page_cap and per_page.get(
            candidate.page_path
        ):
            continue
        seen.add(key)
        sources.append(source)
        used += size
        per_page[candidate.page_path] = per_page.get(candidate.page_path, 0) + size
    for n, source in enumerate(sources, start=1):
        source.n = n
    return sources
