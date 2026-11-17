"""One-line page summaries: the vault map an agent reads instead of page bodies (D103).

`pages.summary` holds a sentence per page, written by the local chat model in the
`summarize_page` job and redone only when the page's text changes (`summary_hash` is the
`body_hash` it was written from). Until a page has one, its first lines stand in, so the map
is useful from the first minute and gets better in the background.

Summaries are written by a model on this computer only. With a cloud model configured the
job does nothing: sending every page to a provider is not something the user asked for.
Pages that no AI may read are never summarised.
"""

from __future__ import annotations

import re
import sqlite3
from typing import Any

import sqlite_vec

from graite.agent.loop import visible

BATCH = 12  # pages per job run; the job queues itself again while pages remain
SOURCE_CHARS = 2400  # how much of a page the model reads to summarise it
MAX_CHARS = 200
TASK = (
    "Summarise the page below in one sentence of at most 25 words: what it is about and the "
    "most useful fact in it (a name, date, amount or decision). Use the page's language. "
    "Reply with the sentence only."
)


def page_text(conn: sqlite3.Connection, path: str, limit: int = SOURCE_CHARS) -> str:
    rows = conn.execute(
        "SELECT text FROM chunks WHERE page_path=? ORDER BY ord", (path,)
    ).fetchall()
    return "\n\n".join(r["text"] for r in rows)[:limit]


def excerpt(text: str, limit: int = 140) -> str:
    """The start of a page as a stand-in summary: its first real sentence or line."""
    lines = [
        re.sub(r"[#>*_`|\[\]]+", " ", line).strip()
        for line in text.splitlines()
        if line.strip() and not line.lstrip().startswith(("```", "---", "|"))
    ]
    flat = re.sub(r"\s+", " ", " ".join(lines[:4])).strip()
    if len(flat) <= limit:
        return flat
    cut = flat.rfind(" ", 0, limit)
    return flat[: cut if cut > limit // 2 else limit] + "…"


def clean(reply: str) -> str:
    """The model's sentence, without thinking, quotes, labels or a second paragraph."""
    lines = [line.strip() for line in visible(reply).splitlines() if line.strip()]
    text = lines[0] if lines else ""
    text = re.sub(r"^(summary|samenvatting)\s*:\s*", "", text, flags=re.I).strip(" \"'*#")
    return text[:MAX_CHARS]


def pending(conn: sqlite3.Connection, allowed: set[str], limit: int) -> list[sqlite3.Row]:
    """Pages with text whose summary is missing or was written from older text."""
    rows = conn.execute(
        "SELECT path, title, body_hash FROM pages WHERE has_content=1 AND body_hash IS NOT NULL "
        "AND (summary IS NULL OR summary_hash IS NOT body_hash) ORDER BY path"
    ).fetchall()
    return [r for r in rows if r["path"] in allowed][:limit]


def counts(conn: sqlite3.Connection) -> dict[str, int]:
    row = conn.execute(
        "SELECT sum(has_content=1 AND body_hash IS NOT NULL) AS pages, "
        "sum(has_content=1 AND summary IS NOT NULL AND summary_hash IS body_hash) AS done "
        "FROM pages"
    ).fetchone()
    return {"summary_pages": int(row["pages"] or 0), "summaries": int(row["done"] or 0)}


def store(conn: sqlite3.Connection, path: str, summary: str, body_hash: str) -> None:
    conn.execute(
        "UPDATE pages SET summary=?, summary_hash=? WHERE path=?", (summary, body_hash, path)
    )


def has_vec(conn: sqlite3.Connection) -> bool:
    return (
        conn.execute("SELECT 1 FROM sqlite_master WHERE name='summary_vec'").fetchone() is not None
    )


async def embed_missing(conn: sqlite3.Connection, embedder: Any, limit: int = 64) -> int:
    """Embed summaries that have no vector yet, so a search by meaning can match a page as a
    whole. Does nothing until the passages themselves are embedded with the current model."""
    item = embedder.item()
    model, dim = embedder.current_model()
    if item is None or not embedder.has_vec() or model != item.id or not dim:
        return 0
    if not has_vec(conn):
        conn.execute(f"CREATE VIRTUAL TABLE summary_vec USING vec0(embedding float[{int(dim)}])")
    rows = conn.execute(
        "SELECT pages.rowid AS id, title, summary FROM pages "
        "WHERE summary IS NOT NULL AND summary_hash IS body_hash "
        "AND pages.rowid NOT IN (SELECT rowid FROM summary_vec) LIMIT ?",
        (limit,),
    ).fetchall()
    if not rows:
        return 0
    vectors = await embedder.embed_texts([f"{r['title']}: {r['summary']}" for r in rows])
    for row, vector in zip(rows, vectors, strict=True):
        conn.execute(
            "INSERT OR REPLACE INTO summary_vec(rowid, embedding) VALUES (?, ?)",
            (row["id"], sqlite_vec.serialize_float32(vector)),
        )
    return len(rows)


def forget_vectors(conn: sqlite3.Connection, path: str) -> None:
    """A page's summary changed: its vector is stale."""
    if has_vec(conn):
        conn.execute(
            "DELETE FROM summary_vec WHERE rowid IN (SELECT rowid FROM pages WHERE path=?)", (path,)
        )
