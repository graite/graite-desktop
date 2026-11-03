"""Choose how to search from the shape of the question."""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any

_QUOTED = re.compile(r'"([^"]{2,120})"|“([^”]{2,120})”')
_IDENTIFIER = re.compile(r"\b(?:[A-Z]{2,}-\d+|[a-z0-9_]+\.[a-z0-9_.]+|#\d+|v?\d+\.\d+(?:\.\d+)?)\b")
_DATE = re.compile(r"\b(?:\d{4}-\d{2}-\d{2}|\d{1,2}/\d{1,2}/\d{2,4})\b")
_STRUCTURED = re.compile(
    r"\b(list|all|every|each|how many|which pages|which notes|with status|tagged|"
    r"tag|property|due|overdue|assigned|open tasks|done tasks)\b",
    re.I,
)
_RESEARCH = re.compile(
    r"\b(why|compare|difference|versus|vs\.?|between|history|timeline|evolve|and then|"
    r"across|everything about|summarize all|trace|relate|connection)\b",
    re.I,
)


@dataclass
class Plan:
    semantic: bool = True
    exact: bool = True
    structured: bool = False
    research: bool = False
    k: int = 12
    phrases: list[str] = field(default_factory=list)
    max_rounds: int = 2

    @property
    def label(self) -> str:
        parts = []
        if self.exact:
            parts.append("keywords")
        if self.semantic:
            parts.append("meaning")
        if self.structured:
            parts.append("properties")
        return " + ".join(parts)


def classify(question: str) -> Plan:
    plan = Plan()
    text = question.strip()
    plan.phrases = [a or b for a, b in _QUOTED.findall(text)]
    exact_signals = bool(plan.phrases) or bool(_IDENTIFIER.search(text)) or bool(_DATE.search(text))
    if exact_signals:
        plan.k = 16
    if _STRUCTURED.search(text):
        plan.structured = True
        plan.k = 20
    words = len(re.findall(r"\w+", text))
    if _RESEARCH.search(text) or words > 30 or text.count("?") > 1:
        plan.research = True
        plan.max_rounds = 5
    return plan


_WORD = re.compile(r"[^\W\d_]{3,}", re.UNICODE)


def _stem(word: str) -> str:
    word = word.lower()
    for suffix, repl in (("ies", "y"), ("ses", "s"), ("s", "")):
        if word.endswith(suffix) and len(word) - len(suffix) >= 3:
            return word[: -len(suffix)] + repl
    return word


def _stems(text: str) -> set[str]:
    return {_stem(w) for w in _WORD.findall(text.replace("_", " ").replace("-", " "))}


def match_tables(question: str, catalog: list[Any], limit: int = 2) -> list[Any]:
    """The databases a question is about, best first, so their rows are read before any page
    passage. A table matches by its name or the title of a page that shows it ("companies"),
    weaker by one of its select values ("customers" -> status Customer); the page that holds
    it ("crm") only breaks ties."""
    words = _stems(question)
    if not words:
        return []
    scored: list[tuple[float, int, Any]] = []
    for order, entry in enumerate(catalog):
        names = _stems(entry.name) | {
            s
            for page in entry.shown_on
            if page != entry.page  # the page holding it ("CRM") only breaks ties, below
            for s in _stems(page.rpartition("/")[2])
        }
        score = 2.0 * len(words & names)
        if not score:
            score = 1.0 * min(1, len(words & {s for o in entry.options for s in _stems(o)}))
        if not score:
            continue
        score += 0.5 * min(1, len(words & _stems(entry.page.replace("/", " "))))
        scored.append((score, order, entry))
    if not scored:
        return []
    scored.sort(key=lambda t: (-t[0], t[1]))
    best = scored[0][0]
    return [e for s, _, e in scored if s >= min(best, 2.0)][:limit]
