# ruff: noqa: E501
from __future__ import annotations

import json
from typing import Any

import pytest
from fastapi.testclient import TestClient

from graite.assistant.profile import join_sections, split_sections
from graite.models.providers import Provider
from tests.test_ai import config, page
from tests.test_chat_v2 import events_of

BODY = {
    "name": "Ada",
    "sections": {
        "personality": "Warm, brief, a little dry.",
        "goals": "- Help me ship the Atlas project.",
    },
}


def setup(client: TestClient, **extra: Any) -> dict[str, Any]:
    response = client.put("/api/v1/assistant", json={**BODY, **extra})
    assert response.status_code == 200, response.text
    return response.json()


def appending(target: str, text: str, prompts: list[Any]):  # type: ignore[no-untyped-def]
    async def fake(self: Provider, messages: Any, tools: Any, **options: Any):  # type: ignore[no-untyped-def]
        prompts.append(messages)
        if messages[-1]["role"] != "tool":
            yield {
                "tool_calls": [
                    {
                        "index": 0,
                        "id": "t1",
                        "function": {
                            "name": "propose_append",
                            "arguments": json.dumps(
                                {"path": target, "text": text, "summary": "Remember this"}
                            ),
                        },
                    }
                ]
            }
        else:
            yield {"content": "Noted."}

    return fake


def test_sections_round_trip_and_keep_unknown_headings() -> None:
    body = "Intro line.\n\n## Personality\n\nKind.\n\n## Habits\n\nEarly riser.\n\n## Goals\n\n- Ship.\n"
    sections = split_sections(body)
    assert sections["goals"] == "- Ship."
    assert "Intro line." in sections["personality"] and "## Habits" in sections["personality"]
    assert split_sections(join_sections(sections)) == sections
    assert join_sections({}) == ""


def test_setup_creates_definition_and_memory_pages(client: TestClient) -> None:
    assert client.get("/api/v1/assistant").json()["configured"] is False
    info = setup(client)
    assert info["configured"] and info["name"] == "Ada"
    assert info["sections"]["personality"] == "Warm, brief, a little dry."
    assert info["memory"]["root"] == "Ada"
    assert set(info["memory"]["pages"]) == {"Memories", "Journal"}
    # Setting the assistant up is the consent: what it learns lands on its own pages at once.
    assert info["memory"]["auto_apply"] is True and info["memory"]["opted_in"] is True
    vault = client.app.state.settings.vault
    text = (vault / "_agents" / "assistant.md").read_text()
    assert "assistant: true" in text and "## Goals" in text
    root = (vault / "Ada" / "page.md").read_text()
    assert "autonomy: auto-apply" in root
    # It is an agent like any other, flagged for the Studio.
    agents = client.get("/api/v1/ai/agents").json()
    assert [a["assistant"] for a in agents if a["name"] == "Ada"] == [True]


def test_rename_keeps_file_and_memory_and_renames_the_untouched_root(client: TestClient) -> None:
    first = setup(client)
    renamed = setup(client, name="Nova")
    assert renamed["path"] == first["path"]
    assert renamed["memory"]["page_id"] == first["memory"]["page_id"]
    root = client.get(f"/api/v1/pages/{renamed['memory']['root']}").json()
    assert root["title"] == "Nova"
    assert len(client.get("/api/v1/ai/agents").json()) == 1


def test_generic_agent_editor_keeps_the_assistant_keys(client: TestClient) -> None:
    info = setup(client, voice={"language": "nl"})
    agent = next(a for a in client.get("/api/v1/ai/agents").json() if a["name"] == "Ada")
    response = client.put(
        "/api/v1/ai/agents/Ada",
        json={"name": "Ada", "instructions": agent["instructions"], "description": "Edited"},
    )
    assert response.status_code == 200
    after = client.get("/api/v1/assistant").json()
    assert after["configured"] and after["description"] == "Edited"
    assert after["memory"]["page_id"] == info["memory"]["page_id"]
    assert after["voice"]["language"] == "nl"


def test_a_name_taken_by_another_agent_is_refused(client: TestClient) -> None:
    client.post("/api/v1/ai/agents", json={"name": "Ada", "instructions": "Summarise."})
    assert client.put("/api/v1/assistant", json=BODY).status_code == 409


