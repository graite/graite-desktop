"""Where tables live: `<page>/_data/<name>.csv`, next to an optional `<name>.schema.json`."""

from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path

from graite.vault.paths import VaultPathError, is_page_dir, page_dir, validate_rel

DATA_DIR = "_data"
SUFFIX = ".csv"
SCHEMA_SUFFIX = ".schema.json"
_NAME = re.compile(r"[^/\\:*?\"<>|\x00-\x1f]{1,120}")


@dataclass(frozen=True)
class TablePath:
    page: str  # the owning page, e.g. "Projects/Atlas"
    name: str  # "expenses"

    @property
    def rel(self) -> str:
        return f"{self.page}/{DATA_DIR}/{self.name}{SUFFIX}"

    @property
    def schema_rel(self) -> str:
        return f"{self.page}/{DATA_DIR}/{self.name}{SCHEMA_SUFFIX}"

    def file(self, vault: Path) -> Path:
        return page_dir(vault, self.page) / DATA_DIR / f"{self.name}{SUFFIX}"

    def schema_file(self, vault: Path) -> Path:
        return page_dir(vault, self.page) / DATA_DIR / f"{self.name}{SCHEMA_SUFFIX}"


def check_name(name: str) -> str:
    name = name.strip()
    if name.lower().endswith(SUFFIX):
        name = name[: -len(SUFFIX)].strip()
    if not _NAME.fullmatch(name) or name.startswith((".", "_")) or name.endswith("."):
        raise VaultPathError("Use a table name without slashes or leading dots.")
    if name.lower().endswith(".schema"):
        raise VaultPathError("A table name cannot end in .schema.")
    return name


def parse(rel: str) -> TablePath:
    """Validate a vault-relative table path such as `Projects/Atlas/_data/expenses.csv`."""
    norm = rel.replace("\\", "/").strip("/")
    head, sep, file = norm.rpartition(f"/{DATA_DIR}/")
    if not sep or not file.endswith(SUFFIX) or "/" in file:
        raise VaultPathError("A table is a .csv file in a page's _data folder.")
    return TablePath(page=validate_rel(head), name=check_name(file))


def checked(vault: Path, table: TablePath) -> TablePath:
    """`table`, if its page exists and nothing on the way is a symlink out of the vault."""
    directory = page_dir(vault, table.page)
    if not is_page_dir(directory):
        raise FileNotFoundError(table.page)
    root = vault.resolve()
    data = directory / DATA_DIR
    for item in (directory, data, table.file(vault), table.schema_file(vault)):
        if item.is_symlink() or not item.resolve().is_relative_to(root):
            raise VaultPathError("Linked table files are not allowed.")
    return table


def schema_owner(rel: str) -> str | None:
    """The table path a `<name>.schema.json` belongs to."""
    if rel.endswith(SCHEMA_SUFFIX):
        return rel[: -len(SCHEMA_SUFFIX)] + SUFFIX
    return None
