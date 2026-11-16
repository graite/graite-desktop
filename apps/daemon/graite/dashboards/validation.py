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


_LIGHT_ONLY = re.compile(
    r"background(?:-color)?\s*:\s*(?:#fff(?:fff)?\b|white\b|rgba?\(\s*255\s*,\s*255\s*,\s*255\s*[,)])",
    re.I,
)


def check_theme(text: str) -> None:
    """Raise when a proposed dashboard paints a white background, which stays white in dark
    mode. Only proposals are checked: a person editing the file may want exactly that."""
    if _LIGHT_ONLY.search(text):
        raise ValueError(
            "This dashboard sets a white background, which stays white in dark mode. Leave the "
            "page background unset (it is transparent) and use var(--graite-bg), "
            "var(--graite-accent) and var(--graite-border) for surfaces, var(--graite-fg) and "
            "var(--graite-muted) for text."
        )
