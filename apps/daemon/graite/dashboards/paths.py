"""Where dashboards live: `<page>/_dashboards/<name>.html` (D72)."""

from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path

from graite.vault.paths import VaultPathError, is_page_dir, page_dir, validate_rel

DASH_DIR = "_dashboards"
SUFFIX = ".html"
MAX_BYTES = 1_000_000
_NAME = re.compile(r"[^/\\:*?\"<>|\x00-\x1f]{1,120}")


@dataclass(frozen=True)
class DashboardPath:
    page: str  # the owning page, e.g. "Projects/Atlas"
    name: str  # "overview"

    @property
    def src(self) -> str:
        """How the page's fence names it."""
        return f"{DASH_DIR}/{self.name}{SUFFIX}"

    @property
    def rel(self) -> str:
        return f"{self.page}/{self.src}"

    def file(self, vault: Path) -> Path:
        return page_dir(vault, self.page) / DASH_DIR / f"{self.name}{SUFFIX}"


def check_name(name: str) -> str:
    name = name.strip()
    if name.lower().endswith(SUFFIX):
        name = name[: -len(SUFFIX)].strip()
    if not _NAME.fullmatch(name) or name.startswith((".", "_")) or name.endswith("."):
        raise VaultPathError("Use a dashboard name without slashes or leading dots.")
    return name


def parse(page: str, src: str) -> DashboardPath:
    """`_dashboards/overview.html` (or just `overview`) on `page`."""
    text = src.replace("\\", "/").strip().strip("/")
    if "/" in text:
        head, _, file = text.rpartition("/")
        if head != DASH_DIR:
            raise VaultPathError("A dashboard is an .html file in the page's _dashboards folder.")
        text = file
    if "." in text and not text.lower().endswith(SUFFIX):
        raise VaultPathError("A dashboard is an .html file.")
    return DashboardPath(page=validate_rel(page), name=check_name(text))


def checked(vault: Path, dashboard: DashboardPath) -> DashboardPath:
    """`dashboard`, if its page exists and nothing on the way is a link out of the vault."""
    directory = page_dir(vault, dashboard.page)
    if not is_page_dir(directory):
        raise FileNotFoundError(dashboard.page)
    root = vault.resolve()
    for item in (directory, directory / DASH_DIR, dashboard.file(vault)):
        if item.is_symlink() or not item.resolve().is_relative_to(root):
            raise VaultPathError("Linked dashboard files are not allowed.")
    return dashboard
