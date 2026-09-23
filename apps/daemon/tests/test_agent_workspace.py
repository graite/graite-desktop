from __future__ import annotations

import asyncio
import json
from pathlib import Path
from types import SimpleNamespace
from typing import Any
from unittest.mock import Mock

import pytest
from fastapi.testclient import TestClient

from graite.agents.definitions import (
    AgentDef,
    agent_query,
    clean_instructions,
    parse_agent,
    render_agent,
)
from graite.agents.knowledge import linked_sources
from graite.agents.triggers import PageTriggers
from graite.models.providers import Provider
from graite.retrieval.scope import Scope, resolve
from tests.test_agent_jobs import wait_for_job
from tests.test_ai import config, page
from tests.test_cron import make


def test_empty_tools_and_trigger_roundtrip() -> None:
    values = {
        "name": "Test",
        "tools": [],
        "triggers": [{"event": "page_created", "path": "Meetings", "enabled": False}],
    }
    agent = parse_agent("_agents/test.md", "", render_agent(values, "## Overview\n\nRead."))
    assert agent.tools == []
    assert agent.triggers == values["triggers"]
    assert agent.instructions.startswith("## Overview")


def test_paused_schedule_stays_paused_after_sync(tmp_path: Path) -> None:
    cron, _, _ = make(tmp_path)
    cron.sync()
    row = next(r for r in cron.rows() if r["source"] == "agent:review")
    cron.update(row["id"], enabled=False)
    cron.sync()
    assert cron.get(row["id"])["enabled"] is False  # type: ignore[index]


async def test_triggers_debounce_respect_scope_and_do_not_loop() -> None:
    agent = AgentDef(
        "Review", "", "_agents/review.md", "", Scope("folder", ["Meetings"], ["Meetings/Private"])
    )
    agent.triggers = [{"event": "page_updated", "path": "Meetings", "enabled": True}]
    state = SimpleNamespace(
        definitions=SimpleNamespace(agents=lambda: [agent], agent=lambda name: agent), queue=Mock()
    )
    runner = PageTriggers(state, delay=0.01)
    for _ in range(3):
        runner.handle("file_changed", {"path": "Meetings/Weekly", "actor": "ui"})
    runner.handle("file_changed", {"path": "Meetings/Private", "actor": "ui"})
    runner.handle("file_changed", {"path": "Meetings/Other", "actor": "agent"})
    runner.handle("file_changed", {"path": "Other", "actor": "ui"})
    await asyncio.sleep(0.04)
    state.queue.enqueue.assert_called_once()
    assert state.queue.enqueue.call_args.args[1] == {
        "agent": "Review",
        "trigger": "page_updated",
        "trigger_page": "Meetings/Weekly",
    }
    runner.handle("file_changed", {"path": "Meetings/Weekly", "actor": "external"})
    agent.triggers[0]["enabled"] = False
    await asyncio.sleep(0.04)
    assert state.queue.enqueue.call_count == 1
    await runner.stop()


