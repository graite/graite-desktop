"""SQLite-backed job queue (ARCHITECTURE.md §4).

`enqueue` is synchronous and safe to call from worker threads (fileops runs in
`asyncio.to_thread`); it wakes the worker through the bound event loop. Claiming uses
`BEGIN IMMEDIATE`, which is enough because one daemon owns one vault.
"""

from __future__ import annotations

import asyncio
import json
import sqlite3
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any

from graite.events import EventBus
from graite.index.db import transaction

PRIORITY_INTERACTIVE = 0
PRIORITY_HOT = 1
PRIORITY_REBUILD = 3
PRIORITY_BULK = 5
PRIORITY_SUMMARY = 8
PRIORITY_ENTITIES = 9


def now() -> str:
    return datetime.now(UTC).isoformat()


@dataclass
class Job:
    id: str
    kind: str
    key: str | None
    payload: dict[str, Any]
    page_path: str | None
    priority: int
    status: str
    run_at: str
    attempts: int
    max_attempts: int
    run_id: str | None

    @classmethod
    def from_row(cls, row: sqlite3.Row) -> Job:
        return cls(
            id=row["id"],
            kind=row["kind"],
            key=row["key"],
            payload=json.loads(row["payload_json"] or "{}"),
            page_path=row["page_path"],
            priority=row["priority"],
            status=row["status"],
            run_at=row["run_at"],
            attempts=row["attempts"],
            max_attempts=row["max_attempts"],
            run_id=row["run_id"],
        )