def test_cloned_voice_needs_consent(client: TestClient) -> None:
    response = client.put(
        "/api/v1/assistant", json={**BODY, "voice": {"reference": "abc-voice.wav"}}
    )
    assert response.status_code == 400 and "consent" in response.json()["detail"]


def test_assistant_survives_deleting_the_index(settings: Any) -> None:
    import shutil

    from graite.app import create_app

    with TestClient(create_app(settings)) as first:
        first.headers["Authorization"] = "Bearer test-token"
        info = setup(first)
        assert first.post("/api/v1/assistant/memory/opt-in").status_code == 200
    shutil.rmtree(settings.vault / ".graite")
    with TestClient(create_app(settings)) as again:
        again.headers["Authorization"] = "Bearer test-token"
        after = again.get("/api/v1/assistant").json()
    assert after["configured"] and after["name"] == "Ada"
    assert after["memory"]["root"] == info["memory"]["root"]
    assert set(after["memory"]["pages"]) == {"Memories", "Journal"}
    # The opt-in lives in the index, but the assistant's own root re-confirms itself rather
    # than putting its memory back behind review because `.graite/` was rebuilt.
    assert after["memory"]["opted_in"] is True


def test_conversation_uses_persona_memory_and_auto_applies_in_memory_only(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    config(client)
    monkeypatch.setattr("keyring.get_password", lambda *_: "")
    info = setup(client)
    profile = info["memory"]["pages"]["Journal"]
    added = client.post(
        "/api/v1/assistant/memory",
        json={"title": "Prefers Dutch in the morning", "kind": "Preference", "pinned": True},
    )
    assert added.status_code == 200, added.text
    # No opt-in call: setting the assistant up already decided this.
    assert client.get("/api/v1/assistant").json()["memory"]["opted_in"] is True

    conversation = client.post("/api/v1/assistant/conversations").json()
    assert client.post("/api/v1/assistant/conversations").json()["id"] == conversation["id"]
    assert (
        client.post("/api/v1/assistant/conversations?fresh=true").json()["id"] != conversation["id"]
    )
    url = f"/api/v1/ai/conversations/{conversation['id']}/messages"

    prompts: list[Any] = []
    monkeypatch.setattr(Provider, "chat", appending(profile, "- Likes oat milk.", prompts))
    events = events_of(client.post(url, json={"message": "Remember I like oat milk"}).text)
    system = prompts[0][0]["content"]
    assert "You are Ada" in system and "Warm, brief" in system
    assert "- Prefers Dutch in the morning\n" in system and "Act mode" in system
    assert "spoken conversation" not in system
    proposal = next(e for e in events if e["type"] == "proposal")["proposal"]
    assert proposal["status"] == "auto_applied"
    assert "oat milk" in client.get(f"/api/v1/pages/{profile}").json()["body"]

    # Outside the memory subtree the page's own policy decides: review by default…
    note = page(client, "Notes")
    monkeypatch.setattr(Provider, "chat", appending(note["path"], "Line.", prompts))
    events = events_of(client.post(url, json={"message": "Add a line to Notes"}).text)
    assert next(e for e in events if e["type"] == "proposal")["proposal"]["status"] == "pending"
    # …and a page that accepts no AI updates refuses the assistant too.
    locked = page(client, "Locked")
    client.put(
        f"/api/v1/pages/{locked['path']}/ai-settings",
        json={"values": {"autonomy": "none"}, "base_hash": locked["hash"]},
    )
    monkeypatch.setattr(Provider, "chat", appending(locked["path"], "Line.", prompts))
    events = events_of(client.post(url, json={"message": "Add a line to Locked"}).text)
    assert not [e for e in events if e["type"] == "proposal"]
    assert "don't allow changes by AI" in prompts[-1][-1]["content"]

    # The assistant's sessions stay out of the chat list and keep history across turns.
    assert client.get("/api/v1/ai/conversations?scope=all").json() == []
    saved = client.get(f"/api/v1/ai/conversations/{conversation['id']}").json()
    assert saved["kind"] == "assistant" and len(saved["messages"]) == 6
    assert [m["content"] for m in prompts[-1] if m["role"] == "user"][0].startswith("Remember")


def wait_for_job(client: TestClient, job_id: str, timeout: float = 10.0) -> dict[str, Any]:
    """The finished job, with its handler result under "result"."""
    from tests.test_agent_jobs import wait_for_job as wait

    job = wait(client, job_id, timeout)
    row = client.app.state.db.execute(
        "SELECT result_json FROM jobs WHERE id=?", (job_id,)
    ).fetchone()
    return {**job, "result": json.loads(row[0] or "{}")}


def test_background_loop_journals_and_asks_questions(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    config(client)
    monkeypatch.setattr("keyring.get_password", lambda *_: "")
    info = setup(client, schedule="0 * * * *")
    client.post("/api/v1/assistant/memory/opt-in")
    assert info["loop"]["enabled"] and info["loop"]["next_run_at"]
    journal = info["memory"]["pages"]["Journal"]
    page(client, "Atlas plan")
    prompts: list[Any] = []

    async def fake(self: Provider, messages: Any, tools: Any, **options: Any):  # type: ignore[no-untyped-def]
        prompts.append((messages, [t["function"]["name"] for t in tools]))
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
                                    "path": journal,
                                    "text": "- Looked at Atlas plan.",
                                    "summary": "Log",
                                }
                            ),
                        },
                    }
                ]
            }
        else:
            yield {"content": "- Logged.\nQUESTION: Is the Atlas deadline still Friday?"}

    monkeypatch.setattr(Provider, "chat", fake)
    job = wait_for_job(client, client.post("/api/v1/assistant/loop/run").json()["job_id"])
    assert job["status"] == "done" and job["result"]["outcome"] == "needs_input"
    system, tools = prompts[0][0][0]["content"], prompts[0][1]
    assert "background pass" in system and "[[Atlas plan]]" in system and "ship the Atlas" in system
    assert "propose_delete" not in tools and "schedule" not in tools
    assert "Looked at Atlas plan" in client.get(f"/api/v1/pages/{journal}").json()["body"]
    after = client.get("/api/v1/assistant").json()
    assert [q["question"] for q in after["questions"]] == ["Is the Atlas deadline still Friday?"]
    client.post(f"/api/v1/assistant/questions/{after['questions'][0]['run_id']}/dismiss")
    assert client.get("/api/v1/assistant").json()["questions"] == []
    runs = client.get("/api/v1/ai/runs?kind=assistant_loop").json()
    assert runs and runs[0]["agent"] == "Ada"


