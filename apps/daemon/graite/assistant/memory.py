"""The assistant's memory: ordinary pages under one root page named after it.

The definition refers to the root by page id, so the user can rename or move it. The root
asks for auto-apply on its own subtree, and setting up an assistant is itself the consent:
what it learns about you lands on its own pages straight away, no review queue. Every page
outside the subtree keeps its own policy, and the writes remain ordinary reversible ones —
they show up under "Recent memory changes" and revert like any other.

One memory is one page under `Memories` (D56): a short title that says the fact, an optional
body, and two properties — `Kind` and `Pinned`. `Memories` carries a `graite:view` fence, so
the user checks, edits and removes memories like the cards of any list. Only pinned memories
go into every prompt; the rest are recalled per turn by what the user just said, and the
model can look up more with `search_memory`. `Journal` stays one page of dated lines, read
by the background loop only.

Because the opt-in is keyed by path while the root can be renamed or moved, and because it
lives in the index rather than the vault, `info` re-confirms it rather than reporting the
memory as unconfirmed after a rename or a rebuilt `.graite/`.
"""

from __future__ import annotations

import asyncio
import json
import re
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any

from graite.review.policy import opt_in, opted_in
from graite.vault import policy

MEMORIES = "Memories"
JOURNAL = "Journal"
MEMORY_PAGES = (MEMORIES, JOURNAL)
# Before D56 memory was two bullet lists. Still read (so nothing is forgotten before the user
# upgrades) and turned into memory pages by `upgrade`.
LEGACY_PAGES = ("Profile", "Playbook")
KINDS = ("About", "Preference", "Person", "Project", "Routine", "Lesson", "Other")
KIND_COLORS = {
    "About": "blue",
    "Preference": "purple",
    "Person": "pink",
    "Project": "green",
    "Routine": "yellow",
    "Lesson": "orange",
    "Other": "gray",
}
_LEGACY_SECTIONS = {
    "about": "About",
    "preferences": "Preference",
    "people": "Person",
    "projects & work": "Project",
    "routines": "Routine",
    "other": "Other",
}
MEMORIES_BODY = (
    "What the assistant remembers about you, one page per memory. Pinned memories are in "
    "every conversation; the others come up when they are relevant. Edit or delete any of "
    "them.\n\n"
    "```graite:view\n"
    "settings:\n"
    "  fields:\n"
    "    - name: Kind\n"
    "      type: single_select\n"
    f"      options: [{', '.join(KINDS)}]\n"
    "      colors: {" + ", ".join(f"{k}: {c}" for k, c in KIND_COLORS.items()) + "}\n"
    "    - name: Pinned\n"
    "      type: checkbox\n"
    "view: list\n"
    "group: Kind\n"
    "show:\n"
    "  list: [Kind, Pinned]\n"
    "  table: [Kind, Pinned]\n"
    "```\n"
)
OLD_AUTO_KINDS = ["append", "create", "edit"]
MEMORY_SETTINGS: dict[str, Any] = {
    "autonomy": "auto-apply",
    # Deletes too (D57): forgetting is part of keeping memory useful, and a delete goes to
    # the trash and reverts like any other change.
    "auto_apply_kinds": ["append", "create", "edit", "properties", "delete"],
}
LEGACY_LIMIT = 6000
JOURNAL_TAIL = 3000
CORE_BUDGET = 1200  # bytes of pinned memories in every prompt
RECALL_BUDGET = 1500  # bytes of memories recalled for one message
RECALL_LIMIT = 6
# sqlite-vec L2 distance between normalised embeddings; 1.0 is a cosine similarity of 0.5.
# Beyond it a "nearest" memory is only the least unrelated one.
RECALL_DISTANCE = 1.0
RECALLED_KEY = "memory_recalled"
_WORD = re.compile(r"\w+")


@dataclass
class MemoryInfo:
    page_id: str | None = None
    root: str | None = None
    pages: dict[str, str] = field(default_factory=dict)  # "Memories" -> vault path
    auto_apply: bool = False  # the root still asks for auto-apply
    opted_in: bool = False  # and the user confirmed it
    legacy: list[str] = field(default_factory=list)  # old Profile/Playbook still to upgrade

    def to_dict(self) -> dict[str, Any]:
        return {
            "page_id": self.page_id,
            "root": self.root,
            "pages": self.pages,
            "auto_apply": self.auto_apply,
            "opted_in": self.opted_in,
            "legacy": self.legacy,
        }


