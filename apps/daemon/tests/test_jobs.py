from __future__ import annotations

import asyncio
from datetime import UTC, datetime, timedelta
from pathlib import Path
from types import SimpleNamespace

from graite.events import EventBus
from graite.index import db
from graite.jobs.queue import JobQueue
from graite.jobs.worker import JobContext, Worker


def make_queue(tmp_path: Path) -> JobQueue:
    return JobQueue(db.connect(tmp_path / "index.sqlite"), EventBus())


def test_claim_is_exclusive_and_ordered_by_priority(tmp_path: Path) -> None:
    queue = make_queue(tmp_path)
    low = queue.enqueue("embed", priority=5)
    high = queue.enqueue("embed", priority=1)
    first = queue.claim("w1", {"embed"})
    assert first is not None and first.id == high and first.attempts == 1
    second = queue.claim("w2", {"embed"})
    assert second is not None and second.id == low
    assert queue.claim("w3", {"embed"}) is None
    assert queue.claim("w3", {"agent_run"}) is None


def test_failure_backs_off_then_gives_up(tmp_path: Path) -> None:
    queue = make_queue(tmp_path)
    job_id = queue.enqueue("embed", max_attempts=2)
    job = queue.claim("w", {"embed"})
    assert job is not None
    queue.fail(job.id, "boom")
    row = queue.get(job_id)
    assert row is not None and row["status"] == "pending" and row["error"] == "boom"
    assert queue.claim("w", {"embed"}) is None  # run_at is in the future
    queue.db.execute(
        "UPDATE jobs SET run_at=? WHERE id=?",
        ((datetime.now(UTC) - timedelta(seconds=1)).isoformat(), job_id),
    )
    job = queue.claim("w", {"embed"})
    assert job is not None and job.attempts == 2
    queue.fail(job.id, "boom again")
    assert queue.get(job_id)["status"] == "failed"  # type: ignore[index]


def test_same_key_coalesces_and_keeps_highest_priority(tmp_path: Path) -> None:
    queue = make_queue(tmp_path)
    a = queue.enqueue("embed", key="embed", priority=5)
    b = queue.enqueue("embed", key="embed", priority=1)
    assert a == b
    assert queue.get(a)["priority"] == 1  # type: ignore[index]
    running = queue.claim("w", {"embed"})
    assert running is not None
    follow = queue.enqueue("embed", key="embed")
    assert follow != a and queue.enqueue("embed", key="embed") == follow
    queue.complete(a)
    promoted = queue.claim("w", {"embed"})
    assert promoted is not None and promoted.id == follow and promoted.key == "embed"


def test_reaper_and_recovery_reset_stale_running_jobs(tmp_path: Path) -> None:
    queue = make_queue(tmp_path)
    job_id = queue.enqueue("embed")
    queue.claim("w", {"embed"})
    assert queue.reap() == 0
    queue.db.execute(
        "UPDATE jobs SET locked_at=? WHERE id=?",
        ((datetime.now(UTC) - timedelta(minutes=20)).isoformat(), job_id),
    )
    assert queue.reap() == 1 and queue.get(job_id)["status"] == "pending"  # type: ignore[index]
    queue.claim("w", {"embed"})
    assert queue.recover() == 1


async def test_lanes_run_concurrently_and_cancel(tmp_path: Path) -> None:
    queue = make_queue(tmp_path)
    started: dict[str, asyncio.Event] = {"embed": asyncio.Event(), "agent_run": asyncio.Event()}
    release = asyncio.Event()

    async def slow(ctx: JobContext) -> dict[str, int]:
        started[ctx.job.kind].set()
        ctx.progress(step=1)
        await release.wait()
        return {"ok": 1}

    async def forever(ctx: JobContext) -> None:
        started[ctx.job.kind].set()
        await asyncio.sleep(3600)

    worker = Worker(
        queue,
        {"embed": slow, "agent_run": forever},
        SimpleNamespace(),
        poll_seconds=0.05,
        reap_seconds=3600,
    )
    await worker.start()
    try:
        embed_id = queue.enqueue("embed")
        agent_id = queue.enqueue("agent_run")
        await asyncio.wait_for(
            asyncio.gather(started["embed"].wait(), started["agent_run"].wait()), 2
        )
        assert queue.get(embed_id)["progress"] == {"step": 1}  # type: ignore[index]
        assert await worker.cancel(agent_id)
        release.set()
        for _ in range(50):
            await asyncio.sleep(0.02)
            if (
                queue.get(embed_id)["status"] == "done"
                and queue.get(agent_id)["status"] == "cancelled"
            ):  # type: ignore[index]
                break
        assert queue.get(embed_id)["status"] == "done"  # type: ignore[index]
        assert queue.get(agent_id)["status"] == "cancelled"  # type: ignore[index]
        failing = queue.enqueue("reindex")  # in the embed lane, but this worker has no handler
        await asyncio.sleep(0.2)
        assert queue.get(failing)["status"] == "failed"  # type: ignore[index]
    finally:
        await worker.stop()
        queue.db.close()


async def test_permanent_failures_are_not_retried(tmp_path: Path) -> None:
    from graite.jobs.worker import PermanentJobError

    queue = make_queue(tmp_path)

    async def never(ctx: JobContext) -> dict[str, object]:
        raise PermanentJobError("not in this version")

    worker = Worker(queue, {"agent_run": never}, SimpleNamespace(), {"model": {"agent_run"}})
    job_id = queue.enqueue("agent_run", max_attempts=3)
    job = queue.claim("w", {"agent_run"})
    assert job is not None
    await worker._run(job)
    row = queue.get(job_id)
    assert row is not None and row["status"] == "failed" and "not in this version" in row["error"]
