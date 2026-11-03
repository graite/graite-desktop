"""Column types for a table: `<name>.schema.json` when it exists, inferred from the data otherwise.

The schema file is optional and hand-editable, so a broken one never hides the table: the
problem becomes a warning and the types fall back to inference.
"""

from __future__ import annotations

import json
import math
import re
from dataclasses import dataclass, field
from typing import Any, Literal, get_args

from graite.tables import formula as fx
from graite.tables import links as lnk

ColumnType = Literal[
    "text",
    "number",
    "currency",
    "percent",
    "single_select",
    "multi_select",
    "status",
    "date",
    "checkbox",
    "url",
    "email",
    "relation",
    "formula",
    "file",
    "page",
]
TYPES: tuple[str, ...] = get_args(ColumnType)
# Names schema files may still use; read as the page-property kind of the same meaning.
ALIASES = {
    "integer": "number",
    "boolean": "checkbox",
    "bool": "checkbox",
    "select": "single_select",
    "multiselect": "multi_select",
    "datetime": "date",
    "percentage": "percent",
}
NUMERIC = ("number", "currency", "percent")
# Fixed decimals a numeric column may show (D82).
MAX_DECIMALS = 6
PANEL_MODES = ("auto", "pills", "list")
# Cells that hold `[[target|label]]` links (D71, D76): rows, attachments and pages.
LINKED = ("relation", "file", "page")
CHOICES = ("single_select", "multi_select", "status")
SQL_TYPES = {"number": "REAL", "currency": "REAL", "percent": "REAL", "checkbox": "INTEGER"}
# Multi-select cells are written `a|b`; `a; b` (the separator before D78) is still read,
# since rows nobody edited keep their bytes and a file may hold both forms.
MULTI_SEPARATOR = "|"
_MULTI_SPLIT = re.compile(r"[|;]")
SAMPLE = 500
MAX_OPTIONS = 100
DEFAULT_CURRENCY = "EUR"

_INT = re.compile(r"-?\d{1,18}")
_NUM = re.compile(r"-?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?")
# 1,234.50 / 1 234.50 / 1234.5, with an optional sign.
_GROUPED = re.compile(r"-?(?:\d{1,3}(?:[, \u00a0]\d{3})+|\d+)(?:\.\d+)?")
_DATE = re.compile(r"\d{4}-\d{2}-\d{2}")
_DATETIME = re.compile(
    r"\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?"
)
_URL = re.compile(r"https?://\S+", re.IGNORECASE)
# The same check page properties use (graite/vault/properties.py).
EMAIL = re.compile(r"[^\s@]+@[^\s@]+\.[^\s@]+")
SYMBOLS = {"€": "EUR", "$": "USD", "£": "GBP", "¥": "JPY"}
_MONEY = re.compile(r"^(-?)\s*([€$£¥])?\s*(-?[\d., \u00a0]+?)\s*([€$£¥])?$")
TRUE = ("true", "yes", "y", "1", "x", "✓")
FALSE = ("false", "no", "n", "0", "")
_BOOL_WORDS = ("true", "false", "yes", "no")


def split_multi(text: str) -> list[str]:
    """The elements of a multi-select cell, in either separator."""
    return [part.strip() for part in _MULTI_SPLIT.split(text) if part.strip()]


def join_multi(values: Any) -> str:
    return MULTI_SEPARATOR.join(v.strip() for v in values if v.strip())


def value_kind(column: Column) -> str:
    """The type a column's values have: a formula's format, else the column type."""
    return (column.format or "number") if column.type == "formula" else column.type


def virtual(column: Column) -> bool:
    """Columns the schema defines that the CSV does not hold (reverse relations, formulas)."""
    return bool(column.reverse) or column.type == "formula"


def normalize_type(kind: Any) -> str | None:
    if not isinstance(kind, str):
        return None
    kind = ALIASES.get(kind.strip().lower(), kind.strip().lower())
    return kind if kind in TYPES else None