@dataclass
class Memory:
    path: str
    title: str
    body: str = ""
    kind: str | None = None
    pinned: bool = False

    def line(self) -> str:
        body = " ".join(self.body.split())
        text = self.title if not body else f"{self.title} — {body}"
        return f"- {text}"

    def to_dict(self) -> dict[str, Any]:
        return {
            "path": self.path,
            "title": self.title,
            "body": self.body,
            "kind": self.kind,
            "pinned": self.pinned,
        }


def root_path(state: Any, page_id: str | None) -> str | None:
    if not page_id:
        return None
    try:
        return str(state.fileops.page_by_id(page_id))
    except (FileNotFoundError, ValueError):
        return None


def _children(state: Any, root: str) -> dict[str, str]:
    rows = state.db.execute(
        "SELECT path, title FROM pages WHERE parent_path=? ORDER BY path", (root,)
    ).fetchall()
    found: dict[str, str] = {}
    for row in rows:
        if row["title"] in (*MEMORY_PAGES, *LEGACY_PAGES) and row["title"] not in found:
            found[row["title"]] = row["path"]
    return {t: found[t] for t in (*MEMORY_PAGES, *LEGACY_PAGES) if t in found}


def info(state: Any, page_id: str | None) -> MemoryInfo:
    root = root_path(state, page_id)
    if root is None:
        return MemoryInfo()
    effective = policy.resolve(state.settings.vault, state.db, root)
    auto = effective.autonomy == "auto-apply"
    source = str(effective.sources.get("autonomy", "vault"))
    confirmed = auto and source in opted_in(state.db)
    if auto and not confirmed and source == root:
        # The assistant's own root asking for auto-apply: that is the setup's decision, not a
        # question. Re-confirm it, so a rename, a move or a rebuilt index does not silently
        # put the memory back behind review.
        opt_in(state.db, source)
        confirmed = True
    children = _children(state, root)
    return MemoryInfo(
        page_id=page_id,
        root=root,
        pages={t: p for t, p in children.items() if t in MEMORY_PAGES},
        auto_apply=auto,
        opted_in=confirmed,
        legacy=[t for t in LEGACY_PAGES if t in children],
    )


async def _create_memories(state: Any, root: str, actor: str) -> str:
    page = await state.fileops.create_page(root, MEMORIES, "🧠", actor)
    await state.fileops.write_body(page.path, MEMORIES_BODY, page.hash, actor)
    return str(page.path)


async def ensure(state: Any, name: str, page_id: str | None, actor: str = "ui") -> MemoryInfo:
    """Create whatever is missing: the root page (titled after the assistant), `Memories`
    and `Journal` and, only when the root is new, the auto-apply setting and its opt-in.
    Existing settings are the user's and are never overwritten."""
    fileops = state.fileops
    root = root_path(state, page_id)
    if root is None:
        doc = await fileops.create_page(None, name, "🧭", actor)
        await fileops.set_ai_settings(doc.path, MEMORY_SETTINGS, None, actor)
        opt_in(state.db, doc.path)
        root, page_id = doc.path, doc.id
    existing = _children(state, root)
    if MEMORIES not in existing:
        await _create_memories(state, root, actor)
    if JOURNAL not in existing:
        await fileops.create_page(root, JOURNAL, None, actor)
    return info(state, page_id)


# ----------------------------------------------------------------------------- reading


def _flags(frontmatter_json: str | None) -> tuple[str | None, bool]:
    try:
        meta = json.loads(frontmatter_json or "{}")
    except ValueError:
        return None, False
    kind: str | None = None
    pinned = False
    for prop in meta.get("properties") or [] if isinstance(meta, dict) else []:
        if not isinstance(prop, dict):
            continue
        name = str(prop.get("name") or "").casefold()
        if name == "kind" and isinstance(prop.get("value"), str):
            kind = prop["value"] or None
        elif name == "pinned":
            pinned = prop.get("value") is True
    return kind, pinned