def test_builder_clarifies_then_returns_validated_patch_without_writing(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    config(client)
    monkeypatch.setattr("keyring.get_password", lambda *_: "")
    outputs = iter(
        [
            {"message": "What time in UTC?", "patch": None},
            {"message": "Ready to review.", "patch": {"schedule": "0 9 * * *"}},
            {"message": "Oops", "patch": {"schedule": "tomorrow"}},
            {"message": "Oops", "patch": {"tools": ["send_email"]}},
        ]
    )
    seen = []

    async def fake(self: Provider, messages: Any, tools: Any):  # type: ignore[no-untyped-def]
        seen.append((messages, tools))
        yield {"content": json.dumps(next(outputs))}

    monkeypatch.setattr(Provider, "chat", fake)
    draft = {"name": "Daily review", "instructions": "## Overview\n\nReview.", "skills": ["review"]}
    body = {"draft": draft, "messages": [{"role": "user", "content": "Set a schedule"}]}
    first = client.post("/api/v1/ai/agent-builder", json=body)
    assert first.status_code == 200, first.text
    assert first.json()["draft"] is None
    body["messages"] += [
        {"role": "assistant", "content": "What time in UTC?"},
        {"role": "user", "content": "9 AM UTC"},
    ]
    second = client.post("/api/v1/ai/agent-builder", json=body)
    assert second.status_code == 200, second.text
    result = second.json()["draft"]
    assert result["schedule"] == "0 9 * * *" and result["skills"] == ["review"]
    assert result["instructions"] == draft["instructions"]
    assert not client.get("/api/v1/ai/agents").json()
    assert not client.get("/api/v1/ai/schedules").json()
    assert all(tools == [] for _, tools in seen)
    for _ in range(2):
        assert client.post("/api/v1/ai/agent-builder", json=body).status_code == 400


def test_agent_empty_tools_enforced_and_links_included(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    config(client)
    monkeypatch.setattr("keyring.get_password", lambda *_: "")
    note = page(client, "Routing rules")
    client.put(
        f"/api/v1/pages/{note['path']}",
        json={"body": "Route orange requests to Cedar.", "base_hash": note["hash"]},
    )
    prompts = []

    async def fake(self: Provider, messages: Any, tools: Any):  # type: ignore[no-untyped-def]
        prompts.append((messages, tools))
        yield {"content": "Reviewed."}

    monkeypatch.setattr(Provider, "chat", fake)
    created = client.post(
        "/api/v1/ai/agents",
        json={
            "name": "Routing",
            "instructions": "Follow [[Routing rules]].",
            "tools": [],
        },
    )
    assert created.status_code == 201 and created.json()["tools"] == []
    queued = client.post("/api/v1/ai/agents/Routing/run", json={}).json()
    assert wait_for_job(client, queued["job_id"])["status"] == "done"
    assert prompts and all(tools == [] for _, tools in prompts)
    assert "Route orange requests to Cedar." in str(prompts)
    # Explicit links cannot widen the user's scope.
    state = client.app.state
    limited = resolve(
        state.db, state.settings.vault, Scope("vault", [], [note["path"]]), cloud_provider=False
    )
    assert linked_sources(state, "[[Routing rules]]", limited) == []


def test_page_creation_triggers_and_rename_preserves_definition(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    config(client)
    monkeypatch.setattr("keyring.get_password", lambda *_: "")
    parent = page(client, "Meetings")

    async def fake(self: Provider, messages: Any, tools: Any):  # type: ignore[no-untyped-def]
        yield {"content": "Done."}

    monkeypatch.setattr(Provider, "chat", fake)
    body = {
        "name": "Follow up",
        "instructions": "Read the triggered meeting.",
        "tools": [],
        "triggers": [{"event": "page_created", "path": parent["path"]}],
    }
    made = client.post("/api/v1/ai/agents", json=body).json()
    client.app.state.page_triggers.delay = 0.01
    child = client.post("/api/v1/pages", json={"title": "Weekly", "parent_path": parent["path"]})
    assert child.status_code == 201, child.text
    import time

    deadline = time.monotonic() + 3
    jobs = []
    while time.monotonic() < deadline:
        jobs = [j for j in client.get("/api/v1/ai/jobs").json() if j["kind"] == "agent_run"]
        if jobs:
            break
        time.sleep(0.02)
    assert jobs
    assert wait_for_job(client, jobs[0]["id"])["status"] == "done"
    body["name"] = "Renamed"
    renamed = client.put("/api/v1/ai/agents/Follow up", json=body)
    assert renamed.status_code == 200, renamed.text
    assert renamed.json()["path"] == made["path"]
    invalid = {**body, "name": "Broken", "schedule": "invalid"}
    assert client.put("/api/v1/ai/agents/Renamed", json=invalid).status_code == 400
    assert client.get("/api/v1/ai/agents").json()[0]["name"] == "Renamed"


def test_local_agent_model_overrides_cloud_default() -> None:
    from graite.models.config import AIConfig
    from graite.models.downloader import CatalogModel
    from graite.models.resolution import resolve as resolve_model

    local = CatalogModel(
        id="local-chat",
        name="Local",
        role="chat",
        repo="test",
        revision="test",
        sha256="",
        size=0,
        ctx=8192,
        min_ram_gb=1,
        tier="test",
        notes="",
        verified_llama=None,
        filename="model.gguf",
        status="installed",
        local_path="/tmp/model.gguf",
    )
    config, fallback = resolve_model(
        AIConfig(provider="compatible", model="remote"),
        {"model": "local-chat"},
        [],
        {"local-chat": local},
    )
    assert (
        config.provider == "local" and config.model_path == "/tmp/model.gguf" and fallback is None
    )


def test_clean_instructions_drops_editor_artifacts_but_parse_keeps_them() -> None:
    body = "## Overview\n\nSummarise.&#x20;\n\n[[Graite]]\n\n\n\n<!-- graite:empty -->\n"
    agent = parse_agent("_agents/a.md", "", render_agent({"name": "A"}, body))
    assert "<!-- graite:empty -->" in agent.instructions  # the file round-trips verbatim
    assert clean_instructions(agent.instructions) == "## Overview\n\nSummarise. \n\n[[Graite]]"
    query = agent_query("Summarize graite page.", clean_instructions(agent.instructions), "Graite")
    assert query == "Summarize graite page. Summarise. Graite"
    assert agent_query("", "## Only a heading\n\n- [[Link]]\n1. Read the page.\n2. Report.") == (
        "Read the page. Report."
    )
