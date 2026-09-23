"""Explicit instruction links become sources, subject to the resolved page scope."""

from __future__ import annotations

import re
from typing import Any

from graite.retrieval.context import Source
from graite.retrieval.scope import ResolvedScope
from graite.vault import frontmatter
from graite.vault.instructions import safe_file


def linked_sources(state: Any, instructions: str, scope: ResolvedScope) -> list[Source]:
    sources = []
    seen: set[str] = set()
    for target in re.findall(r"\[\[([^\]|]+)(?:\|[^\]]*)?\]\]", instructions):
        target = target.split("#", 1)[0].strip().removesuffix("/page.md")
        matches = [p for p, title in scope.titles.items() if title == target]
        path = target if scope.contains(target) else matches[0] if len(matches) == 1 else None
        if not path or not scope.contains(path) or path in seen:
            continue
        seen.add(path)
        try:
            _, body = frontmatter.split(
                safe_file(state.settings.vault, path + "/page.md").read_text()
            )
        except (OSError, ValueError):
            continue
        sources.append(
            Source(0, "page", path, scope.ids.get(path), scope.titles[path], [], body[:12000])
        )
        if len(sources) >= 12:
            break
    return sources
