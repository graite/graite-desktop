# ruff: noqa: E501
from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

from graite.events import EventBus
from graite.index import db
from graite.models.providers import Provider
from graite.review import policy as review_policy
from graite.review.proposals import ProposalConflict, Proposals
from graite.vault import policy
from graite.vault.fileops import FileOps
from tests.test_ai import config, page
from tests.test_chat_v2 import events_of


async def make(tmp_path: Path) -> tuple[FileOps, Proposals]:
    vault = tmp_path / "vault"
    vault.mkdir()
    conn = db.connect(vault / ".graite" / "index.sqlite")
    events = EventBus()
    ops = FileOps(vault, conn, events)
    return ops, Proposals(conn, ops, events)


async def test_edit_proposals_apply_rebase_or_conflict(tmp_path: Path) -> None:
    ops, queue = await make(tmp_path)
    doc = await ops.create_page(None, "Pricing", None, "ui")
    doc = await ops.write_body(
        doc.path, "# Decision\n\nTwenty euro per seat.\n\nMore.\n", None, "ui"
    )
    proposal = await queue.create(
        "edit",
        doc.path,
        summary="Update the price",
        policy="propose",
        old_text="Twenty euro",
        new_text="Thirty euro",
        run_id="r1",
        conversation_id="c1",
    )
    assert proposal["status"] == "pending" and proposal["base_hash"] == doc.hash
    assert (
        "-Twenty euro per seat." in proposal["patch"]
        and "+Thirty euro per seat." in proposal["patch"]
    )
    with pytest.raises(ValueError, match="exactly once"):
        await queue.create(
            "edit", doc.path, summary="x", policy="propose", old_text="e", new_text="a"
        )
    # An unrelated manual edit is rebased over.
    await ops.write_body(
        doc.path, "# Decision\n\nTwenty euro per seat.\n\nEven more.\n", None, "ui"
    )
    accepted = await queue.accept(proposal["id"])
    assert accepted["status"] == "accepted" and accepted["reason"] == "rebased"
    after = await ops.read_page(doc.path)
    assert after.body == "# Decision\n\nThirty euro per seat.\n\nEven more.\n"
    assert accepted["applied_hash"] == after.hash and accepted["snapshot"]
    assert (ops.vault / accepted["snapshot"]).is_file()
    activity = ops.db.execute(
        "SELECT actor, action FROM activities ORDER BY id DESC LIMIT 1"
    ).fetchone()
    assert tuple(activity) == ("agent", "page.write")
    with pytest.raises(ValueError, match="already accepted"):
        await queue.accept(proposal["id"])
    # Reverting restores the snapshot.
    reverted = await queue.revert(proposal["id"])
    assert reverted["status"] == "reverted"
    assert (
        await ops.read_page(doc.path)
    ).body == "# Decision\n\nTwenty euro per seat.\n\nEven more.\n"
    # A proposal whose passage vanished becomes a conflict.
    stale = await queue.create(
        "edit", doc.path, summary="x", policy="propose", old_text="Even more", new_text="Less"
    )
    await ops.write_body(doc.path, "# Decision\n\nTwenty euro per seat.\n", None, "ui")
    with pytest.raises(ProposalConflict) as info:
        await queue.accept(stale["id"])
    assert info.value.proposal["status"] == "conflict" and "Twenty" in (
        info.value.current_body or ""
    )
    rejected = await queue.reject(stale["id"], "Not needed any more")
    assert rejected["status"] == "rejected" and rejected["reason"] == "Not needed any more"
    assert queue.undelivered_rejections("c1") == []  # a different conversation
    rejected_again = await queue.create(
        "append",
        doc.path,
        summary="Add a note",
        policy="propose",
        new_text="Note",
        conversation_id="c1",
    )
    await queue.reject(rejected_again["id"], "Too vague")
    assert queue.undelivered_rejections("c1") == [f"Add a note ({doc.path}): Too vague"]
    assert queue.undelivered_rejections("c1") == []  # delivered once


