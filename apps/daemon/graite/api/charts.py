"""Charts API (D72): the data a `graite:chart` block draws, from the tables its page may read."""

from __future__ import annotations

import asyncio
from typing import Any

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

from graite.tables.cache import TablesCache
from graite.tables.charts import chart_data
from graite.tables.query import QueryError
from graite.vault.paths import VaultPathError, validate_rel

router = APIRouter(prefix="/charts", tags=["charts"])


class ChartRequest(BaseModel):
    page_path: str
    # The fence's keys (source or sql, type, x, y, series, filter, sort, limit, ...).
    spec: dict[str, Any]


class ChartSeries(BaseModel):
    name: str
    data: list[Any]
    # How the values read: number, percent, or currency:<ISO code>.
    format: str = "number"


class ChartData(BaseModel):
    categories: list[str] = []
    series: list[ChartSeries] = []
    # scatter: [x, y] pairs; number: one value and what it measures.
    points: list[list[Any]] = []
    value: float | None = None
    label: str | None = None
    format: str = "number"
    truncated: bool = False
    # The tables the chart reads; reload when one of them changes.
    tables: list[str] = []


class ChartAIRequest(BaseModel):
    page_path: str
    prompt: str = Field(min_length=1, max_length=2000)
    # The chart as it is, when asking for a change ("as a line", "only Done").
    current: dict[str, Any] | None = None


class ChartAIReply(BaseModel):
    spec: dict[str, Any]
    message: str


@router.post("/ai", response_model=ChartAIReply)
async def from_words(request: Request, payload: ChartAIRequest) -> dict[str, Any]:
    """A chart spec from words, made by the configured model and checked against the data.
    The block applies it as the user's own edit (D73)."""
    from graite.tables.chart_ai import chart_from_words

    try:
        page = validate_rel(payload.page_path)
        return await chart_from_words(request.app.state, page, payload.prompt, payload.current)
    except TimeoutError as exc:
        raise HTTPException(504, "The model took too long. Try again or ask for less.") from exc
    except (ValueError, KeyError, TypeError, VaultPathError, FileNotFoundError) as exc:
        raise HTTPException(400, str(exc)) from exc
    except Exception as exc:  # the model server itself
        raise HTTPException(
            502, "Could not reach the model. Check Settings → Chat and try again."
        ) from exc


@router.post("/data", response_model=ChartData)
async def data(request: Request, payload: ChartRequest) -> dict[str, Any]:
    cache: TablesCache = request.app.state.tables
    try:
        page = validate_rel(payload.page_path)
        return await asyncio.to_thread(
            chart_data, cache, request.app.state.fileops.db, page, payload.spec
        )
    except (ValueError, QueryError, VaultPathError, FileNotFoundError) as exc:
        raise HTTPException(400, str(exc)) from exc
