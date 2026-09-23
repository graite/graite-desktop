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
