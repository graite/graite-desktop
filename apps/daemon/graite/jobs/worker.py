"""Lane workers: one task per lane, each claiming only its own job kinds."""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Callable, Coroutine
from dataclasses import dataclass, field
from typing import Any

from graite.jobs.queue import Job, JobQueue

log = logging.getLogger("graite.jobs")

Handler = Callable[["JobContext"], Coroutine[Any, Any, dict[str, Any] | None]]


class PermanentJobError(Exception):
    """A failure that retrying cannot fix; the job is marked failed at once."""


DEFAULT_LANES: dict[str, set[str]] = {
    "embed": {"embed", "reindex", "attachment_text"},
    "model": {
        "summarize_page",
        "agent_run",
        "workflow_run",
        "extract_entities",
        "live_note",
        "assistant_loop",
        "assistant_reflect",
        "assistant_tidy",
    },
}


@dataclass
class JobContext:
    job: Job
    queue: JobQueue
    state: Any
    cancelled: asyncio.Event = field(default_factory=asyncio.Event)

    def progress(self, **data: Any) -> None:
        self.queue.progress(self.job.id, data)


class Worker:
    def __init__(
        self,
        queue: JobQueue,
        handlers: dict[str, Handler],
        state: Any,
        lanes: dict[str, set[str]] | None = None,
        *,
        poll_seconds: float = 10.0,
        reap_seconds: float = 60.0,
    ) -> None:
        self.queue = queue
        self.handlers = handlers
        self.state = state
        self.lanes = lanes or DEFAULT_LANES
        self.poll_seconds = poll_seconds
        self.reap_seconds = reap_seconds
        self.tasks: list[asyncio.Task[None]] = []
        self.running: dict[str, tuple[asyncio.Task[Any], JobContext]] = {}
        self.idle = asyncio.Event()
        self.idle.set()
        # Called with (job, final status, error) after every job; the scheduler listens.
        self.on_finished: Callable[[Job, str, str | None], None] | None = None
        # Set while the user talks with the assistant (assistant/presence.py): the model
        # lane waits for it before claiming work.
        self.gate: asyncio.Event | None = None

    def _finished(self, job: Job, status: str, error: str | None = None) -> None:
        if self.on_finished is None:
            return
        try:
            self.on_finished(job, status, error)
        except Exception:  # noqa: BLE001
            log.exception("job finish hook failed")

    async def start(self) -> None:
        self.queue.bind(asyncio.get_running_loop())
        self.queue.recover()
        for name, kinds in self.lanes.items():
            self.tasks.append(asyncio.create_task(self._lane(name, kinds), name=f"lane:{name}"))
        self.tasks.append(asyncio.create_task(self._reaper(), name="jobs:reaper"))

    async def stop(self, grace: float = 15.0) -> None:
        for task in self.tasks:
            task.cancel()
        try:
            await asyncio.wait_for(asyncio.gather(*self.tasks, return_exceptions=True), grace)
        except TimeoutError:
            log.warning("job worker did not stop within %.0fs", grace)
        self.tasks.clear()

    async def cancel(self, job_id: str) -> bool:
        entry = self.running.get(job_id)
        if entry:
            task, ctx = entry
            ctx.cancelled.set()
            task.cancel()
            return True
        return self.queue.cancel(job_id) == "pending"

    async def _reaper(self) -> None:
        while True:
            await asyncio.sleep(self.reap_seconds)
            try:
                self.queue.reap()
            except Exception:  # noqa: BLE001
                log.exception("job reaper failed")

    async def _lane(self, name: str, kinds: set[str]) -> None:
        worker_id = f"{name}:{id(self)}"
        while True:
            if name == "model" and self.gate is not None:
                await self.gate.wait()
            try:
                job = self.queue.claim(worker_id, kinds)
            except Exception:  # noqa: BLE001
                log.exception("claiming a job failed")
                job = None
            if job is None:
                self.idle.set()
                self.queue.wake.clear()
                try:
                    await asyncio.wait_for(self.queue.wake.wait(), self.poll_seconds)
                except TimeoutError:
                    pass
                continue
            self.idle.clear()
            await self._run(job)

    async def _run(self, job: Job) -> None:
        handler = self.handlers.get(job.kind)
        if handler is None:
            self.queue.fail(job.id, f"No handler for job kind '{job.kind}'.", retry=False)
            return
        ctx = JobContext(job, self.queue, self.state)
        task: asyncio.Task[dict[str, Any] | None] = asyncio.create_task(handler(ctx))
        self.running[job.id] = (task, ctx)
        try:
            result = await task
            self.queue.complete(job.id, result)
            self._finished(job, "done")
        except asyncio.CancelledError:
            if ctx.cancelled.is_set():
                self.queue.mark_cancelled(job.id)
                self._finished(job, "cancelled")
                return
            # The lane itself is shutting down: leave the job pending for the next start.
            self.queue.db.execute(
                "UPDATE jobs SET status='pending', locked_by=NULL WHERE id=?", (job.id,)
            )
            raise
        except PermanentJobError as exc:
            log.warning("job %s (%s) failed permanently: %s", job.id, job.kind, exc)
            self.queue.fail(job.id, str(exc) or exc.__class__.__name__, retry=False)
            self._finished(job, "failed", str(exc))
        except Exception as exc:  # noqa: BLE001
            log.exception("job %s (%s) failed", job.id, job.kind)
            self.queue.fail(job.id, str(exc) or exc.__class__.__name__)
            if job.attempts >= job.max_attempts:
                self._finished(job, "failed", str(exc))
        finally:
            self.running.pop(job.id, None)
