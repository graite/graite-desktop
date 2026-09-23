"""The sources a conversation has gathered so far.

Numbers are assigned once and never reused, so a citation written in an earlier answer still
points at the same passage. Sources are kept in the order they were added, which keeps the
prompt prefix stable across turns and lets llama-server reuse its KV cache.
"""

from __future__ import annotations

import json
import sqlite3
from dataclasses import dataclass
from typing import Any

from graite.retrieval.context import Source, _page_chunks

MAX_SOURCES = 60


@dataclass
class Entry:
    source: Source
    added_turn: int
    last_cited_turn: int = 0
    in_prompt: bool = True
    stale: bool = False

    def to_dict(self) -> dict[str, Any]:
        return {
            "source": {**self.source.to_dict(snippet_chars=0), "text": self.source.text},
            "added_turn": self.added_turn,
            "last_cited_turn": self.last_cited_turn,
            "in_prompt": self.in_prompt,
            "stale": self.stale,
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> Entry:
        raw = data.get("source") or {}
        source = Source(
            int(raw.get("n") or 0),
            str(raw.get("kind") or "page"),
            raw.get("page_path"),
            raw.get("page_id"),
            str(raw.get("title") or ""),
            list(raw.get("heading_path") or []),
            str(raw.get("text") or ""),
            raw.get("hash"),
            [int(c) for c in raw.get("chunk_ids") or []],
            raw.get("start_line"),
            raw.get("end_line"),
        )
        return cls(
            source,
            int(data.get("added_turn") or 0),
            int(data.get("last_cited_turn") or 0),
            bool(data.get("in_prompt", True)),
            bool(data.get("stale", False)),
        )


def _same(a: Source, b: Source) -> bool:
    """The dedupe rule shared by retrieval and the read/search tools."""
    if a.chunk_ids and b.chunk_ids:
        return set(a.chunk_ids) <= set(b.chunk_ids) or set(b.chunk_ids) <= set(a.chunk_ids)
    if a.kind != b.kind or a.page_path != b.page_path or a.heading_path != b.heading_path:
        return False
    if a.kind == "page":
        # Reads of different parts of the same page must remain separately citable.
        # Matching headings alone used to label a later excerpt with the first one's id.
        return a.text in b.text or b.text in a.text
    return a.title == b.title and (a.hash or a.text) == (b.hash or b.text)


class ContextSet:
    def __init__(self, entries: list[Entry] | None = None, turn: int = 0) -> None:
        self.entries: list[Entry] = entries or []
        self.turn = turn

    # ----------------------------------------------------------------- persistence

    @classmethod
    def load(cls, raw: str | None) -> ContextSet:
        try:
            data = json.loads(raw) if raw else []
        except ValueError:
            data = []
        entries = [Entry.from_dict(d) for d in data if isinstance(d, dict)]
        turn = max((e.added_turn for e in entries), default=0)
        turn = max(turn, max((e.last_cited_turn for e in entries), default=0))
        return cls(entries, turn)

    def dump(self) -> str:
        return json.dumps([e.to_dict() for e in self.entries], ensure_ascii=False)

    def public(self) -> list[dict[str, Any]]:
        """What clients see: the set without passage text."""
        return [
            {
                **e.source.to_dict(),
                "added_turn": e.added_turn,
                "last_cited_turn": e.last_cited_turn,
                "stale": e.stale,
            }
            for e in self.entries
        ]

    # ----------------------------------------------------------------- membership

    @property
    def sources(self) -> list[Source]:
        return [e.source for e in self.entries]

    def __len__(self) -> int:
        return len(self.entries)

    def begin_turn(self) -> int:
        self.turn += 1
        return self.turn

    def find(self, source: Source) -> Entry | None:
        for entry in self.entries:
            if _same(entry.source, source):
                return entry
        return None

    def add(self, source: Source) -> int:
        existing = self.find(source)
        if existing is not None:
            existing.in_prompt = True
            if len(source.text) > len(existing.source.text):
                source.n = existing.source.n
                existing.source = source
            return existing.source.n
        if len(self.entries) >= MAX_SOURCES:
            self._evict_one()
        source.n = max((e.source.n for e in self.entries), default=0) + 1
        self.entries.append(Entry(source, self.turn))
        return source.n

    def add_many(self, sources: list[Source]) -> list[int]:
        return [self.add(s) for s in sources]

    def _evict_one(self) -> None:
        """Drop the least recently useful source when the set is full."""
        victims = sorted(
            (e for e in self.entries if e.added_turn != self.turn),
            key=lambda e: (e.last_cited_turn, e.added_turn),
        )
        if victims:
            self.entries.remove(victims[0])

    def new_numbers(self) -> list[int]:
        return [e.source.n for e in self.entries if e.added_turn == self.turn]

    def new_sources(self) -> list[Source]:
        return [e.source for e in self.entries if e.added_turn == self.turn]

    def mark_cited(self, numbers: list[int]) -> None:
        wanted = set(numbers)
        for entry in self.entries:
            if entry.source.n in wanted:
                entry.last_cited_turn = self.turn

    def texts(self) -> list[str]:
        return [e.source.text for e in self.entries]

    # ----------------------------------------------------------------- freshness

    def refresh(self, conn: sqlite3.Connection) -> None:
        """Re-read page passages whose file changed since they were gathered."""
        cache: dict[str, list[sqlite3.Row]] = {}
        for entry in self.entries:
            source = entry.source
            if source.kind != "page" or not source.page_path:
                continue
            row = conn.execute(
                "SELECT file_hash FROM pages WHERE path=?", (source.page_path,)
            ).fetchone()
            if row is None:
                entry.stale = True
                continue
            if row["file_hash"] == source.hash:
                continue
            rows = [
                r
                for r in _page_chunks(conn, cache, source.page_path)
                if json.loads(r["heading_path"]) == source.heading_path
            ]
            if not rows:
                entry.stale = True
                continue
            source.text = "\n\n".join(r["text"] for r in rows if r["text"]) or source.text
            source.chunk_ids = [r["id"] for r in rows]
            source.start_line = rows[0]["start_line"]
            source.end_line = rows[-1]["end_line"]
            source.hash = row["file_hash"]
            entry.stale = False

    # ----------------------------------------------------------------- prompt selection

    def fit(self, budget_bytes: int, *, preferred_paths: list[str] | None = None) -> list[Source]:
        """Choose which sources go into this turn's prompt, newest first, within the budget.

        Evicted sources stay in the set: a citation to them still resolves, they just are not
        shown to the model this turn.
        """
        preferred = set(preferred_paths or [])
        ordered = sorted(
            self.entries,
            key=lambda e: (
                0 if e.source.page_path in preferred else 1,
                0 if e.added_turn == self.turn else 1,
                -e.last_cited_turn,
                -e.added_turn,
                e.source.n,
            ),
        )
        remaining = budget_bytes
        chosen: set[int] = set()
        for entry in ordered:
            size = len(entry.source.prompt_block().encode("utf-8")) + 2
            if size > remaining:
                if not chosen and entry.added_turn == self.turn:
                    chosen.add(entry.source.n)  # one oversize source is clipped by the prompt
                    remaining = 0
                continue
            chosen.add(entry.source.n)
            remaining -= size
        for entry in self.entries:
            entry.in_prompt = entry.source.n in chosen
        sources = self.prompt_sources()
        if preferred:
            sources.sort(key=lambda s: 0 if s.page_path in preferred else 1)
        return sources

    def prompt_sources(self) -> list[Source]:
        return [e.source for e in sorted(self.entries, key=lambda e: e.source.n) if e.in_prompt]

    def drop_unseen(self) -> None:
        """Forget sources gathered this turn that never reached the model."""
        self.entries = [e for e in self.entries if e.in_prompt or e.added_turn != self.turn]

    def keep_only(self, numbers: list[int]) -> None:
        """After prompt assembly: only the passages the model actually saw count as shown."""
        wanted = set(numbers)
        for entry in self.entries:
            if entry.in_prompt and entry.source.n not in wanted:
                entry.in_prompt = False
