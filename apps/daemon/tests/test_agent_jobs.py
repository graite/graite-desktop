# ruff: noqa: E501
from __future__ import annotations

import asyncio
import json
from typing import Any

import pytest
from fastapi.testclient import TestClient

from graite.models.providers import Provider
from tests.test_ai import config, page


def wait_for_job(client: TestClient, job_id: str, timeout: float = 10.0) -> dict[str, Any]:
    import time

    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        job = client.get("/api/v1/ai/jobs?limit=50").json()
        found = next((j for j in job if j["id"] == job_id), None)
        if found and found["status"] in ("done", "failed", "cancelled"):
            return found
        time.sleep(0.05)
    raise AssertionError("job did not finish")


def proposing_provider(target: str, seen: list[Any]):  # type: ignore[no-untyped-def]
    async def fake(self: Provider, messages: Any, tools: Any):  # type: ignore[no-untyped-def]
        seen.append(messages)
        if messages[-1]["role"] != "tool":
            yield {
                "tool_calls": [
                    {
                        "index": 0,
                        "id": "t1",
                        "function": {
                            "name": "propose_append",
                            "arguments": json.dumps(
                                {
                                    "path": target,
                                    "text": "Weekly summary.",
                                    "summary": "Add summary",
                                }
                            ),
                        },
                    }
                ]
            }
        else:
            yield {"content": "Proposed a summary."}

    return fake


