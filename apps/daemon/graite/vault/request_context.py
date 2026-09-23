"""Per-request id, taken from the `X-Graite-Request` header and echoed in events.

Clients use it to recognise the events their own writes produce (see Workspace.tsx).
`asyncio.to_thread` propagates the context, so fileops' sync helpers see it too.
"""

from __future__ import annotations

from contextvars import ContextVar

REQUEST_HEADER = "x-graite-request"

current_request_id: ContextVar[str | None] = ContextVar("graite_request_id", default=None)
