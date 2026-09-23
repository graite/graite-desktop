"""Which pages a conversation may use, after permissions.

Three scopes share one resolver: `page` (one page), `folder` (a page and its subtree) and
`vault` (every page, minus excluded subtrees). Pages whose effective policy is
`cloud: local-only` are dropped when the answer would go to a cloud provider, and listed so
the answer can say so.
"""

from __future__ import annotations

import json
import sqlite3
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from graite.vault.paths import validate_rel
from graite.vault.policy import Effective, Resolver

KINDS = ("page", "folder", "vault")


@dataclass
class Scope:
    kind: str = "vault"
    roots: list[str] = field(default_factory=list)
    excluded: list[str] = field(default_factory=list)

    @classmethod
    def parse(cls, value: Any, *, default_root: str | None = None) -> Scope:
        if isinstance(value, str):
            value = json.loads(value) if value.strip() else {}
        if not isinstance(value, dict):
            value = {}
        kind = str(value.get("kind") or ("folder" if default_root else "vault"))
        if kind not in KINDS:
            raise ValueError("Scope kind must be page, folder or vault.")
        roots = [validate_rel(str(r)) for r in value.get("roots") or []]
        if kind != "vault" and not roots:
            if default_root is None:
                raise ValueError("A page or folder scope needs a root page.")
            roots = [validate_rel(default_root)]
        if kind == "page":
            roots = roots[:1]
        excluded = [validate_rel(str(r)) for r in value.get("excluded") or []]
        return cls(kind, roots, excluded)

    def to_dict(self) -> dict[str, Any]:
        return {"kind": self.kind, "roots": self.roots, "excluded": self.excluded}

    def label(self, titles: dict[str, str] | None = None) -> str:
        titles = titles or {}
        if self.kind == "vault":
            return "your vault" if not self.roots and not self.excluded else "the selected pages"
        name = titles.get(self.roots[0], self.roots[0]) if self.roots else "this page"
        return f"{name} and its subpages" if self.kind == "folder" else name


@dataclass
class ResolvedScope:
    scope: Scope
    paths: list[str]
    titles: dict[str, str]
    ids: dict[str, str]
    policy: Effective
    resolver: Resolver | None = None
    excluded_local_only: list[str] = field(default_factory=list)
    excluded_user: int = 0
    all_pages: bool = False

    def policy_for(self, path: str) -> Effective:
        """The full cascade for one page, resolved on demand."""
        if self.resolver is None:
            return self.policy
        return self.resolver.resolve(path)

    def contains(self, path: str) -> bool:
        return path in self.titles and path not in set(self.excluded_local_only)

    @property
    def path_set(self) -> set[str]:
        return set(self.paths)


def _under(path: str, roots: list[str]) -> bool:
    return any(path == r or path.startswith(r + "/") for r in roots)


def resolve(
    conn: sqlite3.Connection, vault: Path, scope: Scope, *, cloud_provider: bool
) -> ResolvedScope:
    rows = conn.execute("SELECT path, title, id FROM pages ORDER BY path").fetchall()
    titles = {r["path"]: r["title"] for r in rows}
    ids = {r["path"]: r["id"] for r in rows}
    if scope.kind == "page":
        root = scope.roots[0]
        if root not in titles:
            raise FileNotFoundError(root)
        selected = [root]
    elif scope.kind == "folder":
        for root in scope.roots:
            if root not in titles:
                raise FileNotFoundError(root)
        selected = [p for p in titles if _under(p, scope.roots)]
    else:
        selected = [p for p in titles if (not scope.roots or _under(p, scope.roots))]
    excluded_user = 0
    if scope.excluded:
        kept = [p for p in selected if not _under(p, scope.excluded)]
        excluded_user = len(selected) - len(kept)
        selected = kept
    resolver = Resolver(vault, conn)
    root_policy = resolver.resolve(
        scope.roots[0] if scope.kind != "vault" and scope.roots else None
    )
    excluded_local_only: list[str] = []
    if cloud_provider:
        excluded_local_only = [p for p in selected if not resolver.resolve(p).cloud_allowed]
        denied = set(excluded_local_only)
        selected = [p for p in selected if p not in denied]
    return ResolvedScope(
        scope=scope,
        paths=selected,
        titles={p: titles[p] for p in selected},
        ids={p: ids[p] for p in selected},
        policy=root_policy,
        resolver=resolver,
        excluded_local_only=excluded_local_only,
        excluded_user=excluded_user,
        all_pages=len(selected) == len(titles),
    )
