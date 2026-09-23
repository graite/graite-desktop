"""The shape of the vault, for a prompt: which pages exist and where they sit.

A model that can see the tree can go straight to a page with `read_page`, or narrow a
`search_vault` to the right corner, instead of having pages pushed at it. That is the whole
point: the navigation is cheap, the page bodies are not, so we spend the budget on the map
and let the model ask for the territory.

Rendered as indented path segments, which is far denser than a list of full paths and keeps
sibling pages together. When it does not fit, the deepest branches collapse to a count and
the model is told to open them with `list_children`.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from difflib import SequenceMatcher
from typing import Any

INDENT = "  "
SPELLED = re.compile(r"(?<![\w'’])[a-zA-Z](?:[\s.\-]+[a-zA-Z]){2,}(?!\w)")
PAGE_REQUEST = re.compile(
    r"\b(action|actions|tasks?|todos?|pages?|projects?|notes?|open|still|next|remaining|"
    r"summari[sz]e|summary|analyse|analyze|"
    r"acties|taken|pagina|pagina's|notities)\b",
    re.I,
)
SPEECH_FILLERS = {
    "about",
    "actual",
    "again",
    "all",
    "could",
    "have",
    "like",
    "please",
    "tell",
    "that",
    "there",
    "these",
    "they",
    "this",
    "want",
    "what",
    "which",
    "with",
    "would",
    "your",
    "know",
    "mostly",
    "something",
    "things",
    "still",
}
HEADER = (
    "Pages you can read and propose changes to, as a tree. Indentation is nesting: a page's "
    "full path is its own line joined to its parents with '/' (lines at the same indentation "
    "are siblings, never parts of one path). Titles differ from the path segment only where "
    "one is shown in parentheses. Nothing below is loaded — use read_page(path) to open one, "
    "search_vault(query) to find passages, list_children(path) to expand a collapsed branch."
)


def page_reference(
    question: str, history: list[dict[str, Any]], titles: dict[str, str], *, voice: bool
) -> tuple[list[str], str]:
    """Resolve names against accessible pages, without rewriting the user's transcript.

    Spelling is exact evidence. Fuzzy speech matches remain suggestions, never write targets.
    A follow-up can refer to the latest user-mentioned page, not an assistant's earlier guess.
    """
    names = {
        path: {title.casefold(), path.rsplit("/", 1)[-1].casefold(), path.casefold()}
        for path, title in titles.items()
    }

    def match(text: str, approximate: bool) -> tuple[list[str], str]:
        spelled = {re.sub(r"[^a-z]", "", m.group().lower()) for m in SPELLED.finditer(text)}
        exact = [p for p, labels in names.items() if labels & spelled]
        if exact:
            return exact, "spelled name"
        mentioned = [
            p
            for p, labels in names.items()
            if any(
                re.search(r"(?<!\w)" + re.escape(n) + r"(?!\w)", text, re.I) for n in labels if n
            )
        ]
        if mentioned:
            return mentioned, "page name"
        if approximate and voice and PAGE_REQUEST.search(text):
            words = [
                word
                for word in re.findall(r"\w{4,}", text.casefold())
                if word not in SPEECH_FILLERS and not PAGE_REQUEST.fullmatch(word)
            ]
            scores = {
                p: max(
                    (
                        SequenceMatcher(None, w, n).ratio()
                        for w in words
                        for n in labels
                        if " " not in n and "/" not in n
                    ),
                    default=0,
                )
                for p, labels in names.items()
            }
            best = max(scores.values(), default=0)
            if best >= 0.72:
                return [
                    p for p, score in scores.items() if score >= max(0.72, best - 0.08)
                ], "possible spoken name"
        return [], ""

    # A title in small talk (including the assistant's own name) does not call for a read.
    current_request = bool(PAGE_REQUEST.search(question))
    correction = bool(SPELLED.search(question))
    recent_request = any(
        m.get("role") == "user" and PAGE_REQUEST.search(str(m.get("content") or ""))
        for m in history[-6:]
    )
    paths, evidence = match(question, True)
    if not current_request and not (correction and recent_request):
        return [], ""
    earlier = False
    if not paths:
        for message in reversed(history[-12:]):
            if message.get("role") != "user":
                continue
            paths, evidence = match(str(message.get("content") or ""), False)
            if paths:
                earlier = True
                break
    if not paths:
        return [], ""
    # Never let a large request to list many pages consume the dialogue budget.
    paths = paths[:8]
    names_text = json.dumps(paths, ensure_ascii=False)
    origin = "recent user message" if earlier else "current user message"
    hint = f"Available page paths matching the {evidence} in the {origin}: {names_text}. "
    if evidence == "possible spoken name":
        hint += (
            "This is a possible transcription mismatch, not a confirmed identity. "
            "Read to check before asking."
        )
    else:
        hint += (
            "Use the conversation to continue the user's request. A spelling correction "
            "resolves the name even if older memory calls it unclear."
        )
    if correction:
        requests = [
            str(m.get("content") or "")
            for m in history[-6:]
            if m.get("role") == "user" and PAGE_REQUEST.search(str(m.get("content") or ""))
        ]
        hint += " Continue these recent user requests with the corrected name: " + json.dumps(
            requests[-2:], ensure_ascii=False
        )
    return paths, hint


@dataclass
class _Node:
    segment: str
    path: str = ""
    children: dict[str, _Node] = field(default_factory=dict)

    def count(self) -> int:
        """Pages in this subtree, including this one when it is a real page."""
        return bool(self.path) + sum(child.count() for child in self.children.values())


def _tree(paths: list[str]) -> _Node:
    root = _Node("")
    for path in paths:
        node = root
        for depth, segment in enumerate(path.split("/")):
            node = node.children.setdefault(segment, _Node(segment))
            if depth == len(path.split("/")) - 1:
                node.path = path
    return root


def _same(title: str, segment: str) -> bool:
    """The segment is the title with unsafe characters taken out, so a trailing period or a
    swapped dash is not worth printing twice."""
    keep = "".join(c for c in title.casefold() if c.isalnum())
    return keep == "".join(c for c in segment.casefold() if c.isalnum())


def _lines(node: _Node, titles: dict[str, str], depth: int, max_depth: int) -> list[str]:
    out = []
    for child in node.children.values():
        title = titles.get(child.path, "")
        label = child.segment
        if title and not _same(title, child.segment):
            label += f" ({title})"
        if child.children and depth + 1 >= max_depth:
            more = child.count() - bool(child.path)
            where = f' (list_children "{child.path}")' if child.path else ""
            out.append(f"{INDENT * depth}{label}/ — {more} more{where}")
            continue
        out.append(INDENT * depth + label)
        out.extend(_lines(child, titles, depth + 1, max_depth))
    return out


def render(paths: list[str], titles: dict[str, str], budget: int) -> str:
    """The tree as prompt text, shallowing it until it fits `budget` UTF-8 bytes.

    Returns "" when the budget cannot even hold the header and the top level: half an
    explanation pointing at tools is worse than leaving the section out.
    """
    floor = len(HEADER.encode()) + 40
    if not paths or budget < floor:
        return ""
    root = _tree(sorted(paths))
    depth = max(len(p.split("/")) for p in paths)
    while True:
        text = HEADER + "\n" + "\n".join(_lines(root, titles, 0, depth))
        if len(text.encode()) <= budget:
            return text
        if depth == 1:
            note = "Some top-level pages are omitted; use list_children(path='', offset=0)."
            lines = [HEADER]
            for line in _lines(root, titles, 0, depth):
                if len(("\n".join([*lines, line, note])).encode()) > budget:
                    break
                lines.append(line)
            return (
                "\n".join([*lines, note]) if len((HEADER + "\n" + note).encode()) <= budget else ""
            )
        depth -= 1
