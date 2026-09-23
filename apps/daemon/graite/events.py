"""In-process event bus fanned out to WebSocket subscribers.

`publish` is called from the event loop and from worker threads (fileops and the indexer run
in `asyncio.to_thread`), so a thread hands the message to the loop instead of touching the
queues directly: `put_nowait` off-loop neither wakes the selector nor is it thread-safe.
"""

from __future__ import annotations

import asyncio
import json
import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Any

log = logging.getLogger("graite.events")


class EventBus:
    def __init__(self) -> None:
        self._subscribers: set[asyncio.Queue[str]] = set()
        self._loop: asyncio.AbstractEventLoop | None = None

    def bind(self, loop: asyncio.AbstractEventLoop) -> None:
        self._loop = loop

    def publish(self, type_: str, data: dict[str, Any] | None = None) -> None:
        message = json.dumps({"type": type_, "data": data or {}})
        try:
            running: asyncio.AbstractEventLoop | None = asyncio.get_running_loop()
        except RuntimeError:
            running = None
        if running is None and self._loop is not None:
            try:
                self._loop.call_soon_threadsafe(self._deliver, message)
            except RuntimeError:
                pass  # the loop is closing; the event is no longer interesting
            return
        self._deliver(message)

    def _deliver(self, message: str) -> None:
        for queue in list(self._subscribers):
            try:
                queue.put_nowait(message)
            except asyncio.QueueFull:
                # A subscriber that cannot keep up must not break a vault write.
                log.warning("dropping an event for a full subscriber queue")

    @asynccontextmanager
    async def subscribe(self) -> AsyncIterator[asyncio.Queue[str]]:
        queue: asyncio.Queue[str] = asyncio.Queue(maxsize=1000)
        self._subscribers.add(queue)
        try:
            yield queue
        finally:
            self._subscribers.discard(queue)

    @property
    def subscriber_count(self) -> int:
        return len(self._subscribers)
