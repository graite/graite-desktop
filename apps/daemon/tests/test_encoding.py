"""Text I/O must not depend on the platform's default encoding (cp1252 on Windows)."""

from __future__ import annotations

import ast
import pathlib

import pytest
from fastapi.testclient import TestClient

import graite

TEXT_CALLS = {"read_text", "write_text"}
SUBPROCESS_CALLS = {"run", "Popen", "check_output"}


def _unspecified(tree: ast.AST) -> list[int]:
    lines = []
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue
        keywords = {k.arg for k in node.keywords}
        func = node.func
        if "encoding" in keywords:
            continue
        if isinstance(func, ast.Attribute) and func.attr in TEXT_CALLS:
            lines.append(node.lineno)
        elif isinstance(func, ast.Name) and func.id == "open":
            mode = node.args[1] if len(node.args) > 1 else None
            mode = next((k.value for k in node.keywords if k.arg == "mode"), mode)
            if not (isinstance(mode, ast.Constant) and "b" in str(mode.value)):
                lines.append(node.lineno)
        elif (
            isinstance(func, ast.Attribute)
            and func.attr in SUBPROCESS_CALLS
            and keywords & {"text", "universal_newlines"}
        ):
            lines.append(node.lineno)
    return lines


def test_every_text_read_and_write_names_its_encoding() -> None:
    root = pathlib.Path(graite.__file__).parent
    offenders = [
        f"{path.relative_to(root.parent)}:{line}"
        for path in sorted(root.rglob("*.py"))
        for line in _unspecified(ast.parse(path.read_text(encoding="utf-8")))
    ]
    assert offenders == []


def test_toggling_a_property_on_a_page_with_emoji(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Byte 0x90 (inside 🐍 and many other characters) has no cp1252 mapping."""
    read_text = pathlib.Path.read_text

    def strict(self: pathlib.Path, *args: object, **kwargs: object) -> str:
        assert "encoding" in kwargs or args, f"read_text({self}) without an encoding"
        return read_text(self, *args, **kwargs)  # type: ignore[arg-type]

    parent = client.post("/api/v1/pages", json={"title": "Projects"}).json()
    child = client.post(
        "/api/v1/pages", json={"title": "Task", "parent_path": parent["path"]}
    ).json()
    body = "Snake 🐍 café\n"
    saved = client.put(
        f"/api/v1/pages/{child['path']}", json={"body": body, "base_hash": child["hash"]}
    ).json()
    monkeypatch.setattr(pathlib.Path, "read_text", strict)
    done = {"id": "done", "name": "Done", "type": "checkbox", "value": True}
    response = client.put(
        "/api/v1/workspace/properties",
        json={"page_id": child["id"], "base_hash": saved["hash"], "properties": [done]},
    )
    assert response.status_code == 200, response.text
    assert client.get(f"/api/v1/pages/{child['path']}").json()["body"] == body
