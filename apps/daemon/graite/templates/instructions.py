"""Built-in examples of AI instructions (D90): prompts to start a page's AI settings from.

An example is a Markdown file in `instructions/<slug>.md`. Its frontmatter names it (`name`,
`description`, `category`, `icon`, `order`) and its body is the instruction text, written the
way a user would write it in a page's AI settings. Nothing is written to the vault: the app
shows the examples and the user copies one into a page's instructions.
"""

from __future__ import annotations

from dataclasses import dataclass
from functools import cache
from pathlib import Path
from typing import Any

from graite.vault import frontmatter as fm

FOLDER = Path(__file__).parent / "instructions"
CATEGORIES = (
    "Productivity",
    "Startups",
    "Product",
    "Sales",
    "Marketing",
    "Support",
    "Finance",
    "Research",
    "Writing",
    "Personal",
)
# A page's own instructions may hold this much (see `api/pages.py`); an example must fit.
MAX_CHARS = 8000


@dataclass(frozen=True)
class InstructionExample:
    slug: str
    name: str
    description: str
    category: str
    icon: str
    order: int
    text: str

    def to_json(self) -> dict[str, Any]:
        return {
            "slug": self.slug,
            "name": self.name,
            "description": self.description,
            "category": self.category,
            "icon": self.icon,
            "text": self.text,
        }


def _load(file: Path) -> InstructionExample:
    meta, body = fm.split(file.read_text(encoding="utf-8"))
    category = str(meta.get("category") or "")
    if category not in CATEGORIES:
        raise ValueError(f"Instruction example {file.stem} has unknown category {category!r}.")
    text = body.strip()
    if not text or len(text) > MAX_CHARS:
        raise ValueError(f"Instruction example {file.stem} is empty or too long.")
    return InstructionExample(
        slug=file.stem,
        name=str(meta["name"]),
        description=str(meta["description"]),
        category=category,
        icon=str(meta.get("icon") or "📝"),
        order=int(meta.get("order", 1000)),
        text=text,
    )


@cache
def examples() -> tuple[InstructionExample, ...]:
    """Every built-in example, in gallery order."""
    found = [_load(f) for f in sorted(FOLDER.glob("*.md"))]
    return tuple(sorted(found, key=lambda e: (e.order, e.name)))
