from __future__ import annotations

import json
import time
from collections.abc import AsyncIterator
from typing import Any

import pytest
from fastapi.testclient import TestClient

from graite.models.providers import Provider
from tests.test_ai import config, page


def events_of(text: str) -> list[dict[str, Any]]:
    return [json.loads(s[6:]) for s in text.split("\n\n") if s.startswith("data: ")]


def fake_answer(text: str):  # type: ignore[no-untyped-def]
    async def fake(self: Provider, messages: Any, tools: Any) -> AsyncIterator[dict[str, Any]]:
        yield {"content": text}

    return fake


def minimal_pdf(text: str) -> bytes:
    objects = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 144] /Contents 4 0 R "
        b"/Resources << /Font << /F1 5 0 R >> >> >>",
        None,
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ]
    stream = f"BT /F1 18 Tf 20 100 Td ({text}) Tj ET".encode()
    objects[3] = (
        b"<< /Length " + str(len(stream)).encode() + b" >>\nstream\n" + stream + b"\nendstream"
    )
    out = bytearray(b"%PDF-1.4\n")
    offsets = []
    for index, body in enumerate(objects, start=1):
        offsets.append(len(out))
        out += f"{index} 0 obj\n".encode() + body + b"\nendobj\n"  # type: ignore[operator]
    xref = len(out)
    out += f"xref\n0 {len(objects) + 1}\n0000000000 65535 f \n".encode()
    for offset in offsets:
        out += f"{offset:010d} 00000 n \n".encode()
    out += (
        f"trailer\n<< /Size {len(objects) + 1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n".encode()
    )
    return bytes(out)


