# ruff: noqa: E501
from __future__ import annotations

from datetime import UTC, datetime, timedelta
from pathlib import Path
from types import SimpleNamespace

from graite.agents.definitions import Definitions
from graite.events import EventBus
from graite.index import db
from graite.jobs.cron import Cron
from graite.jobs.queue import Job, JobQueue
from graite.vault import indexer
from tests.test_indexer import write_page


def make(tmp_path: Path) -> tuple[Cron, JobQueue, Path]:
    vault = tmp_path / "vault"
    write_page(
        vault,
        "Journal",
        "Journal",
        "",
        {"live": {"objective": "Keep it current", "cron": "0 6 * * *"}},
    )
    write_page(vault, "Projects", "Projects", "")
    (vault / "Projects" / "_agents").mkdir()
    (vault / "Projects" / "_agents" / "review.md").write_text(
        "---\nschedule: '*/5 * * * *'\n---\nReview.\n"
    )
    conn = db.connect(vault / ".graite" / "index.sqlite")
    indexer.scan(vault, conn)
    events = EventBus()
    queue = JobQueue(conn, events)
    epoch = SimpleNamespace(value=0)
    cron = Cron(conn, queue, events, Definitions(vault, lambda: epoch.value), poll_seconds=1)
    return cron, queue, vault


def test_sync_mirrors_definitions_and_live_pages(tmp_path: Path) -> None:
    cron, queue, vault = make(tmp_path)
    cron.sync()
    rows = {r["source"]: r for r in cron.rows()}
    assert set(rows) == {"agent:review", "live:Journal"}
    assert (
        rows["agent:review"]["job_kind"] == "agent_run"
        and rows["agent:review"]["expr"] == "*/5 * * * *"
    )
    assert (
        rows["live:Journal"]["payload"] == {"page_path": "Journal"}
        and rows["live:Journal"]["next_run_at"]
    )
    first_id = rows["agent:review"]["id"]
    cron.sync()  # idempotent
    assert {r["id"] for r in cron.rows()} == {first_id, rows["live:Journal"]["id"]}
    (vault / "Projects" / "_agents" / "review.md").unlink()
    cron.definitions.refresh(force=True)
    cron.sync()
    assert [r["source"] for r in cron.rows()] == ["live:Journal"]


def test_due_rows_fire_once_and_backoff_on_failure(tmp_path: Path) -> None:
    cron, queue, _ = make(tmp_path)
    row = cron.create("Nightly", "0 3 * * *", "agent_run", {"agent": "x"}, source="user")
    assert row["enabled"] and row["next_run_at"]
    assert cron.tick(datetime.now(UTC)) == []  # not due yet
    later = datetime.fromisoformat(row["next_run_at"]) + timedelta(seconds=1)
    fired = cron.tick(later)
    assert fired == [row["id"]] and cron.tick(later) == []  # next_run_at moved on
    jobs = queue.list(kind="agent_run")
    assert len(jobs) == 1 and jobs[0]["status"] == "pending"
    job = queue.claim("w", {"agent_run"})
    assert job is not None and job.payload["cron_id"] == row["id"]
    cron.on_job_finished(job, "failed", "boom")
    after = cron.get(row["id"])
    assert after and after["failures"] == 1 and after["last_status"].startswith("failed")
    delayed = datetime.fromisoformat(after["next_run_at"])
    assert timedelta(hours=1) < delayed - datetime.now(UTC) <= timedelta(hours=24, minutes=1)
    cron.on_job_finished(job, "done", None)
    after = cron.get(row["id"])
    assert after and after["failures"] == 0 and after["last_status"] == "succeeded"
    assert after["last_run_at"]
    # Manual fire and toggling.
    assert queue.get(cron.fire(row["id"])) is not None
    assert cron.update(row["id"], enabled=False)["enabled"] is False
    assert cron.tick(datetime.now(UTC) + timedelta(days=2)) == []
    cron.delete(row["id"])
    assert cron.get(row["id"]) is None
    unrelated = Job("j", "embed", None, {}, None, 5, "done", "", 1, 1, None)
    cron.on_job_finished(unrelated, "done", None)  # no cron_id: ignored


def test_synced_agent_schedule_fires_through_tick(tmp_path: Path) -> None:
    cron, queue, _ = make(tmp_path)
    cron.sync()
    row = next(r for r in cron.rows() if r["source"] == "agent:review")
    assert row["enabled"] and row["next_run_at"]
    due = datetime.fromisoformat(row["next_run_at"]) + timedelta(seconds=1)
    # The Journal's live note (06:00) may be due as well when this runs just before 06:00
    # UTC; only the agent's schedule matters here.
    assert row["id"] in cron.tick(due)
    job = queue.claim("w", {"agent_run"})
    assert job is not None
    assert job.payload == {"agent": "review", "cron_id": row["id"], "trigger": "cron"}
    assert job.page_path == "Projects"
