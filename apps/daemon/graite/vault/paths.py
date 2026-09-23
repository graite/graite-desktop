"""Vault-relative path rules (docs/vault-format.md §1).

A page is a folder containing `page.md`. Folders whose name starts with `_` or `.` are never
pages. Paths are always POSIX-style, relative to the vault root, without a trailing slash.
"""

from __future__ import annotations

import posixpath
import re
from pathlib import Path

PAGE_FILE = "page.md"
GRAITE_DIR = ".graite"
RESERVED_PREFIXES = ("_", ".")
_UNSAFE = re.compile(r'[/\\:*?"<>|\x00-\x1f]')


class VaultPathError(ValueError):
    """The path is outside the vault or names something that cannot be a page."""


def validate_rel(rel: str) -> str:
    """Normalize a vault-relative page path; raise VaultPathError if it is not allowed."""
    if rel is None or rel == "" or rel.strip() == "":
        raise VaultPathError("empty path")
    if rel.startswith(("/", "\\")) or re.match(r"^[A-Za-z]:", rel):
        raise VaultPathError("absolute paths are not allowed")
    norm = posixpath.normpath(rel.replace("\\", "/")).strip("/")
    if norm in ("", "."):
        raise VaultPathError("empty path")
    for seg in norm.split("/"):
        if seg in ("", ".", ".."):
            raise VaultPathError("path traversal is not allowed")
        if seg.startswith(RESERVED_PREFIXES):
            raise VaultPathError(f"'{seg}' cannot be a page folder")
    return norm


def slugify(title: str) -> str:
    """Folder name for a title: keep unicode, replace filesystem-unsafe characters."""
    slug = _UNSAFE.sub("-", title).strip().strip(".").strip()
    slug = re.sub(r"\s+", " ", slug)
    if slug.startswith(RESERVED_PREFIXES):
        slug = slug.lstrip("_.").strip()
    return slug[:120] or "Untitled"


def page_dir(vault: Path, rel: str) -> Path:
    return vault / Path(*rel.split("/"))


def page_file(vault: Path, rel: str) -> Path:
    return page_dir(vault, rel) / PAGE_FILE


def is_reserved_name(name: str) -> bool:
    return name.startswith(RESERVED_PREFIXES)


def is_page_dir(p: Path) -> bool:
    return p.is_dir() and not is_reserved_name(p.name) and (p / PAGE_FILE).is_file()


def parent_of(rel: str) -> str | None:
    """Parent page path, or None for a root page."""
    head = posixpath.dirname(rel)
    return head or None