def test_scheduled_pass_is_skipped_when_nothing_changed(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    config(client)
    monkeypatch.setattr("keyring.get_password", lambda *_: "")
    setup(client, schedule="0 * * * *")
    calls: list[Any] = []

    async def fake(self: Provider, messages: Any, tools: Any, **options: Any):  # type: ignore[no-untyped-def]
        calls.append(messages)
        yield {"content": "- Nothing to do."}

    monkeypatch.setattr(Provider, "chat", fake)
    wait_for_job(client, client.post("/api/v1/assistant/loop/run").json()["job_id"])
    assert len(calls) == 1
    schedule_id = client.get("/api/v1/assistant").json()["loop"]["schedule_id"]
    job = wait_for_job(
        client, client.post(f"/api/v1/ai/schedules/{schedule_id}/run").json()["job_id"]
    )
    assert job["result"]["outcome"] == "skipped" and len(calls) == 1


def test_renaming_keeps_the_schedule_row(client: TestClient) -> None:
    first = setup(client, schedule="0 7 * * *")["loop"]
    client.patch(f"/api/v1/ai/schedules/{first['schedule_id']}", json={"enabled": False})
    renamed = setup(client, name="Nova", schedule="0 7 * * *")["loop"]
    assert renamed["schedule_id"] == first["schedule_id"] and renamed["enabled"] is False
    schedules = client.get("/api/v1/ai/schedules").json()
    assert sorted((s["name"], s["job_kind"]) for s in schedules) == [
        ("Nova", "assistant_loop"),
        ("Nova · memory tidy", "assistant_tidy"),  # weekly, with the memory (D57)
    ]


def test_reflection_files_memory_from_the_new_part_of_a_conversation(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    from graite.assistant import service

    config(client)
    monkeypatch.setattr("keyring.get_password", lambda *_: "")
    monkeypatch.setattr(service, "REFLECT_DELAY", service.timedelta(0))
    info = setup(client)
    client.post("/api/v1/assistant/memory/opt-in")
    profile = info["memory"]["pages"]["Journal"]
    prompts: list[Any] = []

    async def talk(self: Provider, messages: Any, tools: Any, **options: Any):  # type: ignore[no-untyped-def]
        system = messages[0]["content"]
        if "just ended" not in system:
            yield {"content": "Nice, enjoy Lisbon."}
            return
        prompts.append(messages)
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
                                    "path": profile,
                                    "text": "- Moving to Lisbon in May.",
                                    "summary": "Move",
                                }
                            ),
                        },
                    }
                ]
            }
        else:
            yield {"content": "- Remembered the move."}

    monkeypatch.setattr(Provider, "chat", talk)
    conversation = client.post("/api/v1/assistant/conversations").json()
    url = f"/api/v1/ai/conversations/{conversation['id']}/messages"
    events_of(client.post(url, json={"message": "I am moving to Lisbon in May"}).text)
    jobs = client.get("/api/v1/ai/jobs?kind=assistant_reflect").json()
    assert len(jobs) == 1
    wait_for_job(client, jobs[0]["id"])
    assert "Lisbon" in client.get(f"/api/v1/pages/{profile}").json()["body"]
    sources = prompts[0][0]["content"]
    assert "Conversation transcript" in sources and "User: I am moving to Lisbon" in sources
    # The reflection may only touch the memory pages: its page tree names Ada, never Atlas.
    assert "\nAda\n" in sources and "Atlas" not in sources


