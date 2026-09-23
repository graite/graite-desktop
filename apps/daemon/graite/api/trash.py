"""Trash API: list trashed pages and restore them (docs/vault-format.md §1)."""

from __future__ import annotations

from typing import Literal

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

from graite.api.pages import BAD_PATH, NOT_FOUND, UI_ACTOR, PageDocModel, _bad_path, _fileops
from graite.vault.models import TrashEntry
from graite.vault.paths import VaultPathError

router = APIRouter(tags=["trash"])


class TrashEntryModel(BaseModel):
    trash_id: str
    path: str | None
    title: str
    trashed_at: str
    # An attachment entry is one file; `path` is then the page it belonged to.
    kind: Literal["page", "attachment"] = "page"
    file: str | None = None
    page_id: str | None = None
    size: int = 0

    @classmethod
    def from_entry(cls, e: TrashEntry) -> TrashEntryModel:
        return cls(
            trash_id=e.trash_id,
            path=e.path,
            title=e.title,
            trashed_at=e.trashed_at,
            kind="attachment" if e.kind == "attachment" else "page",
            file=e.file,
            page_id=e.page_id,
            size=e.size,
        )


class PurgeResultModel(BaseModel):
    entries: int
    bytes: int


class RestoreRequest(BaseModel):
    target_path: str | None = None


@router.get("/trash", response_model=list[TrashEntryModel])
async def list_trash(request: Request) -> list[TrashEntryModel]:
    return [TrashEntryModel.from_entry(e) for e in await _fileops(request).list_trash()]


@router.post(
    "/trash/{trash_id}/restore",
    response_model=PageDocModel,
    responses=BAD_PATH | NOT_FOUND,
)
async def restore_trash(
    trash_id: str, request: Request, body: RestoreRequest | None = None
) -> PageDocModel:
    target = body.target_path if body else None
    try:
        doc = await _fileops(request).restore(trash_id, actor=UI_ACTOR, target_rel=target)
    except VaultPathError as exc:
        raise _bad_path(exc) from exc
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=f"trash entry not found: {exc}") from exc
    return PageDocModel.from_doc(doc)


async def _purge(request: Request, trash_id: str | None) -> PurgeResultModel:
    try:
        result = await _fileops(request).purge_trash(trash_id, actor=UI_ACTOR)
    except VaultPathError as exc:
        raise _bad_path(exc) from exc
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=f"trash entry not found: {exc}") from exc
    return PurgeResultModel(entries=result.entries, bytes=result.bytes)


@router.delete("/trash", response_model=PurgeResultModel)
async def empty_trash(request: Request) -> PurgeResultModel:
    """Permanently delete everything in the trash. This cannot be undone."""
    return await _purge(request, None)


@router.delete("/trash/{trash_id}", response_model=PurgeResultModel, responses=BAD_PATH | NOT_FOUND)
async def purge_trash_entry(trash_id: str, request: Request) -> PurgeResultModel:
    """Permanently delete one trash entry. This cannot be undone."""
    return await _purge(request, trash_id)
