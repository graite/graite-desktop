"""Discover skills: the ones Graite ships, then opt-in vault skills from root to page.

Vault files are resolved through `safe_file` so a skill can never reach outside the vault.
Built-ins are package data at a fixed path and are read directly; they come first so a vault
skill of the same name shadows them, which is the "→ built-ins" tail docs/vault-format.md
has always described.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from graite.vault import frontmatter
from graite.vault.instructions import safe_file
from graite.vault.paths import validate_rel

BUILTIN_DIR = Path(__file__).parent / "builtin"


def _load_from(
    base: Path,
    source: str,
    result: dict[str, dict[str, Any]],
    allowlist: list[str] | None,
    vault: Path | None,
) -> None:
    for file in sorted(base.glob("*/SKILL.md"))[:100] + sorted(base.glob("*.md"))[:100]:
        try:
            checked = file
            if vault is not None:
                checked = safe_file(vault, file.relative_to(vault.resolve()).as_posix())
            with checked.open(encoding="utf-8") as handle:
                meta, body = frontmatter.split(handle.read(24000))
        except (OSError, ValueError):
            continue  # one broken skill file must not hide the others
        except Exception:  # noqa: BLE001 - malformed YAML front matter
            continue
        name = str(meta.get("name") or (file.parent.name if file.name == "SKILL.md" else file.stem))
        if allowlist is not None and name not in allowlist:
            continue
        result[name] = {
            "name": name,
            "description": str(meta.get("description") or name)[:300],
            "body": body,
            "allowed_tools": meta.get("allowed-tools"),
            "source": source,
        }


def discover(
    vault: Path, scope: str | None, allowlist: list[str] | None = None
) -> dict[str, dict[str, Any]]:
    parts = validate_rel(scope).split("/") if scope else []
    folders = [".graite/skills"] + [
        "/".join([*parts[:i], "_skills"]) for i in range(len(parts) + 1)
    ]
    result: dict[str, dict[str, Any]] = {}
    if BUILTIN_DIR.is_dir():
        _load_from(BUILTIN_DIR, "builtin", result, allowlist, None)
    for folder in folders:
        base = safe_file(vault, folder)
        if not base.is_dir():
            continue
        _load_from(base, "vault", result, allowlist, vault)
    return result
