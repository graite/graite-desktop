"""The HTML a dashboard frame gets: the file with ECharts and the bridge inlined (D72).

The frame is a sandboxed iframe (`allow-scripts` only, so an opaque origin) loaded from the
daemon with a one-time ticket, and its CSP allows no network at all: the dashboard's only way
to its data is `window.graite` over postMessage, answered by the app.
"""

from __future__ import annotations

import re
import secrets
import time
from dataclasses import dataclass
from functools import cache
from pathlib import Path

STATIC = Path(__file__).parent / "static"
TICKET_SECONDS = 600
# No network, no frames, no forms; inline scripts and styles only (the file and our two).
CSP = (
    "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; "
    "img-src data: blob:; font-src data:; base-uri 'none'; form-action 'none'"
)
BASE_STYLE = (
    "<style>html,body{margin:0;background:transparent;color:var(--graite-fg);"
    "font-family:var(--graite-font);font-size:14px;line-height:1.45}</style>"
)
_HEAD = re.compile(r"<head[^>]*>", re.IGNORECASE)
_HTML = re.compile(r"<html[^>]*>", re.IGNORECASE)


@cache
def _script(name: str) -> str:
    return (STATIC / name).read_text(encoding="utf-8")


def render(html: str) -> str:
    """`html` with ECharts, the bridge and base styles placed before anything it runs."""
    inject = (
        f'<meta charset="utf-8">{BASE_STYLE}'
        f"<script>{_script('echarts.min.js')}</script><script>{_script('bridge.js')}</script>"
    )
    match = _HEAD.search(html) or _HTML.search(html)
    if match:
        return html[: match.end()] + inject + html[match.end() :]
    return f"<!doctype html><html><head>{inject}</head><body>{html}</body></html>"


@dataclass
class Ticket:
    page: str
    src: str | None = None  # a dashboard file on `page`
    proposal_id: str | None = None  # or a pending proposal's HTML
    expires: float = 0.0


class Tickets:
    """Short-lived frame tickets: an iframe cannot send the bearer token, so the app asks
    for a ticket (with the token) and the frame URL carries that instead."""

    def __init__(self) -> None:
        self._tickets: dict[str, Ticket] = {}

    def issue(self, page: str, *, src: str | None = None, proposal_id: str | None = None) -> str:
        now = time.monotonic()
        self._tickets = {k: v for k, v in self._tickets.items() if v.expires > now}
        token = secrets.token_urlsafe(24)
        self._tickets[token] = Ticket(page, src, proposal_id, now + TICKET_SECONDS)
        return token

    def get(self, token: str) -> Ticket | None:
        ticket = self._tickets.get(token)
        if ticket is None or ticket.expires < time.monotonic():
            return None
        return ticket
