from __future__ import annotations

import json
import os
import signal
import subprocess
import sys
import time
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]


def daemon(tmp_path: Path, **env: str) -> subprocess.Popen[str]:
    return subprocess.Popen(
        [
            sys.executable,
            "-m",
            "graite",
            "--vault",
            str(tmp_path / "vault"),
            "--port",
            "0",
            "--token",
            "t",
            "--serve",
        ],
        cwd=ROOT,
        env={**os.environ, "GRAITE_APP_DIR": str(tmp_path / "app"), "GRAITE_NO_WATCH": "1", **env},
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )


def test_the_handshake_means_the_service_answers(tmp_path: Path) -> None:
    import httpx

    process = daemon(tmp_path)
    try:
        assert process.stdout is not None
        handshake = json.loads(process.stdout.readline())
        # No waiting, no retries: once the port is announced, the service is there.
        response = httpx.get(
            f"http://127.0.0.1:{handshake['port']}/api/v1/health",
            headers={"Authorization": "Bearer t"},
            timeout=5,
        )
        assert response.status_code == 200
        found = json.loads((tmp_path / "app" / "daemon.json").read_text())
        assert found["url"].endswith(f":{handshake['port']}") and found["pid"] == handshake["pid"]
        assert (tmp_path / "app" / "logs" / "daemon.log").is_file()
    finally:
        process.send_signal(signal.SIGTERM)
        process.wait(timeout=20)


def test_a_daemon_that_cannot_start_announces_nothing_and_says_why(tmp_path: Path) -> None:
    # A missing data file, as in a build that forgot to bundle it.
    script = (
        "import graite.models.engines as e, pathlib, sys;"
        "e.CATALOG_PATH = pathlib.Path('/nonexistent/engines.json');"
        "from graite.cli import main; main(sys.argv[1:])"
    )
    process = subprocess.run(
        [
            sys.executable,
            "-c",
            script,
            "--vault",
            str(tmp_path / "vault"),
            "--port",
            "0",
            "--token",
            "t",
            "--serve",
        ],
        cwd=ROOT,
        env={**os.environ, "GRAITE_APP_DIR": str(tmp_path / "app")},
        capture_output=True,
        text=True,
        timeout=60,
    )
    assert process.returncode != 0
    assert process.stdout.strip() == ""  # no port for the shell to wait on
    assert not (tmp_path / "app" / "daemon.json").exists()
    log = (tmp_path / "app" / "logs" / "daemon.log").read_text()
    assert "engines.json" in log and "startup failed" in log


def test_selftest_passes_from_source() -> None:
    started = time.monotonic()
    process = subprocess.run(
        [sys.executable, "-m", "graite", "selftest"],
        cwd=ROOT,
        capture_output=True,
        text=True,
        timeout=120,
    )
    assert process.returncode == 0, process.stderr[-2000:]
    assert "selftest: ok" in process.stderr and time.monotonic() - started < 120


@pytest.mark.parametrize("argv", [["--host", "0.0.0.0", "--vault", "/tmp/x", "--token", "t"]])
def test_binding_off_loopback_needs_serve(argv: list[str]) -> None:
    process = subprocess.run(
        [sys.executable, "-m", "graite", *argv],
        cwd=ROOT,
        capture_output=True,
        text=True,
        timeout=60,
    )
    assert process.returncode == 2 and "refusing to bind" in process.stderr
