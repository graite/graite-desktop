"""Portable, typed page properties stored in page.md frontmatter."""

from __future__ import annotations

import math
import re
from datetime import date
from typing import Any, Literal, cast, get_args
from urllib.parse import urlparse

from pydantic import BaseModel, Field, model_validator

PropertyKind = Literal[
    "text",
    "number",
    "single_select",
    "multi_select",
    "date",
    "checkbox",
    "email",
    "url",
    "media",
    "status",
    "created",
    "updated",
]
PropertyColor = Literal[
    "default", "gray", "brown", "orange", "yellow", "green", "blue", "purple", "pink", "red"
]


class PageProperty(BaseModel):
    id: str = Field(min_length=1, max_length=100)
    name: str = Field(min_length=1, max_length=100)
    type: PropertyKind
    options: list[str] = Field(default_factory=list, max_length=100)
    colors: dict[str, PropertyColor] = Field(default_factory=dict, max_length=100)
    value: Any = None

    @model_validator(mode="after")
    def validate_value(self) -> PageProperty:
        self.name = self.name.strip()
        if not self.name or any(
            not isinstance(o, str) or not o.strip() or len(o) > 100 for o in self.options
        ):
            raise ValueError("Use a name and nonempty options of up to 100 characters.")
        self.options = list(dict.fromkeys(o.strip() for o in self.options))
        self.colors = {key: color for key, color in self.colors.items() if key in self.options}
        value = self.value
        if self.type in ("created", "updated"):
            self.value = None
        elif self.type == "number":
            if value is not None and (
                isinstance(value, bool)
                or not isinstance(value, (int, float))
                or not math.isfinite(value)
            ):
                raise ValueError("Enter a finite number.")
        elif self.type == "checkbox":
            if not isinstance(value, bool):
                raise ValueError("Checkbox values must be true or false.")
        elif self.type == "multi_select":
            if not isinstance(value, list) or any(v not in self.options for v in value):
                raise ValueError("Choose values from the available options.")
        elif value not in (None, ""):
            if not isinstance(value, str) or len(value) > 10000:
                raise ValueError("Use a text value of up to 10000 characters.")
            if self.type in ("single_select", "status") and value not in self.options:
                raise ValueError("Choose an available option.")
            if self.type == "date":
                date.fromisoformat(value)
            if self.type == "email" and not re.fullmatch(r"[^\s@]+@[^\s@]+\.[^\s@]+", value):
                raise ValueError("Enter a valid email address.")
            if self.type == "url" and (
                urlparse(value).scheme not in ("http", "https") or not urlparse(value).netloc
            ):
                raise ValueError("Use an http or https URL.")
            if self.type == "media" and ("/" in value or "\\" in value or value.startswith(".")):
                raise ValueError("Choose a local page attachment.")
        return self


# Matches defaultStatusField in apps/desktop/src/editor/views/ViewToolbar.tsx, so a board an
# agent builds is coloured like one the user builds by hand.
_KNOWN_COLORS: dict[str, PropertyColor] = {
    "to do": "gray",
    "todo": "gray",
    "backlog": "gray",
    "open": "blue",
    "new": "blue",
    "in progress": "yellow",
    "doing": "yellow",
    "review": "orange",
    "blocked": "red",
    "done": "green",
    "shipped": "green",
    "complete": "green",
    "completed": "green",
    "cancelled": "default",
    "canceled": "default",
    "high": "red",
    "urgent": "red",
    "medium": "orange",
    "normal": "orange",
    "low": "blue",
}
_PALETTE: list[PropertyColor] = [
    "blue",
    "orange",
    "green",
    "purple",
    "pink",
    "brown",
    "yellow",
    "red",
    "gray",
]
_ISO_DATE = re.compile(r"\d{4}-\d{2}-\d{2}$")


def _key(name: str) -> str:
    return name.strip().casefold()


def _slug(name: str, taken: set[str]) -> str:
    base = re.sub(r"[^a-z0-9]+", "_", name.casefold()).strip("_")[:90] or "field"
    candidate, suffix = base, 2
    while candidate in taken:
        candidate, suffix = f"{base}_{suffix}", suffix + 1
    return candidate


def _colors(options: list[str]) -> dict[str, PropertyColor]:
    """A pure function of the options, so cards proposed in separate calls agree."""
    return {
        option: _KNOWN_COLORS.get(_key(option), _PALETTE[index % len(_PALETTE)])
        for index, option in enumerate(options)
    }


def _infer(name: str, value: Any, options: list[str]) -> PropertyKind:
    if isinstance(value, bool):
        return "checkbox"
    if isinstance(value, (int, float)):
        return "number"
    if isinstance(value, list):
        return "multi_select"
    if options:
        return "status" if _key(name) == "status" else "single_select"
    if isinstance(value, str) and _ISO_DATE.match(value.strip()):
        return "date"
    return "text"