def test_a_live_conversation_preempts_background_work(client: TestClient) -> None:
    import asyncio

    from graite.jobs.queue import Job

    state = client.app.state
    started = asyncio.Event()

    async def scenario() -> tuple[bool, list[Any]]:
        async def slow() -> None:
            started.set()
            await asyncio.sleep(30)

        from graite.jobs.worker import JobContext

        job_id = state.queue.enqueue("assistant_loop", {"preemptible": True}, key="assistant_loop")
        state.db.execute("UPDATE jobs SET status='running' WHERE id=?", (job_id,))
        row = state.db.execute("SELECT * FROM jobs WHERE id=?", (job_id,)).fetchone()
        ctx = JobContext(Job.from_row(row), state.queue, state)
        task = asyncio.ensure_future(slow())
        state.worker.running[job_id] = (task, ctx)
        await started.wait()
        async with state.foreground.hold():
            held = not state.foreground.clear.is_set()
        state.worker.running.pop(job_id, None)
        state.db.execute("UPDATE jobs SET status='cancelled' WHERE id=?", (job_id,))
        pending = state.db.execute(
            "SELECT run_at FROM jobs WHERE kind='assistant_loop' AND status='pending'"
        ).fetchall()
        return held and task.cancelled() and state.foreground.clear.is_set(), pending

    ok, pending = client.portal.call(scenario)  # type: ignore[union-attr]
    assert ok and len(pending) == 1


@pytest.mark.parametrize(
    "schedule",
    [
        "@every 7 minutes",
        "@every 5 hours at 30",
        "@every 3 days at 12:30 from 2026-09-21",
        "@every 2 weeks on 1,4 at 12:30 from 2026-09-21",
    ],
)
def test_assistant_interval_schedules_survive_save_and_reload(
    client: TestClient, schedule: str
) -> None:
    saved = setup(client, schedule=schedule)
    assert saved["schedule"] == schedule
    assert saved["loop"]["next_run_at"] is not None
    loaded = client.get("/api/v1/assistant").json()
    assert loaded["schedule"] == schedule
    assert loaded["loop"]["schedule_id"] == saved["loop"]["schedule_id"]


