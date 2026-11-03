"""Built-in templates (D77): ready-made page trees with tables, charts and dashboards.

A template is a folder in `builtin/<slug>/`: `template.json` describes it, and `root/` is the
page tree it makes, laid out as in a vault (`page.md`, `_data/*.csv`, `*.schema.json`,
`_dashboards/*.html`, subpage folders). Nothing is written until the user picks one; then
`render` fills in the placeholders and `FileOps.create_from_template` writes the result.

Placeholders, so every use gets fresh ids and current dates:

    {{id:acme}}        a new row id (uuid7), the same everywhere `acme` is named
    {{table:deals}}    a new table id for `<name>.schema.json` and relation `table_id`s
    {{page:playbook}}  the vault path of the page whose frontmatter has `template_key: playbook`
    {{date:-30}}       today plus or minus some days, as YYYY-MM-DD
    {{month:-2}}       the first day of a month relative to this one, as YYYY-MM-DD
    {{quarter:0}}      a quarter relative to this one, as `2026 Q4`
    {{week:-1}}        an ISO week relative to this one, as `2026 W44`
    {{monday:-1}}      the Monday of a week relative to this one, as YYYY-MM-DD
    {{title}}          the title the user gave the template's top page

File names may hold placeholders too, written with `=` since Windows forbids `:` in file names,
e.g. a row's document `_data/deals/{{id=pilot}}.md`.

A page's frontmatter may hold `template_key` (for `{{page:…}}`) and `template_sample: true`
(left out without sample data); both are dropped from the written page. Placeholders in
frontmatter go inside quotes (`value: "{{date:-3}}"`), so the template stays valid YAML.
Without sample data, tables keep only their header row, except those named in `keep_rows`.
"""

from __future__ import annotations

import json
import re
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import date, timedelta
from functools import cache
from pathlib import Path
from typing import Any

from graite.tables import csvio
from graite.vault import frontmatter as fm

BUILTIN = Path(__file__).parent / "builtin"
CATEGORIES = ("Business", "Finance", "Work", "Personal")
TEXT_SUFFIXES = (".md", ".csv", ".json", ".html")
_PLACEHOLDER = re.compile(
    r"\{\{\s*(id|table|page|date|month|quarter|week|monday|title)(?:[:=]\s*([-\w]+))?\s*\}\}"
)
# A row's document (D80): `_data/<table>/<row id>.md`.
_ROW_DOC = re.compile(r"(?:^|/)_data/([^/]+)/[^/]+\.md$")
_CHART = re.compile(r"^```graite:chart\b", re.MULTILINE)
SAMPLE_KEY = "template_sample"
PAGE_KEY = "template_key"


@dataclass
class TableSummary:
    name: str
    page: str  # the page title it sits on
    columns: list[dict[str, str]]  # {name, type} in file order, then schema-only columns


@dataclass
class Template:
    slug: str
    name: str
    description: str
    icon: str
    category: str
    tags: list[str]
    keep_rows: list[str]
    order: int
    highlights: list[str]
    root: Path
    pages: list[str] = field(default_factory=list)
    tables: list[TableSummary] = field(default_factory=list)
    charts: int = 0
    dashboards: list[str] = field(default_factory=list)

    def to_json(self) -> dict[str, Any]:
        return {
            "slug": self.slug,
            "name": self.name,
            "description": self.description,
            "icon": self.icon,
            "category": self.category,
            "tags": self.tags,
            "highlights": self.highlights,
            "pages": self.pages,
            "tables": [t.__dict__ for t in self.tables],
            "charts": self.charts,
            "dashboards": self.dashboards,
        }


def _load(folder: Path) -> Template:
    meta = json.loads((folder / "template.json").read_text(encoding="utf-8"))
    root = folder / "root"
    if not (root / "page.md").is_file():
        raise ValueError(f"Template {folder.name} has no root/page.md.")
    category = meta.get("category", "Work")
    if category not in CATEGORIES:
        raise ValueError(f"Template {folder.name} has unknown category {category!r}.")
    template = Template(
        slug=folder.name,
        name=str(meta["name"]),
        description=str(meta["description"]),
        icon=str(meta.get("icon") or "📄"),
        category=category,
        tags=[str(t) for t in meta.get("tags", [])],
        keep_rows=[str(t) for t in meta.get("keep_rows", [])],
        order=int(meta.get("order", 100)),
        highlights=[str(h) for h in meta.get("highlights", [])],
        root=root,
    )
    for page_file in sorted(root.rglob("page.md")):
        page_meta, body = fm.split(page_file.read_text(encoding="utf-8"))
        title = str(page_meta.get("title") or page_file.parent.name)
        if "{{" in title:
            title = page_file.parent.name  # a dated title, e.g. "Week {{week:0}}"
        template.pages.append(template.name if page_file.parent == root else title)
        template.charts += len(_CHART.findall(body))
        data = page_file.parent / "_data"
        for csv_file in sorted(data.glob("*.csv")) if data.is_dir() else []:
            template.tables.append(_table_summary(csv_file, template.pages[-1]))
        dashboards = page_file.parent / "_dashboards"
        if dashboards.is_dir():
            template.dashboards += [d.stem for d in sorted(dashboards.glob("*.html"))]
    return template


