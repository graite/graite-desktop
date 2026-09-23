"""Refuse a `graite:` fence the editor would not recognise, while it is still a proposal.

`codeBlock` in packages/md-convert/src/blocks.ts turns any fence it cannot parse into a plain
`rawMarkdown` block. That is right for a human who pasted something odd, and wrong for a model:
one invented key and the board the user asked for silently becomes grey text. The checks below
are the same ones, in the same order, so the answer is the same on both sides — and both read
`fixtures/view-cases.json` in their tests so neither can drift alone.

The parser is TypeScript and this is Python because the daemon has to hold the line for MCP
clients and scheduled runs, where no webview is in the path at all, and because the packaged
daemon has no Node to run the real thing.
"""

from __future__ import annotations

from typing import Any, get_args

import yaml

from graite.vault.layouts import FENCES
from graite.vault.properties import PageProperty, PropertyKind, from_compact

VIEW_KINDS = ("table", "kanban", "list")
VIEW_KEYS = ("view", "group", "field", "show", "settings")


def _names(value: Any) -> bool:
    return isinstance(value, list) and all(isinstance(x, str) and x.strip() for x in value)


def _fields(items: list[dict[str, Any]]) -> list[PageProperty]:
    return from_compact(
        [
            {
                **item,
                "value": False
                if item.get("type") == "checkbox"
                else []
                if item.get("type") == "multi_select"
                else None,
            }
            for item in items
        ]
    )


def _check_view(value: dict[str, Any]) -> str | None:
    unknown = [k for k in value if k not in VIEW_KEYS]
    if unknown:
        # `field` is the legacy spelling of `group`; accepted, never suggested.
        return (
            f"{unknown[0]!r} is not a key of a graite:view fence. "
            "Use view, group, show or settings."
        )
    if value.get("view") not in VIEW_KINDS:
        return (
            f"A graite:view fence needs view: {' , '.join(VIEW_KINDS)}. Got {value.get('view')!r}."
        )
    group = value.get("group", value.get("field"))
    if group is not None and not isinstance(group, str):
        return "group: must be the name of one property, as text."
    show = value.get("show")
    if show is not None and not _names(show):
        if not isinstance(show, dict) or not all(
            k in VIEW_KINDS and _names(v) for k, v in show.items()
        ):
            return "show: must be a list of property names, or a view kind mapped to one."
    settings = value.get("settings")
    if settings is not None and not isinstance(settings, dict):
        return "settings: must be a mapping."
    if isinstance(settings, dict) and "fields" in settings:
        try:
            fields = settings["fields"]
            if not isinstance(fields, list) or not all(isinstance(f, dict) for f in fields):
                raise ValueError("Use a list of property definitions.")
            for f in fields:
                if not isinstance(f.get("name"), str) or not 1 <= len(f["name"].strip()) <= 100:
                    raise ValueError("Each field needs a name of up to 100 characters.")
                if f.get("type") not in get_args(PropertyKind):
                    raise ValueError("Each field needs a supported property type.")
                if "options" in f and (
                    not _names(f["options"])
                    or len(f["options"]) > 100
                    or any(len(o) > 100 for o in f["options"])
                ):
                    raise ValueError(
                        "Use up to 100 nonempty text options, each up to 100 characters."
                    )
            _fields(fields)
        except (ValueError, TypeError, KeyError) as exc:
            return f"Invalid settings.fields: {exc}"
    return None


def view_fields(markdown: str) -> list[PageProperty]:
    """Definitions keep a board usable before its first card exists."""
    fields: list[PageProperty] = []
    for part in FENCES.findall(markdown):
        if not part.startswith("```graite:view\n"):
            continue
        try:
            value = yaml.safe_load(part.split("\n", 1)[1].rsplit("```", 1)[0])
            if isinstance(value, dict) and isinstance(value.get("settings"), dict):
                raw = value["settings"].get("fields", [])
                if isinstance(raw, list) and all(isinstance(f, dict) for f in raw):
                    fields.extend(_fields(raw))
        except (ValueError, TypeError, KeyError, yaml.YAMLError):
            continue
    return fields


def _check_columns(value: dict[str, Any]) -> str | None:
    if set(value) != {"columns"} or not isinstance(value.get("columns"), list):
        return "A graite:columns fence holds one key, columns:, a list of Markdown strings."
    columns = value["columns"]
    if not 2 <= len(columns) <= 4 or not all(isinstance(c, str) for c in columns):
        return "A graite:columns fence needs between 2 and 4 columns of Markdown."
    return None


def check_fences(markdown: str) -> str | None:
    """The first reason this body would not render as written, or None.

    The message is what the model reads and retries against, so it names the offending key.
    """
    for index, part in enumerate(FENCES.split(markdown)):
        if index % 2 == 0:
            continue
        header, _, rest = part.partition("\n")
        lang = header[3:].strip()
        if lang not in ("graite:view", "graite:columns"):
            continue
        try:
            value = yaml.safe_load(rest.rsplit("```", 1)[0])
        except yaml.YAMLError as exc:
            return f"The {lang} fence is not valid YAML: {exc}"
        if not isinstance(value, dict):
            return f"A {lang} fence holds a YAML mapping of keys to values."
        problem = _check_view(value) if lang == "graite:view" else _check_columns(value)
        if problem:
            return problem
    return None
