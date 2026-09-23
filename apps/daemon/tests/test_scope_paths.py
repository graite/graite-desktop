"""Paths a model gets slightly wrong resolve to the one page it meant; the rest get hints."""

from __future__ import annotations

import json
from pathlib import Path

from graite.retrieval.scope import Scope
from graite.retrieval.scope import resolve as resolve_scope
from graite.skills.registry import PROPOSE_GROUPS, Registry
from graite.vault import indexer
from tests.test_proposals import make


async def _registry(tmp_path: Path) -> Registry:
    ops, queue = await make(tmp_path)
    for title in ("Graite", "Welcome", "Todos", "Jarvis"):
        await ops.create_page(None, title, None, "ui")
    await ops.create_page("Todos", "Buy milk", None, "ui")
    await ops.create_page("Jarvis", "Profile", None, "ui")
    indexer.scan(ops.vault, ops.db)
    scope = resolve_scope(ops.db, ops.vault, Scope("vault"), cloud_provider=False)
    registry = Registry(ops, scope, groups=PROPOSE_GROUPS)
    registry.proposals = queue
    registry.turn = {"run_id": "r", "conversation_id": "c1", "cloud_model": False}
    return registry


async def test_glued_siblings_display_forms_and_case_resolve(tmp_path: Path) -> None:
    registry = await _registry(tmp_path)
    assert registry.scoped("Graite/Welcome/Todos") == "Todos"
    assert registry.scoped("Profile (Jarvis/Profile)") == "Jarvis/Profile"
    assert registry.scoped("todos/buy milk") == "Todos/Buy milk"
    assert registry.scoped("Buy milk") == "Todos/Buy milk"

    result = json.loads(await registry.invoke("list_children", '{"path": "Graite/Welcome/Todos"}'))
    assert [c["path"] for c in result["result"]] == ["Todos/Buy milk"]
    assert "'Graite/Welcome/Todos' is 'Todos'" in result["path_note"]


async def test_unknown_or_ambiguous_paths_suggest_and_never_guess(tmp_path: Path) -> None:
    registry = await _registry(tmp_path)
    await registry.ops.create_page("Jarvis", "Todos", None, "ui")
    indexer.scan(registry.ops.vault, registry.ops.db)
    result = json.loads(await registry.invoke("read_page", '{"path": "Work/Todos"}'))
    assert "no page 'Work/Todos'" in result["error"] and "read" not in result["error"].split(".")[0]
    assert "Did you mean: Jarvis/Todos, Todos" in result["error"]

    result = json.loads(await registry.invoke("read_page", '{"path": "Nowhere"}'))
    assert "Did you mean" not in result["error"]


async def test_move_into_a_page_proposed_in_the_same_conversation(tmp_path: Path) -> None:
    registry = await _registry(tmp_path)
    created = json.loads(
        await registry.invoke(
            "propose_create",
            json.dumps({"title": "Projects", "body": "", "summary": "Projects"}),
        )
    )
    assert created["status"] == "pending"
    moved = json.loads(
        await registry.invoke(
            "propose_move",
            json.dumps(
                {"path": "Todos/Buy milk", "new_parent_path": created["path"], "summary": "x"}
            ),
        )
    )
    assert moved.get("status") == "pending", moved


async def test_memory_deletes_apply_only_where_explicitly_allowed(tmp_path: Path) -> None:
    from graite.review import policy as review_policy
    from graite.vault import policy

    registry = await _registry(tmp_path)
    ops = registry.ops
    await ops.set_ai_settings(
        "Jarvis",
        {"autonomy": "auto-apply", "auto_apply_kinds": ["append", "create", "edit", "delete"]},
        None,
        "ui",
    )
    await ops.set_ai_settings(
        "Todos",
        {"autonomy": "auto-apply", "auto_apply_kinds": ["append", "create", "edit", "properties"]},
        None,
        "ui",
    )
    review_policy.opt_in(ops.db, "Jarvis")
    review_policy.opt_in(ops.db, "Todos")
    memory = review_policy.decide(
        policy.resolve(tmp_path / "vault", ops.db, "Jarvis/Profile"),
        "delete",
        cloud_model=False,
        opted=review_policy.opted_in(ops.db),
    )
    todos = review_policy.decide(
        policy.resolve(tmp_path / "vault", ops.db, "Todos/Buy milk"),
        "delete",
        cloud_model=False,
        opted=review_policy.opted_in(ops.db),
    )
    moved = review_policy.decide(
        policy.resolve(tmp_path / "vault", ops.db, "Jarvis/Profile"),
        "move",
        cloud_model=False,
        opted=review_policy.opted_in(ops.db),
    )
    assert memory.action == "auto_apply"
    assert todos.action == "propose" and moved.action == "propose"
