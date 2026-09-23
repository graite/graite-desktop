"""When the user talks with the assistant, background model work steps aside.

The `model` lane runs one job at a time and a local model serves one request at a time, so
a background loop that happens to be running would make the user wait behind it. Jobs that
mark their payload `preemptible` are cancelled and queued again for later; while a session
holds the gate the lane does not claim new work.
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from datetime import UTC, datetime, timedelta
from typing import Any

log = logging.getLogger("graite.assistant")
RETRY_AFTER = timedelta(minutes=10)


class ForegroundGate:
    def __init__(self, worker: Any, queue: Any) -> None:
        self.worker = worker
        self.queue = queue
        self.clear = asyncio.Event()
        self.clear.set()
        self._holders = 0

    @property
    def active(self) -> bool:
        return self._holders > 0

    async def preempt(self, wait: float = 5.0) -> int:
        """Cancel running preemptible jobs and queue them again for later. Returns how many."""
        victims = [
            (task, ctx)
            for task, ctx in list(self.worker.running.values())
            if ctx.job.payload.get("preemptible")
        ]
        for task, ctx in victims:
            ctx.cancelled.set()
            task.cancel()
        if victims:
            await asyncio.wait([task for task, _ in victims], timeout=wait)
        later = (datetime.now(UTC) + RETRY_AFTER).isoformat()
        for _, ctx in victims:
            job = ctx.job
            self.queue.enqueue(
                job.kind,
                job.payload,
                key=job.key,
                page_path=job.page_path,
                priority=job.priority,
                run_at=later,
                max_attempts=1,
            )
            log.info("preempted %s job %s for a live conversation", job.kind, job.id)
        return len(victims)

    @asynccontextmanager
    async def hold(self) -> AsyncIterator[None]:
        self._holders += 1
        self.clear.clear()
        try:
            await self.preempt()
            yield
        finally:
            self._holders -= 1
            if self._holders == 0:
                self.clear.set()
                self.queue.wake.set()
