"""Resolve root-to-page instructions without following links outside the vault."""

from pathlib import Path

from graite.vault.paths import validate_rel


def safe_file(vault: Path, relative: str) -> Path:
    root = vault.resolve()
    target = (root / relative).resolve()
    if not target.is_relative_to(root):
        raise ValueError("This file is outside the vault.")
    return target


def cascade(vault: Path, page: str) -> list[dict[str, str]]:
    page = validate_rel(page)
    parts = page.split("/")
    result = []
    remaining = 16000
    for i in range(len(parts) + 1):
        relative = "/".join([*parts[:i], "AGENTS.md"])
        path = safe_file(vault, relative)
        if path.is_file() and remaining:
            with path.open(encoding="utf-8") as handle:
                text = handle.read(remaining)
            remaining -= len(text)
            result.append({"path": relative, "text": text})
    return result
