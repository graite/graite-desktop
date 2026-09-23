"""The assistant's instructions are four plain markdown sections in its definition body."""

from __future__ import annotations

import re

SECTIONS = ("Personality", "Context", "Guidelines", "Goals")
_HEADING = re.compile(r"^##[ \t]+(.+?)[ \t]*$", re.M)


def split_sections(body: str) -> dict[str, str]:
    """Section texts keyed by lowercase name. Text before the first known heading, or under
    a heading this module does not know, stays with the section it follows (or Personality),
    so a file edited by hand loses nothing on the next save."""
    result = {name.lower(): "" for name in SECTIONS}
    known = {name.lower(): name for name in SECTIONS}
    current = "personality"
    position = 0
    for match in _HEADING.finditer(body):
        result[current] += body[position : match.start()]
        title = match.group(1).strip().lower()
        if title in known:
            current = title
        else:
            result[current] += match.group(0)
        position = match.end()
    result[current] += body[position:]
    return {key: re.sub(r"\n{3,}", "\n\n", text).strip() for key, text in result.items()}


def join_sections(sections: dict[str, str]) -> str:
    parts = []
    for name in SECTIONS:
        text = (sections.get(name.lower()) or "").strip()
        if text:
            parts.append(f"## {name}\n\n{text}")
    return "\n\n".join(parts) + ("\n" if parts else "")
