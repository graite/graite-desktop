"""Chat on another of your computers: an HTTP transport that sends the request through the
sync connection instead of a socket, so `models/providers.py` talks to that computer's
engine exactly as it talks to the one on this computer (streaming, tools, usage)."""

from __future__ import annotations

from collections.abc import AsyncIterator
from typing import Any

import httpx

from graite.compute.service import CallFailed, Compute, Reply

# Where a provider thinks it is talking to; never resolved, the transport takes the request.
DEVICE_URL = "http://device.graite.invalid/v1"


class _Stream(httpx.AsyncByteStream):
    def __init__(self, reply: Reply) -> None:
        self._reply = reply

    async def __aiter__(self) -> AsyncIterator[bytes]:
        try:
            async for piece in self._reply.pieces():
                yield piece
        except CallFailed as exc:
            raise httpx.ReadError(str(exc)) from exc

    async def aclose(self) -> None:
        await self._reply.close()


class DeviceTransport(httpx.AsyncBaseTransport):
    def __init__(self, compute: Compute, device_id: str, model: str = "") -> None:
        # `model` names one of that computer's models; empty leaves the choice to it.
        self._compute, self._device, self._model = compute, device_id, model

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        if not request.url.path.endswith("/chat/completions"):
            return httpx.Response(404, request=request)
        body = await request.aread()
        try:
            reply = await self._compute.call(self._device, "chat", {"model": self._model}, body)
        except ValueError as exc:  # not connected, switched off there, no model there
            return httpx.Response(503, json={"error": {"message": str(exc)}}, request=request)
        head: dict[str, Any] = reply.head
        return httpx.Response(
            int(head.get("status") or 502),
            headers={"content-type": str(head.get("content_type") or "application/json")},
            stream=_Stream(reply),
            request=request,
        )
