"""Receives errors from the UI so they show up in the daemon log (dev aid; M7 log bundle)."""

from __future__ import annotations

import logging

from fastapi import APIRouter
from pydantic import BaseModel

router = APIRouter()
log = logging.getLogger("graite.client")


class ClientLog(BaseModel):
    level: str = "error"
    message: str
    stack: str | None = None
    context: str | None = None


@router.post("/client-log", status_code=204)
async def client_log(entry: ClientLog) -> None:
    fn = log.error if entry.level == "error" else log.warning
    fn(
        "[ui] %s%s%s",
        entry.context + ": " if entry.context else "",
        entry.message,
        "\n" + entry.stack if entry.stack else "",
    )
