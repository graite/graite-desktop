"""Find pages by what they say: the route behind Cmd+K and "Find" in chat (D101).

Answers from the index alone. No chat model is asked and none is waited for.
"""

from __future__ import annotations

import asyncio
from typing import Any

from fastapi import APIRouter, Query, Request
from pydantic import BaseModel, Field

from graite.retrieval.find import Finder

router = APIRouter(prefix="/search", tags=["search"])


class SearchHit(BaseModel):
    path: str
    id: str
    title: str
    icon: str | None = None
    heading_path: list[str] = Field(description="Headings above the best passage of the page.")
    snippet: str = Field(description="Text around the words that matched; empty for a title hit.")
    score: float
    matches: int = Field(description="How many passages of the page matched.")
    via: list[str] = Field(description='What matched: "title", "text" and/or "meaning".')
    start_line: int | None = None


class SearchResult(BaseModel):
    query: str
    results: list[SearchHit]
    semantic: bool = Field(
        description="Whether vectors took part. False while the embedding model is not "
        "loaded: the results are then by words and titles only."
    )
    took_ms: float


@router.get("", response_model=SearchResult)
async def search(
    request: Request,
    q: str = Query(max_length=400),
    k: int = Query(default=10, ge=1, le=50),
    root: str | None = Query(
        default=None, description="Only this page and the pages under it (a vault path)."
    ),
) -> dict[str, Any]:
    state = request.app.state
    finder = Finder(state.db, getattr(state, "embedder", None))
    return await finder.find(q, k=k, root=root or None)


class Warmed(BaseModel):
    semantic: bool


@router.post("/warm", response_model=Warmed)
async def warm(request: Request) -> Warmed:
    """Load the embedding model so that the searches that follow can use meaning as well as
    words. Called when the search palette opens; returns at once and loads in the background."""
    embedder = getattr(request.app.state, "embedder", None)
    if embedder is None:
        return Warmed(semantic=False)
    if embedder.ready_for_queries():
        return Warmed(semantic=True)
    task = asyncio.create_task(embedder.warm())
    request.app.state.background_tasks.add(task)
    task.add_done_callback(request.app.state.background_tasks.discard)
    return Warmed(semantic=False)
