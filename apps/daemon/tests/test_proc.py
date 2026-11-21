"""Every child process the daemon starts must pass `creationflags=NO_WINDOW` (graite/proc.py).

Without it, the packaged daemon on Windows opens an empty console window for each engine or
probe it starts, because the desktop shell runs the daemon itself without a console.
"""

from __future__ import annotations

import ast
from pathlib import Path

import graite

SPAWN = {
    ("asyncio", "create_subprocess_exec"),
    ("asyncio", "create_subprocess_shell"),
    ("subprocess", "run"),
    ("subprocess", "Popen"),
    ("subprocess", "call"),
    ("subprocess", "check_output"),
    ("subprocess", "check_call"),
}


def _passes_no_window(call: ast.Call) -> bool:
    return any(
        k.arg == "creationflags" and isinstance(k.value, ast.Name) and k.value.id == "NO_WINDOW"
        for k in call.keywords
    )


def test_every_spawn_hides_the_console_window() -> None:
    root = Path(graite.__file__).parent
    missing = []
    for path in sorted(root.rglob("*.py")):
        for node in ast.walk(ast.parse(path.read_text(encoding="utf-8"))):
            if (
                isinstance(node, ast.Call)
                and isinstance(node.func, ast.Attribute)
                and isinstance(node.func.value, ast.Name)
                and (node.func.value.id, node.func.attr) in SPAWN
                and not _passes_no_window(node)
            ):
                missing.append(f"{path.relative_to(root)}:{node.lineno}")
    assert not missing, f"spawn without creationflags=NO_WINDOW: {missing}"


def test_system_library_path_drops_the_apps_own_folders() -> None:
    from graite.proc import system_library_path

    bundle, mount = "/tmp/.mount_GraiteAb12/usr/lib/Graite/resources/daemon/_internal", "/opt/app"
    value = ":".join(
        [
            "/home/me/engine",  # an engine's own folder, added by library_env
            bundle,
            "/opt/app/usr/lib/",
            "/opt/app",
            "/tmp/.mount_GraiteOld99/usr/lib/",  # left behind by the copy that ran before
            "",
            "/usr/local/cuda/lib64",
        ]
    )
    assert system_library_path(value, [bundle, mount, ""]) == (
        "/home/me/engine:/usr/local/cuda/lib64"
    )
    # A folder that merely starts with the same letters is not inside the bundle.
    assert system_library_path("/opt/app-other/lib", [mount]) == "/opt/app-other/lib"
    assert system_library_path("/opt/app/usr/lib", [mount]) is None


def test_restore_system_libraries_cleans_the_environment(monkeypatch) -> None:  # type: ignore[no-untyped-def]
    import sys

    from graite import proc

    monkeypatch.setattr(sys, "platform", "linux")
    monkeypatch.setattr(sys, "_MEIPASS", "/bundle/_internal", raising=False)
    monkeypatch.setenv("APPDIR", "/tmp/.mount_GraiteAb12")
    monkeypatch.setenv("LD_LIBRARY_PATH", "/bundle/_internal:/tmp/.mount_GraiteAb12/usr/lib/")
    proc.restore_system_libraries()
    assert "LD_LIBRARY_PATH" not in __import__("os").environ

    monkeypatch.setenv("LD_LIBRARY_PATH", "/bundle/_internal:/usr/local/cuda/lib64")
    proc.restore_system_libraries()
    assert __import__("os").environ["LD_LIBRARY_PATH"] == "/usr/local/cuda/lib64"
