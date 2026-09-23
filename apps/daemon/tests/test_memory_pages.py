"""One page per memory (D56): pinned ones in every prompt, the rest recalled when relevant."""

from __future__ import annotations

import asyncio
import json
from typing import Any

import pytest
from fastapi.testclient import TestClient

from graite.assistant import memory
from graite.vault.blocks import check_fences
from tests.test_assistant import setup


def remember(client: TestClient, title: str, **extra: Any) -> dict[str, Any]:
    response = client.post("/api/v1/assistant/memory", json={"title": title, **extra})
    assert response.status_code == 200, response.text
    return response.json()


def test_setup_makes_a_memories_list_and_a_journal(client: TestClient) -> None:
    info = setup(client)
    pages = info["memory"]["pages"]
    assert set(pages) == {"Memories", "Journal"} and info["memory"]["legacy"] == []
    body = client.get(f"/api/v1/pages/{pages['Memories']}").json()["body"]
    assert "```graite:view" in body and check_fences(body) is None
    root = client.get(f"/api/v1/pages/{info['memory']['root']}").json()["frontmatter"]
    assert "delete" in root["auto_apply_kinds"]


def test_pinned_memories_are_always_there_the_rest_only_when_relevant(
    client: TestClient,
) -> None:
    setup(client)
    remember(client, "The user goes by Sam", kind="About", pinned=True)
    remember(client, "Prefers due dates on todos to plan the week", kind="Preference")
    remember(client, "Sister Anna lives in Lisbon", kind="Person", body="Visits in May.")
    state = client.app.state

    core = asyncio.run(memory.core(state, "Ada", cloud=False))
    assert core == "- The user goes by Sam"

    def recall(text: str) -> str:
        return asyncio.run(memory.recall(state, "Ada", text, cloud=False, voice=True))

    assert recall("hi") == ""  # a greeting recalls nothing
    assert recall("What are my todos this week?").startswith("- Prefers due dates")
    anna = recall("When is Anna coming over?")
    assert anna == "- Sister Anna lives in Lisbon — Visits in May."
    assert "Sam" not in anna  # pinned ones are in the core already
    listed = client.get("/api/v1/assistant/memory").json()["items"]
    seen = {m["title"]: m["last_recalled"] for m in listed}
    assert seen["Sister Anna lives in Lisbon"] and seen["The user goes by Sam"] is None


def test_upgrade_turns_profile_and_playbook_bullets_into_memory_pages(
    client: TestClient,
) -> None:
    info = setup(client)
    root = info["memory"]["root"]
    state = client.app.state

    async def legacy() -> None:
        ops = state.fileops
        profile = await ops.create_page(root, "Profile", None, "ui")
        await ops.write_body(
            profile.path,
            "## About\n\n- The user goes by Sam.\n\n## Preferences\n\n- Wants due dates on "
            "to-dos so the week's priorities can be sorted, especially for the launch.\n\n"
            "## People\n\n## Other\n\n- Tracks projects as a property.\n",
            profile.hash,
            "ui",
        )
        playbook = await ops.create_page(root, "Playbook", None, "ui")
        await ops.write_body(
            playbook.path, "- Answer duplicated messages once.\n", playbook.hash, "ui"
        )
        await ops.set_ai_settings(
            root, {"auto_apply_kinds": ["append", "create", "edit"]}, None, "ui"
        )

    asyncio.run(legacy())
    before = client.get("/api/v1/assistant").json()["memory"]
    assert before["legacy"] == ["Profile", "Playbook"]
    # Until the upgrade the old lists still reach the prompt, so nothing is forgotten.
    assert "The user goes by Sam." in asyncio.run(memory.core(state, root, cloud=False))

    result = client.post("/api/v1/assistant/memory/upgrade").json()
    assert result["created"] == 4
    items = {m["title"]: m for m in client.get("/api/v1/assistant/memory").json()["items"]}
    rik = items["The user goes by Sam"]
    assert rik["kind"] == "About" and rik["pinned"]
    long = next(m for m in items.values() if m["title"].startswith("Wants due dates"))
    assert long["kind"] == "Preference" and not long["pinned"] and "launch" in long["body"]
    assert items["Tracks projects as a property"]["kind"] == "Other"
    assert items["Answer duplicated messages once"]["kind"] == "Lesson"
    after = client.get("/api/v1/assistant").json()["memory"]
    assert after["legacy"] == [] and set(after["pages"]) == {"Memories", "Journal"}
    root_meta = client.get(f"/api/v1/pages/{root}").json()["frontmatter"]
    assert "delete" in root_meta["auto_apply_kinds"]
    # Twice is harmless.
    assert client.post("/api/v1/assistant/memory/upgrade").json()["created"] == 0


def test_the_assistant_searches_and_forgets_memories_without_review(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    from graite.models.providers import Provider
    from tests.test_ai import config
    from tests.test_chat_v2 import events_of

    config(client)
    monkeypatch.setattr("keyring.get_password", lambda *_: "")
    setup(client)
    stale = remember(client, "Working on the Linden IT todo list", kind="Project")
    conversation = client.post("/api/v1/assistant/conversations").json()
    url = f"/api/v1/ai/conversations/{conversation['id']}/messages"
    results: list[str] = []

    async def fake(self: Provider, messages: Any, tools: Any, **options: Any):  # type: ignore[no-untyped-def]
        names = {t["function"]["name"] for t in tools or []}
        assert "search_memory" in names
        done = [m for m in messages if m["role"] == "tool"]
        results.extend(m["content"] for m in done[len(results) :])
        calls = [
            ("search_memory", {"query": "Linden todo"}),
            ("propose_delete", {"path": stale["path"], "summary": "Task status, not a memory"}),
        ]
        if len(done) < len(calls):
            name, args = calls[len(done)]
            yield {
                "tool_calls": [
                    {
                        "index": 0,
                        "id": f"t{len(done)}",
                        "function": {"name": name, "arguments": json.dumps(args)},
                    }
                ]
            }
        else:
            yield {"content": "Forgotten."}

    monkeypatch.setattr(Provider, "chat", fake)
    events_of(client.post(url, json={"message": "Forget the Linden list"}).text)
    found = json.loads(results[0])["memories"]
    assert [m["title"] for m in found] == ["Working on the Linden IT todo list"]
    assert json.loads(results[1])["status"] == "auto_applied"
    assert client.get("/api/v1/assistant/memory").json()["items"] == []


def test_the_tidy_pass_is_scheduled_and_sees_every_memory(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    from graite.models.providers import Provider
    from tests.test_ai import config
    from tests.test_assistant import wait_for_job

    config(client)
    monkeypatch.setattr("keyring.get_password", lambda *_: "")
    setup(client)
    schedules = client.get("/api/v1/ai/schedules").json()
    assert ("assistant_tidy", "0 4 * * 0") in {(s["job_kind"], s["expr"]) for s in schedules}

    remember(client, "Likes tea", kind="Preference")
    remember(client, "Prefers tea over coffee", kind="Preference")
    prompts: list[Any] = []

    async def fake(self: Provider, messages: Any, tools: Any, **options: Any):  # type: ignore[no-untyped-def]
        prompts.append(messages)
        yield {"content": "Merged nothing."}

    monkeypatch.setattr(Provider, "chat", fake)
    job = client.post("/api/v1/assistant/memory/tidy")
    assert job.status_code == 202
    wait_for_job(client, job.json()["job_id"])
    system = prompts[0][0]["content"]
    assert "Likes tea" in system and "Prefers tea over coffee" in system
    assert "never recalled" in system and "Merge duplicates" in system
