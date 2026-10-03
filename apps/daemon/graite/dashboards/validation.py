"""Checks shared by direct and proposed dashboard writes (D72, D74)."""

from __future__ import annotations

import re

from graite.dashboards import paths as dash_paths

_EXTERNAL = re.compile(
    r"<(?:script|link|img|iframe)\b[^>]*\b(?:src|href)\s*=\s*[\"']?\s*(?:https?:)?//",
    re.I,
)


def check_html(text: str) -> None:
    """Raise with user-facing words when `text` cannot be a local dashboard."""
    if _EXTERNAL.search(text):
        raise ValueError(
            "Dashboards have no network: do not load scripts, styles or images from URLs. "
            "ECharts and window.graite are already there; put your own code inline."
        )
    if "<" not in text:
        raise ValueError("html must be an HTML document.")
    if len(text.encode("utf-8")) > dash_paths.MAX_BYTES:
        raise ValueError("A dashboard can be at most 1 MB of HTML.")
