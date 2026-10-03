"""Charts and read-only queries over a page's tables (D72)."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

from graite.config import Settings
from graite.tables.charts import check_chart

CARS = "Garage/_data/cars.csv"
OWNERS = "Garage/_data/owners.csv"


def setup(client: TestClient, settings: Settings) -> Path:
    for title in ("Garage", "Elsewhere"):
        client.post("/api/v1/pages", json={"title": title})
    data = settings.vault / "Garage" / "_data"
    data.mkdir()
    (data / "cars.csv").write_text(
        "id,name,brand,price,status,bought\n"
        "c1,Audi A4,Audi,40000,Done,2026-01-15\n"
        "c2,Audi Q5,Audi,55000,Open,2026-02-03\n"
        "c3,Model 3,Tesla,45000,Done,2026-02-20\n"
        "c4,Corolla,Toyota,25000,Open,\n"
    )
    (data / "owners.csv").write_text(
        "id,first_name,city,car\no1,Rik,Utrecht,[[c1|Audi A4]] [[c3|Model 3]]\n"
        "o2,Cam,Delft,[[c2|Audi Q5]]\n"
    )
    (data / "owners.schema.json").write_text(
        json.dumps({"columns": {"car": {"type": "relation", "table": "cars"}}})
    )
    (data / "cars.schema.json").write_text(
        json.dumps(
            {
                "display": "name",
                "columns": {"owners": {"type": "relation", "table": "owners", "reverse": "car"}},
            }
        )
    )
    other = settings.vault / "Elsewhere" / "_data"
    other.mkdir()
    (other / "secret.csv").write_text("id,x\ns1,1\n")
    client.portal.call(client.app.state.fileops.rescan)  # type: ignore[attr-defined]
    return data


def chart(client: TestClient, spec: dict[str, Any], page: str = "Garage") -> Any:
    r = client.post("/api/v1/charts/data", json={"page_path": page, "spec": spec})
    return r.json() if r.status_code == 200 else (r.status_code, r.json()["detail"])


def test_check_chart_rules() -> None:
    assert check_chart({"source": "cars", "x": "brand"}) is None
    assert "not both" in (check_chart({"source": "a", "sql": "SELECT 1"}) or "")
    assert "x:" in (check_chart({"source": "a"}) or "")
    assert check_chart({"source": "a", "type": "number", "y": "sum(price)"}) is None
    assert "type:" in (check_chart({"source": "a", "x": "b", "type": "radar"}) or "")
    assert "y:" in (check_chart({"source": "a", "x": "b", "y": "median(x)"}) or "")
    assert "sort:" in (check_chart({"source": "a", "x": "b", "sort": "name"}) or "")
    assert "filter" in (check_chart({"source": "a", "x": "b", "filter": "a = ("}) or "")
    assert "does not go" in (check_chart({"sql": "SELECT 1", "x": "b"}) or "")


def test_bar_by_column_and_number(client: TestClient, settings: Settings) -> None:
    setup(client, settings)
    out = chart(client, {"source": "_data/cars.csv", "x": "brand", "y": "sum(price)"})
    assert out["categories"] == ["Audi", "Tesla", "Toyota"]
    assert out["series"] == [
        {"name": "Total price", "data": [95000, 45000, 25000], "format": "number"}
    ]
    assert out["tables"] == [CARS]
    out = chart(client, {"source": "cars", "type": "number", "y": "avg(price)"})
    assert out["value"] == 41250
    out = chart(client, {"source": "cars", "x": "brand", "filter": 'status = "Done"'})
    assert out["categories"] == ["Audi", "Tesla"]


def test_plain_number_columns_are_values(client: TestClient, settings: Settings) -> None:
    setup(client, settings)
    # The obvious chart: each car's price, by name (one row per label: the value itself).
    out = chart(client, {"source": "cars", "x": "name", "y": "price", "sort": "x asc"})
    assert out["categories"] == ["Audi A4", "Audi Q5", "Corolla", "Model 3"]
    assert out["series"] == [
        {"name": "price", "data": [40000, 55000, 25000, 45000], "format": "number"}
    ]
    # Several number fields: one series each; labels say what they are.
    out = chart(client, {"source": "cars", "x": "brand", "y": ["price", "avg(price)", "count"]})
    assert [s["name"] for s in out["series"]] == ["price", "Average price", "Count"]
    # An aggregate without its column is refused by name, as is a text column.
    status, detail = chart(client, {"source": "cars", "x": "brand", "y": "sum()"})
    assert status == 400 and "sum() needs a number column" in detail
    status, detail = chart(client, {"source": "cars", "x": "brand", "y": "status"})
    assert status == 400 and "not a number field" in detail
    assert "needs a number column" in str(check_chart({"source": "a", "x": "b", "y": "avg()"}))


def test_currency_and_percent_values_say_so(client: TestClient, settings: Settings) -> None:
    data = setup(client, settings)
    (data / "cars.schema.json").write_text(
        json.dumps(
            {"display": "name", "columns": {"price": {"type": "currency", "currency": "USD"}}}
        )
    )
    out = chart(client, {"source": "cars", "x": "brand", "y": "price"})
    assert out["series"][0]["format"] == "currency:USD"
    out = chart(client, {"source": "cars", "type": "number", "y": "avg(price)"})
    assert out["format"] == "currency:USD" and out["label"] == "Average price"


def test_series_buckets_and_sort(client: TestClient, settings: Settings) -> None:
    setup(client, settings)
    out = chart(client, {"source": "cars", "type": "line", "x": "month(bought)", "y": "count"})
    # Dates in order; rows without one come last.
    assert out["categories"] == ["2026-01", "2026-02", "(empty)"]
    assert out["series"][0]["data"] == [1, 2, 1]
    out = chart(client, {"source": "cars", "x": "brand", "series": "status", "sort": "x desc"})
    assert out["categories"] == ["Toyota", "Tesla", "Audi"]
    by = {s["name"]: s["data"] for s in out["series"]}
    assert by == {"Done": [None, 1, 1], "Open": [1, None, 1]}


def test_relation_paths_both_ways(client: TestClient, settings: Settings) -> None:
    setup(client, settings)
    # Forward: each owner's cars, by brand.
    out = chart(client, {"source": "owners", "x": "car.brand", "y": "sum(car.price)"})
    assert dict(zip(out["categories"], out["series"][0]["data"], strict=True)) == {
        "Audi": 95000,
        "Tesla": 45000,
    }
    assert out["tables"] == [CARS, OWNERS]
    # A relation column alone means its rows' names.
    out = chart(client, {"source": "owners", "x": "car"})
    assert sorted(out["categories"]) == ["Audi A4", "Audi Q5", "Model 3"]
    # Reverse: cars per owner city, from the cars table.
    out = chart(client, {"source": "cars", "x": "owners.city"})
    assert dict(zip(out["categories"], out["series"][0]["data"], strict=True)) == {
        "Utrecht": 2,
        "Delft": 1,
        "(empty)": 1,
    }


def test_errors_are_words(client: TestClient, settings: Settings) -> None:
    setup(client, settings)
    status, detail = chart(client, {"source": "cars", "x": "colour"})
    assert status == 400 and "no column 'colour'" in detail and "brand" in detail
    status, detail = chart(client, {"source": "cars", "x": "brand", "y": "sum(name)"})
    assert status == 400 and "not a number field" in detail
    status, detail = chart(client, {"source": "Elsewhere/_data/secret.csv", "x": "x"})
    assert status == 400 and "not one of the tables" in detail


def test_sql_charts_and_the_links_view(client: TestClient, settings: Settings) -> None:
    setup(client, settings)
    sql = (
        "SELECT o.first_name, count(*) AS cars FROM owners o "
        "JOIN links l ON l.\"table\" = 'owners' AND l.column = 'car' AND l.row_id = o.id "
        "JOIN cars c ON c.id = l.target_id GROUP BY o.first_name ORDER BY o.first_name"
    )
    out = chart(client, {"sql": sql})
    assert out["categories"] == ["Cam", "Rik"]
    assert out["series"] == [{"name": "cars", "data": [1, 2], "format": "number"}]
    r = client.post("/api/v1/tables/query", json={"page_path": "Garage", "sql": sql})
    assert r.status_code == 200 and r.json()["rows"] == [["Cam", 1], ["Rik", 2]]


@pytest.mark.parametrize(
    "sql",
    ["DELETE FROM cars", 'SELECT * FROM "Elsewhere/secret"', "CREATE TABLE x (a)"],
)
def test_query_is_read_only_and_scoped(client: TestClient, settings: Settings, sql: str) -> None:
    setup(client, settings)
    r = client.post("/api/v1/tables/query", json={"page_path": "Garage", "sql": sql})
    assert r.status_code == 400


def test_subpage_tables_are_in_scope(client: TestClient, settings: Settings) -> None:
    setup(client, settings)
    r = client.post("/api/v1/pages", json={"title": "Fuel", "parent_path": "Garage"})
    assert r.status_code == 201, r.text
    data = settings.vault / "Garage" / "Fuel" / "_data"
    data.mkdir()
    (data / "fills.csv").write_text("id,litres\nf1,40\nf2,35\n")
    client.portal.call(client.app.state.fileops.rescan)  # type: ignore[attr-defined]
    r = client.post(
        "/api/v1/tables/query",
        json={"page_path": "Garage", "sql": 'SELECT sum(litres) FROM "Garage/Fuel/fills"'},
    )
    assert r.status_code == 200, r.text
    assert r.json()["rows"] == [[75.0]]