def memories_path(state: Any, root: str | None) -> str | None:
    return _children(state, root).get(MEMORIES) if root else None


def _allowed(state: Any, root: str, cloud: bool) -> bool:
    return not cloud or policy.resolve(state.settings.vault, state.db, root).cloud_allowed


def _rows(state: Any, parent: str, paths: list[str] | None = None) -> list[Any]:
    if paths is not None:
        if not paths:
            return []
        marks = ",".join("?" * len(paths))
        return list(
            state.db.execute(
                "SELECT path, title, frontmatter_json FROM pages "
                f"WHERE parent_path=? AND path IN ({marks})",
                (parent, *paths),
            )
        )
    return list(
        state.db.execute(
            "SELECT path, title, frontmatter_json FROM pages WHERE parent_path=? ORDER BY path",
            (parent,),
        )
    )


async def _load(state: Any, rows: list[Any]) -> list[Memory]:
    out: list[Memory] = []
    for row in rows:
        kind, pinned = _flags(row["frontmatter_json"])
        try:
            body = (await state.fileops.read_page(row["path"])).body
        except (FileNotFoundError, ValueError):
            continue
        body = body.replace("<!-- graite:empty -->", "").strip()
        out.append(Memory(row["path"], row["title"], body, kind, pinned))
    return out


async def all_memories(state: Any, root: str | None) -> list[Memory]:
    parent = memories_path(state, root)
    return await _load(state, _rows(state, parent)) if parent else []


def _fit(lines: list[str], budget: int) -> str:
    kept: list[str] = []
    size = 0
    for line in lines:
        cost = len(line.encode()) + 1
        if size + cost > budget:
            break
        kept.append(line)
        size += cost
    return "\n".join(kept)


async def core(state: Any, root: str | None, *, cloud: bool) -> str:
    """What goes into every prompt: the pinned memories, plus the old Profile and Playbook
    while they have not been upgraded, so nothing is forgotten in between."""
    if root is None or not _allowed(state, root, cloud):
        return ""
    blocks: list[str] = []
    parent = memories_path(state, root)
    if parent:
        pinned = [r for r in _rows(state, parent) if _flags(r["frontmatter_json"])[1]]
        text = _fit([m.line() for m in await _load(state, pinned)], CORE_BUDGET)
        if text:
            blocks.append(text)
    children = _children(state, root)
    for title in LEGACY_PAGES:
        if title not in children:
            continue
        try:
            body = (await state.fileops.read_page(children[title])).body.strip()
        except (FileNotFoundError, ValueError):
            continue
        body = re.sub(r"^## [^\n]*\n+(?=## |\Z)", "", body + "\n", flags=re.M).strip()
        body = body.replace("<!-- graite:empty -->", "").strip()
        if body:
            blocks.append(f"### {title} ({children[title]})\n{body[:LEGACY_LIMIT]}")
    return "\n\n".join(blocks)


async def journal_tail(state: Any, root: str | None) -> str:
    path = _children(state, root).get(JOURNAL) if root else None
    if not path:
        return ""
    try:
        body = str((await state.fileops.read_page(path)).body).strip()
    except (FileNotFoundError, ValueError):
        return ""
    return body[-JOURNAL_TAIL:]


async def digest(state: Any, root: str | None, *, cloud: bool, limit: int = 40) -> str:
    """For the background loop, which has no user message to recall against: the core, the
    titles of the other memories and the end of the Journal."""
    if root is None or not _allowed(state, root, cloud):
        return ""
    parts = []
    head = await core(state, root, cloud=cloud)
    if head:
        parts.append(head)
    parent = memories_path(state, root)
    if parent:
        others = [
            f"- {r['title']}" for r in _rows(state, parent) if not _flags(r["frontmatter_json"])[1]
        ]
        if others:
            parts.append(
                "Other memories (search_memory for details):\n" + "\n".join(others[:limit])
            )
    journal = await journal_tail(state, root)
    if journal:
        parts.append("### Journal\n" + journal)
    return "\n\n".join(parts)


