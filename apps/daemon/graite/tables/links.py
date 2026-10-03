"""Relation cells (D71): `[[<row id>|<label>]]`, several separated by spaces.

The id is what the link means; the label is the target row's display value when the link
was written, so the CSV stays readable in Excel, git and Obsidian. Reading is lenient: a
link without a label (`[[id]]`) and bare ids separated by `;` or `,` (the older "id column"
form) are links too.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any

_LINK = re.compile(r"\[\[([^\[\]|]+?)(?:\|([^\[\]]*?))?\]\]")
_BARE_SPLIT = re.compile(r"[;,]")
_LABEL_BAD = re.compile(r"[\[\]|\r\n]+")
MAX_LABEL = 200


@dataclass(frozen=True)
class Link:
    id: str
    label: str = ""


def clean_label(text: str) -> str:
    """A label that cannot break the link syntax: no brackets, bars or line breaks."""
    return " ".join(_LABEL_BAD.sub(" ", str(text)).split())[:MAX_LABEL]


def parse_links(text: str) -> list[Link]:
    """The links in one cell, in order, without repeats."""
    value = (text or "").strip()
    if not value:
        return []
    found = [Link(m.group(1).strip(), (m.group(2) or "").strip()) for m in _LINK.finditer(value)]
    if not found and "[[" not in value:
        found = [Link(part.strip()) for part in _BARE_SPLIT.split(value) if part.strip()]
    out: list[Link] = []
    seen: set[str] = set()
    for link in found:
        if link.id and link.id not in seen:
            seen.add(link.id)
            out.append(link)
    return out


def is_links(text: str) -> bool:
    """Whether a non-empty cell reads as links: nothing but `[[...]]` pairs and spaces, or
    bare ids without spaces inside."""
    value = (text or "").strip()
    if not value:
        return True
    if "[[" in value:
        return _LINK.sub("", value).strip() == ""
    return all(part.strip() and " " not in part.strip() for part in _BARE_SPLIT.split(value))


def format_links(links: list[Link]) -> str:
    parts = []
    for link in links:
        label = clean_label(link.label)
        parts.append(f"[[{link.id}|{label}]]" if label else f"[[{link.id}]]")
    return " ".join(parts)


def ids_of(value: Any) -> list[str]:
    """Row ids from what a client or an agent sends for a relation cell: a list of ids,
    of `{id, label}` objects or of link text, one such value, or link text."""
    if value is None:
        return []
    items = value if isinstance(value, list) else [value]
    out: list[str] = []
    for item in items:
        if isinstance(item, dict):
            rid = str(item.get("id") or "").strip()
            candidates = [rid] if rid else []
        else:
            candidates = [link.id for link in parse_links(str(item))]
        for rid in candidates:
            if rid not in out:
                out.append(rid)
    return out
