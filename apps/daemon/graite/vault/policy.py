"""Effective AI settings for a page: the cascade of vault config, AGENTS.md and frontmatter.

Keys (docs/vault-format.md §2): `instructions`, `autonomy`, `auto_apply_kinds`, `cloud`,
`skills`, `model`. Instructions accumulate root to leaf. Two values are locks that a
descendant cannot lift: `autonomy: none` and `cloud: local-only`. Everything else takes
the nearest value. Every effective value remembers which file set it.
"""

from __future__ import annotations

import json
import sqlite3
import tomllib
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from graite.vault import frontmatter
from graite.vault.instructions import safe_file
from graite.vault.paths import GRAITE_DIR, validate_rel

KEYS = ("instructions", "autonomy", "auto_apply_kinds", "cloud", "skills", "model", "ai_scope")
AUTONOMY = ("auto-apply", "propose", "none")  # most to least permissive
CLOUD = ("allowed", "local-only")
AUTO_APPLY_KINDS = ("append", "create", "edit", "properties", "delete")
DEFAULTS: dict[str, Any] = {"autonomy": "propose", "cloud": "allowed"}
MAX_INSTRUCTIONS = 8000
POLICY_FILE = "AGENTS.md"


def validate(values: dict[str, Any]) -> dict[str, Any]:
    """Clean a settings payload; `None` means "remove the key". Raises ValueError."""
    clean: dict[str, Any] = {}
    for key, value in values.items():
        if key not in KEYS:
            raise ValueError(f"'{key}' is not an AI setting.")
        if value is None:
            clean[key] = None
            continue
        if key == "instructions":
            if not isinstance(value, str):
                raise ValueError("Instructions must be text.")
            if len(value) > MAX_INSTRUCTIONS:
                raise ValueError("Keep page instructions under 8,000 characters.")
            clean[key] = value.strip() or None
        elif key == "ai_scope":
            if value not in ("page", "subtree"):
                raise ValueError("Access must be page or subtree.")
            clean[key] = value
        elif key == "autonomy":
            if value not in AUTONOMY:
                raise ValueError("Autonomy must be auto-apply, propose or none.")
            clean[key] = value
        elif key == "cloud":
            if value not in CLOUD:
                raise ValueError("Cloud must be allowed or local-only.")
            clean[key] = value
        elif key == "auto_apply_kinds":
            if not isinstance(value, list) or any(v not in AUTO_APPLY_KINDS for v in value):
                raise ValueError(
                    "Auto-apply kinds may only contain append, create, edit, properties and delete."
                )
            clean[key] = sorted(set(value), key=AUTO_APPLY_KINDS.index)
        elif key == "skills":
            if not isinstance(value, list) or not all(
                isinstance(v, str) and v.strip() for v in value
            ):
                raise ValueError("Skills must be a list of skill names.")
            clean[key] = [v.strip() for v in value][:100]
        elif key == "model":
            if not isinstance(value, str):
                raise ValueError("Model must be a catalog id or provider model name.")
            clean[key] = value.strip() or None
    return clean


@dataclass
class Effective:
    values: dict[str, Any] = field(default_factory=lambda: dict(DEFAULTS))
    sources: dict[str, str] = field(default_factory=lambda: {k: "default" for k in DEFAULTS})
    instructions: list[dict[str, str]] = field(default_factory=list)
    agents_md: list[dict[str, str]] = field(default_factory=list)
    # Every file that set something, root first: {"source", "values"} (instructions included
    # as a flag, not the text). What the settings dialog draws as the cascade.
    layers: list[dict[str, Any]] = field(default_factory=list)

    @property
    def cloud_allowed(self) -> bool:
        return str(self.values.get("cloud", "allowed")) != "local-only"

    @property
    def autonomy(self) -> str:
        return str(self.values.get("autonomy", "propose"))

    def as_dict(self) -> dict[str, Any]:
        return {
            "values": self.values,
            "sources": self.sources,
            "instructions": self.instructions,
            "layers": self.layers,
        }


def _apply(effective: Effective, meta: dict[str, Any], source: str) -> None:
    layer: dict[str, Any] = {}
    for key in KEYS:
        if key in ("model", "ai_scope") or key not in meta or meta[key] is None:
            continue
        value = meta[key]
        if key == "instructions":
            if isinstance(value, str) and value.strip():
                effective.instructions.append({"source": source, "text": value.strip()})
                layer["instructions"] = True
            continue
        layer[key] = value
        if key == "autonomy":
            if value not in AUTONOMY:
                continue
            if effective.values.get("autonomy") == "none":
                continue  # "no AI updates" set above cannot be lifted below
        if key == "cloud":
            if value not in CLOUD:
                continue
            if effective.values.get("cloud") == "local-only":
                continue
        effective.values[key] = value
        effective.sources[key] = source
    if layer:
        effective.layers.append({"source": source, "values": layer})


