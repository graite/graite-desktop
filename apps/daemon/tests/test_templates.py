"""Built-in templates (D77): every one must make a working page tree.

The contract test makes each template in a fresh vault and checks what a user would hit:
tables load without warnings (no broken relations or page links, valid formulas), every chart
fence draws, every view and table fence is one the editor keeps, and every query the
dashboards run works on the template's own tables.
"""

from __future__ import annotations

import json
import re
from datetime import date, timedelta
from pathlib import Path
from typing import Any

import pytest
import yaml
from fastapi.testclient import TestClient

from graite.config import Settings
from graite.tables import csvio
from graite.templates import catalog
from graite.vault.blocks import check_fences

SLUGS = [t.slug for t in catalog.templates()]
FENCE = re.compile(r"^```graite:(\w+)\n(.*?)^```", re.MULTILINE | re.DOTALL)
QUERIES = re.compile(r"const QUERIES = (\{.*?\n\});", re.DOTALL)


def use(client: TestClient, slug: str, **body: Any) -> dict[str, Any]:
    r = client.post(f"/api/v1/templates/{slug}/use", json=body)
    assert r.status_code == 201, r.text
    return dict(r.json())


def sql_vars() -> dict[str, str]:
    """Values for the `$NAME` dates dashboards fill in (any plausible date works)."""
    today = date.today()
    month = today.replace(day=1)
    quarter = month.replace(month=(month.month - 1) // 3 * 3 + 1)
    out = {
        "TODAY": today,
        "ASOF": today,
        "FROM": today.replace(month=1, day=1),
        "TO": today,
        "SOON": today + timedelta(days=14),
        "STALE": today - timedelta(days=30),
        "YEAR_AGO": today - timedelta(days=365),
        "MONTH_START": month,
        "MONTH_END": (month + timedelta(days=32)).replace(day=1) - timedelta(days=1),
        "QUARTER_START": quarter,
        "WEEK_START": today - timedelta(days=today.weekday()),
        "WEEK_END": today + timedelta(days=6 - today.weekday()),
        "LATER": today + timedelta(days=30),
        "HISTORY": today - timedelta(days=180),
    }
    return {k: v.isoformat() for k, v in out.items()}


def fill(sql: str) -> str:
    for name, value in sorted(sql_vars().items(), key=lambda kv: -len(kv[0])):
        sql = sql.replace("$" + name, value)
    assert "$" not in sql, f"unknown variable in {sql}"
    return sql


def test_the_catalog_lists_every_template(client: TestClient) -> None:
    r = client.get("/api/v1/templates")
    assert r.status_code == 200
    listed = r.json()
    assert [t["slug"] for t in listed] == SLUGS
    assert len(SLUGS) == 10
    for t in listed:
        assert t["category"] in catalog.CATEGORIES and t["description"] and t["tables"]


@pytest.mark.parametrize("slug", SLUGS)
def test_template_makes_a_working_tree(client: TestClient, settings: Settings, slug: str) -> None:
    doc = use(client, slug)
    root = doc["path"]
    folder = settings.vault / root
    written = [p for p in folder.rglob("*") if p.is_file()]
    for path in written:
        text = path.read_text(encoding="utf-8")
        assert "{{" not in text or path.suffix == ".html", f"placeholder left in {path}"
        assert not re.search(r"\{\{\s*(id|table|page|date|month|quarter|week|monday|title)\b", text)
    assert not list((settings.vault / ".graite" / "staging").glob("*"))

    tables = client.get("/api/v1/tables").json()
    mine = [t for t in tables if t["page_path"] == root or t["page_path"].startswith(root + "/")]
    assert mine, "a template has tables"
    for table in mine:
        page = client.get("/api/v1/tables/rows", params={"path": table["path"]}).json()
        assert page["warnings"] == [], (table["path"], page["warnings"])
        for column in page["columns"]:
            assert column["invalid"] == 0, (table["path"], column["name"])
        # Row documents (D80) belong to rows that exist.
        docs = settings.vault / table["path"].removesuffix(".csv")
        if docs.is_dir():
            ids = {r["id"] for r in page["rows"]}
            assert {f.stem for f in docs.glob("*.md")} <= ids, table["path"]
            assert set(page["docs"]) == {f.stem for f in docs.glob("*.md")}
        # New tables are `;`-separated (D78).
        text = (settings.vault / table["path"]).read_text(encoding="utf-8")
        assert csvio.parse(text).dialect.delimiter == ";"

    pages = [p for p in written if p.name == "page.md"]
    # The shared shape (docs/templates.md): a home page with the stats, one live view and links
    # to the database pages; each database page shows one table, and each table has one page.
    top = (folder / "page.md").read_text(encoding="utf-8")
    home = FENCE.findall(top)
    assert not (folder / "Data").exists(), slug
    assert [kind for kind, _ in home].count("dashboard") >= 1, slug
    assert [kind for kind, _ in home].count("table") == 1, slug
    assert "```graite:chart" not in top, slug
    shown: dict[str, str] = {}
    for page_file in pages:
        if page_file.parent == folder:
            continue
        kinds = FENCE.findall(page_file.read_text(encoding="utf-8"))
        tables = [yaml.safe_load(text) for kind, text in kinds if kind == "table"]
        if not tables:
            continue  # a guide or note page
        assert len(tables) == 1, page_file
        sources = {view["source"] for view in tables[0]["views"]}
        assert len(sources) == 1, (page_file, sources)
        source = sources.pop()
        assert source not in shown, (source, shown.get(source), page_file)
        shown[source] = page_file.parent.name
        assert f"[[{page_file.parent.name}]]" in top, (slug, page_file.parent.name)
    assert set(shown) == {Path(t["path"]).stem for t in mine}, slug
    for page_file in pages:
        rel = page_file.parent.relative_to(settings.vault).as_posix()
        body = page_file.read_text(encoding="utf-8")
        assert check_fences(body) is None, (rel, check_fences(body))
        for kind, text in FENCE.findall(body):
            spec = yaml.safe_load(text)
            if kind == "chart":
                r = client.post("/api/v1/charts/data", json={"page_path": rel, "spec": spec})
                assert r.status_code == 200, (rel, spec, r.text)
            elif kind == "dashboard":
                assert (page_file.parent / spec["src"]).is_file()
            elif kind == "table":
                # Each named view (D79), or the block itself in the older form.
                for view in spec.get("views") or [spec]:
                    r = client.get(
                        "/api/v1/tables/resolve",
                        params={"page_path": rel, "source": view["source"]},
                    )
                    assert r.status_code == 200, (rel, view, r.text)
                    sort = view.get("sort", "")
                    params = {
                        "path": r.json()["path"],
                        "filter": view.get("filter", ""),
                        "sort": sort if isinstance(sort, str) else ",".join(sort),
                    }
                    r = client.get("/api/v1/tables/rows", params=params)
                    assert r.status_code == 200, (rel, view, r.text)
                    columns = {c["name"]: c for c in r.json()["columns"]}
                    if view.get("view") == "board":
                        group = columns.get(view.get("group", ""))
                        assert group and group["type"] in ("status", "single_select"), view
                    for name in [*view.get("show", []), *view.get("columns", [])]:
                        assert name in columns, (view["name"], name)

    # Every dashboard file is shown by a fence, and every query it runs works.
    fences: set[Path] = set()
    for page_file in pages:
        for kind, text in FENCE.findall(page_file.read_text(encoding="utf-8")):
            if kind == "dashboard":
                spec = yaml.safe_load(text)
                fences.add(page_file.parent / spec["src"])
    assert set(fences) == set(folder.rglob("_dashboards/*.html")), "every dashboard is shown"
    for html in fences:
        page = html.parent.parent.relative_to(settings.vault).as_posix()
        found = QUERIES.search(html.read_text(encoding="utf-8"))
        assert found, f"{html} keeps its SQL in `const QUERIES = {{…}};`"
        for name, sql in json.loads(found.group(1)).items():
            body = {"page_path": page, "sql": fill(sql)}
            r = client.post("/api/v1/tables/query", json=body)
            assert r.status_code == 200, (html.name, name, r.text)


@pytest.mark.parametrize("slug", SLUGS)
def test_without_sample_data(client: TestClient, settings: Settings, slug: str) -> None:
    template = catalog.get(slug)
    doc = use(client, slug, title="Mine", sample_data=False)
    assert doc["title"] == "Mine" and doc["path"] == "Mine"
    for csv_file in (settings.vault / "Mine").rglob("_data/*.csv"):
        rows = csvio.parse(csv_file.read_text(encoding="utf-8")).rows
        if csv_file.stem not in template.keep_rows:
            assert rows == [], csv_file
    for page_file in (settings.vault / "Mine").rglob("page.md"):
        assert "template_sample" not in page_file.read_text(encoding="utf-8")
    for table in client.get("/api/v1/tables").json():
        page = client.get("/api/v1/tables/rows", params={"path": table["path"]}).json()
        assert page["warnings"] == [], (table["path"], page["warnings"])


def test_each_use_gets_fresh_ids_and_a_free_folder(client: TestClient, settings: Settings) -> None:
    first = use(client, "crm")
    second = use(client, "crm")
    assert (first["path"], second["path"]) == ("CRM", "CRM 2")
    assert first["id"] != second["id"]
    a = (settings.vault / "CRM/_data/deals.csv").read_text(encoding="utf-8")
    b = (settings.vault / "CRM 2/_data/deals.csv").read_text(encoding="utf-8")
    assert a.splitlines()[0] == b.splitlines()[0] and a.splitlines()[1] != b.splitlines()[1]


def test_under_a_parent_page(client: TestClient, settings: Settings) -> None:
    client.post("/api/v1/pages", json={"title": "Work"})
    doc = use(client, "projects", parent_path="Work")
    assert doc["path"].startswith("Work/")
    parent = (settings.vault / "Work" / "page.md").read_text(encoding="utf-8")
    assert f"[[{doc['path'].split('/')[-1]}]]" in parent
    r = client.post("/api/v1/templates/nope/use", json={})
    assert r.status_code == 404


def test_render_is_pure_and_dated() -> None:
    template = catalog.get("crm")
    rendered = catalog.render(template, "X", "X", today=date(2026, 1, 15))
    assert "page.md" in rendered.files and rendered.pages[""] == "X"
    meta = rendered.files["page.md"].split("---")[1]
    assert "title: X" in meta and "template_" not in meta
    assert "2026-01-09" in rendered.files["_data/activities.csv"]  # {{date:-6}}
    # Placeholders in file names: a row's document is named by the row's new id (D80).
    docs = [path for path in rendered.files if path.startswith("_data/deals/")]
    assert len(docs) == 1 and "{{" not in docs[0]
    assert (
        docs[0].removeprefix("_data/deals/").removesuffix(".md")
        in rendered.files["_data/deals.csv"]
    )


def _bookkeeping_position(client: TestClient, root: str, asof: str) -> dict[str, float]:
    found = None
    for path in (catalog.get("bookkeeping").root / "_dashboards").glob("*.html"):
        match = QUERIES.search(path.read_text(encoding="utf-8"))
        if match and "position" in json.loads(match.group(1)):
            found = json.loads(match.group(1))
    assert found is not None
    out: dict[str, float] = {}
    for key in ("position", "cash", "cash_unassigned"):
        sql = found[key].replace("$ASOF", asof)
        r = client.post("/api/v1/tables/query", json={"page_path": root, "sql": sql})
        assert r.status_code == 200, r.text
        result = r.json()
        rows = [dict(zip(result["columns"], row, strict=True)) for row in result["rows"]]
        if key == "position":
            out.update({k: float(v or 0) for k, v in rows[0].items()})
        elif key == "cash":
            out["cash"] = sum(float(r["balance"] or 0) for r in rows)
        else:
            out["cash_unassigned"] = float(rows[0]["amount"] or 0)
    return out


def test_the_balance_sheet_balances(client: TestClient) -> None:
    root = use(client, "bookkeeping")["path"]
    for days in (0, -30, -90):
        asof = (date.today() + timedelta(days=days)).isoformat()
        p = _bookkeeping_position(client, root, asof)
        assets = p["cash"] + p["cash_unassigned"] + p["receivables"]
        liabilities = p["payables"] + p["vat_payable"] + p["loans"]
        equity = p["opening"] + p["owner"] + p["profit"]
        assert assets - liabilities - equity == pytest.approx(p["transfers"], abs=0.01), (asof, p)
        assert p["transfers"] == pytest.approx(0, abs=0.01)
