"""Formula columns (D75): defined in the schema, computed by the cache, never in the CSV."""

from __future__ import annotations

import json
import sqlite3
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

from graite.config import Settings
from graite.tables.formula import FormulaError, compile_all, compile_formula, rename_column

T = "Books/_data/invoices.csv"


def value(sql_text: str, **row: Any) -> Any:
    conn = sqlite3.connect(":memory:")
    names = list(row) or ["x"]
    conn.execute("CREATE TABLE t (" + ", ".join(f'"{n}"' for n in names) + ")")
    conn.execute(
        f"INSERT INTO t VALUES ({', '.join('?' for _ in names)})", list(row.values()) or [None]
    )
    compiled = compile_formula(sql_text, lambda name: '"' + name + '"')
    return conn.execute(f"SELECT {compiled.sql} FROM t").fetchone()[0]


def test_expressions() -> None:
    assert value("net * vat_rate / 100", net=200.0, vat_rate=21.0) == 42.0
    assert value("1 / 2") == 0.5
    assert value("1 / 0") is None
    assert value("-a + 2 * (b - 1)", a=1, b=3) == 3
    assert value('if(stage = "Won", v, v * p / 100)', stage="Lost", v=1000.0, p=25.0) == 250.0
    assert value("round(x, 1)", x=2.345) == 2.3
    assert value("min(a, b) + max(a, b)", a=1, b=5) == 6
    assert value("coalesce(a, 0)", a=None) == 0
    assert value('concat(a, " ", b)', a="Acme", b=None) == "Acme "
    assert value("days_between(a, b)", a="2026-01-01", b="2026-01-31") == 30.0
    assert value("add_days(a, 14)", a="2026-01-25") == "2026-02-08"
    assert value("quarter(a) + year(a)", a="2026-08-02") == 2029
    assert value("a is empty and not (b is empty)", a="", b="x") == 1
    assert value("`net amount` > 10", **{"net amount": 11}) == 1
    assert value('x = "it\'s"', x="it's") == 1


@pytest.mark.parametrize(
    ("text", "message"),
    [
        ("", "Write a formula"),
        ("a +", "ends too early"),
        ("today()", "Unknown function"),
        ("round()", "takes 1–2 values"),
        ("a b", "Unexpected"),
        ("(a b", r"Expected '\)'"),
    ],
)
def test_bad_formulas(text: str, message: str) -> None:
    with pytest.raises(FormulaError, match=message):
        compile_formula(text, lambda name: name)


def test_compile_all_checks_names_and_cycles() -> None:
    out, warnings = compile_all(
        {"vat": "net * rate / 100", "total": "net + vat", "a": "b", "b": "a", "c": "a + 1"},
        ["net", "rate"],
    )
    assert out["vat"] == '(("net" * "rate") * 1.0 / 100)' and out["total"] == '("net" + "vat")'
    assert out["a"] is None and out["b"] is None and out["c"] is None
    assert any(w.startswith("formula_invalid:c:It uses 'a'") for w in warnings)
    out, warnings = compile_all({"x": "missing * 2", "y": "x"}, ["net"], ["linked"])
    assert out == {"x": None, "y": None}
    assert warnings[0] == "formula_invalid:x:The table has no column 'missing'."
    assert compile_all({"x": "linked"}, [], ["linked"])[1][0].endswith("only read this row.")


def test_rename_column_keeps_the_rest() -> None:
    assert rename_column("net*rate/100 + round(net)", "net", "Net amount") == (
        "`Net amount`*rate/100 + round(`Net amount`)"
    )
    # A function of the same name is not a reference.
    assert rename_column("round(round)", "round", "r") == "round(r)"
    assert rename_column('"net" + `net`', "net", "n") == '"net" + n'


# ------------------------------------------------------------------ through the API


def setup(client: TestClient, settings: Settings) -> Path:
    client.post("/api/v1/pages", json={"title": "Books"})
    data = settings.vault / "Books" / "_data"
    data.mkdir()
    (data / "invoices.csv").write_text(
        "id;number;net;vat_rate;status\na;2026-001;1000;21;Paid\nb;2026-002;250.5;9;Sent\n",
        encoding="utf-8",
    )
    (data / "invoices.schema.json").write_text(
        json.dumps(
            {
                "columns": {
                    "net": {"type": "currency"},
                    "vat_rate": {"type": "percent"},
                    "vat": {
                        "type": "formula",
                        "formula": "round(net * vat_rate / 100, 2)",
                        "format": "currency",
                    },
                    "total": {"type": "formula", "formula": "net + vat", "format": "currency"},
                    "paid": {"type": "formula", "formula": 'status = "Paid"', "format": "checkbox"},
                }
            }
        ),
        encoding="utf-8",
    )
    return data / "invoices.csv"