async def test_edit_then_accept_and_batch_stop_at_conflict(tmp_path: Path) -> None:
    ops, queue = await make(tmp_path)
    doc = await ops.create_page(None, "Log", None, "ui")
    doc = await ops.write_body(doc.path, "One\n", None, "ui")
    first = await queue.create("append", doc.path, summary="a", policy="propose", new_text="Two")
    second = await queue.create(
        "edit", doc.path, summary="b", policy="propose", old_text="One", new_text="Uno"
    )
    third = await queue.create("append", doc.path, summary="c", policy="propose", new_text="Three")
    await ops.write_body(doc.path, "1\n", None, "ui")  # "One" is gone: the edit will conflict
    result = await queue.accept_many([third["id"], second["id"], first["id"]])
    assert result == {"applied": [first["id"]], "stopped_at": second["id"]}
    assert (await ops.read_page(doc.path)).body == "1\n\nTwo\n"
    edited = await queue.accept(third["id"], new_text="Three, edited")
    assert edited["edited"] is True and edited["new_text"] == "Three, edited"
    assert (await ops.read_page(doc.path)).body == "1\n\nTwo\n\nThree, edited\n"


async def test_reject_many_discards_open_proposals_without_feedback(tmp_path: Path) -> None:
    ops, queue = await make(tmp_path)
    doc = await ops.create_page(None, "Log", None, "ui")
    doc = await ops.write_body(doc.path, "One\n", None, "ui")
    kept = await queue.create("append", doc.path, summary="a", policy="propose", new_text="Two")
    await queue.accept(kept["id"])
    pending = await queue.create(
        "append", doc.path, summary="b", policy="propose", new_text="Three", conversation_id="c1"
    )
    stale = await queue.create(
        "edit", doc.path, summary="c", policy="propose", old_text="One", new_text="Uno"
    )
    await ops.write_body(doc.path, "1\n", None, "ui")
    with pytest.raises(ProposalConflict):
        await queue.accept(stale["id"])
    result = await queue.reject_many([pending["id"], stale["id"], kept["id"], "p_missing"])
    assert result == {"rejected": [pending["id"], stale["id"]]}
    assert [queue.get(i)["status"] for i in (pending["id"], stale["id"], kept["id"])] == [  # type: ignore[index]
        "rejected",
        "rejected",
        "accepted",
    ]
    assert (await ops.read_page(doc.path)).body == "1\n"
    assert queue.undelivered_rejections("c1") == []  # no reason, nothing for the model


async def test_create_delete_and_move_round_trip(tmp_path: Path) -> None:
    ops, queue = await make(tmp_path)
    parent = await ops.create_page(None, "Projects", None, "ui")
    other = await ops.create_page(None, "Archive", None, "ui")
    created = await queue.create(
        "create",
        parent.path,
        summary="New page",
        policy="propose",
        title="Atlas",
        new_text="# Atlas\n\nHello.",
    )
    assert created["new_path"] == "Projects/Atlas" and "+# Atlas" in created["patch"]
    accepted = await queue.accept(created["id"])
    atlas = await ops.read_page("Projects/Atlas")
    assert atlas.body == "# Atlas\n\nHello.\n" and accepted["applied_hash"] == atlas.hash
    moved = await queue.create(
        "move", "Projects/Atlas", summary="Archive it", policy="propose", new_path=other.path
    )
    accepted_move = await queue.accept(moved["id"])
    assert accepted_move["new_path"] == "Archive/Atlas"
    assert (await ops.read_page("Archive/Atlas")).title == "Atlas"
    reverted = await queue.revert(moved["id"])
    assert (
        reverted["status"] == "reverted"
        and (await ops.read_page("Projects/Atlas")).title == "Atlas"
    )
    deleted = await queue.create("delete", "Projects/Atlas", summary="Remove", policy="propose")
    accepted_delete = await queue.accept(deleted["id"])
    assert accepted_delete["trash_id"]
    with pytest.raises(FileNotFoundError):
        await ops.read_page("Projects/Atlas")
    await queue.revert(deleted["id"])
    assert (await ops.read_page("Projects/Atlas")).body == "# Atlas\n\nHello.\n"
    reverted_create = await queue.revert(created["id"])
    assert reverted_create["status"] == "reverted"
    with pytest.raises(FileNotFoundError):
        await ops.read_page("Projects/Atlas")


