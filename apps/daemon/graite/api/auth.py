"""Bearer-token gate for every HTTP route and the events WebSocket."""

from __future__ import annotations

import hmac

from fastapi import Request, WebSocket
from fastapi.responses import JSONResponse
from starlette.middleware.base import BaseHTTPMiddleware, RequestResponseEndpoint
from starlette.responses import Response

from graite.vault.request_context import REQUEST_HEADER, current_request_id


def _token_matches(presented: str | None, expected: str) -> bool:
    return presented is not None and hmac.compare_digest(presented, expected)


class BearerAuthMiddleware(BaseHTTPMiddleware):
    def __init__(self, app, token: str) -> None:  # type: ignore[no-untyped-def]
        super().__init__(app)
        self._token = token

    async def dispatch(self, request: Request, call_next: RequestResponseEndpoint) -> Response:
        if request.method == "OPTIONS":  # CORS preflight carries no credentials by design
            return await call_next(request)
        header = request.headers.get("authorization", "")
        presented = header.removeprefix("Bearer ").strip() if header.startswith("Bearer ") else None
        if not _token_matches(presented, self._token):
            return JSONResponse({"detail": "unauthorized"}, status_code=401)
        token = current_request_id.set(request.headers.get(REQUEST_HEADER) or None)
        try:
            return await call_next(request)
        finally:
            current_request_id.reset(token)


def websocket_authorized(websocket: WebSocket, token: str) -> bool:
    """Browsers cannot set headers on WebSockets, so accept `?token=` as well."""
    header = websocket.headers.get("authorization", "")
    presented = header.removeprefix("Bearer ").strip() if header.startswith("Bearer ") else None
    if presented is None:
        presented = websocket.query_params.get("token")
    return _token_matches(presented, token)
