"""Row and column edits on a parsed table (pure: fileops reads, applies and writes).

Rows are addressed by their `id` cell, never by position. A row without a usable id (the
column is missing, the cell is blank or repeats an earlier id) gets an ephemeral id `@<n>`,
its 1-based position among data rows. The next write gives missing and blank ids a real one;
opening a table never writes it (CLAUDE.md rule 5). A repeated id is left alone until the
user asks (`reassign_duplicates`): links from other tables may mean either row (D71).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Literal

from graite.tables import schema as sch
from graite.tables.csvio import Record, Table
from graite.vault.frontmatter import uuid7


@dataclass
class RowConflict:
    id: str
    reason: Literal["missing", "changed"]
    column: str | None = None


class TableConflict(Exception):
    """Some edited rows changed or vanished since the client read them; nothing was written."""

    def __init__(self, hash_: str, conflicts: list[RowConflict]) -> None:
        super().__init__("conflict")
        self.hash = hash_
        self.conflicts = conflicts


@dataclass
class RowOp:
    op: Literal["insert", "update", "delete"]
    id: str | None = None
    values: dict[str, Any] = field(default_factory=dict)
    # The values the client saw for the columns it changes; a mismatch is a conflict.
    base: dict[str, Any] | None = None
    after: str | None = None
    # Insert only: put the row first (a reverted delete of the first row).
    first: bool = False


@dataclass
class ColumnOp:
    op: Literal["add", "rename", "delete", "move"]
    name: str
    to: str | None = None
    index: int | None = None


def pk_index(header: list[str], primary_key: str = "id") -> int | None:
    for i, name in enumerate(header):
        if name.strip().lower() == primary_key.lower():
            return i
    return None


def effective_ids(table: Table, primary_key: str = "id") -> tuple[list[str], list[str]]:
    """One id per data row (in order) and warnings about rows that needed an ephemeral one."""
    pk = pk_index(table.header, primary_key)
    rows = table.rows
    if pk is None:
        return [f"@{n}" for n in range(1, len(rows) + 1)], ["ids_missing"]
    ids: list[str] = []
    seen: set[str] = set()
    blank = duplicate = 0
    for n, record in enumerate(rows, start=1):
        value = record.values[pk].strip() if pk < len(record.values) else ""
        if not value:
            blank += 1
            ids.append(f"@{n}")
        elif value in seen:
            duplicate += 1
            ids.append(f"@{n}")
        else:
            seen.add(value)
            ids.append(value)
    warnings = []
    if blank:
        warnings.append(f"ids_blank:{blank}")
    if duplicate:
        warnings.append(f"ids_duplicate:{duplicate}")
    return ids, warnings


def _cell(record: Record, index: int) -> str:
    return record.values[index] if index < len(record.values) else ""


def _set(record: Record, index: int, text: str) -> None:
    if index >= len(record.values):
        record.values.extend([""] * (index + 1 - len(record.values)))
    if record.values[index] != text:
        record.values[index] = text
        record.raw = None


def ensure_ids(table: Table, primary_key: str = "id") -> dict[str, Record]:
    """Give every row without an id one (adding the column when missing); map every id the
    client could hold, ephemeral ones included, to its record. Repeated ids stay as they are
    (see `reassign_duplicates`) and keep their ephemeral `@<n>`."""
    ids, _ = effective_ids(table, primary_key)
    rows = table.rows
    by_id = dict(zip(ids, rows, strict=True))
    pk = pk_index(table.header, primary_key)
    if pk is None:
        table.header.insert(0, primary_key)
        table.header_raw = None
        for record in table.records:
            if not record.blank:
                record.values.insert(0, uuid7())
                record.raw = None
        pk = 0
    else:
        for eid, record in zip(ids, rows, strict=True):
            if eid.startswith("@") and not _cell(record, pk).strip():
                _set(record, pk, uuid7())
    for record in rows:
        by_id.setdefault(record.values[pk], record)
    return by_id


def reassign_duplicates(table: Table, primary_key: str = "id") -> dict[str, list[str]]:
    """Give every row that repeats an earlier id a new one (the first row keeps it).
    Returns `{repeated id: [new ids]}`. Only on the user's explicit request."""
    ensure_ids(table, primary_key)
    pk = pk_index(table.header, primary_key)
    assert pk is not None
    seen: set[str] = set()
    out: dict[str, list[str]] = {}
    for record in table.rows:
        value = _cell(record, pk).strip()
        if value in seen:
            new_id = uuid7()
            _set(record, pk, new_id)
            out.setdefault(value, []).append(new_id)
        else:
            seen.add(value)
    return out