def from_compact(
    items: list[dict[str, Any]], existing: list[PageProperty] | None = None
) -> list[PageProperty]:
    """The flat `{name, type, options, value}` shape a model writes, as real properties.

    Deliberately forgiving: a small local model gets ids, colours and option lists wrong far
    more often than it gets the user's intent wrong. Anything still invalid afterwards raises
    from PageProperty, whose messages are already written for the model to read and retry.
    """
    known = {_key(p.name): p for p in existing or []}
    taken = {p.id for p in existing or []}
    out: list[PageProperty] = []
    for item in items:
        if not isinstance(item, dict) or not str(item.get("name", "")).strip():
            raise ValueError("Every property needs a name.")
        name = str(item["name"]).strip()
        prior = known.get(_key(name))
        value = item.get("value", None)
        options = [str(o).strip() for o in item.get("options") or []]
        if prior:  # a board's options live on its cards; never narrow them from one card
            options = list(dict.fromkeys([*prior.options, *options]))
        named = str(item.get("type") or "").strip() or (prior.type if prior else "")
        kind = (
            cast(PropertyKind, named)
            if named in get_args(PropertyKind)
            else _infer(name, value, options)
        )
        # A value outside the options is the model's commonest mistake, and it means it wants
        # that column to exist — adding it beats refusing the whole proposal.
        for candidate in value if isinstance(value, list) else [value]:
            if kind in ("status", "single_select", "multi_select") and isinstance(candidate, str):
                if candidate.strip() and candidate.strip() not in options:
                    options.append(candidate.strip())
        if kind == "checkbox" and isinstance(value, str):
            value = value.strip().casefold() == "true"
        if kind == "number" and isinstance(value, str):
            try:
                value = float(value) if "." in value else int(value)
            except ValueError:
                pass
        if kind == "multi_select" and value is not None and not isinstance(value, list):
            value = [value]
        identifier = prior.id if prior else _slug(name, taken)
        taken.add(identifier)
        colors = {**_colors(options), **(prior.colors if prior else {})}
        out.append(
            PageProperty(
                id=identifier, name=name, type=kind, options=options, colors=colors, value=value
            )
        )
    return out


def merge(existing: list[PageProperty], incoming: list[PageProperty]) -> list[PageProperty]:
    """Incoming wins per field, by name; fields nobody mentioned are left exactly as they are."""
    by_name = {_key(p.name): p for p in incoming}
    out = [by_name.pop(_key(p.name), p) for p in existing]
    return out + list(by_name.values())


def merge_definitions(children: list[list[PageProperty]]) -> list[PageProperty]:
    """The board's shared field definitions, from the cards that already exist.

    The Python mirror of `mergeFields` in apps/desktop/src/editor/views/collection.ts: same
    union of options, same first-definition-wins colours, values dropped.
    """
    merged: dict[str, PageProperty] = {}
    for page in children:
        for prop in page:
            current = merged.get(_key(prop.name))
            if current is None:
                merged[_key(prop.name)] = prop.model_copy(
                    update={
                        "options": list(prop.options),
                        "colors": dict(prop.colors),
                        "value": False
                        if prop.type == "checkbox"
                        else []
                        if prop.type == "multi_select"
                        else None,
                    }
                )
                continue
            for option in prop.options:
                if option not in current.options:
                    current.options.append(option)
            current.colors = {**prop.colors, **current.colors}
    return list(merged.values())


def parse_properties(raw: Any) -> list[PageProperty]:
    """A page's stored properties, skipping any entry that no longer validates."""
    out: list[PageProperty] = []
    for item in raw if isinstance(raw, list) else []:
        try:
            out.append(PageProperty.model_validate(item))
        except ValueError:
            continue
    return out


def _shown(value: Any, limit: int = 80) -> str:
    if isinstance(value, bool):
        return "true" if value else "false"
    text = str(value).strip()
    return text if len(text) <= limit else text[: limit - 1] + "…"


def compact_values(props: list[PageProperty], limit: int = 8) -> dict[str, Any]:
    """`{name: value}` for the filled fields of one page, capped for a tool listing."""
    out: dict[str, Any] = {}
    for prop in props:
        if len(out) >= limit:
            break
        value = prop.value
        if value is None or value == "" or value == [] or prop.type in ("created", "updated"):
            continue
        if isinstance(value, list):
            out[prop.name] = [_shown(v) for v in value]
        elif isinstance(value, (bool, int, float)):
            out[prop.name] = value
        else:
            out[prop.name] = _shown(value)
    return out


def board_summary(
    definitions: list[list[PageProperty]], cards: list[list[PageProperty]], *, top: int = 20
) -> list[dict[str, Any]]:
    """What a model needs to add a card that fits a board: each field's name, type and
    options (merged as `merge_definitions` does), and how often each value is used."""
    out: list[dict[str, Any]] = []
    for field in merge_definitions(definitions):
        counts: dict[str, int] = {}
        empty = 0
        for card in cards:
            prop = next((p for p in card if _key(p.name) == _key(field.name)), None)
            value = prop.value if prop is not None else None
            if value is None or value == "" or value == []:
                empty += 1
                continue
            for item in value if isinstance(value, list) else [value]:
                shown = _shown(item, 60)
                counts[shown] = counts.get(shown, 0) + 1
        entry: dict[str, Any] = {"name": field.name, "type": field.type}
        if field.options:
            entry["options"] = list(field.options)
        if field.type not in ("created", "updated"):
            ranked = sorted(counts.items(), key=lambda kv: -kv[1])
            entry["value_counts"] = dict(ranked[:top])
            if len(ranked) > top:
                entry["other_values"] = len(ranked) - top
            if empty:
                entry["empty"] = empty
        out.append(entry)
    return out
