"""Multi-step tasks must carry usable paths, fields and questions into the next step."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

from graite.models.providers import Provider
from graite.retrieval.scope import Scope, resolve
from graite.skills.registry import PROPOSE_GROUPS, Registry
from tests.test_ai import config, page
from tests.test_chat_v2 import events_of
from tests.test_proposals import make

BOARD = """```graite:view
view: kanban
group: Status
show: [Priority, Project]
settings:
  fields:
    - name: Status
      type: status
      options: [Backlog, To do, In progress, Done]
    - name: Priority
      type: single_select
      options: [High, Medium, Low]
    - name: Project
      type: text
```
"""


@pytest.mark.parametrize("accept_parent", [False, True])
async def test_new_board_can_receive_cards_in_the_same_turn(
    tmp_path: Path, accept_parent: bool
) -> None:
    ops, proposals = await make(tmp_path)
    root = await ops.create_page(None, "Todos", None, "ui")
    registry = Registry(ops, root.path, groups=PROPOSE_GROUPS)
    registry.proposals = proposals
    registry.turn = {"conversation_id": "c1", "run_id": "r1"}

    async def invoke(name: str, **kwargs: Any) -> Any:
        result = json.loads(await registry.invoke(name, json.dumps(kwargs)))
        assert "error" not in result, result
        return result

    board = await invoke(
        "propose_create", title="Sprint", body=BOARD, parent_path=root.path, summary="Sprint board"
    )
    if accept_parent:
        await proposals.accept(board["proposal_id"])
    card = await invoke(
        "propose_create",
        title="Call dentist",
        body="",
        parent_path=board["path"],
        summary="Add requested task",
        properties=[{"name": "Status", "type": "status", "value": "Backlog"}],
    )
    if not accept_parent:
        await proposals.accept(board["proposal_id"])
    await proposals.accept(card["proposal_id"])
    read = await invoke("read_page", path=card["path"])
    assert read["properties"][0]["value"] == "Backlog"
    assert {f["name"] for f in read["properties"]} == {"Status", "Priority", "Project"}
    children = json.loads(
        await registry.invoke("list_children", json.dumps({"path": board["path"]}))
    )
    assert children[0]["path"] == card["path"]
    ops.db.close()


async def test_empty_board_fields_are_inherited_without_inventing_cards(tmp_path: Path) -> None:
    ops, proposals = await make(tmp_path)
    root = await ops.create_page(None, "Todos", None, "ui")
    await ops.write_body(root.path, BOARD, None, "ui")
    assert await ops.child_pages(root.id) == []
    proposal = await proposals.create(
        "create",
        root.path,
        title="Call dentist",
        new_text="",
        summary="Task",
        policy="propose",
        properties=[{"name": "Status", "value": "Backlog"}],
    )
    await proposals.accept(proposal["id"])
    card = await ops.read_page(proposal["new_path"])
    fields = {f["name"]: f for f in card.frontmatter["properties"]}
    assert set(fields) == {"Status", "Priority", "Project"}
    assert fields["Status"]["options"] == ["Backlog", "To do", "In progress", "Done"]
    assert fields["Status"]["value"] == "Backlog"
    ops.db.close()


async def test_pending_parent_does_not_widen_scope_or_cross_conversations(tmp_path: Path) -> None:
    ops, proposals = await make(tmp_path)
    root = await ops.create_page(None, "Todos", None, "ui")
    private = await ops.create_page(None, "Private", None, "ui")
    p = await proposals.create(
        "create",
        private.path,
        title="Hidden",
        summary="Hidden",
        policy="propose",
        conversation_id="c1",
    )
    registry = Registry(ops, root.path, groups=PROPOSE_GROUPS)
    registry.proposals = proposals
    registry.turn = {"conversation_id": "c1"}
    with pytest.raises(ValueError, match="scope"):
        registry.create_parent(p["new_path"])
    with pytest.raises(ValueError, match="scope"):
        registry.create_parent("")
    other = await proposals.create(
        "create", root.path, title="Other", summary="Other", policy="propose", conversation_id="c2"
    )
    with pytest.raises(ValueError, match="scope"):
        registry.create_parent(other["new_path"])
    registry.scope = resolve(ops.db, ops.vault, Scope("folder", [root.path]), cloud_provider=False)
    ops.db.close()


def test_clarification_is_saved_and_available_to_the_next_turn(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    config(client)
    monkeypatch.setattr("keyring.get_password", lambda *_: "")
    todo = page(client, "Todos")
    conversation = client.post(
        "/api/v1/ai/conversations", json={"page_path": todo["path"], "mode": "act"}
    ).json()
    prompts = []

    async def respond(self: Provider, messages: Any, tools: Any, **options: Any):
        prompts.append(messages)
        if len(prompts) == 1:
            assert "Current page" in messages[0]["content"]
            yield {
                "tool_calls": [
                    {
                        "index": 0,
                        "id": "q",
                        "function": {
                            "name": "request_clarification",
                            "arguments": json.dumps({"question": "Which project should I use?"}),
                        },
                    }
                ]
            }
        else:
            assert any(m.get("content") == "Which project should I use?" for m in messages)
            yield {"content": "I will use Personal."}

    monkeypatch.setattr(Provider, "chat", respond)
    endpoint = f"/api/v1/ai/conversations/{conversation['id']}/messages"
    events = events_of(client.post(endpoint, json={"message": "Organize these tasks"}).text)
    answer = next(e for e in events if e["type"] == "answer")
    assert answer["text"] == "Which project should I use?"
    assert any(s["name"] == "request_clarification" for s in answer["activity"])
    run = client.app.state.db.execute(
        "SELECT status FROM runs WHERE id=?", (answer["run_id"],)
    ).fetchone()
    assert run["status"] == "needs_input"
    saved = client.get(f"/api/v1/ai/conversations/{conversation['id']}").json()
    assert saved["messages"][-1]["content"] == answer["text"]
    assert saved["messages"][-1]["activity"]
    events = events_of(client.post(endpoint, json={"message": "Personal"}).text)
    assert not any(e["type"] == "error" for e in events), events


def test_a_failed_followup_keeps_completed_proposals_visible(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    config(client)
    monkeypatch.setattr("keyring.get_password", lambda *_: "")
    todo = page(client, "Todos")
    c = client.post(
        "/api/v1/ai/conversations", json={"page_path": todo["path"], "mode": "act"}
    ).json()
    count = 0

    async def respond(self: Provider, messages: Any, tools: Any, **options: Any):
        nonlocal count
        count += 1
        if count == 1:
            yield {
                "tool_calls": [
                    {
                        "index": 0,
                        "id": "write",
                        "function": {
                            "name": "propose_append",
                            "arguments": json.dumps(
                                {"path": todo["path"], "text": BOARD, "summary": "Board here"}
                            ),
                        },
                    }
                ]
            }
        else:
            raise ValueError("Provider disconnected")

    monkeypatch.setattr(Provider, "chat", respond)
    events = events_of(
        client.post(
            f"/api/v1/ai/conversations/{c['id']}/messages", json={"message": "Make a board here"}
        ).text
    )
    assert any(e["type"] == "error" for e in events)
    saved = client.get(f"/api/v1/ai/conversations/{c['id']}").json()["messages"][-1]
    assert saved["interrupted"] and saved["proposals"]
    assert saved["activity"][-1]["status"] == "succeeded"
    assert saved["content"] == "Stopped before finishing."
