from __future__ import annotations

import os

from fastapi import APIRouter, Request

from graite import __version__

router = APIRouter()


@router.get("/health")
async def health(request: Request) -> dict[str, object]:
    state = request.app.state
    settings = state.settings
    pages = int(state.db.execute("SELECT count(*) FROM pages").fetchone()[0])
    return {
        "status": "ok",
        "version": __version__,
        "pid": os.getpid(),
        "vault": str(settings.vault),
        "vault_name": settings.vault.name or str(settings.vault),
        "pages": pages,
        # A folder Graite has not indexed before and that holds no pages yet.
        "is_new": bool(getattr(state, "fresh_vault", False)) and pages == 0,
        "serve": settings.serve,
        "index": {"vec_version": state.vec_version},
        "events": {"subscribers": state.events.subscriber_count},
    }