class JobQueue:
    def __init__(self, db: sqlite3.Connection, events: EventBus) -> None:
        self.db = db
        self.events = events
        self.wake = asyncio.Event()
        self.loop: asyncio.AbstractEventLoop | None = None

    def bind(self, loop: asyncio.AbstractEventLoop) -> None:
        self.loop = loop

    def _wake(self) -> None:
        if self.loop is None:
            return
        try:
            self.loop.call_soon_threadsafe(self.wake.set)
        except RuntimeError:
            pass  # loop closed during shutdown

    def _publish(self, job_id: str) -> None:
        row = self.db.execute("SELECT * FROM jobs WHERE id=?", (job_id,)).fetchone()
        if row:
            self.events.publish("job_update", self.describe(row))

    @staticmethod
    def describe(row: sqlite3.Row) -> dict[str, Any]:
        return {
            "id": row["id"],
            "kind": row["kind"],
            "status": row["status"],
            "page_path": row["page_path"],
            "priority": row["priority"],
            "attempts": row["attempts"],
            "progress": json.loads(row["progress_json"]) if row["progress_json"] else None,
            "error": row["error"],
            "run_id": row["run_id"],
            "created_at": row["created_at"],
            "finished_at": row["finished_at"],
        }

    def enqueue(
        self,
        kind: str,
        payload: dict[str, Any] | None = None,
        *,
        key: str | None = None,
        page_path: str | None = None,
        priority: int = PRIORITY_BULK,
        run_at: str | None = None,
        max_attempts: int = 3,
        run_id: str | None = None,
    ) -> str:
        """Add a job, or fold it into a pending job with the same key (best priority wins)."""
        with transaction(self.db):
            if key:
                existing = self.db.execute(
                    "SELECT id, priority, status FROM jobs WHERE key=? "
                    "AND status IN ('pending','running')",
                    (key,),
                ).fetchone()
                if existing:
                    if existing["status"] == "pending":
                        self.db.execute(
                            "UPDATE jobs SET priority=min(priority, ?), payload_json=?, "
                            "run_at=min(run_at, ?) WHERE id=?",
                            (priority, json.dumps(payload or {}), run_at or now(), existing["id"]),
                        )
                        self._wake()
                        return str(existing["id"])
                    # Running: queue one follow-up so changes made meanwhile are picked up.
                    follow = self.db.execute(
                        "SELECT id FROM jobs WHERE key=? AND status='pending'", (key + ":next",)
                    ).fetchone()
                    if follow:
                        return str(follow["id"])
                    key = key + ":next"
            job_id = uuid.uuid4().hex
            self.db.execute(
                "INSERT INTO jobs (id, kind, key, payload_json, page_path, priority, status, "
                "run_at, "
                "max_attempts, run_id, created_at) VALUES (?,?,?,?,?,?,'pending',?,?,?,?)",
                (
                    job_id,
                    kind,
                    key,
                    json.dumps(payload or {}),
                    page_path,
                    priority,
                    run_at or now(),
                    max_attempts,
                    run_id,
                    now(),
                ),
            )
        self._wake()
        self._publish(job_id)
        return job_id

    def claim(self, worker_id: str, kinds: set[str]) -> Job | None:
        marks = ",".join("?" * len(kinds))
        with transaction(self.db):
            row = self.db.execute(
                f"SELECT * FROM jobs WHERE status='pending' AND run_at<=? AND kind IN ({marks}) "
                "ORDER BY priority, run_at LIMIT 1",
                (now(), *kinds),
            ).fetchone()
            if not row:
                return None
            key = row["key"]
            if key and key.endswith(":next"):
                # Promote the follow-up so a further enqueue coalesces into it.
                key = key[: -len(":next")]
            self.db.execute(
                "UPDATE jobs SET status='running', locked_by=?, locked_at=?, attempts=attempts+1, "
                "key=? WHERE id=?",
                (worker_id, now(), key, row["id"]),
            )
            job = Job.from_row(
                self.db.execute("SELECT * FROM jobs WHERE id=?", (row["id"],)).fetchone()
            )
        self._publish(job.id)
        return job

    def progress(self, job_id: str, data: dict[str, Any]) -> None:
        """Record progress and refresh the lock, so long jobs are not reaped as stale."""
        self.db.execute(
            "UPDATE jobs SET progress_json=?, locked_at=? WHERE id=?",
            (json.dumps(data), now(), job_id),
        )
        self._publish(job_id)

    def complete(self, job_id: str, result: dict[str, Any] | None = None) -> None:
        self.db.execute(
            "UPDATE jobs SET status='done', result_json=?, finished_at=?, locked_by=NULL "
            "WHERE id=?",
            (json.dumps(result or {}), now(), job_id),
        )
        self._publish(job_id)

    def fail(self, job_id: str, error: str, *, retry: bool = True) -> None:
        row = self.db.execute(
            "SELECT attempts, max_attempts FROM jobs WHERE id=?", (job_id,)
        ).fetchone()
        if not row:
            return
        if retry and row["attempts"] < row["max_attempts"]:
            delay = 30 * 2 ** row["attempts"]
            run_at = (datetime.now(UTC) + timedelta(seconds=delay)).isoformat()
            self.db.execute(
                "UPDATE jobs SET status='pending', error=?, run_at=?, locked_by=NULL WHERE id=?",
                (error[:1000], run_at, job_id),
            )
        else:
            self.db.execute(
                "UPDATE jobs SET status='failed', error=?, finished_at=?, locked_by=NULL "
                "WHERE id=?",
                (error[:1000], now(), job_id),
            )
        self._publish(job_id)

    def cancel(self, job_id: str) -> str | None:
        row = self.db.execute("SELECT status FROM jobs WHERE id=?", (job_id,)).fetchone()
        if not row:
            return None
        if row["status"] == "pending":
            self.db.execute(
                "UPDATE jobs SET status='cancelled', finished_at=? WHERE id=?", (now(), job_id)
            )
            self._publish(job_id)
        return str(row["status"])

    def mark_cancelled(self, job_id: str) -> None:
        self.db.execute(
            "UPDATE jobs SET status='cancelled', finished_at=?, locked_by=NULL WHERE id=?",
            (now(), job_id),
        )
        self._publish(job_id)

    def get(self, job_id: str) -> dict[str, Any] | None:
        row = self.db.execute("SELECT * FROM jobs WHERE id=?", (job_id,)).fetchone()
        return self.describe(row) if row else None

    def list(
        self, *, status: str | None = None, kind: str | None = None, limit: int = 100
    ) -> list[dict[str, Any]]:
        clauses, params = [], []
        if status:
            clauses.append("status=?")
            params.append(status)
        if kind:
            clauses.append("kind=?")
            params.append(kind)
        where = ("WHERE " + " AND ".join(clauses)) if clauses else ""
        rows = self.db.execute(
            f"SELECT * FROM jobs {where} ORDER BY created_at DESC LIMIT ?", (*params, limit)
        ).fetchall()
        return [self.describe(r) for r in rows]

    def reap(self, stale_minutes: int = 15) -> int:
        cutoff = (datetime.now(UTC) - timedelta(minutes=stale_minutes)).isoformat()
        cursor = self.db.execute(
            "UPDATE jobs SET status='pending', locked_by=NULL "
            "WHERE status='running' AND locked_at<?",
            (cutoff,),
        )
        if cursor.rowcount:
            self._wake()
        return int(cursor.rowcount)

    def recover(self) -> int:
        """At startup, jobs left `running` by a previous process go back to pending."""
        cursor = self.db.execute(
            "UPDATE jobs SET status='pending', locked_by=NULL WHERE status='running'"
        )
        return int(cursor.rowcount)

    def counts(self) -> dict[str, int]:
        return {
            r["status"]: r["n"]
            for r in self.db.execute("SELECT status, count(*) AS n FROM jobs GROUP BY status")
        }
