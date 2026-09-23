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