@dataclass
class Column:
    name: str
    type: ColumnType = "text"
    options: list[str] = field(default_factory=list)
    # Option -> palette name (the page-property colors: gray, blue, green, ...).
    colors: dict[str, str] = field(default_factory=dict)
    currency: str | None = None
    width: int | None = None
    # Show long text on several lines (rows grow to fit).
    wrap: bool = False
    # Non-empty cells that do not read as this type; they stay in the CSV as written.
    invalid: int = 0
    # Relations (D71): the target table's path (a readable hint) and schema id, "one" or
    # "many", and for a reverse column the forward column of `table` it mirrors. A reverse
    # column is virtual: it lives in the schema only, never in the CSV.
    table: str | None = None
    table_id: str | None = None
    cardinality: str | None = None
    reverse: str | None = None
    via: str | None = None
    # The target table's path as the cache resolved it (by id, then by path); None when the
    # target cannot be found.
    target: str | None = None
    # How the row panel and page show a relation's links (D80): {as: auto|pills|list,
    # show: [fields a list row shows]}.
    panel: dict[str, Any] | None = None
    # Formula columns (D75): the expression and how its value shows (number, currency, ...).
    # Like a reverse column it lives in the schema only; the cache computes it.
    formula: str | None = None
    format: str | None = None
    # Number, currency and percent columns (and formulas shown as one): fixed decimals,
    # 0 to MAX_DECIMALS; None shows what the value has (money: the currency's usual places).
    decimals: int | None = None

    def to_json(self) -> dict[str, Any]:
        out: dict[str, Any] = {"name": self.name, "type": self.type}
        for key in (
            "options",
            "colors",
            "currency",
            "width",
            "wrap",
            "table",
            "table_id",
            "cardinality",
            "reverse",
            "via",
            "target",
            "formula",
            "format",
            "panel",
            "invalid",
        ):
            value = getattr(self, key)
            if value:
                out[key] = value
        if self.decimals is not None:
            out["decimals"] = self.decimals  # 0 is a choice, not "unset"
        return out


@dataclass
class Schema:
    primary_key: str = "id"
    # The table's own stable id (uuidv7), written when a relation first involves it.
    id: str | None = None
    display: str | None = None
    display_secondary: str | None = None
    order: list[str] = field(default_factory=list)
    columns: dict[str, dict[str, Any]] = field(default_factory=dict)


