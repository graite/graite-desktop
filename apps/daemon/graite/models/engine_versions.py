"""Ordering engine versions, and what the newest-build check reports (no imports of the
installer, so both `engines` and `engine_releases` can use it)."""

from __future__ import annotations

import re

from pydantic import BaseModel


class NewestBuild(BaseModel):
    """What the geek-mode "newest build" row shows."""

    version: str
    published_at: str = ""
    prerelease: bool = False
    url: str = ""  # the release page, for its notes
    newer: bool = False  # newer than what is installed (or than the pinned build)
    tested: bool = False  # the build this Graite release was tested with


def version_key(version: str) -> tuple[int, ...]:
    """`b12359` → (12359,), `v0.8.54` → (0, 8, 54): enough to order one engine's releases."""
    return tuple(int(part) for part in re.findall(r"\d+", version))


def is_newer(candidate: str, than: str | None) -> bool:
    if not than:
        return True
    a, b = version_key(candidate), version_key(than)
    return a > b if a and b else candidate != than