def _terms(text: str) -> list[str]:
    from graite.retrieval.search import STOPWORDS

    words = [w for w in _WORD.findall(text.lower()) if len(w) > 3 and w not in STOPWORDS]
    return list(dict.fromkeys(words))[:12]


async def search(
    state: Any,
    root: str | None,
    query: str,
    *,
    cloud: bool,
    limit: int = RECALL_LIMIT,
    include_pinned: bool = True,
    wait: float = 3.0,
) -> list[Memory]:
    """Memories that match `query`: keyword hits, and embedding neighbours close enough to
    mean something. Nothing when neither finds a real match — a greeting recalls nothing."""
    from graite.retrieval.scope import Scope
    from graite.retrieval.scope import resolve as resolve_scope
    from graite.retrieval.search import RRF_K, Searcher

    parent = memories_path(state, root)
    if parent is None or root is None or not _allowed(state, root, cloud):
        return []
    try:
        scope = resolve_scope(
            state.db, state.settings.vault, Scope("folder", [parent]), cloud_provider=cloud
        )
    except FileNotFoundError:
        return []
    scope.paths = [p for p in scope.paths if p != parent]
    if not scope.paths:
        return []
    scope.all_pages = False
    searcher = Searcher(state.db, getattr(state, "embedder", None))
    scores: dict[int, float] = {}
    try:
        clause = searcher._scope_clause(scope)
        terms = _terms(query)
        if terms:
            fts = " OR ".join(f'"{t}"*' for t in terms)
            for rank, (chunk, _) in enumerate(searcher.fts(fts, clause, 30), start=1):
                scores[chunk] = scores.get(chunk, 0.0) + 1.0 / (RRF_K + rank)
        if searcher.embedder is not None and query.strip():
            # Shielded: a slow first embedding finishes in the background and warms the model
            # for the next turn instead of holding this one up.
            task = asyncio.ensure_future(searcher.vector(query, clause, 30))
            try:
                hits = await asyncio.wait_for(asyncio.shield(task), wait)
            except TimeoutError:
                hits = []
            close = [(c, d) for c, d in hits if d <= RECALL_DISTANCE]
            for rank, (chunk, _) in enumerate(close, start=1):
                scores[chunk] = scores.get(chunk, 0.0) + 1.0 / (RRF_K + rank)
    finally:
        searcher.release()
    if not scores:
        return []
    marks = ",".join("?" * len(scores))
    page_score: dict[str, float] = {}
    for row in state.db.execute(
        f"SELECT id, page_path FROM chunks WHERE id IN ({marks})", list(scores)
    ):
        path = row["page_path"]
        page_score[path] = max(page_score.get(path, 0.0), scores[row["id"]])
    ranked = sorted(page_score, key=lambda p: -page_score[p])
    rows = {r["path"]: r for r in _rows(state, parent, ranked)}
    ordered = [rows[p] for p in ranked if p in rows]
    if not include_pinned:
        ordered = [r for r in ordered if not _flags(r["frontmatter_json"])[1]]
    return await _load(state, ordered[:limit])


async def recall(state: Any, root: str | None, query: str, *, cloud: bool, voice: bool) -> str:
    """The memories that bear on this message, for the prompt; pinned ones are already in
    the core. Remembers when each was last recalled, for the tidy pass."""
    found = await search(
        state,
        root,
        query,
        cloud=cloud,
        include_pinned=False,
        wait=1.0 if voice else 3.0,
    )
    if not found:
        return ""
    note_recalled(state.db, [m.path for m in found])
    return _fit([m.line() for m in found], RECALL_BUDGET)


def note_recalled(db: Any, paths: list[str]) -> None:
    seen = last_recalled(db)
    stamp = datetime.now(UTC).strftime("%Y-%m-%d")
    seen.update({p: stamp for p in paths})
    db.execute("INSERT OR REPLACE INTO meta VALUES (?, ?)", (RECALLED_KEY, json.dumps(seen)))


def last_recalled(db: Any) -> dict[str, str]:
    row = db.execute("SELECT value FROM meta WHERE key=?", (RECALLED_KEY,)).fetchone()
    try:
        value = json.loads(row[0]) if row else {}
    except ValueError:
        return {}
    return value if isinstance(value, dict) else {}


