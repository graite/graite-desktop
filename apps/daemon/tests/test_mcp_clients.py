"""One-click setup of Graite in Claude Code, Codex and Cursor (graite/mcp/clients.py)."""

from __future__ import annotations

import json
import os
import stat
import sys
import tomllib
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from graite.mcp import clients

COMMAND, ARGS = "/opt/Graite/graite-daemon", ["mcp"]


@pytest.fixture
def home(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    home = tmp_path / "home"
    home.mkdir()
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    monkeypatch.setenv("HOME", str(home))
    monkeypatch.setenv("USERPROFILE", str(home))  # what `~` means on Windows
    monkeypatch.delenv("CODEX_HOME", raising=False)
    monkeypatch.setenv("PATH", str(bin_dir))
    return home


def fake_cli(home: Path, name: str) -> Path:
    """A CLI that records its argv, one JSON list per line."""
    log = home.parent / f"{name}.log"
    code = f"import json, sys\nopen({str(log)!r}, 'a').write(json.dumps(sys.argv[1:]) + '\\n')\n"
    bin_dir = home.parent / "bin"
    script = bin_dir / name
    script.write_text(f"#!{sys.executable}\n" + code)
    script.chmod(script.stat().st_mode | stat.S_IEXEC)
    return log


def by_id(found: list[clients.ClientStatus]) -> dict[str, clients.ClientStatus]:
    return {s.id: s for s in found}


async def test_cursor_merges_its_entry_and_keeps_the_rest(home: Path) -> None:
    config = home / ".cursor" / "mcp.json"
    config.parent.mkdir()
    config.write_text(json.dumps({"mcpServers": {"other": {"command": "x"}}, "keep": 1}))
    before = by_id(clients.statuses(COMMAND, ARGS, headless=False))["cursor"]
    assert before.found and not before.installed and before.where == "~/.cursor/mcp.json"

    after = await clients.install("cursor", COMMAND, ARGS, headless=False)
    assert after.installed and not after.outdated
    data = json.loads(config.read_text())
    assert data["keep"] == 1 and data["mcpServers"]["other"] == {"command": "x"}
    assert data["mcpServers"]["graite-local"] == {"command": COMMAND, "args": ARGS}

    moved = by_id(clients.statuses("/new/graite", ARGS, headless=False))["cursor"]
    assert moved.installed and moved.outdated


async def test_cursor_refuses_a_file_it_cannot_read(home: Path) -> None:
    config = home / ".cursor" / "mcp.json"
    config.parent.mkdir()
    config.write_text("{ not json")
    status = by_id(clients.statuses(COMMAND, ARGS, headless=False))["cursor"]
    assert not status.can_install and "not valid JSON" in (status.note or "")
    with pytest.raises(ValueError, match="not valid JSON"):
        await clients.install("cursor", COMMAND, ARGS, headless=False)
    assert config.read_text() == "{ not json"


async def test_codex_config_is_edited_without_the_cli(home: Path) -> None:
    config = home / ".codex" / "config.toml"
    config.parent.mkdir()
    config.write_text(
        'model = "o4"\n\n[mcp_servers.graite-local]\ncommand = "/old"\nargs = []\n\n'
        '[mcp_servers.other]\ncommand = "x"\n'
    )
    status = by_id(clients.statuses(COMMAND, ARGS, headless=False))["codex"]
    assert status.installed and status.outdated and status.where == "~/.codex/config.toml"

    await clients.install("codex", COMMAND, ARGS, headless=False)
    data = tomllib.loads(config.read_text())
    assert data["model"] == "o4"
    assert data["mcp_servers"]["other"] == {"command": "x"}
    assert data["mcp_servers"]["graite-local"] == {"command": COMMAND, "args": ARGS}
    assert config.read_text().count("[mcp_servers.graite-local]") == 1


async def test_codex_home_and_quoting(home: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    codex_home = home / "elsewhere"
    monkeypatch.setenv("CODEX_HOME", str(codex_home))
    await clients.install("codex", 'C:\\Graite "app"\\graite.exe', ["mcp"], headless=False)
    data = tomllib.loads((codex_home / "config.toml").read_text())
    assert data["mcp_servers"]["graite-local"]["command"] == 'C:\\Graite "app"\\graite.exe'


@pytest.mark.skipif(
    os.name == "nt", reason="fake .cmd CLIs are not worth a CI hang; the file edits are tested"
)
async def test_the_cli_is_used_when_it_is_installed(home: Path) -> None:
    codex = fake_cli(home, "codex")
    claude = fake_cli(home, "claude")
    await clients.install("codex", COMMAND, ARGS, headless=False)
    await clients.install("claude-code", COMMAND, ARGS, headless=False)
    assert [json.loads(line) for line in codex.read_text().splitlines()] == [
        ["mcp", "remove", "graite-local"],
        ["mcp", "add", "graite-local", "--", COMMAND, "mcp"],
    ]
    assert [json.loads(line) for line in claude.read_text().splitlines()] == [
        ["mcp", "remove", "-s", "user", "graite-local"],
        ["mcp", "add", "-s", "user", "graite-local", "--", COMMAND, "mcp"],
    ]
    assert not (home / ".codex" / "config.toml").exists()  # the CLI owns the file


async def test_claude_code_needs_its_cli_and_reads_its_config(home: Path) -> None:
    status = by_id(clients.statuses(COMMAND, ARGS, headless=False))["claude-code"]
    assert not status.found and not status.can_install
    with pytest.raises(ValueError, match="claude command"):
        await clients.install("claude-code", COMMAND, ARGS, headless=False)
    (home / ".claude.json").write_text(
        json.dumps({"mcpServers": {"graite-local": {"command": COMMAND, "args": ARGS}}})
    )
    assert by_id(clients.statuses(COMMAND, ARGS, headless=False))["claude-code"].installed


async def test_headless_never_touches_this_computer(home: Path) -> None:
    for status in clients.statuses(COMMAND, ARGS, headless=True):
        assert not status.can_install and "server" in (status.note or "")
    with pytest.raises(ValueError, match="server"):
        await clients.install("cursor", COMMAND, ARGS, headless=True)
    assert not (home / ".cursor").exists()


def test_info_lists_the_apps_and_the_route_adds_one(client: TestClient, home: Path) -> None:
    info = client.get("/api/v1/mcp/info").json()
    assert [c["id"] for c in info["clients"]] == ["claude-code", "codex", "cursor"]
    added = client.post("/api/v1/mcp/clients/cursor")
    assert added.status_code == 200, added.text
    assert added.json()["installed"] is True
    assert "graite-local" in (home / ".cursor" / "mcp.json").read_text()
    assert client.post("/api/v1/mcp/clients/vim").status_code == 400
