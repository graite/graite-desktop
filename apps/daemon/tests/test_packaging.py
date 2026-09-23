"""The packaged daemon only contains what `graite-daemon.spec` puts in it. A data file the
code reads but the spec does not bundle works from source, passes every other test, and breaks
the installed app (it did, 2026-09-20: `engines.json`)."""

from __future__ import annotations

import ast
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SPEC = ROOT / "graite-daemon.spec"


def data_patterns() -> list[str]:
    for node in ast.walk(ast.parse(SPEC.read_text(encoding="utf-8"))):
        if isinstance(node, ast.Assign) and any(
            isinstance(t, ast.Name) and t.id == "DATA_PATTERNS" for t in node.targets
        ):
            return [str(value) for value in ast.literal_eval(node.value)]
    raise AssertionError("graite-daemon.spec no longer defines DATA_PATTERNS")


def test_every_data_file_in_the_package_is_bundled() -> None:
    bundled = {path for pattern in data_patterns() for path in ROOT.glob(pattern)}
    shipped = {
        path
        for path in (ROOT / "graite").rglob("*")
        if path.is_file() and path.suffix not in (".py", ".pyc") and "__pycache__" not in path.parts
    }
    missing = sorted(str(path.relative_to(ROOT)) for path in shipped - bundled)
    assert not missing, (
        f"Not bundled into the packaged daemon: {missing}. "
        "Add a pattern to DATA_PATTERNS in graite-daemon.spec."
    )
    names = {path.name for path in bundled}
    assert {"schema.sql", "catalog.json", "engines.json"} <= names


def test_the_spec_uses_the_patterns_for_its_datas() -> None:
    text = SPEC.read_text(encoding="utf-8")
    assert "datas=_package_datas" in text and "for pattern in DATA_PATTERNS" in text