def _mark_layer(effective: Effective, source: str, key: str, value: Any) -> None:
    for layer in effective.layers:
        if layer["source"] == source:
            layer["values"][key] = value
            return
    effective.layers.append({"source": source, "values": {key: value}})


class Resolver:
    """Resolves many pages cheaply: AGENTS.md files and page frontmatter are cached."""

    def __init__(self, vault: Path, conn: sqlite3.Connection) -> None:
        self.vault = vault
        self.conn = conn
        self._agents: dict[str, tuple[dict[str, Any], str] | None] = {}
        self._pages: dict[str, dict[str, Any]] | None = None
        self._vault_defaults: dict[str, Any] | None = None

    def vault_defaults(self) -> dict[str, Any]:
        if self._vault_defaults is None:
            self._vault_defaults = {}
            config = self.vault / GRAITE_DIR / "config.toml"
            if config.is_file():
                try:
                    data = tomllib.loads(config.read_text(encoding="utf-8")).get("agents", {})
                    if isinstance(data, dict):
                        self._vault_defaults = validate(
                            {k: v for k, v in data.items() if k in KEYS}
                        )
                except (OSError, ValueError, tomllib.TOMLDecodeError):
                    self._vault_defaults = {}
        return self._vault_defaults

    def agents_md(self, folder: str) -> tuple[dict[str, Any], str] | None:
        if folder not in self._agents:
            relative = f"{folder}/{POLICY_FILE}" if folder else POLICY_FILE
            path = safe_file(self.vault, relative)
            entry = None
            if path.is_file():
                try:
                    with path.open(encoding="utf-8") as handle:
                        meta, body = frontmatter.split(handle.read(16000))
                    entry = (meta, body)
                except (OSError, ValueError):
                    entry = None
                except Exception:  # noqa: BLE001 - malformed YAML front matter
                    entry = ({}, path.read_text(encoding="utf-8")[:16000])
            self._agents[folder] = entry
        return self._agents[folder]

    def page_meta(self, path: str) -> dict[str, Any] | None:
        if self._pages is None:
            self._pages = {}
            for row in self.conn.execute("SELECT path, frontmatter_json FROM pages"):
                try:
                    self._pages[row["path"]] = json.loads(row["frontmatter_json"])
                except ValueError:
                    continue
        return self._pages.get(path)

    def local_only_roots(self) -> list[str]:
        """Folders and pages that keep everything below them off cloud providers.

        Reading the two files that can set `cloud` (vault config, AGENTS.md, page frontmatter)
        once per subtree replaces resolving every page's full cascade on every chat turn.
        """
        if self.vault_defaults().get("cloud") == "local-only":
            return [""]
        roots: list[str] = []
        for row in self.conn.execute("SELECT path, frontmatter_json FROM pages ORDER BY path"):
            path = str(row["path"])
            if any(path == r or path.startswith(r + "/") for r in roots):
                continue
            meta = self.page_meta(path) or {}
            if meta.get("cloud") == "local-only":
                roots.append(path)
                continue
            agents = self.agents_md(path)
            if agents is not None and agents[0].get("cloud") == "local-only":
                roots.append(path)
        root_agents = self.agents_md("")
        if root_agents is not None and root_agents[0].get("cloud") == "local-only":
            return [""]
        return roots

    def resolve(
        self, page_path: str | None, *, leaf_meta: dict[str, Any] | None = None
    ) -> Effective:
        effective = Effective()
        defaults = self.vault_defaults()
        if defaults:
            _apply(effective, defaults, "vault")
        parts = validate_rel(page_path).split("/") if page_path else []
        for depth in range(len(parts) + 1):
            folder = "/".join(parts[:depth])
            agents = self.agents_md(folder)
            if agents is not None:
                meta, body = agents
                relative = f"{folder}/{POLICY_FILE}" if folder else POLICY_FILE
                effective.agents_md.append({"path": relative, "text": body})
                if body.strip():
                    effective.instructions.append({"source": relative, "text": body.strip()})
                _apply(effective, meta, relative)
                if body.strip():
                    _mark_layer(effective, relative, "instructions", True)
            if depth == 0:
                continue
            page_meta: dict[str, Any] | None = (
                leaf_meta
                if depth == len(parts) and leaf_meta is not None
                else self.page_meta(folder)
            )
            if page_meta and (depth == len(parts) or page_meta.get("ai_scope") != "page"):
                _apply(effective, page_meta, folder)
        return effective


def resolve(
    vault: Path,
    conn: sqlite3.Connection,
    page_path: str | None,
    *,
    leaf_meta: dict[str, Any] | None = None,
) -> Effective:
    return Resolver(vault, conn).resolve(page_path, leaf_meta=leaf_meta)


def resolve_many(vault: Path, conn: sqlite3.Connection, paths: list[str]) -> dict[str, Effective]:
    resolver = Resolver(vault, conn)
    return {path: resolver.resolve(path) for path in paths}