def test_policy_decisions() -> None:
    def effective(**values: Any) -> policy.Effective:
        e = policy.Effective()
        e.values.update(values)
        e.sources.update({k: "Journal" for k in values})
        return e

    assert (
        review_policy.decide(effective(autonomy="none"), "append", cloud_model=False).action
        == "refuse"
    )
    assert (
        review_policy.decide(effective(cloud="local-only"), "edit", cloud_model=True).action
        == "refuse"
    )
    assert (
        review_policy.decide(effective(cloud="local-only"), "edit", cloud_model=False).action
        == "propose"
    )
    auto = effective(autonomy="auto-apply", auto_apply_kinds=["append"])
    first = review_policy.decide(auto, "append", cloud_model=False, opted=set())
    assert first.action == "propose" and first.policy == review_policy.NEEDS_OPT_IN
    assert first.opt_in_source == "Journal"
    second = review_policy.decide(auto, "append", cloud_model=False, opted={"Journal"})
    assert second.action == "auto_apply"
    assert (
        review_policy.decide(auto, "edit", cloud_model=False, opted={"Journal"}).action == "propose"
    )
    assert (
        review_policy.decide(auto, "delete", cloud_model=False, opted={"Journal"}).action
        == "propose"
    )


async def test_auto_apply_appends_without_review_after_opt_in(tmp_path: Path) -> None:
    ops, queue = await make(tmp_path)
    doc = await ops.create_page(None, "Journal", None, "ui")
    applied = await queue.create(
        "append", doc.path, summary="Daily line", policy="auto_apply", new_text="- Did things"
    )
    assert applied["status"] == "auto_applied" and applied["decided_by"] == "policy"
    assert (await ops.read_page(doc.path)).body == "- Did things\n"
    reverted = await queue.revert(applied["id"])
    assert reverted["status"] == "reverted" and (await ops.read_page(doc.path)).body == ""
    assert review_policy.opted_in(ops.db) == set()
    assert review_policy.opt_in(ops.db, "Journal") == {"Journal"}