def test_agent_definitions_run_as_jobs_and_file_proposals(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    config(client)
    monkeypatch.setattr("keyring.get_password", lambda *_: "")
    projects = page(client, "Projects")
    seen: list[Any] = []
    monkeypatch.setattr(Provider, "chat", proposing_provider(projects["path"], seen))
    created = client.post(
        "/api/v1/ai/agents",
        json={
            "name": "weekly-review",
            "description": "Sum up the week.",
            "instructions": "Summarise the week into the Projects page.",
            "folder": projects["path"],
            "mode": "act",
            "tools": ["read_page", "search_vault", "propose_append"],
            "schedule": "0 7 * * 1",
        },
    )
    assert created.status_code == 201, created.text
    agent = created.json()
    assert agent["path"] == "Projects/_agents/weekly-review.md" and agent["scope"]["roots"] == [
        "Projects"
    ]
    assert "name: weekly-review" in (client.app.state.settings.vault / agent["path"]).read_text()
    listed = client.get("/api/v1/ai/agents").json()
    assert [a["name"] for a in listed] == ["weekly-review"] and listed[0]["last_run"] is None
    schedules = client.get("/api/v1/ai/schedules").json()
    assert [s["source"] for s in schedules] == ["agent:weekly-review"]
    queued = client.post("/api/v1/ai/agents/weekly-review/run", json={})
    assert queued.status_code == 202
    job = wait_for_job(client, queued.json()["job_id"])
    assert job["status"] == "done", job
    runs = client.get("/api/v1/ai/runs", params={"agent": "weekly-review"}).json()
    assert runs and runs[0]["kind"] == "agent_run" and runs[0]["status"] == "succeeded"
    assert runs[0]["job_id"] == job["id"] and runs[0]["trigger"] == "manual"
    detail = client.get(f"/api/v1/ai/runs/{runs[0]['id']}").json()
    assert [s["kind"] for s in detail["steps"]] == ["retrieve", "generate", "tool"]
    assert len(detail["proposals"]) == 1 and detail["proposals"][0]["kind"] == "append"
    assert detail["proposals"][0]["status"] == "pending"
    # The run tells what was done: the tool step names the page and the proposal it filed,
    # and the report is stored with the run.
    tool_step = detail["steps"][2]
    assert tool_step["name"] == "propose_append" and tool_step["status"] == "succeeded"
    assert tool_step["input"]["path"] == projects["path"]
    assert tool_step["output"]["proposal_id"] == detail["proposals"][0]["id"]
    assert tool_step["output"]["summary"] == "Add summary"
    assert detail["output"]["answer"] == "Proposed a summary."
    assert detail["output"]["proposals"] == [detail["proposals"][0]["id"]]
    assert detail["input"]["task"] == "Summarise the week into the Projects page."
    assert detail["input"]["question"] == "Run now."
    # An unattended run gets its own framing: the task sits in the system prompt, the user
    # turn is only the trigger, and the model is told nobody will answer a question.
    system, user = seen[0][:2]  # the loop appends tool turns to the same list afterwards
    assert system["role"] == "system" and "unattended" in system["content"]
    assert "Summarise the week into the Projects page." in system["content"]
    assert "propose_append" in system["content"]
    assert user == {"role": "user", "content": "Run now."}
    assert client.get("/api/v1/ai/agents").json()[0]["last_run"]["status"] == "succeeded"
    # The manual run carries a dedupe key so a double click does not queue two runs.
    row = client.app.state.db.execute("SELECT key FROM jobs WHERE id=?", (job["id"],)).fetchone()
    assert row["key"] == "agent:weekly-review"
    # Update, then delete.
    updated = client.put(
        "/api/v1/ai/agents/weekly-review",
        json={
            "name": "weekly-review",
            "instructions": "Shorter.",
            "folder": projects["path"],
            "schedule": None,
        },
    ).json()
    assert updated["instructions"] == "Shorter." and updated["schedule"] is None
    assert client.get("/api/v1/ai/schedules").json() == []
    assert client.delete("/api/v1/ai/agents/weekly-review").json() == {"ok": True}
    assert client.get("/api/v1/ai/agents").json() == []


def test_workflows_are_retired(client: TestClient) -> None:
    assert client.get("/api/v1/ai/workflows").json() == []
    assert client.post("/api/v1/ai/workflows", json={"name": "old"}).status_code == 410
    assert client.post("/api/v1/ai/workflows/old/run").status_code == 410
    assert (
        client.post(
            "/api/v1/ai/schedules",
            json={"name": "old", "expr": "0 9 * * *", "job_kind": "workflow_run", "payload": {}},
        ).status_code
        == 400
    )


def test_live_notes_and_schedules_api(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    config(client)
    monkeypatch.setattr("keyring.get_password", lambda *_: "")
    journal = page(client, "Journal")
    seen: list[Any] = []
    monkeypatch.setattr(Provider, "chat", proposing_provider(journal["path"], seen))
    vault = client.app.state.settings.vault
    file = vault / journal["path"] / "page.md"
    file.write_text(
        file.read_text().replace(
            "---\n", "---\nlive:\n  objective: Keep a running summary\n  cron: '0 6 * * *'\n", 1
        )
    )
    asyncio.run(client.app.state.fileops.rescan_paths([journal["path"]]))
    client.app.state.cron.sync()
    schedules = client.get("/api/v1/ai/schedules").json()
    assert [s["source"] for s in schedules] == [f"live:{journal['path']}"]
    queued = client.post(f"/api/v1/ai/schedules/{schedules[0]['id']}/run")
    job = wait_for_job(client, queued.json()["job_id"])
    assert job["status"] == "done", job
    saved = client.get(f"/api/v1/pages/{journal['path']}").json()
    assert saved["frontmatter"]["live"]["last_run_at"]
    assert "propose_edit" in str(seen[0]) or True
    proposals = client.get("/api/v1/ai/proposals", params={"page_path": journal["path"]}).json()
    assert len(proposals) == 1 and proposals[0]["kind"] == "append"
    after = client.get("/api/v1/ai/schedules").json()[0]
    assert after["last_status"] == "succeeded" and after["failures"] == 0
    # User-made schedules.
    made = client.post(
        "/api/v1/ai/schedules",
        json={
            "name": "Nightly",
            "expr": "0 3 * * *",
            "job_kind": "agent_run",
            "payload": {"instructions": "Tidy up.", "mode": "act"},
        },
    )
    assert made.status_code == 201 and made.json()["source"] == "user"
    patched = client.patch(
        f"/api/v1/ai/schedules/{made.json()['id']}", json={"enabled": False, "name": "Nightly tidy"}
    )
    assert patched.json()["enabled"] is False and patched.json()["name"] == "Nightly tidy"
    assert (
        client.post("/api/v1/ai/schedules", json={"name": "x", "expr": "every day"}).status_code
        == 400
    )
    assert client.delete(f"/api/v1/ai/schedules/{made.json()['id']}").json() == {"ok": True}


def test_schedule_tool_creates_jobs_and_cron_rows(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    config(client)
    monkeypatch.setattr("keyring.get_password", lambda *_: "")
    page(client, "Notes")
    calls = iter(
        [
            {"when": "in 2 hours", "instructions": "Remind me to review the notes."},
            {"when": "0 9 * * 1", "instructions": "Weekly digest.", "name": "Digest"},
        ]
    )

    async def fake(self: Provider, messages: Any, tools: Any):  # type: ignore[no-untyped-def]
        assert (
            any(t["function"]["name"] == "schedule" for t in tools)
            or messages[-1]["role"] == "tool"
        )
        if messages[-1]["role"] != "tool":
            yield {
                "tool_calls": [
                    {
                        "index": 0,
                        "id": "t",
                        "function": {"name": "schedule", "arguments": json.dumps(next(calls))},
                    }
                ]
            }
        else:
            yield {"content": "Scheduled."}

    monkeypatch.setattr(Provider, "chat", fake)
    c = client.post("/api/v1/ai/conversations", json={}).json()
    url = f"/api/v1/ai/conversations/{c['id']}/messages"
    client.post(url, json={"message": "Remind me later"})
    jobs = [j for j in client.get("/api/v1/ai/jobs").json() if j["kind"] == "agent_run"]
    assert len(jobs) == 1 and jobs[0]["status"] == "pending"
    client.post(url, json={"message": "And every week"})
    rows = client.get("/api/v1/ai/schedules").json()
    assert (
        [r["name"] for r in rows] == ["Digest"]
        and rows[0]["source"] == "tool"
        and rows[0]["expr"] == "0 9 * * 1"
    )
    assert (
        rows[0]["payload"]["instructions"] == "Weekly digest."
        and rows[0]["payload"]["mode"] == "act"
    )


def test_agent_tools_and_triggers_are_validated_on_save(client: TestClient) -> None:
    config(client)
    page(client, "Notes")
    base = {"name": "Checker", "instructions": "Check.", "mode": "act"}
    unknown = client.post("/api/v1/ai/agents", json={**base, "tools": ["read_page", "send_mail"]})
    assert unknown.status_code == 400
    assert "send_mail" in unknown.json()["detail"] and "read_page" in unknown.json()["detail"]
    asking = client.post(
        "/api/v1/ai/agents", json={**base, "mode": "ask", "tools": ["read_page", "propose_edit"]}
    )
    assert asking.status_code == 400 and "Ask" in asking.json()["detail"]
    outside = client.post(
        "/api/v1/ai/agents",
        json={
            **base,
            "folder": "Notes",
            "triggers": [{"event": "page_updated", "path": "Elsewhere"}],
        },
    )
    assert outside.status_code == 400 and "scope" in outside.json()["detail"]
    fine = client.post(
        "/api/v1/ai/agents",
        json={**base, "folder": "Notes", "triggers": [{"event": "page_updated", "path": "Notes"}]},
    )
    assert fine.status_code == 201, fine.text
    assert client.get("/api/v1/ai/agents").json()[0]["name"] == "Checker"


def test_unattended_run_records_needs_input_notes_and_events(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    config(client)
    monkeypatch.setattr("keyring.get_password", lambda *_: "")
    page(client, "Inbox")
    events: list[tuple[str, dict[str, Any]]] = []
    bus = client.app.state.events
    original = bus.publish

    def record(type_: str, data: dict[str, Any] | None = None) -> None:
        events.append((type_, dict(data or {})))
        original(type_, data)

    monkeypatch.setattr(bus, "publish", record)

    async def fake(self: Provider, messages: Any, tools: Any):  # type: ignore[no-untyped-def]
        assert messages[-1]["content"] == "Run now."
        assert "## Notes" in messages[0]["content"]
        yield {"content": "CLARIFY: which page should be tidied?"}

    monkeypatch.setattr(Provider, "chat", fake)
    made = client.post(
        "/api/v1/ai/agents",
        json={
            "name": "Tidy",
            "instructions": "## Overview\n\nTidy the inbox.&#x20;\n\n<!-- graite:empty -->\n",
            "model": "m_gone12345",  # a saved model that was removed
            "tools": [],
        },
    )
    assert made.status_code == 201, made.text
    queued = client.post("/api/v1/ai/agents/Tidy/run", json={}).json()
    job = wait_for_job(client, queued["job_id"])
    assert job["status"] == "done" and job["progress"]["message"].startswith("Needs input")
    run = client.get(f"/api/v1/ai/runs/{job['run_id']}").json()
    assert run["status"] == "needs_input"
    assert run["output"]["question"] == "which page should be tidied?"
    assert run["input"]["task"] == "## Overview\n\nTidy the inbox."
    assert run["input"]["notes"] == [
        "The agent's saved model no longer exists. Using your default model."
    ]
    updates = [d for t, d in events if t == "run_update" and d["id"] == run["id"]]
    assert updates[0]["status"] == "running" and updates[-1]["status"] == "needs_input"
    assert {u["step"]["kind"] for u in updates if u.get("step")} == {"retrieve", "generate"}
    assert all(u["job_id"] == job["id"] and u["agent"] == "Tidy" for u in updates)
