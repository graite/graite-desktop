from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


@dataclass
class PageDoc:
    path: str
    id: str
    title: str
    icon: str | None
    frontmatter: dict[str, Any]
    body: str
    hash: str


@dataclass
class TreeNode:
    path: str
    id: str
    title: str
    icon: str | None
    children: list[TreeNode] = field(default_factory=list)
    has_content: bool = False
    # The body holds a graite:view fence, so its children are that view's entries.
    has_view: bool = False


@dataclass
class TrashEntry:
    trash_id: str
    path: str | None
    title: str
    trashed_at: str
    # "page" (a page folder) or "attachment" (one file from a page's _assets).
    kind: str = "page"
    file: str | None = None
    page_id: str | None = None
    size: int = 0


@dataclass
class AttachmentEntry:
    file: str  # stored name, `<uuid>-<safe name>`
    name: str  # display name without the uuid prefix
    size: int
    modified: str
    referenced_by: list[str] = field(default_factory=list)
    # Text an earlier version wrote next to the original after an extraction. The user never
    # attached it, so the attachments list leaves it out.
    generated: bool = False


@dataclass
class PurgeResult:
    entries: int
    bytes: int


class AttachmentInUse(Exception):
    """The attachment is still referenced by these pages; pass force to trash it anyway."""

    def __init__(self, paths: list[str]) -> None:
        super().__init__("attachment in use")
        self.paths = paths


class ConflictError(Exception):
    """The page on disk no longer matches the caller's base hash."""

    def __init__(self, hash: str, body: str) -> None:
        super().__init__("conflict")
        self.hash = hash
        self.body = body
