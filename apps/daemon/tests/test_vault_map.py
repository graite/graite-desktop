"""The vault map and progressive reading (D103): summaries, read_navigation, merged search
hits, section reads, pinned pages."""

from __future__ import annotations

import asyncio
import json
import time
from collections.abc import AsyncIterator
from types import SimpleNamespace
from typing import Any

import pytest
from fastapi.testclient import TestClient

from graite.index import summaries
from graite.jobs.handlers import summarize_page
from graite.models.providers import Provider

MCP = {
    "Accept": "application/json, text/event-stream",
    "Content-Type": "application/json",
    "X-Graite-MCP-Client": "test-client",
}


def call(client: TestClient, name: str, /, **arguments: Any) -> Any:
    body = {
        "jsonrpc": "2.0",
        "id": 1,
        "method": "tools/call",
        "params": {"name": name, "arguments": arguments},
    }
    response = client.post("/mcp", json=body, headers=MCP)
    assert response.status_code == 200, response.text
    return json.loads(response.json()["result"]["content"][0]["text"])


def page(client: TestClient, title: str, body: str, parent: str | None = None) -> dict:
    doc = client.post("/api/v1/pages", json={"title": title, "parent_path": parent}).json()
    client.put(f"/api/v1/pages/{doc['path']}", json={"body": body, "base_hash": doc["hash"]})
    return doc


LONG = "This sentence is filler that makes the section long enough to stand alone. " * 12


@pytest.fixture
def notes(client: TestClient) -> TestClient:
    page(client, "Projects", "Everything we are working on.\n")
    page(
        client,
        "Atlas",
        f"## Plan\n\nAtlas ships in March. {LONG}\n\n### Risks\n\nThe supplier is late. {LONG}\n\n"
        f"## Notes\n\n### Risks\n\nBudget risks are small. {LONG}\n\n"
        f"## Budget\n\nThe budget is 40,000 euros. {LONG}\n",
        "Projects",
    )
    page(client, "Pricing", "## Decision\n\nWe charge 20 euro per seat.\n")
    return client


def test_excerpt_and_clean() -> None:
    assert summaries.excerpt("## Plan\n\nAtlas ships in **March**.\n\n| a | b |") == (
        "Plan Atlas ships in March ."
    ) or "Atlas ships in" in summaries.excerpt("## Plan\n\nAtlas ships in **March**.")
    assert len(summaries.excerpt("word " * 100)) <= 141
    assert summaries.clean('<think>x</think>Summary: "Atlas ships in March."\nMore.') == (
        "Atlas ships in March."
    )


def test_read_navigation_maps_pages_without_their_text(notes: TestClient) -> None:
    result = call(notes, "read_navigation")
    assert result["pages"] == 3
    lines = result["map"].split("\n")
    assert lines[0] == "Pricing: We charge 20 euro per seat."
    # Until a summary exists the first lines stand in; the body is not there.
    atlas = next(line for line in lines if line.startswith("Projects/Atlas"))
    assert "Atlas ships in March" in atlas and "40,000" not in result["map"]
    assert len(result["map"]) < 700
    under = call(notes, "read_navigation", path="Projects")
    assert under["pages"] == 2 and "Pricing" not in under["map"]