def test_vault_conversation_cites_sources_and_records_a_run(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    config(client)
    monkeypatch.setattr("keyring.get_password", lambda *_: "")
    pricing = page(client, "Pricing")
    client.put(
        f"/api/v1/pages/{pricing['path']}",
        json={
            "body": "# Decision\n\nWe decided on 20 euro per seat.\n",
            "base_hash": pricing["hash"],
        },
    )
    monkeypatch.setattr(Provider, "chat", fake_answer("Twenty euro per seat [1]. Also [4]."))
    c = client.post("/api/v1/ai/conversations", json={"scope": {"kind": "vault"}}).json()
    assert c["scope"] == {"kind": "vault", "roots": [], "excluded": []} and c["page_id"] is None
    response = client.post(
        f"/api/v1/ai/conversations/{c['id']}/messages",
        json={"message": "What did we decide about the price per seat?"},
    )
    assert response.status_code == 200
    events = events_of(response.text)
    kinds = [e["type"] for e in events]
    assert (
        kinds.index("sources")
        < kinds.index("token")
        < kinds.index("limits")
        < kinds.index("answer")
    )
    sources = next(e for e in events if e["type"] == "sources")["sources"]
    assert sources[0]["page_path"] == pricing["path"] and sources[0]["n"] == 1
    assert (
        sources[0]["heading_path"] == ["Decision"]
        and sources[0]["hash"] == client.get(f"/api/v1/pages/{pricing['path']}").json()["hash"]
    )
    answer = next(e for e in events if e["type"] == "answer")
    assert answer["text"] == "Twenty euro per seat [1]. Also." and answer["cited"] == [1]
    limits = next(e for e in events if e["type"] == "limits")["items"]
    assert limits[0].startswith("Searched 1 page in your vault")
    assert any("No embedding model" in line for line in limits)
    saved = client.get(f"/api/v1/ai/conversations/{c['id']}").json()
    last = saved["messages"][-1]
    assert last["cited"] == [1] and last["sources"][0]["page_path"] == pricing["path"]
    assert last["run_id"] and last["limits"]
    run = client.app.state.db.execute("SELECT * FROM runs WHERE id=?", (last["run_id"],)).fetchone()
    assert run["kind"] == "chat_turn" and run["status"] == "succeeded" and run["mode"] == "ask"
    steps = client.app.state.db.execute(
        "SELECT kind, status FROM run_steps WHERE run_id=? ORDER BY ord", (run["id"],)
    ).fetchall()
    assert [tuple(s) for s in steps] == [("retrieve", "succeeded"), ("generate", "succeeded")]
    listed = client.get("/api/v1/ai/conversations", params={"scope": "vault"}).json()
    assert [x["id"] for x in listed] == [c["id"]]


def test_page_scope_reads_only_that_page(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    config(client)
    monkeypatch.setattr("keyring.get_password", lambda *_: "")
    parent = page(client, "Parent")
    child = page(client, "Child", parent["path"])
    client.put(
        f"/api/v1/pages/{child['path']}",
        json={"body": "The secret word is cobalt.\n", "base_hash": child["hash"]},
    )
    monkeypatch.setattr(Provider, "chat", fake_answer("Answer."))
    single = client.post(
        "/api/v1/ai/conversations", json={"scope": {"kind": "page", "roots": [parent["path"]]}}
    ).json()
    assert single["page_id"] == parent["id"] and single["scope"]["kind"] == "page"
    events = events_of(
        client.post(
            f"/api/v1/ai/conversations/{single['id']}/messages", json={"message": "cobalt?"}
        ).text
    )
    assert next(e for e in events if e["type"] == "meta")["pages"] == 1
    assert next(e for e in events if e["type"] == "sources")["sources"] == []
    folder = client.post("/api/v1/ai/conversations", json={"page_path": parent["path"]}).json()
    assert folder["scope"]["kind"] == "folder"
    events = events_of(
        client.post(
            f"/api/v1/ai/conversations/{folder['id']}/messages", json={"message": "cobalt?"}
        ).text
    )
    assert (
        next(e for e in events if e["type"] == "sources")["sources"][0]["page_path"]
        == child["path"]
    )
    assert client.get("/api/v1/ai/conversations", params={"page_path": parent["path"]}).json()[0][
        "id"
    ] in (
        single["id"],
        folder["id"],
    )


def test_local_only_pages_are_left_out_of_cloud_answers(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr("keyring.get_password", lambda *_: "k")
    monkeypatch.setattr("keyring.set_password", lambda *_: None)
    assert (
        client.put(
            "/api/v1/ai/config", json={"provider": "anthropic", "model": "claude", "api_key": "k"}
        ).status_code
        == 200
    )
    private = page(client, "Private")
    client.put(
        f"/api/v1/pages/{private['path']}",
        json={"body": "Salary is 90k.\n", "base_hash": private["hash"]},
    )
    client.put(
        f"/api/v1/pages/{private['path']}/ai-settings", json={"values": {"cloud": "local-only"}}
    )
    public = page(client, "Public")
    client.put(
        f"/api/v1/pages/{public['path']}",
        json={"body": "Salary review is in May.\n", "base_hash": public["hash"]},
    )
    monkeypatch.setattr(Provider, "chat", fake_answer("In May [1]."))
    c = client.post("/api/v1/ai/conversations", json={}).json()
    events = events_of(
        client.post(
            f"/api/v1/ai/conversations/{c['id']}/messages", json={"message": "salary?"}
        ).text
    )
    meta = next(e for e in events if e["type"] == "meta")
    assert meta["excluded_local_only"] == [private["path"]] and meta["pages"] == 1
    sources = next(e for e in events if e["type"] == "sources")["sources"]
    assert [s["page_path"] for s in sources] == [public["path"]]
    limits = next(e for e in events if e["type"] == "limits")
    assert limits["excluded_local_only"] == [private["path"]]
    assert any("local-only" in line and "Claude" in line for line in limits["items"])


def test_edit_and_resend_truncates_history(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    async def generated_title(manager, config, question):
        return "Topic: " + question

    monkeypatch.setattr("graite.agent.titles.chat_title", generated_title)
    config(client)
    monkeypatch.setattr("keyring.get_password", lambda *_: "")
    page(client, "Any")
    monkeypatch.setattr(Provider, "chat", fake_answer("Reply."))
    c = client.post("/api/v1/ai/conversations", json={}).json()
    url = f"/api/v1/ai/conversations/{c['id']}/messages"
    client.post(url, json={"message": "First"})
    client.post(url, json={"message": "Second"})
    assert len(client.get(f"/api/v1/ai/conversations/{c['id']}").json()["messages"]) == 4
    client.post(url, json={"message": "First, edited", "replace_from": 0})
    saved = client.get(f"/api/v1/ai/conversations/{c['id']}").json()
    assert [m["content"] for m in saved["messages"]] == ["First, edited", "Reply."]
    assert saved["title"] == "Topic: First, edited"
    assert client.post(url, json={"message": "x", "replace_from": 1}).status_code == 400
    assert (
        client.patch(
            f"/api/v1/ai/conversations/{c['id']}", json={"title": "Renamed", "mode": "draft"}
        ).json()["title"]
        == "Renamed"
    )
    assert client.delete(f"/api/v1/ai/conversations/{c['id']}").json() == {"ok": True}
    assert client.get(f"/api/v1/ai/conversations/{c['id']}").status_code == 404


def test_cancel_persists_partial_answer(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    import asyncio

    config(client)
    monkeypatch.setattr("keyring.get_password", lambda *_: "")
    page(client, "Any")

    c = client.post("/api/v1/ai/conversations", json={}).json()

    async def slow(self: Provider, messages: Any, tools: Any) -> AsyncIterator[dict[str, Any]]:
        yield {"content": "Partial"}
        # The test client buffers the stream, so the Stop button is pressed from in here.
        client.app.state.active_chats[c["id"]].cancel()
        await asyncio.sleep(30)
        yield {"content": " never"}

    monkeypatch.setattr(Provider, "chat", slow)
    assert client.post(f"/api/v1/ai/conversations/{c['id']}/cancel").json() == {"cancelled": False}
    response = client.post(f"/api/v1/ai/conversations/{c['id']}/messages", json={"message": "Go"})
    assert '"type": "done"' not in response.text and '"type": "token"' in response.text
    for _ in range(50):
        saved = client.get(f"/api/v1/ai/conversations/{c['id']}").json()
        if len(saved["messages"]) == 2:
            break
        time.sleep(0.05)
    assert saved["messages"][-1] == {
        **saved["messages"][-1],
        "content": "Partial",
        "interrupted": True,
    }
    assert not client.app.state.active_chats
    run = client.app.state.db.execute("SELECT status FROM runs ORDER BY started_at DESC").fetchone()
    assert run["status"] == "cancelled"


def test_attachments_become_sources(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    config(client)
    monkeypatch.setattr("keyring.get_password", lambda *_: "")
    page(client, "Any")
    c = client.post("/api/v1/ai/conversations", json={}).json()
    base = f"/api/v1/ai/conversations/{c['id']}/attachments"
    pdf = client.post(
        base, params={"name": "brief.pdf"}, content=minimal_pdf("Budget is 5000 dollars")
    )
    assert pdf.status_code == 200, pdf.text
    assert pdf.json()["text_status"] == "ready" and pdf.json()["pages"] == 1
    assert "5000" in pdf.json()["text_preview"]
    note = client.post(base, params={"name": "notes.md"}, content=b"# Notes\n\nCall Sam on Monday.")
    assert note.json()["kind"] == "text" and note.json()["text_status"] == "ready"
    assert client.post(base, params={"name": "x.exe"}, content=b"nope").status_code == 400
    assert client.post(base, params={"name": "empty.txt"}, content=b"").status_code == 400
    stored = client.app.state.settings.vault / ".graite" / "chat" / c["id"]
    assert len(list(stored.iterdir())) == 2
    seen: list[str] = []

    async def fake(self: Provider, messages: Any, tools: Any) -> AsyncIterator[dict[str, Any]]:
        seen.append(messages[0]["content"])
        yield {"content": "Budget 5000 [1], call Sam [2]."}

    monkeypatch.setattr(Provider, "chat", fake)
    events = events_of(
        client.post(
            f"/api/v1/ai/conversations/{c['id']}/messages",
            json={
                "message": "What is the budget?",
                "attachments": [pdf.json()["id"], note.json()["id"]],
            },
        ).text
    )
    sources = next(e for e in events if e["type"] == "sources")["sources"]
    assert [s["kind"] for s in sources[:2]] == ["attachment", "attachment"]
    assert sources[0]["title"] == "brief.pdf"
    assert "[1] brief.pdf" in seen[0] and "Call Sam" in seen[0]
    assert next(e for e in events if e["type"] == "answer")["cited"] == [1, 2]
    saved = client.get(f"/api/v1/ai/conversations/{c['id']}").json()
    assert [a["name"] for a in saved["messages"][0]["attachments"]] == ["brief.pdf", "notes.md"]
    assert client.get(base).json()[0]["name"] == "brief.pdf"
    assert client.delete(f"{base}/{pdf.json()['id']}").json() == {"ok": True}
    assert len(list(stored.iterdir())) == 1
    client.delete(f"/api/v1/ai/conversations/{c['id']}")
    assert not stored.exists()


def test_selection_is_a_citable_source(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    config(client)
    monkeypatch.setattr("keyring.get_password", lambda *_: "")
    p = page(client, "Any")
    monkeypatch.setattr(Provider, "chat", fake_answer("It says amber [1]."))
    c = client.post("/api/v1/ai/conversations", json={}).json()
    events = events_of(
        client.post(
            f"/api/v1/ai/conversations/{c['id']}/messages",
            json={
                "message": "What does this say?",
                "selection": {"page_path": p["path"], "text": "Launch is amber."},
            },
        ).text
    )
    sources = next(e for e in events if e["type"] == "sources")["sources"]
    assert sources[0]["kind"] == "selection" and sources[0]["page_path"] == p["path"]
    saved = client.get(f"/api/v1/ai/conversations/{c['id']}").json()
    assert saved["messages"][0]["selection"]["text"] == "Launch is amber."


def test_index_status_and_jobs_endpoints(client: TestClient) -> None:
    page(client, "Indexed")
    status = client.get("/api/v1/ai/index/status").json()
    assert status["pages"] == 1 and status["chunks"] >= 1 and status["embedding_model"] is None
    rebuild = client.post("/api/v1/ai/index/rebuild")
    assert rebuild.status_code == 202 and rebuild.json()["job_id"]
    jobs = client.get("/api/v1/ai/jobs").json()
    assert any(j["kind"] == "reindex" for j in jobs)
    assert client.delete("/api/v1/ai/jobs/nope").status_code == 404


def test_cancel_tells_the_client_the_stream_ended_on_purpose(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    import asyncio

    config(client)
    monkeypatch.setattr("keyring.get_password", lambda *_: "")
    page(client, "Any")
    c = client.post("/api/v1/ai/conversations", json={}).json()

    async def slow(self: Provider, messages: Any, tools: Any) -> AsyncIterator[dict[str, Any]]:
        yield {"content": "Partial"}
        client.app.state.active_chats[c["id"]].cancel()
        await asyncio.sleep(30)

    monkeypatch.setattr(Provider, "chat", slow)
    response = client.post(f"/api/v1/ai/conversations/{c['id']}/messages", json={"message": "Go"})
    kinds = [e["type"] for e in events_of(response.text)]
    assert kinds[-1] == "cancelled" and "done" not in kinds


def test_only_the_passages_the_model_saw_are_shown(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A small context window trims the prompt; the source list must trim with it."""
    config(client)
    monkeypatch.setattr("keyring.get_password", lambda *_: "")
    for i in range(6):
        p = page(client, f"Note {i}")
        client.put(
            f"/api/v1/pages/{p['path']}",
            json={
                "body": f"# Pricing\n\n{'seat price euro decision ' * 60}\n",
                "base_hash": p["hash"],
            },
        )
    client.put(
        "/api/v1/ai/config", json={"provider": "compatible", "model": "m", "context_size": 2048}
    )
    seen: list[str] = []

    async def fake(self: Provider, messages: Any, tools: Any) -> AsyncIterator[dict[str, Any]]:
        seen.append(messages[0]["content"])
        yield {"content": "Answer."}

    monkeypatch.setattr(Provider, "chat", fake)
    c = client.post("/api/v1/ai/conversations", json={}).json()
    events = events_of(
        client.post(
            f"/api/v1/ai/conversations/{c['id']}/messages", json={"message": "seat price?"}
        ).text
    )
    shown = next(e for e in events if e["type"] == "sources")["sources"]
    assert shown, "at least one source should fit"
    assert len(shown) < 6
    for source in shown:
        assert f"[{source['n']}] {source['title']}" in seen[0]


def test_follow_up_builds_on_the_context_set_instead_of_searching_again(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    async def generated_title(manager, config, question):  # type: ignore[no-untyped-def]
        return "Title"

    monkeypatch.setattr("graite.agent.titles.chat_title", generated_title)
    config(client)
    monkeypatch.setattr("keyring.get_password", lambda *_: "")
    pricing = page(client, "Pricing")
    client.put(
        f"/api/v1/pages/{pricing['path']}",
        json={
            "body": "# Decision\n\nWe decided on 20 euro per seat after the workshop.\n",
            "base_hash": pricing["hash"],
        },
    )
    journal = page(client, "Journal")
    client.put(
        f"/api/v1/pages/{journal['path']}",
        json={
            "body": "Talked about cobalt paint for the office walls.\n",
            "base_hash": journal["hash"],
        },
    )
    prompts: list[str] = []

    async def fake(self: Provider, messages: Any, tools: Any) -> AsyncIterator[dict[str, Any]]:
        prompts.append(messages[0]["content"])
        yield {"reasoning_content": "The seat price is in source one. "}
        yield {"content": "<think>double-checking</think>Twenty euro per seat [1]."}

    monkeypatch.setattr(Provider, "chat", fake)
    c = client.post("/api/v1/ai/conversations", json={"scope": {"kind": "vault"}}).json()
    url = f"/api/v1/ai/conversations/{c['id']}/messages"
    first = events_of(client.post(url, json={"message": "What is the price per seat?"}).text)
    sources = next(e for e in first if e["type"] == "sources")
    assert [s["n"] for s in sources["sources"]] == [1] and sources["new"] == [1]
    answer = next(e for e in first if e["type"] == "answer")
    assert answer["thinking"] == "The seat price is in source one.\ndouble-checking"
    saved = client.get(f"/api/v1/ai/conversations/{c['id']}").json()
    assert saved["context"][0]["page_path"] == pricing["path"] and "text" not in saved["context"][0]
    assert saved["messages"][-1]["thinking"].startswith("The seat price")
    assert saved["messages"][-1]["context"] is True

    # A follow-up that the gathered passages already cover: no search, nothing new listed.
    second = events_of(client.post(url, json={"message": "Why was that seat price decided?"}).text)
    kinds = [e["type"] for e in second]
    assert not any(e["type"] == "status" and "Searching" in e["text"] for e in second)
    sources = next(e for e in second if e["type"] == "sources")
    assert [s["n"] for s in sources["sources"]] == [1] and sources["new"] == []
    answer = next(e for e in second if e["type"] == "answer")
    assert answer["cited"] == [1] and answer["new_sources"] == []
    limits = next(e for e in second if e["type"] == "limits")["items"]
    assert limits[0].startswith("Answered from the 1 passage gathered earlier")
    assert "gathered earlier in this conversation" in prompts[1]
    assert "[1] Pricing" in prompts[1]
    run_id = answer["run_id"]
    steps = client.app.state.db.execute(
        "SELECT kind FROM run_steps WHERE run_id=? ORDER BY ord", (run_id,)
    ).fetchall()
    assert [s["kind"] for s in steps] == ["followup", "generate"]
    saved = client.get(f"/api/v1/ai/conversations/{c['id']}").json()
    assert saved["messages"][-1]["sources"] == [] and saved["messages"][-1]["cited"] == [1]
    assert "done" in kinds

    # A new topic searches again and only the new page is listed for that answer.
    third = events_of(client.post(url, json={"message": "What colour is the office paint?"}).text)
    sources = next(e for e in third if e["type"] == "sources")
    assert [s["n"] for s in sources["sources"]] == [1, 2] and sources["new"] == [2]
    assert sources["sources"][1]["page_path"] == journal["path"]
    answer = next(e for e in third if e["type"] == "answer")
    assert [s["n"] for s in answer["new_sources"]] == [2]
    assert "[1] Pricing" in prompts[2] and "[2] Journal" in prompts[2]
    saved = client.get(f"/api/v1/ai/conversations/{c['id']}").json()
    assert [s["n"] for s in saved["context"]] == [1, 2]
    assert [s["n"] for s in saved["messages"][-1]["sources"]] == [2]


def test_title_is_set_on_the_first_turn_only(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    async def generated_title(manager, config, question):  # type: ignore[no-untyped-def]
        return "Topic: " + question

    monkeypatch.setattr("graite.agent.titles.chat_title", generated_title)
    config(client)
    monkeypatch.setattr("keyring.get_password", lambda *_: "")
    page(client, "Any")
    monkeypatch.setattr(Provider, "chat", fake_answer("Reply."))
    c = client.post("/api/v1/ai/conversations", json={}).json()
    url = f"/api/v1/ai/conversations/{c['id']}/messages"
    client.post(url, json={"message": "First"})
    assert client.get(f"/api/v1/ai/conversations/{c['id']}").json()["title"] == "Topic: First"
    client.patch(f"/api/v1/ai/conversations/{c['id']}", json={"title": "New conversation"})
    client.post(url, json={"message": "Second"})
    assert client.get(f"/api/v1/ai/conversations/{c['id']}").json()["title"] == "New conversation"


def test_conversations_saved_before_the_context_set_still_load(client: TestClient) -> None:
    db = client.app.state.db
    db.execute(
        "INSERT INTO conversations (id, title, messages_json, updated_at) VALUES (?,?,?,?)",
        (
            "legacy",
            "Old",
            json.dumps(
                [
                    {"role": "user", "content": "hi"},
                    {"role": "assistant", "content": "yo [1]", "sources": [{"n": 1}], "cited": [1]},
                ]
            ),
            "now",
        ),
    )
    saved = client.get("/api/v1/ai/conversations/legacy").json()
    assert saved["context"] == [] and saved["messages"][1]["context"] is False
    assert saved["messages"][1]["thinking"] is None
