from __future__ import annotations

import asyncio
import json
from pathlib import Path

from fastapi.testclient import TestClient
from watchfiles import Change

from graite.app import create_app
from graite.config import Settings
from graite.vault.watcher import Watcher, changes_to_paths
from tests.conftest import TOKEN


def test_changes_map_to_page_paths_and_policy_folders(tmp_path: Path) -> None:
    vault = tmp_path / "vault"
    (vault / "A" / "B").mkdir(parents=True)
    (vault / "A" / "page.md").write_text("---\ntitle: A\n---\n")
    changes = {
        (Change.modified, str(vault / "A" / "page.md")),
        (Change.added, str(vault / "A" / "B" / "page.md")),
        (Change.deleted, str(vault / "Gone" / "page.md")),
        (Change.modified, str(vault / "A" / "AGENTS.md")),
        (Change.modified, str(vault / "AGENTS.md")),
        (Change.added, str(vault / "A" / "_skills" / "x" / "SKILL.md")),
        (Change.modified, str(vault / "A" / "_assets" / "pic.png")),
        (Change.modified, str(vault / ".graite" / "index.sqlite")),
        (Change.modified, str(vault / "A" / ".page.md.tmp-1")),
        (Change.added, str(vault / "NewFolder")),
    }
    pages, policies = changes_to_paths(vault, changes)
    assert pages == ["A", "Gone", "NewFolder"]  # A covers A/B
    assert policies == ["", "A"]


def test_daemon_writes_are_ignored_by_the_watcher(client: TestClient) -> None:
    client.post("/api/v1/pages", json={"title": "Own"})
    vault = client.app.state.settings.vault
    pages, _ = changes_to_paths(vault, {(Change.added, str(vault / "Own" / "page.md"))})
    assert pages == []


def test_external_edit_is_indexed_and_announced(tmp_path: Path) -> None:
    settings = Settings(_env_file=None, vault=tmp_path / "vault", token=TOKEN, no_watch=True)  # type: ignore[call-arg]
    with TestClient(create_app(settings), headers={"Authorization": f"Bearer {TOKEN}"}) as client:
        page = client.post("/api/v1/pages", json={"title": "Ext"}).json()
        state = client.app.state
        watcher = Watcher(settings.vault, state.fileops, state.events)
        with client.websocket_connect(f"/events?token={TOKEN}") as ws:
            file = settings.vault / "Ext" / "page.md"
            file.write_text(file.read_text() + "\nWritten by vim.\n", encoding="utf-8")
            (settings.vault / "Ext" / "AGENTS.md").write_text("# Rules\n")
            client.portal.call(
                watcher.handle,
                {
                    (Change.modified, str(file)),
                    (Change.added, str(settings.vault / "Ext" / "AGENTS.md")),
                },
            )
            kinds: dict[str, dict] = {}
            while not {"policy_changed", "file_changed"} <= kinds.keys():
                event = json.loads(ws.receive_text())
                kinds.setdefault(event["type"], event["data"])
        assert kinds["policy_changed"] == {"path": "Ext"}
        assert (
            kinds["file_changed"]["actor"] == "external" and kinds["file_changed"]["path"] == "Ext"
        )
        assert kinds["file_changed"]["hash"] != page["hash"]
        assert client.get("/api/v1/pages/Ext").json()["body"].endswith("Written by vim.\n")
        row = state.db.execute("SELECT count(*) FROM chunks WHERE page_path='Ext'").fetchone()[0]
        assert row == 1


async def test_real_filesystem_change_reaches_the_index(tmp_path: Path) -> None:
    from graite.events import EventBus
    from graite.index import db
    from graite.vault.fileops import FileOps
    from tests.test_indexer import write_page

    vault = tmp_path / "vault"
    write_page(vault, "Live", "Live", "Before.\n")
    conn = db.connect(vault / ".graite" / "index.sqlite")
    events = EventBus()
    ops = FileOps(vault, conn, events)
    await ops.rescan()
    watcher = Watcher(vault, ops, events, debounce_ms=100)
    await watcher.start()
    try:
        await asyncio.sleep(0.3)
        (vault / "Live" / "page.md").write_text(
            "---\ntitle: Live\n---\n\nAfter the edit.\n", encoding="utf-8"
        )
        for _ in range(50):
            await asyncio.sleep(0.1)
            if conn.execute(
                "SELECT count(*) FROM chunk_fts WHERE chunk_fts MATCH 'edit'"
            ).fetchone()[0]:
                break
        assert (
            conn.execute("SELECT count(*) FROM chunk_fts WHERE chunk_fts MATCH 'edit'").fetchone()[
                0
            ]
            == 1
        )
    finally:
        await watcher.stop()
        conn.close()


async def test_watcher_shuts_down_cleanly_while_watching(tmp_path: Path) -> None:
    """The file-system watcher runs on a native thread; a cancelled stop crashes at exit."""
    from graite.events import EventBus
    from graite.index import db
    from graite.vault.fileops import FileOps
    from tests.test_indexer import write_page

    vault = tmp_path / "vault"
    write_page(vault, "Live", "Live", "Before.\n")
    conn = db.connect(vault / ".graite" / "index.sqlite")
    ops = FileOps(vault, conn, EventBus())
    await ops.rescan()
    watcher = Watcher(vault, ops, EventBus(), debounce_ms=100)
    await watcher.start()
    try:
        await asyncio.sleep(0.3)
        (vault / "Live" / "page.md").write_text(
            "---\ntitle: Live\n---\n\nDuring shutdown.\n", encoding="utf-8"
        )
        await watcher.stop()
        assert watcher.task is None and watcher.stream is None
        assert watcher.stop_event.is_set()
        await watcher.stop()  # stopping twice is harmless
    finally:
        conn.close()
