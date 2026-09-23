from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

from graite.models.llama_server import UnsupportedModelError, startup_error
from graite.models.providers import Provider
from graite.retrieval.context import Source
from graite.retrieval.contextset import ContextSet
from graite.retrieval.scope import Scope, resolve
from graite.review.policy import decide, opted_in
from graite.vault import policy
from tests.test_ai import config, page


def settings(client: TestClient, path: str, **values: Any) -> dict[str, Any]:
    response = client.put(f"/api/v1/pages/{path}/ai-settings", json={"values": values})
    assert response.status_code == 200, response.text
    return response.json()


def test_page_only_permissions_do_not_leak_to_children(client: TestClient) -> None:
    parent = page(client, "Contacts")
    child = page(client, "Ada", parent["path"])
    settings(
        client,
        parent["path"],
        instructions="Include email.",
        autonomy="none",
        cloud="local-only",
        ai_scope="page",
    )
    state = client.app.state
    child_policy = policy.resolve(state.settings.vault, state.db, child["path"])
    assert child_policy.cloud_allowed and child_policy.autonomy == "propose"
    assert not child_policy.instructions
    scope = resolve(state.db, state.settings.vault, Scope("vault"), cloud_provider=True)
    assert parent["path"] not in scope.paths and child["path"] in scope.paths
    settings(client, parent["path"], ai_scope="subtree")
    inherited = settings(client, child["path"], autonomy="auto-apply", cloud="allowed")
    assert inherited["effective"]["values"]["autonomy"] == "none"
    assert inherited["effective"]["values"]["cloud"] == "local-only"
    assert inherited["inherited"]["instructions"][0]["source"] == "Contacts"


def test_auto_apply_setting_is_explicit_opt_in_and_changes_stay_page_scoped(
    client: TestClient,
) -> None:
    a, b, c = [page(client, title) for title in ("Automatic", "Review", "Read only")]
    settings(
        client, a["path"], autonomy="auto-apply", auto_apply_kinds=["append", "edit", "create"]
    )
    settings(client, c["path"], autonomy="none")
    state = client.app.state
    for doc, expected in ((a, "auto_apply"), (b, "propose"), (c, "refuse")):
        effective = policy.resolve(state.settings.vault, state.db, doc["path"])
        assert (
            decide(effective, "append", cloud_model=False, opted=opted_in(state.db)).action
            == expected
        )
    assert (
        decide(
            policy.resolve(state.settings.vault, state.db, a["path"]),
            "delete",
            cloud_model=False,
            opted=opted_in(state.db),
        ).action
        == "propose"
    )


def test_shared_instructions_edit_preserves_frontmatter_and_checks_conflicts(
    client: TestClient,
) -> None:
    state = client.app.state
    root = state.settings.vault / "AGENTS.md"
    root.write_text("---\ncloud: local-only\n---\nKeep it clear.\n")
    route = "/api/v1/vault/instructions?source=AGENTS.md"
    original = client.get(route).json()
    assert original["text"].strip() == "Keep it clear."
    body = {"text": "Use plain language.\n", "base_hash": original["hash"]}
    changed = client.put(route, json=body)
    assert changed.status_code == 200
    assert "cloud: local-only" in root.read_text()
    assert root.read_text().endswith("Use plain language.\n")
    assert client.put(route, json=body).status_code == 409
    assert (
        client.get("/api/v1/vault/instructions", params={"source": "../AGENTS.md"}).status_code
        == 400
    )
    assert (
        client.get("/api/v1/vault/instructions", params={"source": "Contacts/page.md"}).status_code
        == 400
    )
    assert (
        state.db.execute(
            "SELECT count(*) FROM activities WHERE action='instructions.write'"
        ).fetchone()[0]
        == 1
    )


def test_instruction_files_cannot_follow_symlinks_outside_vault(
    client: TestClient, tmp_path: Path
) -> None:
    outside = tmp_path / "secret.md"
    outside.write_text("secret")
    root = client.app.state.settings.vault / "AGENTS.md"
    root.symlink_to(outside)
    assert (
        client.get("/api/v1/vault/instructions", params={"source": "AGENTS.md"}).status_code == 400
    )


@pytest.mark.parametrize("previous_context", [False, True])
def test_cloud_never_receives_local_only_page_or_old_context(
    client: TestClient, monkeypatch: pytest.MonkeyPatch, previous_context: bool
) -> None:
    config(client)
    doc = page(client, "Private")
    settings(client, doc["path"], cloud="local-only", instructions="Private instruction")
    scope = {"kind": "vault"} if previous_context else {"kind": "page", "roots": [doc["path"]]}
    conversation = client.post("/api/v1/ai/conversations", json={"scope": scope}).json()
    if previous_context:
        context = ContextSet()
        context.add(Source(0, "page", doc["path"], doc["id"], "Private", [], "Secret body"))
        client.app.state.db.execute(
            "UPDATE conversations SET context_json=? WHERE id=?",
            (context.dump(), conversation["id"]),
        )
    called = []

    async def fake(self: Provider, messages: Any, tools: Any):  # type: ignore[no-untyped-def]
        called.append(messages)
        yield {"content": "Should never run"}

    monkeypatch.setattr(Provider, "chat", fake)
    response = client.post(
        f"/api/v1/ai/conversations/{conversation['id']}/messages", json={"message": "Summarize"}
    )
    assert "local models only" in response.text
    assert not called


def test_model_startup_errors_identify_an_unsupported_architecture() -> None:
    error = startup_error(
        "llama_model_load: error loading model architecture: unknown model architecture: 'gemma4'"
    )
    assert isinstance(error, UnsupportedModelError)
    assert "gemma4" in str(error) and "newer llama-server" in str(error)
    assert "out of memory" in str(startup_error("failed to allocate: out of memory"))


def test_edit_auto_apply_covers_properties_for_older_settings() -> None:
    effective = policy.Effective()
    effective.values.update(autonomy="auto-apply", auto_apply_kinds=["append", "create", "edit"])
    effective.sources["autonomy"] = "Projects"
    assert decide(effective, "properties", cloud_model=False, opted={"Projects"}).action == (
        "auto_apply"
    )
    effective.values["auto_apply_kinds"] = ["append"]
    assert decide(effective, "properties", cloud_model=False, opted={"Projects"}).action == (
        "propose"
    )
