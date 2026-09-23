"""Schedules: cron rows that enqueue jobs when due (ARCHITECTURE.md §4).

Rows come from three places and carry it in `source`: `agent:<name>` and `workflow:<name>`
for definitions with a `schedule`, `live:<page path>` for pages with `live.cron`, and
`tool`/`user` for rows made by the `schedule` tool or the Schedules view. Definition rows
are synced from the vault; the others are edited directly. `next_run_at` is anchored on the
last successful run; each failure doubles the wait, up to a day.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import sqlite3
import uuid
from datetime import UTC, datetime, timedelta
from typing import Any

from graite.events import EventBus
from graite.index.db import transaction
from graite.jobs.queue import PRIORITY_SUMMARY, Job, JobQueue
from graite.jobs.when import interval_seconds, next_run

log = logging.getLogger("graite.cron")

POLL_SECONDS = 30
MAX_BACKOFF = timedelta(hours=24)
ASSISTANT_SOURCE = "assistant:loop"
TIDY_SOURCE = "assistant:tidy"
TIDY_EXPR = "0 4 * * 0"  # Sundays, early: the weekly memory tidy (D57)


def now() -> datetime:
    return datetime.now(UTC)


def _iso(value: datetime) -> str:
    return value.isoformat()


class Cron:
    def __init__(
        self,
        db: sqlite3.Connection,
        queue: JobQueue,
        events: EventBus,
        definitions: Any,
        *,
        poll_seconds: float = POLL_SECONDS,
    ) -> None:
        self.db = db
        self.queue = queue
        self.events = events
        self.definitions = definitions
        self.poll_seconds = poll_seconds
        self.task: asyncio.Task[None] | None = None

    async def start(self) -> None:
        self.sync()
        self.task = asyncio.create_task(self._loop(), name="jobs:cron")

    async def stop(self) -> None:
        if self.task:
            self.task.cancel()
            await asyncio.gather(self.task, return_exceptions=True)
            self.task = None

    async def _loop(self) -> None:
        while True:
            try:
                self.tick()
            except Exception:  # noqa: BLE001
                log.exception("cron tick failed")
            await asyncio.sleep(self.poll_seconds)

    # ----------------------------------------------------------------- rows

    @staticmethod
    def describe(row: sqlite3.Row) -> dict[str, Any]:
        data = dict(row)
        data["enabled"] = bool(data.get("enabled"))
        try:
            data["payload"] = json.loads(data.pop("payload_json") or "{}")
        except ValueError:
            data["payload"] = {}
        return data

    def get(self, cron_id: str) -> dict[str, Any] | None:
        row = self.db.execute("SELECT * FROM cron WHERE id=?", (cron_id,)).fetchone()
        return self.describe(row) if row else None

    def rows(self) -> list[dict[str, Any]]:
        rows = self.db.execute("SELECT * FROM cron ORDER BY name").fetchall()
        return [self.describe(r) for r in rows]

    def _publish(self, cron_id: str) -> None:
        row = self.get(cron_id)
        if row:
            self.events.publish("schedule_update", row)

    def create(
        self,
        name: str,
        expr: str,
        job_kind: str,
        payload: dict[str, Any],
        *,
        source: str = "user",
        page_path: str | None = None,
        cron_id: str | None = None,
        enabled: bool = True,
    ) -> dict[str, Any]:
        cron_id = cron_id or "cr_" + uuid.uuid4().hex[:10]
        with transaction(self.db):
            self.db.execute(
                "INSERT OR REPLACE INTO cron (id, name, expr, source, job_kind, payload_json, "
                "page_path, enabled, last_run_at, next_run_at, last_status, failures) "
                "VALUES (?,?,?,?,?,?,?,?,"
                "(SELECT last_run_at FROM cron WHERE id=?),?,"
                "(SELECT last_status FROM cron WHERE id=?),"
                "COALESCE((SELECT failures FROM cron WHERE id=?),0))",
                (
                    cron_id,
                    name[:120],
                    expr,
                    source,
                    job_kind,
                    json.dumps(payload, ensure_ascii=False),
                    page_path,
                    int(enabled),
                    cron_id,
                    _iso(next_run(expr, now())),
                    cron_id,
                    cron_id,
                ),
            )
        self._publish(cron_id)
        row = self.get(cron_id)
        assert row is not None
        return row

    def update(
        self,
        cron_id: str,
        *,
        name: str | None = None,
        expr: str | None = None,
        enabled: bool | None = None,
    ) -> dict[str, Any]:
        row = self.get(cron_id)
        if row is None:
            raise KeyError(cron_id)
        fields: dict[str, Any] = {}
        if name is not None and name.strip():
            fields["name"] = name.strip()[:120]
        if expr is not None:
            fields["expr"] = expr
            fields["next_run_at"] = _iso(next_run(expr, now()))
            fields["failures"] = 0
        if enabled is not None:
            fields["enabled"] = int(enabled)
            if enabled and not row["enabled"]:
                fields["next_run_at"] = _iso(next_run(expr or row["expr"], now()))
        if fields:
            keys = ", ".join(f"{k}=?" for k in fields)
            with transaction(self.db):
                self.db.execute(f"UPDATE cron SET {keys} WHERE id=?", (*fields.values(), cron_id))
        self._publish(cron_id)
        found = self.get(cron_id)
        assert found is not None
        return found

    def delete(self, cron_id: str) -> None:
        with transaction(self.db):
            self.db.execute("DELETE FROM cron WHERE id=?", (cron_id,))
        self.events.publish("schedule_update", {"id": cron_id, "deleted": True})

    # ----------------------------------------------------------------- firing

    def fire(self, cron_id: str) -> str:
        """Enqueue the schedule's job now (the next tick keeps its own rhythm)."""
        row = self.get(cron_id)
        if row is None:
            raise KeyError(cron_id)
        if row["job_kind"] == "workflow_run":
            raise ValueError("Workflows are no longer available.")
        return self.queue.enqueue(
            row["job_kind"],
            {**row["payload"], "cron_id": cron_id, "trigger": "cron"},
            key=f"cron:{cron_id}",
            page_path=row["page_path"],
            priority=PRIORITY_SUMMARY,
            max_attempts=1,
        )

    def tick(self, at: datetime | None = None) -> list[str]:
        at = at or now()
        due = self.db.execute(
            "SELECT * FROM cron WHERE enabled=1 AND next_run_at IS NOT NULL AND next_run_at<=?",
            (_iso(at),),
        ).fetchall()
        fired: list[str] = []
        for row in due:
            try:
                self.fire(row["id"])
                with transaction(self.db):
                    self.db.execute(
                        "UPDATE cron SET next_run_at=? WHERE id=?",
                        (_iso(next_run(row["expr"], at)), row["id"]),
                    )
                fired.append(row["id"])
            except Exception:  # noqa: BLE001 - one bad row must not stop the others
                log.exception("could not fire schedule %s", row["id"])
        return fired

    def on_job_finished(self, job: Job, status: str, error: str | None) -> None:
        cron_id = job.payload.get("cron_id")
        if not cron_id:
            return
        row = self.get(str(cron_id))
        if row is None:
            return
        at = now()
        if status == "done":
            fields = {
                "last_run_at": _iso(at),
                "last_status": "succeeded",
                "failures": 0,
                "next_run_at": _iso(next_run(row["expr"], at)),
            }
        elif status == "cancelled":
            fields = {"last_status": "cancelled"}
        else:
            failures = int(row["failures"] or 0) + 1
            wait = min(
                timedelta(seconds=interval_seconds(row["expr"], at) * (2**failures)), MAX_BACKOFF
            )
            fields = {
                "last_status": f"failed: {(error or '')[:200]}",
                "failures": failures,
                "next_run_at": _iso(at + wait),
            }
        keys = ", ".join(f"{k}=?" for k in fields)
        with transaction(self.db):
            self.db.execute(f"UPDATE cron SET {keys} WHERE id=?", (*fields.values(), row["id"]))
        self._publish(row["id"])

    # ----------------------------------------------------------------- definitions

    def sync(self) -> None:
        """Mirror scheduled agents, workflows and live pages into cron rows."""
        self.db.execute("UPDATE cron SET enabled=0 WHERE job_kind='workflow_run'")
        wanted: dict[str, tuple[str, str, str, dict[str, Any], str | None]] = {}
        for agent in self.definitions.agents():
            if agent.assistant and agent.memory:
                wanted[TIDY_SOURCE] = (
                    f"{agent.name} · memory tidy",
                    TIDY_EXPR,
                    "assistant_tidy",
                    {"preemptible": True},
                    None,
                )
            if agent.schedule and agent.assistant:
                # One fixed source: renaming the assistant keeps its schedule row.
                wanted[ASSISTANT_SOURCE] = (
                    agent.name,
                    agent.schedule,
                    "assistant_loop",
                    {"preemptible": True},
                    None,
                )
            elif agent.schedule:
                wanted[f"agent:{agent.name}"] = (
                    agent.name,
                    agent.schedule,
                    "agent_run",
                    {"agent": agent.name},
                    agent.scope.roots[0] if agent.scope.roots else None,
                )
        for row in self.db.execute("SELECT path, frontmatter_json FROM pages"):
            try:
                meta = json.loads(row["frontmatter_json"] or "{}")
            except ValueError:
                continue
            live = meta.get("live")
            if isinstance(live, dict) and live.get("cron") and live.get("objective"):
                try:
                    from graite.agents.definitions import validate_cron

                    expr = validate_cron(str(live["cron"]))
                except ValueError:
                    continue
                if expr:
                    wanted[f"live:{row['path']}"] = (
                        f"Live note: {row['path']}",
                        expr,
                        "live_note",
                        {"page_path": row["path"]},
                        row["path"],
                    )
        existing = {
            r["source"]: r
            for r in self.db.execute(
                "SELECT * FROM cron WHERE source LIKE 'agent:%' OR source LIKE 'workflow:%' "
                "OR source LIKE 'live:%' OR source IN (?, ?)",
                (ASSISTANT_SOURCE, TIDY_SOURCE),
            )
        }
        for source, (name, expr, kind, payload, page_path) in wanted.items():
            row = existing.get(source)
            cron_id = row["id"] if row else "cr_" + hashlib.sha1(source.encode()).hexdigest()[:10]
            if row and row["expr"] == expr and row["name"] == name:
                continue
            self.create(
                name,
                expr,
                kind,
                payload,
                source=source,
                page_path=page_path,
                cron_id=cron_id,
                enabled=bool(row["enabled"]) if row else True,
            )
        for source, row in existing.items():
            if source not in wanted:
                self.delete(row["id"])
