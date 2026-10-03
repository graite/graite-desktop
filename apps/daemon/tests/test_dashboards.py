"""Dashboards and AI charts (D72): files, the frame, propose_chart, propose_dashboard."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

from graite.config import Settings
from graite.review.proposals import ProposalConflict
from tests.test_tables_agent import PAGE, call, make, registry


async def tool(reg: Any, tool_name: str, **args: Any) -> dict[str, Any]:
    """Like `call`, for tools with a `name` argument."""
    return dict(json.loads(await reg.invoke(tool_name, json.dumps(args))))


HTML = "<!doctype html><html><head><title>t</title></head><body><div id=x></div></body></html>"


# ------------------------------------------------------------------ files and the frame


def test_dashboard_files_and_frame(client: TestClient, settings: Settings) -> None:
    client.post("/api/v1/pages", json={"title": "Atlas"})
    r = client.put(
        "/api/v1/dashboards",
        json={
            "page_path": "Atlas",
            "src": "_dashboards/overview.html",
            "html": HTML,
            "create": True,
        },
    )
    assert r.status_code == 200, r.text
    assert (settings.vault / "Atlas" / "_dashboards" / "overview.html").read_text() == HTML
    # Creating twice is refused; writing without `create` replaces.
    r = client.put(
        "/api/v1/dashboards",
        json={
            "page_path": "Atlas",
            "src": "_dashboards/overview.html",
            "html": HTML,
            "create": True,
        },
    )
    assert r.status_code == 400
    assert client.get("/api/v1/dashboards/list", params={"page_path": "Atlas"}).json() == [
        {"src": "_dashboards/overview.html", "name": "overview"}
    ]
    for bad in ("../x.html", "_dashboards/../../x.html", "_dashboards/x.js", "other/x.html"):
        r = client.get("/api/v1/dashboards", params={"page_path": "Atlas", "src": bad})
        assert r.status_code == 400, bad

    ticket = client.post(
        "/api/v1/dashboards/ticket", json={"page_path": "Atlas", "src": "_dashboards/overview.html"}
    ).json()["url"]
    # The frame needs no token (an iframe cannot send one): the ticket is the key.
    anonymous = TestClient(client.app)
    r = anonymous.get(ticket)
    assert r.status_code == 200
    csp = r.headers["content-security-policy"]
    assert "default-src 'none'" in csp and "connect-src" not in csp
    body = r.text
    assert body.index("echarts") < body.index("window.graite") < body.index("<title>t</title>")
    assert anonymous.get("/api/v1/dashboards/frame?ticket=nope").status_code == 403
    assert anonymous.get("/api/v1/dashboards/list?page_path=Atlas").status_code == 401


# ------------------------------------------------------------------ the AI


async def test_propose_chart_checks_against_the_data(tmp_path: Path) -> None:
    ops, queue = await make(tmp_path)
    reg = registry(ops, queue)
    bad = await call(
        reg,
        "propose_chart",
        page_path=PAGE,
        summary="Spend",
        chart={"source": "expenses", "x": "kind"},
    )
    assert "no column 'kind'" in bad["error"] and "category" in bad["error"]
    ok = await call(
        reg,
        "propose_chart",
        page_path=PAGE,
        summary="Spend per category",
        chart={"source": "expenses", "type": "pie", "x": "category", "y": ["sum(amount)"]},
    )
    assert ok["status"] == "pending", ok
    proposal = queue.get(ok["proposal_id"])
    assert proposal is not None and proposal["kind"] == "append"
    assert proposal["new_text"] == (
        "\n```graite:chart\nsource: expenses\ntype: pie\nx: category\ny: sum(amount)\n```\n"
    )


async def test_dashboard_proposal_waits_applies_and_reverts(tmp_path: Path) -> None:
    ops, queue = await make(tmp_path)
    reg = registry(ops, queue)
    refused = await tool(
        reg,
        "propose_dashboard",
        page_path=PAGE,
        name="overview",
        summary="x",
        html='<script src="https://cdn.example/chart.js"></script>',
    )
    assert "no network" in refused["error"]
    result = await tool(
        reg, "propose_dashboard", page_path=PAGE, name="overview", summary="Overview", html=HTML
    )
    assert result["status"] == "pending", result
    file = ops.vault / PAGE / "_dashboards" / "overview.html"
    assert not file.exists()
    proposal = queue.get(result["proposal_id"])
    assert proposal is not None
    assert proposal["dashboard"] == {
        "src": "_dashboards/overview.html",
        "file": f"{PAGE}/_dashboards/overview.html",
        "show": True,
        "created": True,
        "html": HTML,
    }
    await queue.accept(result["proposal_id"])
    assert file.read_text() == HTML
    body = (await ops.read_page(PAGE)).body
    assert "```graite:dashboard\nsrc: _dashboards/overview.html\n```" in body

    # A change to it: conflict-checked against the file it read.
    change = await tool(
        reg,
        "propose_dashboard",
        page_path=PAGE,
        name="overview",
        summary="Bigger",
        html=HTML.replace("t</title>", "v2</title>"),
    )
    assert queue.get(change["proposal_id"])["dashboard"]["show"] is False  # type: ignore[index]
    file.write_text(HTML.replace("t</title>", "hand</title>"))
    with pytest.raises(ProposalConflict):
        await queue.accept(change["proposal_id"])
    assert "hand" in file.read_text()

    await queue.revert(result["proposal_id"])
    assert not file.exists()
    assert "graite:dashboard" not in (await ops.read_page(PAGE)).body


async def test_read_dashboard_tool(tmp_path: Path) -> None:
    ops, queue = await make(tmp_path)
    reg = registry(ops, queue)
    missing: dict[str, Any] = await tool(reg, "read_dashboard", page_path=PAGE, name="overview")
    assert "does not exist" in missing["error"]
    await ops.write_dashboard(PAGE, "_dashboards/overview.html", HTML, "ui")
    found = await tool(reg, "read_dashboard", page_path=PAGE, name="overview")
    assert found["html"] == HTML and json.dumps(found)


async def test_ask_mode_adds_dashboards_but_never_rewrites_one(tmp_path: Path) -> None:
    from graite.skills.registry import ASK_TOOLS

    ops, queue = await make(tmp_path)
    reg = registry(ops, queue)
    reg.narrow(ASK_TOOLS, group="propose")
    first = await tool(reg, "propose_dashboard", page_path=PAGE, name="a", summary="A", html=HTML)
    assert first["status"] == "pending", first
    await ops.write_dashboard(PAGE, "_dashboards/b.html", HTML, "ui")
    again = await tool(reg, "propose_dashboard", page_path=PAGE, name="b", summary="B", html=HTML)
    assert "switching to Act" in again["error"]