def _table_summary(csv_file: Path, page: str) -> TableSummary:
    parsed = csvio.parse(csv_file.read_text(encoding="utf-8"))
    schema_file = csv_file.with_name(csv_file.stem + ".schema.json")
    specs: dict[str, Any] = {}
    if schema_file.is_file():
        specs = json.loads(schema_file.read_text(encoding="utf-8")).get("columns", {})
    columns = [
        {"name": name, "type": str(specs.get(name, {}).get("type", "text"))}
        for name in parsed.header
        if name != "id"
    ]
    shown = {c["name"] for c in columns}
    for name, spec in specs.items():
        if name not in shown and (spec.get("type") == "formula" or spec.get("reverse")):
            columns.append(
                {"name": name, "type": "formula" if spec.get("type") == "formula" else "relation"}
            )
    return TableSummary(name=csv_file.stem, page=page, columns=columns)


@cache
def templates() -> tuple[Template, ...]:
    """Every built-in template, in gallery order."""
    found = [_load(d) for d in sorted(BUILTIN.iterdir()) if (d / "template.json").is_file()]
    return tuple(sorted(found, key=lambda t: (t.order, t.name)))


def get(slug: str) -> Template:
    for template in templates():
        if template.slug == slug:
            return template
    raise FileNotFoundError(f"There is no template {slug!r}.")


# ------------------------------------------------------------------ rendering


@dataclass
class Rendered:
    """A template's files ready to write: paths relative to the new top page's folder."""

    files: dict[str, str]
    # Relative folder of each page ("" for the top page) -> its title.
    pages: dict[str, str]


def _months(day: date, delta: int) -> date:
    month = day.month - 1 + delta
    return date(day.year + month // 12, month % 12 + 1, 1)


def render(
    template: Template,
    root_rel: str,
    title: str,
    *,
    sample_data: bool = True,
    today: date | None = None,
    new_id: Callable[[], str] = fm.uuid7,
) -> Rendered:
    """The files of `template` for a top page at vault path `root_rel` titled `title`."""
    today = today or date.today()
    ids: dict[tuple[str, str], str] = {}
    page_paths: dict[str, str] = {}
    # Keys of sample pages left out: links to them only appear in sample rows, which go too.
    dropped: set[str] = set()
    skipped: list[str] = []  # page folders (relative) left out without sample data
    pages: dict[str, str] = {}
    sources: list[tuple[str, Path]] = []

    for page_file in sorted(template.root.rglob("page.md")):
        rel = page_file.parent.relative_to(template.root).as_posix()
        rel = "" if rel == "." else rel
        meta, _ = fm.split(page_file.read_text(encoding="utf-8"))
        if any(rel == s or rel.startswith(s + "/") for s in skipped):
            continue
        if meta.get(SAMPLE_KEY) and not sample_data:
            skipped.append(rel)
            if isinstance(meta.get(PAGE_KEY), str):
                dropped.add(meta[PAGE_KEY])
            continue
        key = meta.get(PAGE_KEY)
        if isinstance(key, str):
            page_paths[key] = root_rel + (f"/{rel}" if rel else "")
        pages[rel] = title if not rel else str(meta.get("title") or page_file.parent.name)

    for path in sorted(template.root.rglob("*")):
        if not path.is_file():
            continue
        rel = path.relative_to(template.root).as_posix()
        folder = rel.rsplit("/", 1)[0] if "/" in rel else ""
        owner = folder.removesuffix("/_data").removesuffix("/_dashboards")
        owner = "" if owner in ("_data", "_dashboards") else owner
        if any(owner == s or owner.startswith(s + "/") for s in skipped):
            continue
        doc = _ROW_DOC.search(rel)
        if doc and not sample_data and doc.group(1) not in template.keep_rows:
            continue  # a sample row's document goes with its row
        if path.suffix.lower() not in TEXT_SUFFIXES:
            raise ValueError(f"Template file {rel} is not text; templates hold text only.")
        sources.append((rel, path))

    def fill(match: re.Match[str]) -> str:
        kind, arg = match.group(1), match.group(2) or ""
        if kind in ("id", "table"):
            return ids.setdefault((kind, arg), new_id())
        if kind == "page":
            if arg in dropped:
                return ""
            if arg not in page_paths:
                raise ValueError(f"{{{{page:{arg}}}}} names no page with template_key {arg!r}.")
            return page_paths[arg]
        if kind == "date":
            return (today + timedelta(days=int(arg or 0))).isoformat()
        if kind == "month":
            return _months(today, int(arg or 0)).isoformat()
        if kind == "quarter":
            start = _months(today, int(arg or 0) * 3)
            return f"{start.year} Q{(start.month - 1) // 3 + 1}"
        if kind == "week":
            year, week, _ = (today + timedelta(weeks=int(arg or 0))).isocalendar()
            return f"{year} W{week:02d}"
        if kind == "monday":
            day = today + timedelta(weeks=int(arg or 0))
            return (day - timedelta(days=day.weekday())).isoformat()
        return title

    files: dict[str, str] = {}
    for rel, path in sources:
        text = _PLACEHOLDER.sub(fill, path.read_text(encoding="utf-8"))
        if path.name == "page.md":
            meta, body = fm.split(text)
            meta.pop(SAMPLE_KEY, None)
            meta.pop(PAGE_KEY, None)
            for key in ("id", "created", "updated"):
                meta.pop(key, None)
            if rel == "page.md":
                meta["title"] = title
            page_title = str(meta.pop("title", None) or path.parent.name)
            fresh = fm.new_meta(page_title, meta.pop("icon", None))
            fresh.update(meta)
            files[_PLACEHOLDER.sub(fill, rel)] = fm.join(fresh, body)
            continue
        if path.suffix == ".csv" and not sample_data and path.stem not in template.keep_rows:
            parsed = csvio.parse(text)
            parsed.records = []
            text = csvio.serialize(parsed)
        files[_PLACEHOLDER.sub(fill, rel)] = text
    return Rendered(files=files, pages=pages)
