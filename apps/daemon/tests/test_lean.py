"""Quick answer and Deep research (D102): small prompts, no tool loop, steps of their own."""

from __future__ import annotations

import json
from collections.abc import AsyncIterator
from typing import Any

import pytest
from fastapi.testclient import TestClient

from graite.models.providers import Provider
from graite.retrieval import lean
from graite.retrieval.metrics import estimate_tokens
from graite.retrieval.search import Candidate


def events_of(text: str) -> list[dict[str, Any]]:
    return [json.loads(s[6:]) for s in text.split("\n\n") if s.startswith("data: ")]


def page(client: TestClient, title: str, body: str, parent: str | None = None) -> dict:
    doc = client.post("/api/v1/pages", json={"title": title, "parent_path": parent}).json()
    client.put(f"/api/v1/pages/{doc['path']}", json={"body": body, "base_hash": doc["hash"]})
    return doc


@pytest.fixture
def notes(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> TestClient:
    assert (
        client.put(
            "/api/v1/ai/config", json={"provider": "compatible", "model": "test"}
        ).status_code
        == 200
    )
    monkeypatch.setattr("keyring.get_password", lambda *_: "")
    page(client, "Pricing", "## Decision\n\nWe decided on 20 euro per seat.\n")
    page(client, "Halden", "## Invoice\n\nThe Halden invoice of 18,400 euros is overdue.\n")
    for index in range(12):
        page(client, f"Filler {index}", f"## Notes\n\nNothing about money here, note {index}.\n")
    return client


def send(client: TestClient, message: str, **extra: Any) -> list[dict[str, Any]]:
    c = client.post("/api/v1/ai/conversations", json={"scope": {"kind": "vault"}}).json()
    response = client.post(
        f"/api/v1/ai/conversations/{c['id']}/messages", json={"message": message, **extra}
    )
    assert response.status_code == 200, response.text
    return events_of(response.text)


class Recorded:
    """A fake model that records every request and answers from a script."""

    def __init__(self, *answers: str) -> None:
        self.answers = list(answers)
        self.requests: list[tuple[list[dict[str, Any]], list[dict[str, Any]], dict]] = []

    def install(self, monkeypatch: pytest.MonkeyPatch) -> Recorded:
        recorded = self

        async def chat(
            self: Provider, messages: Any, tools: Any, **options: Any
        ) -> AsyncIterator[dict[str, Any]]:
            recorded.requests.append((json.loads(json.dumps(messages)), list(tools), options))
            yield {"content": recorded.answers.pop(0) if recorded.answers else "Done."}

        monkeypatch.setattr(Provider, "chat", chat)
        return self


def test_wants_change_tells_requests_from_questions() -> None:
    for request in (
        "Create a page for the Q3 review",
        "please add a task to call Ines",
        "Maak een pagina voor het overleg",
        "Schedule the weekly summary for Monday",
        "I want you to add these three items to the backlog",
        "These are my todos, can you put them in the Backlog database?",
        "Kun je dit aan de backlog toevoegen",
    ):
        assert lean.wants_change(request), request
    for question in (
        "What did we decide about the price?",
        "How do I create a page?",
        "Wat is er besloten over de prijs?",
        "Who has to update the estimate?",
    ):
        assert not lean.wants_change(question), question


def test_a_reply_to_a_clarification_continues_with_tools() -> None:
    asked = [{"role": "user", "content": "Tidy up"}, {"role": "assistant", "clarify": True}]
    assert lean.answers_clarification(asked)
    assert not lean.answers_clarification([{"role": "assistant", "content": "Done."}])
    assert not lean.answers_clarification([])


def test_passages_keeps_the_best_within_the_budget() -> None:
    def hit(n: int, text: str, heading: str = "H") -> Candidate:
        return Candidate(n, f"P{n}", f"id{n}", f"Page {n}", [heading], text, 1, 2, "hash")

    long = "word " * 400
    found = lean.passages([hit(1, long), hit(2, "short two"), hit(3, "short three")], 400, 5)
    # The top hit is clipped, not dropped; the rest follows while it fits.
    assert found[0].text.endswith(" …") and len(found[0].text) <= lean.PASSAGE_CHARS + 2
    assert [s.page_path for s in found] == ["P1", "P2", "P3"]
    tight = lean.passages([hit(1, long), hit(2, long), hit(3, "short three")], 300, 5)
    assert [s.page_path for s in tight] == ["P1", "P3"]  # the second did not fit, the third did
    assert len(lean.passages([hit(n, f"text {n}") for n in range(9)], 4000, 5)) == 5
    # The same section of a page is one passage.
    twice = [hit(1, "a"), Candidate(9, "P1", "id1", "Page 1", ["H"], "b", 3, 4, "hash")]
    assert len(lean.passages(twice, 4000, 5)) == 1


def test_parse_plan_keeps_the_question_and_cleans_the_lines() -> None:
    text = (
        '<think>hmm</think>Searches:\n1. Halden invoice overdue\n- "price per seat"\n\n'
        "Halden invoice overdue\n4) x\n5. one more\n6. too many"
    )
    assert lean.parse_plan(text, "What is overdue and what do we charge?") == [
        "What is overdue and what do we charge?",
        "Halden invoice overdue",
        "price per seat",
        "one more",
    ]
    assert lean.parse_plan("", "Just this") == ["Just this"]


def test_quick_answer_is_one_small_request_without_tools(
    notes: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    model = Recorded("Twenty euro per seat [1].").install(monkeypatch)
    events = send(notes, "What did we decide about the price per seat?", depth="quick")
    # The answer, then the chat's title, which starts from the same messages as the answer
    # so that a local model reads nothing twice.
    assert len(model.requests) == 2
    messages, tools, _ = model.requests[0]
    title = model.requests[1][0]
    assert title[:2] == messages[:1] + [
        {"role": "user", "content": "What did we decide about the price per seat?"}
    ]
    assert title[2] == {"role": "assistant", "content": "Twenty euro per seat [1]."}
    assert "title" in title[3]["content"]
    assert tools == []  # no tool list to read
    assert [m["role"] for m in messages] == ["system", "user"]
    system, user = messages[0]["content"], messages[1]["content"]
    # The system prompt carries nothing of this turn: no sources, no page list, no question.
    assert "20 euro" not in system and "Pricing" not in system and "Filler" not in system
    assert user.index("## Sources") < user.index("20 euro per seat") < user.index("## Question")
    assert user.rstrip().endswith("What did we decide about the price per seat?")
    assert estimate_tokens(system + user) < 700
    answer = next(e for e in events if e["type"] == "answer")
    assert answer["text"] == "Twenty euro per seat [1]." and answer["cited"] == [1]
    metrics = next(e for e in events if e["type"] == "metrics")["metrics"]
    assert metrics["model_calls"] == 1 and metrics["tool_calls"] == 0
    assert 1 <= metrics["chunks"] <= lean.QUICK_PASSAGES
    assert metrics["context_tokens"] < 400
    assert [s["query"] for s in metrics["searches"]] == [
        "What did we decide about the price per seat?"
    ]


def test_the_system_prompt_is_identical_from_turn_to_turn(
    notes: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """What llama-server can reuse from its cache: the system prompt, then the history."""
    model = Recorded("Twenty euro [1].", "Price", "It is overdue [2].").install(monkeypatch)
    c = notes.post("/api/v1/ai/conversations", json={"scope": {"kind": "vault"}}).json()
    for message in ("What is the price per seat?", "And what about the Halden invoice status?"):
        response = notes.post(
            f"/api/v1/ai/conversations/{c['id']}/messages",
            json={"message": message, "depth": "quick"},
        )
        assert response.status_code == 200
    first, _title, second = (r[0] for r in model.requests[:3])
    assert first[0] == _title[0] == second[0]  # byte for byte
    # The second turn carries the first as plain history, without its sources.
    assert [m["role"] for m in second] == ["system", "user", "assistant", "user"]
    assert second[1]["content"] == "What is the price per seat?"
    assert second[2]["content"] == "Twenty euro [1]."
    assert "## Sources" in second[3]["content"] and "Halden" in second[3]["content"]


def test_a_request_to_change_something_still_gets_the_tools(
    notes: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    model = Recorded("I filed that.").install(monkeypatch)
    send(notes, "Create a page called Q3 review", depth="quick")
    _, tools, _ = model.requests[0]
    assert {t["function"]["name"] for t in tools} >= {"propose_create", "search_vault"}


def test_quick_answer_keeps_attachment_selection_and_no_pages(
    notes: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    model = Recorded("From the selection [1].", "Cobalt", "Hello.").install(monkeypatch)
    events = send(
        notes,
        "What does the selected text say about cobalt?",
        depth="quick",
        selection={"text": "The walls get cobalt blue.", "page_path": "Pricing"},
    )
    user = model.requests[0][0][-1]["content"]
    assert "cobalt blue" in user
    assert next(e for e in events if e["type"] == "answer")["cited"] == [1]
    # A chat with no pages selected answers from the conversation alone.
    c = notes.post("/api/v1/ai/conversations", json={"scope": {"kind": "none"}}).json()
    response = notes.post(
        f"/api/v1/ai/conversations/{c['id']}/messages", json={"message": "Hi", "depth": "quick"}
    )
    assert response.status_code == 200
    system = model.requests[2][0][0]["content"]
    assert "No pages are selected" in system and model.requests[2][1] == []


def test_deep_research_works_in_small_steps_and_answers_from_notes(
    notes: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    model = Recorded(
        "price per seat\nHalden invoice overdue",  # the plan
        "Nothing found.",  # note for the question itself
        "The price is 20 euro per seat [1].",  # note for "price per seat"
        "The Halden invoice of 18,400 euros is overdue [2].",  # note for the invoice
        "We charge 20 euro per seat [1]; Halden owes 18,400 euros [2].",  # the answer
    ).install(monkeypatch)
    events = send(notes, "What do we charge per seat, and what is overdue?", depth="deep")
    assert len(model.requests) == 6  # plan, three notes, the answer, the chat title
    assert all(tools == [] for _, tools, _ in model.requests)
    # Every call starts from the same system prompt; steps do not think.
    systems = {r[0][0]["content"] for r in model.requests}
    assert len(systems) == 1
    assert all(r[2].get("thinking") is False for r in model.requests[:4])
    # No step reads more than its own passages: each stays small.
    for messages, _, _ in model.requests:
        assert estimate_tokens("".join(m["content"] for m in messages)) < 900
    # The answer is written from the notes, not from the passages.
    final = model.requests[4][0][-1]["content"]
    assert "## Research notes" in final and "## Sources" not in final
    assert "price per seat: The price is 20 euro per seat [1]." in final
    assert "Nothing found" not in final

    steps = [e["step"] for e in events if e["type"] == "activity"]
    names = [s["name"] for s in steps if s["status"] == "succeeded"]
    assert names[0] == "Planning the search"
    assert names.count("Reading what was found") == 3
    assert "Searching “price per seat”" in names and "Searching “Halden invoice overdue”" in names
    searched = next(s for s in steps if s["name"].startswith("Searching “price") and "hits" in s)
    assert searched["hits"] >= 1 and searched["ms"] >= 0 and "passage" in searched["text"]

    answer = next(e for e in events if e["type"] == "answer")
    assert answer["cited"] == [1, 2]
    assert {s["page_path"] for s in answer["sources"]} == {"Pricing", "Halden"}
    assert [a["name"] for a in answer["activity"]][0] == "Planning the search"
    metrics = next(e for e in events if e["type"] == "metrics")["metrics"]
    assert metrics["model_calls"] == 5 and len(metrics["searches"]) == 3
    assert metrics["pages"] >= 2


def test_the_context_budget_limits_what_a_tool_turn_is_given(
    notes: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    config = notes.get("/api/v1/ai/status").json()["config"]
    assert config["context_budget_tokens"] == 3000 and config["max_tool_calls"] == 8
    assert (
        notes.put("/api/v1/ai/config", json={**config, "context_budget_tokens": 500}).status_code
        == 200
    )
    Recorded("Twenty [1].").install(monkeypatch)
    events = send(notes, "money euro seat invoice notes")
    metrics = next(e for e in events if e["type"] == "metrics")["metrics"]
    assert metrics["context_tokens"] <= 560  # the budget, give or take one heading line
    assert (
        notes.put("/api/v1/ai/config", json={**config, "context_budget_tokens": 100}).status_code
        == 422
    )


def test_only_what_reads_as_a_question_goes_without_tools() -> None:
    for request in (
        "link the contacts to their companies",
        "can you hook the contacts up to their companies?",
        "Koppel de contacten aan de bedrijven",
        "the CRM needs a contacts table",
        "continue",
    ):
        assert lean.wants_change(request), request
    for question in (
        "Can you tell me what we decided?",
        "Show me the open invoices",
        "Is the roof quote in yet?",
        "Which contacts work at Fernhill?",
        "anything about pricing?",
    ):
        assert not lean.wants_change(question), question