def load(text: str | None) -> tuple[Schema, list[str]]:
    """Parse a schema file; returns the schema and any problems found in it."""
    if not text or not text.strip():
        return Schema(), []
    try:
        raw = json.loads(text)
    except json.JSONDecodeError as exc:
        return Schema(), [f"The schema file is not valid JSON ({exc.msg}, line {exc.lineno})."]
    if not isinstance(raw, dict):
        return Schema(), ["The schema file must hold a JSON object."]
    problems: list[str] = []
    schema = Schema()
    if isinstance(raw.get("primary_key"), str) and raw["primary_key"].strip():
        schema.primary_key = raw["primary_key"].strip()
    if isinstance(raw.get("id"), str) and raw["id"].strip():
        schema.id = raw["id"].strip()
    if isinstance(raw.get("display"), str):
        schema.display = raw["display"]
    if isinstance(raw.get("display_secondary"), str):
        schema.display_secondary = raw["display_secondary"]
    template = raw.get("document_template")
    if template is not None and (not isinstance(template, str) or len(template) > 20_000):
        problems.append("document_template must be Markdown text (up to 20 000 characters).")
    if isinstance(raw.get("order"), list):
        schema.order = [c for c in raw["order"] if isinstance(c, str)]
    columns = raw.get("columns") or {}
    if not isinstance(columns, dict):
        problems.append("columns in the schema file must be an object keyed by column name.")
        columns = {}
    for name, spec in columns.items():
        if not isinstance(spec, dict):
            problems.append(f"Column {name!r} in the schema file must be an object.")
            continue
        spec = dict(spec)
        if "type" in spec:
            kind = normalize_type(spec["type"])
            if kind is None:
                problems.append(f"Column {name!r} has unknown type {spec['type']!r}.")
                spec.pop("type")
            else:
                spec["type"] = kind
        if spec.get("type") == "formula":
            if not isinstance(spec.get("formula"), str) or not spec["formula"].strip():
                problems.append(f"Formula column {name!r} needs formula: the expression.")
            if spec.get("format") is not None and spec.get("format") not in fx.FORMATS:
                problems.append(
                    f"format of {name!r} must be one of {', '.join(fx.FORMATS)}, "
                    f"not {spec['format']!r}."
                )
                spec.pop("format")
        if spec.get("type") == "relation" and not isinstance(spec.get("table"), str):
            if not isinstance(spec.get("table_id"), str):
                problems.append(f"Relation {name!r} needs table: the table it links to.")
        options = spec.get("options")
        if isinstance(options, list) and any(
            isinstance(o, str) and MULTI_SEPARATOR in o for o in options
        ):
            problems.append(f"Options of {name!r} cannot contain {MULTI_SEPARATOR!r}.")
        decimals = spec.get("decimals")
        if decimals is not None and not (
            isinstance(decimals, int)
            and not isinstance(decimals, bool)
            and 0 <= decimals <= MAX_DECIMALS
        ):
            problems.append(
                f"decimals of {name!r} must be a whole number from 0 to {MAX_DECIMALS}."
            )
            spec.pop("decimals")
        panel = spec.get("panel")
        if panel is not None:
            ok = (
                isinstance(panel, dict)
                and set(panel) <= {"as", "show"}
                and panel.get("as", "auto") in PANEL_MODES
                and (
                    "show" not in panel
                    or (
                        isinstance(panel["show"], list)
                        and all(isinstance(x, str) for x in panel["show"])
                    )
                )
            )
            if not ok:
                problems.append(
                    f"panel of {name!r} must be {{as: auto|pills|list, show: [field names]}}."
                )
                spec.pop("panel")
        if spec.get("reverse") is not None and not isinstance(spec.get("reverse"), str):
            problems.append(f"reverse of {name!r} must be the name of a column.")
            spec.pop("reverse")
        schema.columns[name] = spec
    return schema, problems


def _money(value: str) -> tuple[float, str | None] | None:
    """`€1,200.50`, `-$3`, `12.5 €` -> (number, currency code or None)."""
    match = _MONEY.match(value.strip())
    if not match:
        return None
    sign, lead, digits, trail = match.groups()
    digits = digits.strip()
    if not _GROUPED.fullmatch(digits.lstrip("-")):
        return None
    number = float(re.sub(r"[, \u00a0]", "", digits))
    if sign or digits.startswith("-"):
        number = -abs(number)
    symbol = lead or trail
    return number, SYMBOLS.get(symbol) if symbol else None


def _percent(value: str) -> float | None:
    text = value.strip()
    if not text.endswith("%"):
        return None
    body = text[:-1].strip()
    return float(body.replace(",", "")) if _GROUPED.fullmatch(body.lstrip("-")) else None


def _infer(values: list[str]) -> tuple[ColumnType, str | None]:
    """The column type the values look like, and a currency code for money columns."""
    filled = [v.strip() for v in values if v.strip()]
    if not filled:
        return "text", None
    if all(_INT.fullmatch(v) for v in filled):
        # Leading zeros are identifiers (postcodes, phone numbers), not numbers.
        if any(len(v.lstrip("-")) > 1 and v.lstrip("-").startswith("0") for v in filled):
            return "text", None
        return "number", None
    if all(_NUM.fullmatch(v) for v in filled):
        return "number", None
    if all(_percent(v) is not None for v in filled):
        return "percent", None
    money = [_money(v) for v in filled]
    if all(money) and any(m and m[1] for m in money):
        codes = {m[1] for m in money if m and m[1]}
        return "currency", codes.pop() if len(codes) == 1 else None
    if all(v.lower() in _BOOL_WORDS for v in filled):
        return "checkbox", None
    if all(_DATE.fullmatch(v) or _DATETIME.fullmatch(v) for v in filled):
        return "date", None
    if all(_URL.fullmatch(v) for v in filled):
        return "url", None
    if all(EMAIL.fullmatch(v) for v in filled):
        return "email", None
    return "text", None