def test_act_mode_files_proposals_and_review_api_applies_them(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    async def generated_title(manager, config, question):  # type: ignore[no-untyped-def]
        return "Title"

    monkeypatch.setattr("graite.agent.titles.chat_title", generated_title)
    config(client)
    monkeypatch.setattr("keyring.get_password", lambda *_: "")
    note = page(client, "Notes")
    client.put(
        f"/api/v1/pages/{note['path']}",
        json={"body": "# Notes\n\nOld line.\n", "base_hash": note["hash"]},
    )
    prompts: list[list[dict[str, Any]]] = []

    async def fake(self: Provider, messages: Any, tools: Any):  # type: ignore[no-untyped-def]
        prompts.append(messages)
        names = [t["function"]["name"] for t in tools]
        if messages[-1]["role"] != "tool":
            assert "propose_append" in names and "read_page" in names
            yield {
                "tool_calls": [
                    {
                        "index": 0,
                        "id": "t1",
                        "function": {
                            "name": "propose_append",
                            "arguments": json.dumps(
                                {
                                    "path": note["path"],
                                    "text": "New line.",
                                    "summary": "Add a TL;DR",
                                }
                            ),
                        },
                    }
                ]
            }
        else:
            assert "awaiting review" in messages[-1]["content"]
            yield {"content": "I proposed adding a line; it awaits your review."}

    monkeypatch.setattr(Provider, "chat", fake)
    c = client.post("/api/v1/ai/conversations", json={"mode": "act"}).json()
    assert c["mode"] == "act"
    url = f"/api/v1/ai/conversations/{c['id']}/messages"
    events = events_of(client.post(url, json={"message": "Add a TL;DR to Notes"}).text)
    proposal_event = next(e for e in events if e["type"] == "proposal")
    proposal = proposal_event["proposal"]
    assert proposal["kind"] == "append" and proposal["status"] == "pending"
    answer = next(e for e in events if e["type"] == "answer")
    assert answer["proposals"] == [proposal["id"]]
    assert "Act mode" in prompts[0][0]["content"]
    saved = client.get(f"/api/v1/ai/conversations/{c['id']}").json()
    assert saved["messages"][-1]["proposals"] == [proposal["id"]]
    # The page is untouched until the user decides.
    assert client.get(f"/api/v1/pages/{note['path']}").json()["body"] == "# Notes\n\nOld line.\n"
    listed = client.get("/api/v1/ai/proposals", params={"conversation_id": c["id"]}).json()
    assert [p["id"] for p in listed] == [proposal["id"]]
    assert client.get(f"/api/v1/ai/proposals?page_path={note['path']}&status=pending").json()
    accepted = client.post(f"/api/v1/ai/proposals/{proposal['id']}/accept", json={}).json()
    assert accepted["status"] == "accepted"
    assert (
        client.get(f"/api/v1/pages/{note['path']}").json()["body"]
        == "# Notes\n\nOld line.\n\nNew line.\n"
    )
    reverted = client.post(f"/api/v1/ai/proposals/{proposal['id']}/revert").json()
    assert reverted["status"] == "reverted"
    assert client.get(f"/api/v1/pages/{note['path']}").json()["body"] == "# Notes\n\nOld line.\n"
    # Rejecting with a reason feeds the next turn.
    events = events_of(client.post(url, json={"message": "Try again"}).text)
    second = next(e for e in events if e["type"] == "proposal")["proposal"]
    rejected = client.post(
        f"/api/v1/ai/proposals/{second['id']}/reject",
        json={"reason": "Too short, write a paragraph"},
    ).json()
    assert rejected["status"] == "rejected"
    client.post(url, json={"message": "Once more"})
    assert "Reviewer notes on your earlier proposals" in prompts[-2][0]["content"]
    assert "Too short, write a paragraph" in prompts[-2][0]["content"]
    # Ask mode may only add (create, append, set properties) and only when asked.
    ask = client.post("/api/v1/ai/conversations", json={}).json()
    monkeypatch.setattr(Provider, "chat", fake_ask)
    events = events_of(
        client.post(f"/api/v1/ai/conversations/{ask['id']}/messages", json={"message": "Hi"}).text
    )
    assert next(e for e in events if e["type"] == "answer")["proposals"] == []
    opted = client.post("/api/v1/ai/proposals/opt-in", json={"source": "Journal"}).json()
    assert opted == {"opted_in": ["Journal"]}
    batch = client.post(
        "/api/v1/ai/proposals/reject-batch", json={"ids": [proposal["id"], second["id"]]}
    ).json()
    assert batch == {"rejected": []}  # both were decided above


async def fake_ask(self: Provider, messages: Any, tools: Any):  # type: ignore[no-untyped-def]
    proposing = {
        t["function"]["name"] for t in tools if t["function"]["name"].startswith("propose")
    }
    assert proposing == {"propose_create", "propose_append", "propose_properties"}
    assert "Ask mode: you may not edit, delete or move" in messages[0]["content"]
    assert "Otherwise just answer" in messages[0]["content"]
    yield {"content": "Hello."}


def test_ask_mode_tools_add_but_never_rewrite() -> None:
    from graite.skills.registry import chat_tools, groups_for

    propose = {"propose_create", "propose_append", "propose_properties"}
    ask = chat_tools("ask")
    assert propose <= ask and {"read_page", "search_vault", "list_children"} <= ask
    assert not ask & {"propose_edit", "propose_delete", "propose_move"}
    assert {n for n in chat_tools("draft") if n.startswith("propose")} == {"propose_create"}
    assert {"propose_edit", "propose_delete", "propose_move"} <= chat_tools("act")
    # Agents and the assistant keep Ask as report-only.
    assert "propose" not in groups_for("ask")


async def test_auto_apply_covers_property_proposals_and_adds_new_options(tmp_path: Path) -> None:
    from graite.skills.registry import Registry
    from graite.vault import indexer

    ops, queue = await make(tmp_path)
    board = await ops.create_page(None, "Projects", None, "ui")
    card = await ops.create_page(board.path, "Launch", None, "ui")
    project = {
        "id": "project",
        "name": "Project",
        "type": "single_select",
        "options": ["Atlas", "Graite"],
        "colors": {},
        "value": "Atlas",
    }
    await ops.set_properties(card.id, [project], (await ops.read_page(card.path)).hash, "ui")
    assert policy.validate({"auto_apply_kinds": ["properties"]}) == {
        "auto_apply_kinds": ["properties"]
    }
    board_doc = await ops.read_page(board.path)
    await ops.set_ai_settings(
        board.path,
        {"autonomy": "auto-apply", "auto_apply_kinds": ["append", "create", "edit", "properties"]},
        board_doc.hash,
        "ui",
    )
    review_policy.opt_in(ops.db, board.path)
    indexer.scan(ops.vault, ops.db)
    registry = Registry(ops, board.path, groups={"read", "search", "meta", "propose"})
    registry.proposals = queue
    registry.turn = {"run_id": "r", "conversation_id": None, "cloud_model": False}
    result = json.loads(
        await registry.invoke(
            "propose_properties",
            json.dumps(
                {
                    "path": card.path,
                    "summary": "It belongs to the new project",
                    "properties": [{"name": "Project", "value": "Orbit"}],
                }
            ),
        )
    )
    assert result["status"] == "auto_applied", result
    field = (await ops.read_page(card.path)).frontmatter["properties"][0]
    assert field["value"] == "Orbit"
    assert field["options"] == ["Atlas", "Graite", "Orbit"]  # widened, never narrowed


async def test_read_page_returns_board_fields_and_list_children_properties(
    tmp_path: Path,
) -> None:
    from graite.skills.registry import Registry
    from graite.vault import indexer

    ops, queue = await make(tmp_path)
    board = await ops.create_page(None, "Projects", None, "ui")
    await ops.write_body(
        board.path, "```graite:view\nview: kanban\ngroup: Status\n```\n", None, "ui"
    )
    values = [("Launch", "Atlas", "Done"), ("Docs", "Atlas", "Open"), ("Site", "Graite", "Open")]
    for title, project, status in values:
        card = await ops.create_page(board.path, title, None, "ui")
        await ops.set_properties(
            card.id,
            [
                {
                    "id": "project",
                    "name": "Project",
                    "type": "single_select",
                    "options": ["Atlas", "Graite"],
                    "colors": {},
                    "value": project,
                },
                {
                    "id": "status",
                    "name": "Status",
                    "type": "status",
                    "options": ["Open", "Done"],
                    "colors": {},
                    "value": status,
                },
            ],
            (await ops.read_page(card.path)).hash,
            "ui",
        )
    await ops.create_page(board.path, "Loose", None, "ui")
    indexer.scan(ops.vault, ops.db)
    registry = Registry(ops, board.path)

    parent = json.loads(await registry.invoke("read_page", json.dumps({"path": board.path})))
    assert parent["board_path"] == board.path
    fields = {f["name"]: f for f in parent["board_fields"]}
    assert fields["Project"]["type"] == "single_select"
    assert fields["Project"]["options"] == ["Atlas", "Graite"]
    assert fields["Project"]["value_counts"] == {"Atlas": 2, "Graite": 1}
    assert fields["Project"]["empty"] == 1  # the card with no properties
    assert fields["Status"]["value_counts"] == {"Open": 2, "Done": 1}

    child = json.loads(
        await registry.invoke("read_page", json.dumps({"path": f"{board.path}/Site"}))
    )
    assert child["board_path"] == board.path
    assert {f["name"] for f in child["board_fields"]} == {"Project", "Status"}

    listed = json.loads(await registry.invoke("list_children", json.dumps({"path": board.path})))
    by_title = {c["title"]: c for c in listed}
    assert by_title["Site"]["properties"] == {"Project": "Graite", "Status": "Open"}
    assert "properties" not in by_title["Loose"]


def test_local_only_page_refuses_cloud_proposals(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr("keyring.get_password", lambda *_: "k")
    monkeypatch.setattr("keyring.set_password", lambda *_: None)
    client.put(
        "/api/v1/ai/config", json={"provider": "anthropic", "model": "claude", "api_key": "k"}
    )
    private = page(client, "Private")
    public = page(client, "Public")
    client.put(
        f"/api/v1/pages/{private['path']}/ai-settings", json={"values": {"cloud": "local-only"}}
    )
    client.put(f"/api/v1/pages/{public['path']}/ai-settings", json={"values": {"autonomy": "none"}})
    results: list[str] = []

    async def fake(self: Provider, messages: Any, tools: Any):  # type: ignore[no-untyped-def]
        if messages[-1]["role"] != "tool":
            yield {
                "tool_calls": [
                    {
                        "index": i,
                        "id": f"t{i}",
                        "function": {
                            "name": "propose_append",
                            "arguments": json.dumps({"path": path, "text": "x", "summary": "s"}),
                        },
                    }
                    for i, path in enumerate([private["path"], public["path"]])
                ]
            }
        else:
            results.extend(m["content"] for m in messages if m["role"] == "tool")
            yield {"content": "Done."}

    monkeypatch.setattr(Provider, "chat", fake)
    c = client.post("/api/v1/ai/conversations", json={"mode": "act"}).json()
    client.post(f"/api/v1/ai/conversations/{c['id']}/messages", json={"message": "Append"})
    assert "is local-only" in results[0]  # local-only pages are outside a cloud scope
    assert "don't allow changes by AI" in results[1]
    assert client.get("/api/v1/ai/proposals").json() == []


async def test_root_level_create_and_rebased_only_when_the_body_changed(tmp_path: Path) -> None:
    ops, queue = await make(tmp_path)
    # A new page at the vault root: the parent path is legitimately empty.
    created = await queue.create(
        "create", "", summary="Inbox page", policy="propose", title="Inbox", new_text="Hello."
    )
    assert created["page_path"] == "" and created["new_path"] == "Inbox"
    accepted = await queue.accept(created["id"])
    assert accepted["new_path"] == "Inbox" and (await ops.read_page("Inbox")).body == "Hello.\n"
    # Touching only the frontmatter (an icon) must not report a rebase; a body edit must.
    doc = await ops.create_page(None, "Log", None, "ui")
    doc = await ops.write_body(doc.path, "One\n", None, "ui")
    first = await queue.create("append", doc.path, summary="a", policy="propose", new_text="Two")
    assert first["base_body_hash"] and first["base_hash"] == doc.hash
    await ops.update_meta(doc.path, icon="📒", actor="ui")
    assert (await ops.read_page(doc.path)).hash != doc.hash
    assert (await queue.accept(first["id"]))["reason"] is None
    second = await queue.create("append", doc.path, summary="b", policy="propose", new_text="Three")
    await ops.write_body(doc.path, "Uno\n\nTwo\n", None, "ui")
    assert (await queue.accept(second["id"]))["reason"] == "rebased"
    # The folder whose setting needs confirming travels with the proposal.
    noted = await queue.create(
        "append",
        doc.path,
        summary="c",
        policy=review_policy.NEEDS_OPT_IN,
        new_text="Four",
        opt_in_source="Journal/AGENTS.md",
    )
    assert noted["opt_in_source"] == "Journal/AGENTS.md"


def test_optional_tool_arguments_are_nullable_and_not_required() -> None:
    from graite.skills.tools import TOOLS

    move = TOOLS["propose_move"].schema["function"]["parameters"]
    assert move["required"] == ["path", "summary"]
    assert move["properties"]["new_parent_path"]["type"] == ["string", "null"]
    listing = TOOLS["list_proposals"].schema["function"]["parameters"]
    assert listing["required"] == [] and listing["properties"]["status"]["type"] == [
        "string",
        "null",
    ]


async def test_tool_conflicts_become_tool_errors_not_turn_failures(tmp_path: Path) -> None:
    from graite.skills import tools as tool_module
    from graite.skills.registry import Registry

    ops, queue = await make(tmp_path)
    doc = await ops.create_page(None, "Notes", None, "ui")
    await ops.write_body(doc.path, "Alpha\n", None, "ui")
    from graite.vault import indexer

    indexer.scan(ops.vault, ops.db)
    registry = Registry(ops, "Notes", groups={"read", "search", "meta", "propose"})
    registry.proposals = queue
    registry.turn = {"run_id": "r", "conversation_id": None, "cloud_model": False}

    async def racing(reg: Any, **_: Any) -> Any:
        raise ProposalConflict({"id": "p_x", "status": "conflict", "reason": "gone"}, "Alpha")

    tool_module.TOOLS["racing_tool"] = tool_module.Tool(
        "racing_tool",
        "propose",
        "test",
        {"type": "function", "function": {"name": "racing_tool"}},
        racing,
    )
    try:
        registry.allowed.add("racing_tool")
        result = json.loads(await registry.invoke("racing_tool", "{}"))
        assert result["proposal_id"] == "p_x" and "awaits review" in result["error"]
    finally:
        del tool_module.TOOLS["racing_tool"]


# --------------------------------------------------------------- boards


async def test_a_board_and_its_cards_are_proposed_and_applied_in_one_turn(tmp_path: Path) -> None:
    """The whole point: an agent could not do this before, because a card's parent had to
    already exist on disk and there was no way to set a Status at all."""
    ops, queue = await make(tmp_path)
    todos = await ops.create_page(None, "Todos", None, "ui")

    board = await queue.create(
        "create",
        todos.path,
        summary="A board for the todos",
        policy="propose",
        title="Sprint board",
        new_text="Drag the cards between columns.\n\n```graite:view\nview: kanban\ngroup: Status\n```\n",
        conversation_id="c1",
    )
    card = await queue.create(
        "create",
        board["new_path"],  # still only a proposal; nothing is on disk yet
        summary="First card",
        policy="propose",
        title="Finish the app",
        new_text="",
        conversation_id="c1",
        properties=[
            {"name": "Status", "type": "status", "options": ["Open", "Done"], "value": "Open"},
            {"name": "Priority", "options": ["High", "Low"], "value": "High"},
        ],
    )
    assert card["parent_proposal_id"] == board["id"]

    await queue.accept(board["id"])
    applied = await queue.accept(card["id"])

    doc = await ops.read_page(applied["new_path"])
    fields = {f["name"]: f for f in doc.frontmatter["properties"]}
    assert fields["Status"]["value"] == "Open"
    assert fields["Status"]["type"] == "status"  # what the board groups its columns by
    assert fields["Priority"]["type"] == "single_select"  # inferred from having options
    assert "```graite:view" in (await ops.read_page(board["new_path"])).body


async def test_a_card_cannot_be_applied_before_the_page_it_belongs_under(tmp_path: Path) -> None:
    ops, queue = await make(tmp_path)
    todos = await ops.create_page(None, "Todos", None, "ui")
    board = await queue.create(
        "create",
        todos.path,
        summary="b",
        policy="propose",
        title="Board",
        new_text="x",
        conversation_id="c1",
    )
    card = await queue.create(
        "create",
        board["new_path"],
        summary="c",
        policy="propose",
        title="Card",
        new_text="",
        conversation_id="c1",
    )
    with pytest.raises(ValueError, match="Accept the page this one belongs under first"):
        await queue.accept(card["id"])


async def test_rejecting_a_board_supersedes_the_cards_that_needed_it(tmp_path: Path) -> None:
    """Otherwise the user is left with buttons that can now only fail."""
    ops, queue = await make(tmp_path)
    todos = await ops.create_page(None, "Todos", None, "ui")
    board = await queue.create(
        "create",
        todos.path,
        summary="b",
        policy="propose",
        title="Board",
        new_text="x",
        conversation_id="c1",
    )
    card = await queue.create(
        "create",
        board["new_path"],
        summary="c",
        policy="propose",
        title="Card",
        new_text="",
        conversation_id="c1",
    )
    await queue.reject(board["id"], "not like that")
    assert queue.get(card["id"])["status"] == "superseded"


async def test_a_properties_proposal_merges_and_reverts(tmp_path: Path) -> None:
    ops, queue = await make(tmp_path)
    parent = await ops.create_page(None, "Board", None, "ui")
    card = await ops.create_page(parent.path, "Card", None, "ui")
    await ops.set_properties(
        card.id,
        [
            {
                "id": "due",
                "name": "Due",
                "type": "date",
                "options": [],
                "colors": {},
                "value": "2026-10-02",
            }
        ],
        (await ops.read_page(card.path)).hash,
    )
    proposal = await queue.create(
        "properties",
        card.path,
        summary="Move it to Done",
        policy="propose",
        properties=[
            {"name": "Status", "type": "status", "options": ["Open", "Done"], "value": "Done"}
        ],
    )
    await queue.accept(proposal["id"])
    fields = {
        f["name"]: f["value"] for f in (await ops.read_page(card.path)).frontmatter["properties"]
    }
    # The date was never mentioned by the model and must not be collateral damage.
    assert fields == {"Due": "2026-10-02", "Status": "Done"}

    await queue.revert(proposal["id"])
    after = {f["name"] for f in (await ops.read_page(card.path)).frontmatter["properties"]}
    assert after == {"Due"}


async def test_a_fence_the_editor_would_drop_is_refused_while_it_is_still_words(
    tmp_path: Path,
) -> None:
    """A bad key makes the block render as grey text; the user would see a broken page and
    no error anywhere."""
    ops, queue = await make(tmp_path)
    todos = await ops.create_page(None, "Todos", None, "ui")
    with pytest.raises(ValueError, match="groupBy"):
        await queue.create(
            "create",
            todos.path,
            summary="b",
            policy="propose",
            title="Board",
            new_text="```graite:view\nview: kanban\ngroupBy: Status\n```\n",
        )
