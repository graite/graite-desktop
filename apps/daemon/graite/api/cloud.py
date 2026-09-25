"""Graite Cloud account for the settings screen: sign in through the browser, status, models.

`GET /cloud/callback` is where the browser lands after signing in. It is the one route
without the bearer token (the browser cannot send it); the one-time `state` from
`begin_login` protects it instead (api/auth.py).
"""

from __future__ import annotations

import asyncio
import html
import logging
import webbrowser

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import HTMLResponse
from pydantic import BaseModel

from graite.cloud.session import CALLBACK_PATH, CloudModel, CloudStatus, get_cloud

router = APIRouter(prefix="/cloud", tags=["cloud"])


class _HideCallbackQuery(logging.Filter):
    """The callback's query holds the one-time sign-in code; keep it out of the access log
    (the log may be attached to feedback)."""

    def filter(self, record: logging.LogRecord) -> bool:
        args = record.args
        if isinstance(args, tuple) and len(args) >= 3 and str(args[2]).startswith(CALLBACK_PATH):
            record.args = (*args[:2], CALLBACK_PATH, *args[3:])
        return True


def hide_callback_query() -> None:
    access = logging.getLogger("uvicorn.access")
    if not any(isinstance(f, _HideCallbackQuery) for f in access.filters):
        access.addFilter(_HideCallbackQuery())


class LoginIn(BaseModel):
    signup: bool = False


class LoginOut(BaseModel):
    # Also shown in the UI, in case no browser opened.
    url: str
    opened: bool


class CloudModels(BaseModel):
    models: list[CloudModel]


async def _open(url: str) -> bool:
    try:
        return await asyncio.to_thread(webbrowser.open, url)
    except Exception:  # noqa: BLE001 - the UI shows the link instead
        return False


@router.get("/status", response_model=CloudStatus)
async def status() -> CloudStatus:
    return await get_cloud().status()


@router.post("/login", response_model=LoginOut)
async def login(body: LoginIn, request: Request) -> LoginOut:
    url = get_cloud().begin_login(request.url.port or 0, signup=body.signup)
    return LoginOut(url=url, opened=await _open(url))


@router.post("/logout")
async def logout(request: Request) -> dict[str, bool]:
    try:
        await get_cloud().sign_out()
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    request.app.state.events.publish("cloud_status", {"signed_in": False})
    return {"signed_in": False}


@router.get("/models", response_model=CloudModels)
async def models() -> CloudModels:
    try:
        return CloudModels(models=await get_cloud().models())
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc


@router.post("/open-account", response_model=LoginOut)
async def open_account() -> LoginOut:
    url = get_cloud().account_url
    return LoginOut(url=url, opened=await _open(url))


def _page(title: str, body: str, status: int = 200) -> HTMLResponse:
    return HTMLResponse(
        f"""<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{html.escape(title)} · Graite</title>
<style>
  :root {{ color-scheme: light dark; }}
  body {{ margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 16px;
         background: #faf9f6; color: #282824; font: 15px/1.6 system-ui, sans-serif; }}
  main {{ max-width: 420px; background: #fff; border: 1px solid #e4e3db; border-radius: 10px;
         padding: 32px; }}
  h1 {{ font: 450 1.8rem/1.1 Georgia, serif; letter-spacing: -.03em; margin: 0 0 12px; }}
  p {{ margin: 0; color: #73736b; }}
  @media (prefers-color-scheme: dark) {{
    body {{ background: #1b1c19; color: #eeeee5; }}
    main {{ background: #23241f; border-color: #393b32; }}
    p {{ color: #aaa99d; }}
  }}
</style></head>
<body><main><h1>{html.escape(title)}</h1><p>{html.escape(body)}</p></main></body></html>""",
        status_code=status,
        headers={"Cache-Control": "no-store", "Referrer-Policy": "no-referrer"},
    )


@router.get("/callback", include_in_schema=False)
async def callback(
    request: Request, state: str = "", code: str = "", error: str = ""
) -> HTMLResponse:
    cloud = get_cloud()
    if error or not code:
        cloud.cancel_login(state)
        return _page(
            "Sign-in cancelled",
            "Nothing was connected. You can close this tab and try again from Graite.",
            400,
        )
    try:
        email = await cloud.finish_login(state, code)
    except ValueError as exc:
        return _page("Sign-in didn’t finish", str(exc), 400)
    request.app.state.events.publish("cloud_status", {"signed_in": True})
    return _page(
        "You’re signed in",
        f"Graite is now connected to {email}. You can close this tab and go back to Graite.",
    )
