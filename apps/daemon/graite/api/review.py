"""The review queue: list, accept, edit-then-accept, reject, batch-accept and revert."""

from __future__ import annotations

import json
from typing import Any

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from graite.review.policy import opt_in
from graite.review.proposals import ProposalConflict, Proposals
from graite.vault.models import ConflictError
from graite.vault.paths import VaultPathError
from graite.vault.properties import PageProperty

router = APIRouter(prefix="/ai/proposals", tags=["AI"])


class Proposal(BaseModel):
    id: str
    run_id: str | None = None
    conversation_id: str | None = None
    page_path: str
    page_id: str | None = None
    page_title: str | None = None
    kind: str
    base_hash: str | None = None
    old_text: str | None = None
    new_text: str | None = None
    new_path: str | None = None
    patch: str | None = None
    summary: str | None = None
    status: str
    policy: str | None = None
    decided_by: str | None = None
    reason: str | None = None
    created_at: str
    decided_at: str | None = None
    applied_hash: str | None = None
    snapshot: str | None = None
    trash_id: str | None = None
    edited: bool = False
    base_body_hash: str | None = None
    opt_in_source: str | None = None
    properties: list[PageProperty] | None = None
    base_properties: list[PageProperty] | None = None
    parent_proposal_id: str | None = None


class AcceptBody(BaseModel):
    new_text: str | None = Field(default=None, max_length=200000)


class RejectBody(BaseModel):
    reason: str = Field(default="", max_length=1000)


class BatchBody(BaseModel):
    ids: list[str] = Field(min_length=1, max_length=200)


class BatchResult(BaseModel):
    applied: list[str]
    stopped_at: str | None = None


class RejectBatchBody(BatchBody):
    reason: str = Field(default="", max_length=1000)


class RejectBatchResult(BaseModel):
    rejected: list[str]


class OptInBody(BaseModel):
    source: str = Field(min_length=1, max_length=1000)


class OptInResult(BaseModel):
    opted_in: list[str]


def _queue(request: Request) -> Proposals:
    queue: Proposals = request.app.state.proposals
    return queue


def _model(row: dict[str, Any]) -> Proposal:
    data = {k: v for k, v in row.items() if k != "reason_delivered"}
    # The two property lists are stored as JSON text; clients get them typed like any other.
    for column, field in (
        ("properties_json", "properties"),
        ("base_properties_json", "base_properties"),
    ):
        raw = data.pop(column, None)
        data[field] = json.loads(raw) if raw else None
    return Proposal.model_validate(data)


@router.get("", response_model=list[Proposal])
async def list_proposals(
    request: Request,
    status: str | None = None,
    conversation_id: str | None = None,
    page_path: str | None = None,
    run_id: str | None = None,
    limit: int = 100,
) -> list[Proposal]:
    rows = _queue(request).find(
        status=status,
        conversation_id=conversation_id,
        page_path=page_path,
        run_id=run_id,
        limit=limit,
    )
    return [_model(r) for r in rows]


@router.get("/{proposal_id}", response_model=Proposal)
async def get_proposal(proposal_id: str, request: Request) -> Proposal:
    row = _queue(request).get(proposal_id)
    if row is None:
        raise HTTPException(404, "Proposal not found.")
    return _model(row)


def _conflict_response(queue: Proposals, proposal_id: str, exc: BaseException) -> JSONResponse:
    if isinstance(exc, ProposalConflict):
        proposal, body = exc.proposal, exc.current_body
    else:  # fileops ConflictError: another writer got there first; the proposal stays open
        proposal, body = queue.get(proposal_id) or {}, getattr(exc, "body", None)
    return JSONResponse(
        status_code=409,
        content={
            "detail": "conflict",
            "proposal": _model(proposal).model_dump() if proposal else None,
            "current_body": body,
        },
    )


@router.post("/{proposal_id}/accept", response_model=Proposal)
async def accept_proposal(proposal_id: str, body: AcceptBody, request: Request) -> Any:
    queue = _queue(request)
    try:
        return _model(await queue.accept(proposal_id, new_text=body.new_text))
    except KeyError as exc:
        raise HTTPException(404, "Proposal not found.") from exc
    except (ProposalConflict, ConflictError) as exc:
        return _conflict_response(queue, proposal_id, exc)
    except (ValueError, VaultPathError) as exc:
        raise HTTPException(400, str(exc)) from exc
    except FileNotFoundError as exc:
        raise HTTPException(404, f"The page no longer exists: {exc}") from exc


@router.post("/{proposal_id}/reject", response_model=Proposal)
async def reject_proposal(proposal_id: str, body: RejectBody, request: Request) -> Proposal:
    try:
        return _model(await _queue(request).reject(proposal_id, body.reason))
    except KeyError as exc:
        raise HTTPException(404, "Proposal not found.") from exc
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc


@router.post("/accept-batch", response_model=BatchResult)
async def accept_batch(body: BatchBody, request: Request) -> BatchResult:
    return BatchResult.model_validate(await _queue(request).accept_many(body.ids))


@router.post("/reject-batch", response_model=RejectBatchResult)
async def reject_batch(body: RejectBatchBody, request: Request) -> RejectBatchResult:
    """Discard several open proposals at once. Without a reason nothing is fed back to the model."""
    return RejectBatchResult.model_validate(
        await _queue(request).reject_many(body.ids, body.reason)
    )


@router.post("/{proposal_id}/revert", response_model=Proposal)
async def revert_proposal(proposal_id: str, request: Request) -> Any:
    queue = _queue(request)
    try:
        return _model(await queue.revert(proposal_id))
    except KeyError as exc:
        raise HTTPException(404, "Proposal not found.") from exc
    except ConflictError as exc:
        return _conflict_response(queue, proposal_id, exc)
    except (ValueError, VaultPathError) as exc:
        raise HTTPException(400, str(exc)) from exc
    except FileNotFoundError as exc:
        raise HTTPException(404, f"Nothing to revert: {exc}") from exc


@router.post("/opt-in", response_model=OptInResult)
async def opt_in_auto_apply(body: OptInBody, request: Request) -> OptInResult:
    """Confirm once that a folder's auto-apply setting may apply changes without review."""
    return OptInResult(opted_in=sorted(opt_in(request.app.state.db, body.source)))
