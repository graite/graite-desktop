"""Decide whether a question needs a new search or can build on what the chat already has.

A wrong "reuse" costs one tool round (the model may still call `search_vault`); a wrong
"retrieve" costs latency. The decision is recorded as a run step so thresholds can be tuned.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any

from graite.retrieval.search import STOPWORDS
from graite.retrieval.strategy import _DATE, _IDENTIFIER, classify

ANAPHORA = {
    "it",
    "this",
    "that",
    "these",
    "those",
    "above",
    "previous",
    "more",
    "again",
    "why",
    "elaborate",
    "expand",
    "shorter",
    "longer",
    "summarise",
    "summarize",
    "rephrase",
    "explain",
    "detail",
    "details",
    "so",
    "then",
}
COVERAGE = 0.6
MAX_WORDS = 30
MAX_SHORT_TOKENS = 6


@dataclass
class Decision:
    retrieve: bool
    reason: str


def _tokens(text: str) -> list[str]:
    return [t for t in re.findall(r"\w+", text.lower()) if len(t) > 3 and t not in STOPWORDS]


def decide(question: str, history: list[dict[str, Any]], texts: list[str]) -> Decision:
    """`texts` are the passages already gathered; `history` the persisted messages so far."""
    if not texts:
        return Decision(True, "no context yet")
    answers = [
        str(m.get("content") or "")
        for m in history
        if m.get("role") == "assistant" and not m.get("interrupted")
    ]
    if not answers:
        return Decision(True, "no earlier answer")
    haystack = "\n".join([*texts, *answers[-2:]]).lower()
    plan = classify(question)
    exact = [*plan.phrases, *_IDENTIFIER.findall(question), *_DATE.findall(question)]
    for term in exact:
        if term.lower() not in haystack:
            return Decision(True, f"new exact term {term!r}")
    words = re.findall(r"\w+", question)
    tokens = _tokens(question)
    if not tokens:
        return Decision(False, "no content words")
    covered = sum(1 for t in tokens if t in haystack)
    coverage = covered / len(tokens)
    lowered = {w.lower() for w in words}
    if coverage >= COVERAGE and len(words) <= MAX_WORDS:
        return Decision(False, f"covered {covered}/{len(tokens)}")
    if len(tokens) <= MAX_SHORT_TOKENS and lowered & ANAPHORA:
        return Decision(False, "short follow-up")
    return Decision(True, f"covered {covered}/{len(tokens)}")