def _distinct(values: list[str], multi: bool) -> list[str]:
    seen: dict[str, None] = {}
    for raw in values:
        parts = split_multi(raw) if multi else [raw]
        for part in parts:
            part = part.strip()
            if part and part not in seen:
                seen[part] = None
                if len(seen) >= MAX_OPTIONS:
                    return list(seen)
    return list(seen)


def columns_for(header: list[str], rows: list[list[str]], schema: Schema) -> list[Column]:
    """The table's columns in file order, typed by the schema or by the data."""
    from graite.vault.properties import _colors as default_colors

    out: list[Column] = []
    for index, name in enumerate(header):
        spec = schema.columns.get(name, {})
        cells = [r[index] if index < len(r) else "" for r in rows]
        kind = spec.get("type")
        if kind == "formula":
            kind = None  # a column in the CSV holds values; formulas live in the schema only
        if kind is None and name.strip().lower() == schema.primary_key.lower():
            kind = "text"  # ids are names, even when they look like numbers
        currency = spec.get("currency") if isinstance(spec.get("currency"), str) else None
        if kind is None:
            kind, inferred = _infer(cells[:SAMPLE])
            currency = currency or inferred
        if kind == "currency":
            currency = (currency or DEFAULT_CURRENCY).upper()[:3]
        options = spec.get("options")
        options = [str(o) for o in options] if isinstance(options, list) else []
        colors: dict[str, str] = {}
        if kind in CHOICES:
            # Values in the data that the schema does not list are options too.
            for value in _distinct(cells, kind == "multi_select"):
                if value not in options and len(options) < MAX_OPTIONS:
                    options.append(value)
            raw_colors = spec.get("colors")
            given: dict[str, Any] = raw_colors if isinstance(raw_colors, dict) else {}
            colors = {
                option: str(given.get(option) or default)
                for option, default in default_colors(options).items()
            }
        width = spec.get("width")
        out.append(
            Column(
                name=name,
                type=kind,
                invalid=sum(1 for c in cells if not fits(kind, c)),
                options=options if kind in CHOICES else [],
                colors=colors,
                currency=currency if kind == "currency" else None,
                width=width if isinstance(width, int) and 20 <= width <= 2000 else None,
                wrap=spec.get("wrap") is True,
                decimals=spec.get("decimals") if kind in NUMERIC else None,
                **_relation(spec, kind),
            )
        )
    taken = {c.name.lower() for c in out} | {r.lower() for r in RESERVED}
    for name, spec in schema.columns.items():
        # Reverse columns: derived from the other table's links, not stored in this CSV.
        if not isinstance(spec.get("reverse"), str) or name.lower() in taken:
            continue
        taken.add(name.lower())
        width = spec.get("width")
        out.append(
            Column(
                name=name,
                type="relation",
                width=width if isinstance(width, int) and 20 <= width <= 2000 else None,
                **_relation({**spec, "cardinality": "many"}, "relation"),
            )
        )
    for name, spec in schema.columns.items():
        # Formula columns (D75): computed by the cache, never stored in the CSV.
        if spec.get("type") != "formula" or name.lower() in taken:
            continue
        taken.add(name.lower())
        width = spec.get("width")
        fmt = spec.get("format") if spec.get("format") in fx.FORMATS else "number"
        currency = spec.get("currency") if isinstance(spec.get("currency"), str) else None
        out.append(
            Column(
                name=name,
                type="formula",
                formula=str(spec.get("formula") or ""),
                format=fmt,
                currency=(currency or DEFAULT_CURRENCY).upper()[:3] if fmt == "currency" else None,
                width=width if isinstance(width, int) and 20 <= width <= 2000 else None,
                decimals=spec.get("decimals") if fmt in NUMERIC else None,
            )
        )
    if schema.order:
        rank = {name: i for i, name in enumerate(schema.order)}
        # Unlisted columns follow in file order; reverse columns (not in the CSV) last.
        place = {c.name: n for n, c in enumerate(out)}
        out.sort(key=lambda c: rank.get(c.name, len(rank) + place[c.name]))
    return out


