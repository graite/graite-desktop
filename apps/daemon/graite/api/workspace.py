"""User-authored page properties, child collections and sidebar moves."""

from typing import Literal

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

from graite.api.pages import PageDocModel
from graite.vault.models import ConflictError
from graite.vault.properties import PageProperty

router = APIRouter(prefix="/workspace", tags=["workspace"])


class PropertiesRequest(BaseModel):
    page_id: str
    base_hash: str
    properties: list[PageProperty] = Field(max_length=100)


class MovePageRequest(BaseModel):
    page_id: str
    target_id: str | None = None
    position: Literal["before", "after", "inside"] = "inside"


@router.get("/children", response_model=list[PageDocModel])
async def children(request: Request, page_id: str) -> list[PageDocModel]:
    try:
        return [
            PageDocModel.from_doc(p) for p in await request.app.state.fileops.child_pages(page_id)
        ]
    except (ValueError, FileNotFoundError) as exc:
        raise HTTPException(404, str(exc)) from exc


@router.put("/properties", response_model=PageDocModel)
async def properties(request: Request, payload: PropertiesRequest) -> PageDocModel:
    try:
        return PageDocModel.from_doc(
            await request.app.state.fileops.set_properties(
                payload.page_id, [p.model_dump() for p in payload.properties], payload.base_hash
            )
        )
    except ConflictError as exc:
        raise HTTPException(409, "This page changed. Refresh before saving properties.") from exc
    except (ValueError, FileNotFoundError) as exc:
        raise HTTPException(400, str(exc)) from exc


@router.post("/move", response_model=PageDocModel)
async def move(request: Request, payload: MovePageRequest) -> PageDocModel:
    try:
        return PageDocModel.from_doc(
            await request.app.state.fileops.relocate_page(
                payload.page_id, payload.target_id, payload.position
            )
        )
    except (ValueError, FileNotFoundError) as exc:
        raise HTTPException(400, str(exc)) from exc


class MoveTextRequest(BaseModel):
    """Text dragged out of `source_id` onto the page at `target_path`."""

    source_id: str
    target_path: str
    text: str = Field(min_length=1, max_length=2_000_000)
    body: str = Field(description="The source page's body without the moved text.")
    base_hash: str


class MoveTextResult(BaseModel):
    path: str
    source_hash: str


@router.post("/move-text", response_model=MoveTextResult)
async def move_text(request: Request, payload: MoveTextRequest) -> MoveTextResult:
    from graite.vault.paths import VaultPathError

    try:
        return MoveTextResult(
            **await request.app.state.fileops.move_text(
                payload.source_id,
                payload.target_path,
                payload.text,
                payload.body,
                payload.base_hash,
            )
        )
    except ConflictError as exc:
        raise HTTPException(409, "This page changed. Reload it before moving text.") from exc
    except FileNotFoundError as exc:
        raise HTTPException(404, "The page no longer exists.") from exc
    except (ValueError, VaultPathError) as exc:
        raise HTTPException(400, str(exc)) from exc