def rows(client: TestClient, **params: Any) -> dict[str, Any]:
    r = client.get("/api/v1/tables/rows", params={"path": T, **params})
    assert r.status_code == 200, r.text
    return dict(r.json())


def test_formula_columns_read_filter_sort_and_chart(client: TestClient, settings: Settings) -> None:
    setup(client, settings)
    page = rows(client)
    by_name = {c["name"]: c for c in page["columns"]}
    assert by_name["vat"]["type"] == "formula" and by_name["vat"]["format"] == "currency"
    assert by_name["vat"]["currency"] == "EUR"
    assert page["warnings"] == []
    cells = {r["id"]: dict(zip(page["visible"], r["cells"], strict=True)) for r in page["rows"]}
    assert cells["a"]["vat"] == 210.0 and cells["a"]["total"] == 1210.0
    assert cells["b"]["vat"] == 22.55 and cells["a"]["paid"] is True and cells["b"]["paid"] is False

    assert [r["id"] for r in rows(client, filter="total > 500")["rows"]] == ["a"]
    assert [r["id"] for r in rows(client, sort="total asc")["rows"]] == ["b", "a"]

    r = client.post(
        "/api/v1/tables/query",
        json={"page_path": "Books", "sql": "SELECT sum(total) FROM invoices"},
    )
    assert r.status_code == 200, r.text
    assert r.json()["rows"] == [[pytest.approx(1483.05)]]

    r = client.post(
        "/api/v1/charts/data",
        json={
            "page_path": "Books",
            "spec": {"source": "_data/invoices.csv", "type": "bar", "x": "status", "y": "total"},
        },
    )
    assert r.status_code == 200, r.text


def test_formulas_are_never_written(client: TestClient, settings: Settings) -> None:
    csv = setup(client, settings)
    before = csv.read_text(encoding="utf-8")
    r = client.post(
        "/api/v1/tables/rows",
        json={"path": T, "ops": [{"op": "update", "id": "a", "values": {"total": 5}}]},
    )
    assert r.status_code == 400 and "formula" in r.json()["detail"]
    r = client.post(
        "/api/v1/tables/rows",
        json={"path": T, "ops": [{"op": "update", "id": "a", "values": {"net": 2000}}]},
    )
    assert r.status_code == 200, r.text
    text = csv.read_text(encoding="utf-8")
    assert "total" not in text and text != before
    cells = rows(client, filter="number = 2026-001")["rows"][0]["cells"]
    assert 2420.0 in cells


def test_renaming_a_column_follows_into_formulas(client: TestClient, settings: Settings) -> None:
    setup(client, settings)
    r = client.post(
        "/api/v1/tables/columns",
        json={"path": T, "ops": [{"op": "rename", "name": "net", "to": "Net amount"}]},
    )
    assert r.status_code == 200, r.text
    schema = json.loads((settings.vault / "Books/_data/invoices.schema.json").read_text())
    assert schema["columns"]["vat"]["formula"] == "round(`Net amount` * vat_rate / 100, 2)"
    assert rows(client)["warnings"] == []
    # Deleting a formula column only touches the schema.
    r = client.post(
        "/api/v1/tables/columns", json={"path": T, "ops": [{"op": "delete", "name": "paid"}]}
    )
    assert r.status_code == 200, r.text
    assert "paid" not in [c["name"] for c in rows(client)["columns"]]


def test_broken_formula_is_a_warning_and_check_explains(
    client: TestClient, settings: Settings
) -> None:
    setup(client, settings)
    r = client.patch(
        "/api/v1/tables/schema",
        json={
            "path": T,
            "schema": {"columns": {"bad": {"type": "formula", "formula": "nope * 2"}}},
        },
    )
    assert r.status_code == 200, r.text
    page = rows(client)
    assert "formula_invalid:bad:The table has no column 'nope'." in page["warnings"]
    assert {r["cells"][page["visible"].index("bad")] for r in page["rows"]} == {None}

    r = client.post("/api/v1/tables/formula/check", json={"path": T, "formula": "net * 2"})
    assert r.json() == {"ok": True, "error": None, "sample": [2000.0, 501.0]}
    r = client.post("/api/v1/tables/formula/check", json={"path": T, "formula": "net +"})
    assert r.json()["ok"] is False and "ends too early" in r.json()["error"]


def test_cache_rebuilds_formulas(client: TestClient, settings: Settings) -> None:
    setup(client, settings)
    assert rows(client)["rows"][0]["cells"]
    cache: Any = client.app.state.tables  # type: ignore[attr-defined]
    cache.conn.execute("DELETE FROM _tables")
    page = rows(client)
    assert dict(zip(page["visible"], page["rows"][0]["cells"], strict=True))["total"] == 1210.0
