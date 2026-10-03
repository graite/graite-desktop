"""Read and write table CSV files without disturbing what Graite did not change.

The file keeps its dialect (delimiter, line endings, BOM, trailing newline) and every record
that was not edited is written back byte for byte, so a one-cell edit is a one-line diff in
git or a sync client.
"""

from __future__ import annotations

import csv
import io
import re
from dataclasses import dataclass, field

_LINE = re.compile(r"[^\r\n]*(?:\r\n|\n|\r)|[^\r\n]+$")
_TERMINATOR = re.compile(r"(?:\r\n|\n|\r)$")
DELIMITERS = ",;\t|"


@dataclass
class Dialect:
    delimiter: str = ","
    newline: str = "\n"
    bom: bool = False
    trailing_newline: bool = True


@dataclass
class Record:
    """One CSV record. `raw` is its original text (without terminator) until it is edited."""

    values: list[str]
    raw: str | None = None

    @property
    def blank(self) -> bool:
        return not self.values


@dataclass
class Table:
    header: list[str]
    records: list[Record] = field(default_factory=list)
    dialect: Dialect = field(default_factory=Dialect)
    header_raw: str | None = None

    @property
    def rows(self) -> list[Record]:
        """Data records, skipping blank lines."""
        return [r for r in self.records if not r.blank]

    def column(self, name: str) -> int:
        return self.header.index(name)


def _detect(text: str) -> Dialect:
    first = re.search(r"\r\n|\n|\r", text)
    newline = first.group(0) if first else "\n"
    sample = text[:8192]
    head = sample.split(newline, 1)[0] if first else sample
    delimiter = ","
    try:
        delimiter = csv.Sniffer().sniff(sample, delimiters=DELIMITERS).delimiter
    except csv.Error:
        # Sniffer gives up on one-column and one-line files; count in the header instead.
        counts = {d: head.count(d) for d in DELIMITERS}
        best = max(counts, key=lambda d: counts[d])
        delimiter = best if counts[best] else ","
    # The sniffer can pick a character that only appears inside quoted values of the header.
    if head.count(delimiter) == 0 and head.count(",") > 0:
        delimiter = ","
    return Dialect(
        delimiter=delimiter, newline=newline, trailing_newline=bool(_TERMINATOR.search(text))
    )


def parse(text: str) -> Table:
    bom = text.startswith("﻿")
    if bom:
        text = text[1:]
    dialect = _detect(text)
    dialect.bom = bom
    lines = _LINE.findall(text)
    reader = csv.reader(iter(lines), delimiter=dialect.delimiter, strict=False)
    records: list[Record] = []
    consumed = 0
    for values in reader:
        raw = _TERMINATOR.sub("", "".join(lines[consumed : reader.line_num]))
        consumed = reader.line_num
        records.append(Record(values=values, raw=raw))
    if not records:
        return Table(header=[], dialect=dialect)
    head = records.pop(0)
    return Table(header=head.values, records=records, dialect=dialect, header_raw=head.raw)


def _format(values: list[str], delimiter: str) -> str:
    out = io.StringIO()
    csv.writer(out, delimiter=delimiter, lineterminator="", quoting=csv.QUOTE_MINIMAL).writerow(
        values
    )
    return out.getvalue()


def serialize(table: Table) -> str:
    d = table.dialect
    lines = [
        table.header_raw if table.header_raw is not None else _format(table.header, d.delimiter)
    ]
    for record in table.records:
        lines.append(record.raw if record.raw is not None else _format(record.values, d.delimiter))
    text = d.newline.join(lines)
    if d.trailing_newline:
        text += d.newline
    return ("﻿" if d.bom else "") + text


def decode(data: bytes) -> str:
    """Text of an imported file: UTF-8 (with or without BOM), else Windows-1252."""
    try:
        return data.decode("utf-8")
    except UnicodeDecodeError:
        return data.decode("cp1252", errors="replace")
