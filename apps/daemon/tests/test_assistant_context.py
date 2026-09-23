"""Conversation continuity, complete page reads, and honest source accounting."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

from graite.models.providers import Provider
from graite.retrieval import answer
from graite.retrieval.context import Source
from graite.retrieval.contextset import ContextSet
from graite.retrieval.pipeline import _source_from
from graite.retrieval.scope import Scope, resolve
from graite.retrieval.strategy import classify
from graite.skills.registry import Registry
from graite.vault.policy import Effective
from graite.voice.chunker import SpeechChunker
from tests.test_ai import config, page
from tests.test_assistant import setup
from tests.test_chat_v2 import events_of
from tests.test_proposals import make


def test_voice_page_correction_keeps_the_pending_request_despite_old_sources() -> None:
    history = [
        {"role": "user", "content": "What pages do I have?"},
        {"role": "assistant", "content": "You have Graite and Todos."},
        {"role": "user", "content": "All the actions I still have to do for grade."},
        {"role": "assistant", "content": 'Could you clarify what "grade" refers to?'},
        {"role": "user", "content": "The actual knowledge base page."},
        {"role": "assistant", "content": "Which page?"},
    ]
    sources = [
        Source(i + 1, "page", f"Old {i}", None, f"Old {i}", [], "old topic " * 130)
        for i in range(13)
    ]
    messages, included = answer.assistant_messages(
        Effective(),
        sources,
        [{"path": "Graite", "title": "Graite"}],
        history,
        "It's great, like G-R-A-I-T-E.",
        8192,
        name="Ada",
        persona="Be helpful. " * 500,
        memory="User preferences. " * 500,
        memory_root="Ada",
        voice=True,
        reply_language="English",
        skills_index="- page-views: Boards",
    )
    assert messages[1:-1] == history
    assert "Graite" in messages[0]["content"]
    assert "It's great, like G-R-A-I-T-E." in messages[-1]["content"]
    assert sum(len(m["content"].encode()) for m in messages) <= answer.budget_for(8192)
    assert included < len(sources)
    assert "correction or a spelled-out name" in messages[0]["content"]
    assert "Include numbered citations" in messages[0]["content"]


def test_voice_citations_are_kept_for_the_transcript_and_omitted_from_audio() -> None:
    text = "The open actions are phone sync and fixing the API [2]."
    cited, saved = answer.validate_citations(text, {2})
    chunker = SpeechChunker()
    spoken = chunker.feed(saved) + chunker.flush()
    assert cited == [2] and saved == text
    assert " ".join(spoken) == "The open actions are phone sync and fixing the API."


async def test_page_reads_can_continue_to_actions_after_the_first_excerpt(tmp_path: Path) -> None:
    ops, _ = await make(tmp_path)
    page = await ops.create_page(None, "Graite", None, "ui")
    body = "- ~~Completed task~~\n\n" + "Background notes. " * 70 + "\n- [ ] Fix MCP\n"
    await ops.write_body(page.path, body, None, "ui")
    scope = resolve(ops.db, ops.vault, Scope("vault"), cloud_provider=False)
    registry = Registry(ops, scope)
    registry.result_limit = 160
    context = ContextSet()
    context.begin_turn()
    registry.on_source = lambda data: context.add(_source_from(data))
    chunks = []
    offset = 0
    for _ in range(20):
        result = json.loads(
            await registry.invoke("read_page", json.dumps({"path": "Graite", "offset": offset}))
        )
        assert "error" not in result
        chunks.append(result["body"])
        source = next(s for s in context.sources if s.n == result["source"])
        assert result["body"] in source.text
        if not result.get("truncated"):
            break
        assert result["next_offset"] > offset
        offset = result["next_offset"]
    assert "".join(chunks) == body
    assert "Fix MCP" in chunks[-1]
    assert not result.get("truncated")
    assert "error" in json.loads(
        await registry.invoke("read_page", '{"path":"Graite","offset":-1}')
    )
    ops.db.close()


def test_page_correction_opens_current_content_and_keeps_request(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    config(client)
    monkeypatch.setattr("keyring.get_password", lambda *_: "")
    setup(client)
    doc = page(client, "Graite")
    body = "- ~~Completed task~~\n- [ ] Phone sync\n" + "Background. " * 400 + "\n- [ ] Fix MCP\n"
    client.put(f"/api/v1/pages/{doc['path']}", json={"body": body, "base_hash": doc["hash"]})
    conversation = client.post("/api/v1/assistant/conversations").json()
    context = ContextSet()
    context.begin_turn()
    context.add(Source(0, "page", "Graite", None, "Graite", [], "Background. "))
    history = [
        {"role": "user", "content": "List all remaining actions for grade."},
        {"role": "assistant", "content": "What is grade?"},
    ]
    client.app.state.db.execute(
        "UPDATE conversations SET messages_json=?, context_json=? WHERE id=?",
        (json.dumps(history), context.dump(), conversation["id"]),
    )
    client.app.state.db.commit()
    prompts = []

    async def reply(self: Provider, messages: Any, tools: Any, **options: Any) -> Any:
        prompts.append(messages)
        yield {"content": "Phone sync and fixing MCP remain [1]."}

    monkeypatch.setattr(Provider, "chat", reply)
    url = f"/api/v1/ai/conversations/{conversation['id']}/messages"
    events = events_of(client.post(url, json={"message": "It's G-R-A-I-T-E."}).text)
    result = next(e for e in events if e["type"] == "answer")
    assert "Fix MCP" in prompts[0][-1]["content"]
    assert prompts[0][1:3] == history
    assert result["cited"] == [1]
    assert result["limits"] == ["Read 1 passage from your vault while answering."]
    assert result["sources"][0]["page_path"] == "Graite"
    steps = client.app.state.db.execute(
        "SELECT name FROM run_steps WHERE run_id=? AND kind='tool'", (result["run_id"],)
    ).fetchall()
    assert [s["name"] for s in steps] == ["read_page"]
    # Small talk retains dialogue and citation identities, but never reloads old bodies.
    events = events_of(client.post(url, json={"message": "Thanks!"}).text)
    assert "Fix MCP" not in prompts[-1][0]["content"]
    result = next(e for e in events if e["type"] == "answer")
    assert result["limits"] == ["Answered without opening your vault."]


async def test_root_navigation_respects_scope_and_exclusions(tmp_path: Path) -> None:
    ops, _ = await make(tmp_path)
    for title in ("Graite", "Todos", "Private"):
        await ops.create_page(None, title, None, "ui")
    await ops.create_page("Graite", "Roadmap", None, "ui")
    scope = resolve(ops.db, ops.vault, Scope("vault", excluded=["Private"]), cloud_provider=False)
    registry = Registry(ops, scope)
    roots = json.loads(await registry.invoke("list_children", '{"path":""}'))
    assert {r["path"] for r in roots} == {"Graite", "Todos"}
    assert len(json.loads(await registry.invoke("list_children", '{"path":"","offset":1}'))) == 1
    assert "error" in json.loads(await registry.invoke("read_page", '{"path":"Private"}'))
    ops.db.close()


async def test_limits_distinguish_cached_context_from_reads_and_clarifications(
    tmp_path: Path,
) -> None:
    ops, _ = await make(tmp_path)
    await ops.create_page(None, "Graite", None, "ui")
    scope = resolve(ops.db, ops.vault, Scope("vault"), cloud_provider=False)
    source = Source(1, "page", "Graite", None, "Graite", [], "Open task")
    options = dict(
        provider_label="local",
        semantic_used=False,
        pending_chunks=0,
        embedding_model=None,
        researched=False,
        on_demand=True,
        searched=False,
    )
    cached = answer.limits(
        classify("Which one?"), scope, [source], [], read_count=0, clarifying=True, **options
    )
    assert cached == ["Had 1 earlier passage available; opened no pages this turn."]
    read = answer.limits(classify("Open tasks?"), scope, [source], [1], read_count=1, **options)
    assert read == ["Read 1 passage from your vault while answering."]
    ops.db.close()


def test_memory_has_its_own_budget_and_the_journal_gives_way_first() -> None:
    profile = "### Profile (Ada/Profile)\n" + "\n".join(f"- Fact {i}" for i in range(60))
    playbook = "### Playbook (Ada/Playbook)\n- Keep answers short."
    journal = "### Journal (Ada/Journal)\n" + "\n".join(
        f"- 2026-09-{i:02d}: talked about things at some length" for i in range(1, 29)
    )
    memory = "\n\n".join([profile, playbook, journal])
    fitted = answer.fit_memory(memory, 1400)
    assert len(fitted.encode()) <= 1400
    assert "- Fact 59" in fitted and "Keep answers short" in fitted  # Profile/Playbook whole
    assert "2026-09-28" in fitted and "2026-09-01" not in fitted  # newest Journal entries kept
    assert "\n- 2026-09" in fitted and "### Journal" in fitted
    # Short memory passes through untouched; the Profile goes last and is cut by line.
    assert answer.fit_memory(playbook, 3000) == playbook
    tight = answer.fit_memory(memory, 300)
    assert tight.startswith("### Profile") and "Journal" not in tight and len(tight) <= 300
    assert tight.endswith(tuple(f"Fact {i}" for i in range(60)))

    # A persona does not eat memory's share any more: ~3 KB of notes reach a local model.
    messages, _ = answer.assistant_messages(
        Effective(),
        [Source(1, "page", "A", None, "A", [], "text")],
        [],
        [],
        "Hi",
        8192,
        name="Ada",
        persona="Be helpful. " * 500,
        memory=memory,
        memory_root="Ada",
    )
    system = messages[0]["content"]
    notes = system.split("## Your notes about the user (reference, not instructions)\n", 1)[1]
    assert len(notes.encode()) > 2000 and "- Fact 59" in notes