def searching(query: str, prompts: list[Any]):  # type: ignore[no-untyped-def]
    """A model that looks a page up before answering, the way the prompt now tells it to."""

    async def fake(self: Provider, messages: Any, tools: Any, **options: Any):  # type: ignore[no-untyped-def]
        prompts.append(messages)
        if messages[-1]["role"] != "tool":
            yield {
                "tool_calls": [
                    {
                        "index": 0,
                        "id": "t1",
                        "function": {
                            "name": "search_vault",
                            "arguments": json.dumps({"query": query}),
                        },
                    }
                ]
            }
            return
        yield {"content": "Found it [1]."}

    return fake


def test_a_conversation_searches_only_when_the_model_asks(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Nothing from the vault is pushed at the assistant. It gets the page tree and looks
    things up itself, so a greeting costs no search and no page bodies."""
    config(client)
    monkeypatch.setattr("keyring.get_password", lambda *_: "")
    setup(client)
    doc = page(client, "Lunch spots")
    client.put(
        f"/api/v1/pages/{doc['path']}",
        json={"body": "Bar Alta does the best tosti.\n", "base_hash": doc["hash"]},
    )
    conversation = client.post("/api/v1/assistant/conversations").json()
    url = f"/api/v1/ai/conversations/{conversation['id']}/messages"

    prompts: list[Any] = []

    async def chatting(self: Provider, messages: Any, tools: Any, **options: Any):  # type: ignore[no-untyped-def]
        prompts.append(messages)
        yield {"content": "Hello."}

    monkeypatch.setattr(Provider, "chat", chatting)
    events_of(client.post(url, json={"message": "hi"}).text)
    system = prompts[0][0]["content"]
    # The tree names the page; its body was never loaded.
    assert "Lunch spots" in system and "Bar Alta" not in system
    assert "## Your pages" in system and "read_page(path" in system
    assert "(no matching passages)" in system

    run_id = client.get("/api/v1/ai/runs").json()[0]["id"]
    steps = [s["kind"] for s in client.get(f"/api/v1/ai/runs/{run_id}").json()["steps"]]
    assert "retrieve" not in steps and "on_demand" in steps

    # Ask something the notes cover and the model goes and looks.
    prompts.clear()
    monkeypatch.setattr(Provider, "chat", searching("tosti", prompts))
    events = events_of(client.post(url, json={"message": "where do I get a tosti?"}).text)
    assert [e for e in events if e["type"] == "tool_start" and e["name"] == "search_vault"]
    assert "Bar Alta" in json.dumps(prompts[-1])


def test_every_assistant_conversation_is_reflected_on_once(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Ask mode learns too, and a conversation folds into one pending reflection that waits
    until it has gone quiet."""
    from datetime import UTC, datetime, timedelta

    from graite.assistant import service

    config(client)
    monkeypatch.setattr("keyring.get_password", lambda *_: "")
    setup(client, mode="ask")

    async def reply(self: Provider, messages: Any, tools: Any, **options: Any):  # type: ignore[no-untyped-def]
        yield {"content": "Noted."}

    monkeypatch.setattr(Provider, "chat", reply)
    conversation = client.post("/api/v1/assistant/conversations").json()
    url = f"/api/v1/ai/conversations/{conversation['id']}/messages"
    db = client.app.state.db

    def pending() -> list[Any]:
        return db.execute(
            "SELECT id, run_at FROM jobs WHERE kind='assistant_reflect' AND status='pending'"
        ).fetchall()

    events_of(client.post(url, json={"message": "I prefer tea over coffee"}).text)
    first = pending()
    assert len(first) == 1
    # Pretend the first turn was a while ago: its reflection is due sooner than a new one.
    earlier = (datetime.now(UTC) + timedelta(seconds=60)).isoformat()
    db.execute("UPDATE jobs SET run_at=? WHERE id=?", (earlier, first[0]["id"]))
    events_of(client.post(url, json={"message": "And I live in Lisbon"}).text)
    second = pending()
    assert [r["id"] for r in second] == [first[0]["id"]]
    assert second[0]["run_at"] > earlier  # pushed back to after the last turn
    task = service.reflect_task(client.app.state.definitions.assistant(), "Ada")
    assert "search_memory" in task and "Ada/Memories" in task and "task or project status" in task