# ----------------------------------------------------------------------------- upgrade


def _title(text: str, limit: int = 80) -> tuple[str, str]:
    """A memory's title and body from one old bullet: short bullets become the title alone."""
    text = " ".join(text.split()).strip()
    if len(text) <= limit:
        return text.rstrip("."), ""
    sentence = re.split(r"(?<=[.!?])\s", text, maxsplit=1)[0]
    if len(sentence) <= limit:
        return sentence.rstrip("."), text
    cut = text[:limit].rsplit(" ", 1)[0]
    return cut.rstrip(",;:") + "…", text


def legacy_items(profile: str, playbook: str) -> list[tuple[str, str]]:
    """(kind, text) for every bullet of the old Profile (by section) and Playbook."""
    items: list[tuple[str, str]] = []
    kind = "Other"
    for line in profile.splitlines():
        heading = re.match(r"^#{1,6}\s+(.+?)\s*$", line)
        if heading:
            kind = _LEGACY_SECTIONS.get(heading.group(1).strip().casefold(), "Other")
            continue
        bullet = re.match(r"^\s*(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?(.+)$", line)
        if bullet and bullet.group(1).strip():
            items.append((kind, bullet.group(1).strip()))
    for line in playbook.splitlines():
        bullet = re.match(r"^\s*(?:[-*+]|\d+[.)])\s+(.+)$", line)
        if bullet and bullet.group(1).strip():
            items.append(("Lesson", bullet.group(1).strip()))
    return items


async def add(
    state: Any,
    parent: str,
    title: str,
    body: str,
    *,
    kind: str | None,
    pinned: bool,
    actor: str,
) -> Memory:
    from graite.vault.properties import from_compact

    doc = await state.fileops.create_page(parent, title, None, actor)
    fields = from_compact(
        [
            {
                "name": "Kind",
                "type": "single_select",
                "options": list(KINDS),
                "value": kind if kind in KINDS else None,
            },
            {"name": "Pinned", "type": "checkbox", "value": pinned},
        ]
    )
    values = [f.model_dump() for f in fields]
    for value in values:
        if value["name"] == "Kind":
            value["colors"] = dict(KIND_COLORS)
    doc = await state.fileops.set_properties(doc.id, values, doc.hash, actor)
    if body.strip():
        doc = await state.fileops.write_body(doc.path, body.strip() + "\n", doc.hash, actor)
    return Memory(doc.path, doc.title, body.strip(), kind, pinned)


async def upgrade(state: Any, page_id: str | None, actor: str = "ui") -> dict[str, Any]:
    """Turn the old Profile and Playbook bullets into one memory page each, then move the
    old pages to the trash. Explicit (a button), never on open: it writes many files."""
    root = root_path(state, page_id)
    if root is None:
        raise ValueError("The assistant has no memory page.")
    children = _children(state, root)
    texts: dict[str, str] = {}
    for title in LEGACY_PAGES:
        if title in children:
            texts[title] = (await state.fileops.read_page(children[title])).body
    if not texts:
        return {"created": 0, "memories": memories_path(state, root)}
    parent = children.get(MEMORIES) or await _create_memories(state, root, actor)
    if JOURNAL not in children:
        await state.fileops.create_page(root, JOURNAL, None, actor)
    created = 0
    seen: set[str] = set()
    for kind, text in legacy_items(texts.get("Profile", ""), texts.get("Playbook", "")):
        title, body = _title(text)
        if not title or title.casefold() in seen:
            continue
        seen.add(title.casefold())
        await add(state, parent, title, body, kind=kind, pinned=kind == "About", actor=actor)
        created += 1
    for title in LEGACY_PAGES:
        if title in children:
            await state.fileops.trash_page(children[title], actor)
    # Deletes join auto-apply only where the setting is still the one the setup wrote.
    meta = (await state.fileops.read_page(root)).frontmatter
    if meta.get("autonomy") == "auto-apply" and meta.get("auto_apply_kinds") == OLD_AUTO_KINDS:
        await state.fileops.set_ai_settings(root, MEMORY_SETTINGS, None, actor)
    return {"created": created, "memories": parent}