def _relation(spec: dict[str, Any], kind: str) -> dict[str, Any]:
    if kind in ("file", "page"):
        # Attachments and page links (D76): one or several per cell.
        return {"cardinality": "one" if spec.get("cardinality") == "one" else "many"}
    if kind != "relation":
        return {}
    text = {k: spec.get(k) if isinstance(spec.get(k), str) else None for k in ("table", "table_id")}
    reverse = spec.get("reverse") if isinstance(spec.get("reverse"), str) else None
    cardinality = spec.get("cardinality") if spec.get("cardinality") in ("one", "many") else "many"
    via = spec.get("via") if isinstance(spec.get("via"), str) else None
    panel = spec.get("panel") if isinstance(spec.get("panel"), dict) else None
    return {**text, "reverse": reverse, "cardinality": cardinality, "via": via, "panel": panel}


DISPLAY_TYPES = ("text", "single_select", "status", "email", "url")


def display_column(columns: list[Column], schema: Schema) -> str | None:
    """The column that names a row (in pills, pickers and review cards): the schema's
    `display`, else the first text-like column that is not the id."""
    names = {c.name for c in columns if not c.reverse}
    if schema.display and schema.display in names:
        return schema.display
    pk = schema.primary_key.lower()
    for column in columns:
        if column.name.lower() != pk and not column.reverse and column.type in DISPLAY_TYPES:
            return column.name
    return None


def secondary_column(columns: list[Column], schema: Schema) -> str | None:
    names = {c.name for c in columns if not c.reverse}
    secondary = schema.display_secondary
    return secondary if secondary and secondary in names else None


def fits(kind: str, text: str) -> bool:
    """Whether a non-empty cell reads as `kind` (empty cells always fit)."""
    value = text.strip()
    if not value:
        return True
    if kind in NUMERIC or kind == "checkbox":
        return not isinstance(to_sql(kind, text), str)
    if kind == "date":
        return bool(_DATE.fullmatch(value) or _DATETIME.fullmatch(value))
    if kind == "email":
        return bool(EMAIL.fullmatch(value))
    if kind == "url":
        return bool(_URL.fullmatch(value))
    if kind in LINKED:
        return lnk.is_links(value)
    return True


_UUID_PREFIX = re.compile(r"^[a-f0-9]{32}-")


def _shown_file(stored: str) -> str:
    """An attachment's original name: its stored name without the unique prefix."""
    return _UUID_PREFIX.sub("", stored) or stored


def targets_of(kind: str, value: Any) -> list[lnk.Link]:
    """File or page links from what a client or agent sends: `{file, name}` / `{path, title}`
    objects, plain names or paths, or link text; one such value or a list."""
    if value is None or value == "":
        return []
    key, label = ("file", "name") if kind == "file" else ("path", "title")
    items = value if isinstance(value, list) else [value]
    out: list[lnk.Link] = []
    for item in items:
        if isinstance(item, dict):
            target = str(item.get(key) or "").strip()
            found = [lnk.Link(target, str(item.get(label) or ""))] if target else []
        else:
            text = str(item).strip()
            found = lnk.parse_links(text) if "[[" in text else [lnk.Link(text)] if text else []
        for link in found:
            if any(x.id == link.id for x in out):
                continue
            if kind == "file" and not _FILE_NAME.fullmatch(link.id):
                raise ValueError(f"{link.id!r} is not an attachment of this page.")
            if kind == "page" and (link.id.startswith("/") or ".." in link.id.split("/")):
                raise ValueError(f"{link.id!r} is not a page path.")
            shown = _shown_file(link.id) if kind == "file" else ""
            out.append(lnk.Link(link.id, link.label or shown))
    return out


# The names `FileOps.add_attachment` gives files (vault/fileops.py).
_FILE_NAME = re.compile(r"[a-zA-Z0-9][a-zA-Z0-9._-]{0,199}")


