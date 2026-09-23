"""Choose how to search from the shape of the question."""

from __future__ import annotations

import re
from dataclasses import dataclass, field

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