def _norm(kind: str, text: str) -> str:
    if kind == "relation":
        # A link is its id; a label that changed meanwhile is no conflict.
        return " ".join(link.id for link in sch.links_of(text))
    return sch.to_cell(kind, sch.to_json(kind, sch.to_sql(kind, text)))


def apply_rows(
    table: Table,
    ops: list[RowOp],
    kinds: dict[str, str],
    *,
    file_hash: str,
    primary_key: str = "id",
) -> list[str]:
    """Apply `ops` in order; returns the id of each op's row. Raises TableConflict (and the
    caller writes nothing) when any op targets a row that changed or is gone."""
    by_id = ensure_ids(table, primary_key)
    names = sch.column_names(table.header)
    index = {name: i for i, name in enumerate(names)}
    pk = pk_index(table.header, primary_key)
    assert pk is not None
    conflicts: list[RowConflict] = []
    out: list[str] = []

    def column(name: str) -> int:
        if name not in index:
            raise ValueError(f"The table has no column {name!r}.")
        if index[name] == pk:
            raise ValueError("Row ids cannot be edited.")
        return index[name]

    for op in ops:
        if op.op == "insert":
            new_id = (op.id or "").strip() or uuid7()
            if new_id.startswith("@") or new_id in by_id:
                raise ValueError(f"A row with id {new_id!r} already exists.")
            values = [""] * len(table.header)
            values[pk] = new_id
            for name, value in op.values.items():
                i = column(name)
                values[i] = sch.to_cell(kinds.get(name, "text"), value)
            record = Record(values=values)
            position = len(table.records)
            if op.first:
                position = 0
            elif op.after is not None:
                anchor = by_id.get(op.after)
                if anchor is None:
                    conflicts.append(RowConflict(op.after, "missing"))
                    continue
                position = table.records.index(anchor) + 1
            else:
                # New rows go before any blank lines that end the file.
                while position and table.records[position - 1].blank:
                    position -= 1
            table.records.insert(position, record)
            by_id[new_id] = record
            out.append(new_id)
            continue
        target = by_id.get(op.id or "")
        if target is None:
            conflicts.append(RowConflict(op.id or "", "missing"))
            continue
        record = target
        changed = False
        for name, seen in (op.base or {}).items():
            i = column(name)
            kind = kinds.get(name, "text")
            if _norm(kind, _cell(record, i)) != _norm(kind, sch.to_cell(kind, seen)):
                conflicts.append(RowConflict(op.id or "", "changed", name))
                changed = True
                break
        if changed:
            continue
        if op.op == "delete":
            table.records.remove(record)
            by_id = {k: v for k, v in by_id.items() if v is not record}
        else:
            for name, value in op.values.items():
                i = column(name)
                _set(record, i, sch.to_cell(kinds.get(name, "text"), value))
        out.append(record.values[pk] if op.op == "update" else op.id or "")
    if conflicts:
        raise TableConflict(file_hash, conflicts)
    return out


def apply_columns(table: Table, ops: list[ColumnOp], primary_key: str = "id") -> None:
    """Add, rename, delete or reorder columns. Every row is rewritten for add/delete/move."""
    for op in ops:
        names = sch.column_names(table.header)
        pk = pk_index(table.header, primary_key)
        if op.op == "add":
            name = op.name.strip()
            if not name or name.lower() in (n.lower() for n in names):
                raise ValueError(f"Choose a new, nonempty column name (not {name!r}).")
            at = len(table.header) if op.index is None else max(0, min(op.index, len(table.header)))
            table.header.insert(at, name)
            for record in table.rows:
                if at <= len(record.values):
                    record.values.insert(at, "")
                    record.raw = None
            table.header_raw = None
            continue
        if op.name not in names:
            raise ValueError(f"The table has no column {op.name!r}.")
        i = names.index(op.name)
        if i == pk and op.op in ("rename", "delete"):
            raise ValueError("The id column cannot be renamed or deleted.")
        if op.op == "rename":
            to = (op.to or "").strip()
            if not to or to.lower() in (n.lower() for j, n in enumerate(names) if j != i):
                raise ValueError(f"Choose a new, nonempty column name (not {to!r}).")
            table.header[i] = to
            table.header_raw = None
        elif op.op == "delete":
            table.header.pop(i)
            for record in table.rows:
                if i < len(record.values):
                    record.values.pop(i)
                    record.raw = None
            table.header_raw = None
        else:
            at = max(0, min(op.index if op.index is not None else i, len(table.header) - 1))
            if at == i:
                continue
            table.header.insert(at, table.header.pop(i))
            for record in table.rows:
                record.values.extend([""] * (len(table.header) - len(record.values)))
                record.values.insert(at, record.values.pop(i))
                record.raw = None
            table.header_raw = None
