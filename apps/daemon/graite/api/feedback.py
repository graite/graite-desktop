"""User feedback: the one outbound call to the project, sent only when the user presses Send.

The daemon posts it rather than the webview so the web build and the desktop app behave the
same and the optional log excerpt never passes through the browser.
"""

from __future__ import annotations

import logging
import platform
from typing import Literal

import httpx
from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

from graite import __version__

router = APIRouter(tags=["feedback"])
log = logging.getLogger(__name__)

LOG_LINES = 200


class FeedbackStatus(BaseModel):
    enabled: bool


class FeedbackIn(BaseModel):
    kind: Literal["bug", "idea", "other"] = "other"
    message: str = Field(min_length=1, max_length=5000)
    email: str | None = Field(default=None, max_length=320)
    include_log: bool = False


def _log_tail(request: Request) -> str:
    path = request.app.state.settings.app_dir / "logs" / "daemon.log"
    try:
        lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
    except OSError:
        return ""
    return "\n".join(lines[-LOG_LINES:])


@router.get("/feedback", response_model=FeedbackStatus)
async def feedback_status(request: Request) -> FeedbackStatus:
    return FeedbackStatus(enabled=bool(request.app.state.settings.feedback_url))


@router.post("/feedback", responses={502: {}, 503: {}})
async def send_feedback(body: FeedbackIn, request: Request) -> dict[str, bool]:
    url = request.app.state.settings.feedback_url
    if not url:
        raise HTTPException(status_code=503, detail="Feedback is not set up in this build.")
    payload = {
        "kind": body.kind,
        "message": body.message.strip(),
        "email": (body.email or "").strip() or None,
        "version": __version__,
        "os": f"{platform.system()} {platform.release()}",
        "arch": platform.machine(),
        "log": _log_tail(request) if body.include_log else None,
    }
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(10, connect=5)) as client:
            response = await client.post(url, json=payload)
            response.raise_for_status()
    except httpx.HTTPError as exc:
        log.warning("feedback delivery failed: %s", exc)
        detail = "Could not reach the feedback service."
        raise HTTPException(status_code=502, detail=detail) from exc
    return {"sent": True}
