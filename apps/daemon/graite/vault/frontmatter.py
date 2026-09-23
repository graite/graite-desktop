"""`page.md` frontmatter: fixed key order, ISO timestamps, uuid7 ids (vault-format §2)."""

from __future__ import annotations

import secrets
import uuid
from datetime import UTC, datetime
from typing import Any

import frontmatter as _fm
import yaml

KEY_ORDER = [
    "id",
    "title",
    "icon",
    "created",
    "updated",
    "tags",
    "order",
    "aliases",
    "autonomy",
    "auto_apply_kinds",
    "cloud",
    "instructions",
    "ai_scope",
    "skills",
    "model",
    "live",
]


class _Dumper(yaml.SafeDumper):
    """Block-style mappings, flow-style lists: `tags: [a, b]` like Obsidian writes them."""


def _represent_list(dumper: yaml.SafeDumper, data: list[Any]) -> yaml.Node:
    return dumper.represent_sequence("tag:yaml.org,2002:seq", data, flow_style=True)


_Dumper.add_representer(list, _represent_list)


def uuid7() -> str:
    ms = datetime.now(UTC).timestamp() * 1000
    value = (int(ms) << 80) | (0x7 << 76) | (secrets.randbits(12) << 64)
    value |= (0b10 << 62) | secrets.randbits(62)
    return str(uuid.UUID(int=value))


def now_iso() -> str:
    return datetime.now(UTC).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def _normalize_value(value: Any) -> Any:
    if isinstance(value, datetime):
        return value.astimezone(UTC).replace(microsecond=0).isoformat().replace("+00:00", "Z")
    return value


def split(text: str) -> tuple[dict[str, Any], str]:
    """Return (metadata, body). Body always ends with exactly one newline unless empty."""
    post = _fm.loads(text)
    meta = {k: _normalize_value(v) for k, v in post.metadata.items()}
    body = post.content.strip("\n")
    return meta, (body + "\n" if body else "")


def join(meta: dict[str, Any], body: str) -> str:
    ordered: dict[str, Any] = {}
    for key in KEY_ORDER:
        if key in meta and meta[key] is not None:
            ordered[key] = meta[key]
    for key in sorted(k for k in meta if k not in KEY_ORDER):
        if meta[key] is not None:
            ordered[key] = meta[key]
    yaml_text = yaml.dump(
        ordered,
        Dumper=_Dumper,
        sort_keys=False,
        allow_unicode=True,
        default_flow_style=False,
        width=1000,
    )
    body = body.strip("\n")
    return f"---\n{yaml_text}---\n" + (f"\n{body}\n" if body else "")


def new_meta(title: str, icon: str | None = None) -> dict[str, Any]:
    ts = now_iso()
    meta: dict[str, Any] = {"id": uuid7(), "title": title, "created": ts, "updated": ts}
    if icon:
        meta["icon"] = icon
    return meta