def test_summaries_are_written_once_per_change_by_a_local_model(
    notes: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    state = notes.app.state
    db = state.db
    asked: list[str] = []

    async def chat(self: Provider, messages: Any, tools: Any, **options: Any) -> AsyncIterator:
        asked.append(messages[-1]["content"].split("\n")[0])
        assert options.get("thinking") is False and tools == []
        yield {"content": "A one-line summary of " + messages[-1]["content"].split("\n")[0][2:]}

    monkeypatch.setattr(Provider, "chat", chat)
    ctx = SimpleNamespace(
        state=state,
        cancelled=asyncio.Event(),
        job=SimpleNamespace(payload={"preemptible": True}),
        progress=lambda **_: None,
    )
    run = lambda: notes.portal.call(summarize_page, ctx)  # noqa: E731

    # A cloud model never summarises, and neither does a local model that is not loaded.
    assert "local model only" in run()["skipped"]
    config = notes.get("/api/v1/ai/status").json()["config"]
    db.execute(
        "INSERT OR REPLACE INTO meta VALUES ('ai_config', ?)",
        (json.dumps({**config, "provider": "local", "model_path": "/m.gguf"}),),
    )
    assert "not loaded" in run()["skipped"] and not asked

    state.models.server.process = SimpleNamespace(returncode=None, terminate=lambda: None)

    class Use:
        async def __aenter__(self) -> Provider:
            return Provider("local", "http://x/v1", "local", "")

        async def __aexit__(self, *_: object) -> None:
            return None

    monkeypatch.setattr(state.models, "use", lambda *_: Use())
    try:
        assert run()["summarised"] == 3
        assert sorted(asked) == ["# Atlas", "# Pricing", "# Projects"]
        assert summaries.counts(db) == {"summary_pages": 3, "summaries": 3}
        assert "Pricing: A one-line summary of Pricing" in call(notes, "read_navigation")["map"]
        status = notes.get("/api/v1/ai/index/status").json()
        assert status["summaries"] == 3 and status["summary_pages"] == 3 and status["updated_at"]

        # Nothing changed: nothing is asked again.
        asked.clear()
        assert run()["summarised"] == 0 and not asked
        # One page edited: indexing queues the job, and only that page is summarised again.
        doc = notes.get("/api/v1/pages/Pricing").json()
        notes.put(
            "/api/v1/pages/Pricing",
            json={"body": "## Decision\n\nNow 22 euro per seat.\n", "base_hash": doc["hash"]},
        )
        for _ in range(100):
            if asked:
                break
            time.sleep(0.02)
        run()
        assert asked == ["# Pricing"]
        assert summaries.counts(db)["summaries"] == 3
    finally:
        state.models.server.process = None


def test_search_returns_one_result_per_page_with_a_short_snippet(notes: TestClient) -> None:
    hits = call(notes, "search_vault", query="risks supplier budget")
    paths = [h["path"] for h in hits]
    assert paths.count("Projects/Atlas") == 1  # several passages, one result
    atlas = hits[0]
    assert atlas["path"] == "Projects/Atlas" and atlas["score"] > 0
    assert len(atlas["snippet"]) <= 301 and atlas["snippet"].endswith("…")
    assert atlas["heading"] and atlas["also"]  # the other sections that matched are named
    assert len(json.dumps(hits)) < 1500


def test_read_page_reads_the_section_that_was_asked_for(notes: TestClient) -> None:
    # The exact heading path tells two sections called "Risks" apart.
    plan = call(notes, "read_page", path="Projects/Atlas", section="Plan > Risks")
    assert "supplier is late" in plan["body"] and "Budget risks" not in plan["body"]
    other = call(notes, "read_page", path="Projects/Atlas", section="Notes > Risks")
    assert "Budget risks" in other["body"] and "supplier" not in other["body"]
    budget = call(notes, "read_page", path="Projects/Atlas", section="budget")
    assert budget["section"] == "budget" and "40,000 euros" in budget["body"]
    assert "Atlas ships" not in budget["body"]
    missing = call(notes, "read_page", path="Projects/Atlas", section="Nope")
    assert "section_note" in missing


def test_a_long_page_comes_back_as_an_outline_and_its_beginning(notes: TestClient) -> None:
    big = "\n\n".join(f"## Part {n}\n\n{LONG}{LONG}" for n in range(1, 8))
    page(notes, "Handbook", big)
    whole = call(notes, "read_page", path="Handbook")
    assert whole["truncated"] is True and whole["next_offset"] == len(whole["body"])
    assert whole["outline"] == [f"Part {n}" for n in range(1, 8)]
    assert "section=" in whole["outline_note"]
    # Continuing does not repeat the outline; a short page has none.
    more = call(notes, "read_page", path="Handbook", offset=whole["next_offset"])
    assert "outline" not in more
    assert "outline" not in call(notes, "read_page", path="Pricing")


def test_pinned_pages_are_given_to_the_model_first(
    notes: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    assert (
        notes.put("/api/v1/ai/config", json={"provider": "compatible", "model": "test"}).status_code
        == 200
    )
    monkeypatch.setattr("keyring.get_password", lambda *_: "")
    seen: list[str] = []

    async def chat(self: Provider, messages: Any, tools: Any, **options: Any) -> AsyncIterator:
        seen.append(messages[-1]["content"])
        yield {"content": "Twenty [1]."}

    monkeypatch.setattr(Provider, "chat", chat)
    c = notes.post("/api/v1/ai/conversations", json={"scope": {"kind": "vault"}}).json()
    response = notes.post(
        f"/api/v1/ai/conversations/{c['id']}/messages",
        json={
            "message": "What is in the Atlas budget?",
            "depth": "quick",
            "pinned_paths": ["Pricing", "Nope/Missing"],
        },
    )
    assert response.status_code == 200
    user = seen[0]
    # The pinned page leads the sources although the question is about another page.
    assert user.index("[1] Pricing") < user.index("20 euro per seat")
    assert user.index("20 euro per seat") < user.index("40,000 euros")
    saved = notes.get(f"/api/v1/ai/conversations/{c['id']}").json()["messages"][0]
    assert saved["pinned"] == ["Pricing"]