def check(kind: str, cells: list[str]) -> dict[str, Any]:
    """How the cells of a column would read as `kind`: counts and a few misfits."""
    filled = [c for c in cells if c.strip()]
    bad = [c for c in filled if not fits(kind, c)]
    return {"total": len(filled), "invalid": len(bad), "examples": list(dict.fromkeys(bad))[:3]}


def to_sql(kind: str, text: str) -> Any:
    """The value stored in the cache for one cell. Unparseable cells keep their text."""
    value = text.strip()
    if value == "":
        return None
    if kind in NUMERIC:
        if _NUM.fullmatch(value):
            return float(value)
        parsed = _percent(value) if kind == "percent" else None
        if parsed is None:
            money = _money(value)
            parsed = money[0] if money else None
        if parsed is not None:
            return parsed
    if kind == "checkbox":
        lowered = value.lower()
        if lowered in TRUE:
            return 1
        if lowered in FALSE:
            return 0
    if kind == "date" and _DATETIME.fullmatch(value):
        return value.replace(" ", "T", 1)
    if kind == "multi_select":
        # One form in the cache, whichever separator the file uses.
        return join_multi(split_multi(value)) or None
    return text


def to_json(kind: str, value: Any) -> Any:
    """A cached value as the UI receives it."""
    if value is None:
        return None
    if kind == "checkbox" and isinstance(value, int):
        return bool(value)
    if kind == "multi_select" and isinstance(value, str):
        return split_multi(value)
    if kind == "relation" and isinstance(value, str):
        return [{"id": link.id, "label": link.label} for link in lnk.parse_links(value)]
    if kind == "file" and isinstance(value, str):
        return [
            {"file": link.id, "name": link.label or _shown_file(link.id)}
            for link in lnk.parse_links(value)
        ]
    if kind == "page" and isinstance(value, str):
        return [
            {"path": link.id, "title": link.label or link.id.rsplit("/", 1)[-1]}
            for link in lnk.parse_links(value)
        ]
    return value


def to_cell(kind: str, value: Any) -> str:
    """A value from the UI or an agent as CSV text. Money and percentages stay plain numbers."""
    if value is None:
        return ""
    if kind == "relation":
        return lnk.format_links(links_of(value))
    if kind in ("file", "page"):
        return lnk.format_links(targets_of(kind, value))
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, int):
        return str(value)
    if isinstance(value, float):
        if not math.isfinite(value):
            raise ValueError("Numbers must be finite.")
        return str(int(value)) if value.is_integer() and abs(value) < 1e15 else repr(value)
    if isinstance(value, list):
        return join_multi(str(v) for v in value)
    if kind == "email" and str(value).strip() and not EMAIL.fullmatch(str(value).strip()):
        raise ValueError(f"{value!r} is not an email address.")
    return str(value)


def links_of(value: Any) -> list[lnk.Link]:
    """Links from a relation value as clients send it (ids, `{id, label}` or link text)."""
    items = value if isinstance(value, list) else [value]
    out: list[lnk.Link] = []
    for item in items:
        if isinstance(item, dict):
            rid = str(item.get("id") or "").strip()
            found = [lnk.Link(rid, str(item.get("label") or ""))] if rid else []
        elif item is None:
            found = []
        else:
            found = lnk.parse_links(str(item))
        out += [f for f in found if f.id not in {o.id for o in out}]
    return out


def unique_names(header: list[str], taken: tuple[str, ...] = ()) -> list[str]:
    """Column names as the app addresses them: blanks named, duplicates numbered."""
    seen = {t.lower() for t in taken}
    out: list[str] = []
    for index, raw in enumerate(header):
        base = raw.strip() or f"column {index + 1}"
        name, n = base, 2
        while name.lower() in seen:
            name, n = f"{base} {n}", n + 1
        seen.add(name.lower())
        out.append(name)
    return out


RESERVED = ("_rid", "_row")


def column_names(header: list[str]) -> list[str]:
    """The names the cache, the API and edits use for `header` (never the cache's own
    `_rid` / `_row`)."""
    return unique_names(header, RESERVED)
