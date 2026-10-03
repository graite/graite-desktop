"""Dashboards API (D72): HTML files in a page's `_dashboards/`, shown in a sandboxed frame.

The webview asks for a ticket (bearer auth like every route) and points an
`<iframe sandbox="allow-scripts">` at `/dashboards/frame?ticket=...`, the one route the token
does not guard (an iframe cannot send headers). The frame's CSP allows no network, so the
dashboard reads data only through the bridge the app answers (`static/bridge.js`).
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import HTMLResponse
from pydantic import BaseModel, Field

from graite.api.auth import FRAME_PATH
from graite.dashboards import paths as dash_paths
from graite.dashboards.frame import CSP, Tickets, render
from graite.vault.fileops import FileOps
from graite.vault.paths import VaultPathError, page_dir, validate_rel

router = APIRouter(prefix="/dashboards", tags=["dashboards"])

UI_ACTOR = "ui"


class TicketRequest(BaseModel):
    page_path: str
    # The dashboard file (`_dashboards/x.html`), or a pending dashboard proposal to preview.
    src: str | None = None
    proposal_id: str | None = None


class TicketResult(BaseModel):
    # The frame URL, relative to the daemon (prefix it with the daemon's address).
    url: str


class Dashboard(BaseModel):
    page_path: str
    src: str
    path: str
    # None while the file does not exist.
    html: str | None = None


class WriteDashboard(BaseModel):
    page_path: str
    src: str
    html: str = Field(max_length=dash_paths.MAX_BYTES)
    # Only create it: refuse when the file already exists.
    create: bool = False


class DashboardInfo(BaseModel):
    src: str
    name: str


def tickets(request: Request) -> Tickets:
    state = request.app.state
    if not hasattr(state, "dashboard_tickets"):
        state.dashboard_tickets = Tickets()
    found: Tickets = state.dashboard_tickets
    return found


def _ops(request: Request) -> FileOps:
    ops: FileOps = request.app.state.fileops
    return ops


def _errors(exc: Exception) -> HTTPException:
    if isinstance(exc, FileNotFoundError):
        return HTTPException(404, str(exc) or "Not found.")
    return HTTPException(400, str(exc))


@router.get("", response_model=Dashboard)
async def read(request: Request, page_path: str, src: str) -> Dashboard:
    try:
        dashboard = dash_paths.parse(page_path, src)
        html = await _ops(request).read_dashboard(dashboard.page, dashboard.src)
        return Dashboard(page_path=dashboard.page, src=dashboard.src, path=dashboard.rel, html=html)
    except (VaultPathError, FileNotFoundError, ValueError) as exc:
        raise _errors(exc) from exc


@router.put("", response_model=Dashboard)
async def write(request: Request, payload: WriteDashboard) -> Dashboard:
    try:
        dashboard = dash_paths.parse(payload.page_path, payload.src)
        rel = await _ops(request).write_dashboard(
            dashboard.page,
            dashboard.src,
            payload.html,
            UI_ACTOR,
            base=None if payload.create else False,
        )
        return Dashboard(page_path=dashboard.page, src=dashboard.src, path=rel, html=payload.html)
    except (VaultPathError, FileNotFoundError, ValueError) as exc:
        raise _errors(exc) from exc


@router.get("/list", response_model=list[DashboardInfo])
async def list_dashboards(request: Request, page_path: str) -> list[DashboardInfo]:
    try:
        folder = page_dir(_ops(request).vault, validate_rel(page_path)) / dash_paths.DASH_DIR
    except VaultPathError as exc:
        raise _errors(exc) from exc
    if not folder.is_dir() or folder.is_symlink():
        return []
    return [
        DashboardInfo(src=f"{dash_paths.DASH_DIR}/{f.name}", name=f.stem)
        for f in sorted(folder.iterdir())
        if f.suffix.lower() == dash_paths.SUFFIX and f.is_file() and not f.name.startswith(".")
    ]


@router.post("/ticket", response_model=TicketResult)
async def ticket(request: Request, payload: TicketRequest) -> TicketResult:
    try:
        page = validate_rel(payload.page_path)
        if payload.proposal_id:
            token = tickets(request).issue(page, proposal_id=payload.proposal_id)
        elif payload.src:
            token = tickets(request).issue(page, src=dash_paths.parse(page, payload.src).src)
        else:
            raise ValueError("Name the dashboard (src) or the proposal to preview.")
    except (VaultPathError, ValueError) as exc:
        raise _errors(exc) from exc
    return TicketResult(url=f"{FRAME_PATH}?ticket={token}")


def _page(message: str, status: int) -> HTMLResponse:
    body = (
        '<!doctype html><meta charset=utf-8><body style="font:13px system-ui;color:#888;'
        f'padding:16px">{message}</body>'
    )
    return HTMLResponse(body, status_code=status, headers={"Content-Security-Policy": CSP})


@router.get("/frame", response_class=HTMLResponse, include_in_schema=False)
async def frame(request: Request, ticket: str) -> HTMLResponse:
    found = tickets(request).get(ticket)
    if found is None:
        return _page("This dashboard link expired. Reload the dashboard.", 403)
    html: Any = None
    if found.proposal_id:
        proposal = request.app.state.proposals.get(found.proposal_id)
        payload = (proposal or {}).get("dashboard") or {}
        html = payload.get("html")
    elif found.src:
        try:
            html = await _ops(request).read_dashboard(found.page, found.src)
        except (VaultPathError, FileNotFoundError):
            html = None
    if not isinstance(html, str):
        return _page("This dashboard file does not exist (yet).", 404)
    return HTMLResponse(
        render(html),
        headers={
            "Content-Security-Policy": CSP,
            "Cache-Control": "no-store",
            "X-Content-Type-Options": "nosniff",
            "Referrer-Policy": "no-referrer",
        },
    )
