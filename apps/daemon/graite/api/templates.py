"""Templates API (D77): the built-in gallery, making a template's page tree, and the
examples of AI instructions (D90)."""

from __future__ import annotations

import asyncio
from typing import Any

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

from graite.api.pages import PageDocModel
from graite.templates import catalog, instructions
from graite.vault.fileops import FileOps

router = APIRouter(prefix="/templates", tags=["templates"])

UI_ACTOR = "ui"


class TemplateColumn(BaseModel):
    name: str
    type: str


class TemplateTable(BaseModel):
    name: str
    # The title of the page the table sits on.
    page: str
    columns: list[TemplateColumn]


class TemplateModel(BaseModel):
    slug: str
    name: str
    description: str
    icon: str
    # Business | Finance | Work | Personal
    category: str
    tags: list[str] = Field(default_factory=list)
    # What it does well, in a few short lines for the gallery.
    highlights: list[str] = Field(default_factory=list)
    # Page titles, the top page first.
    pages: list[str]
    tables: list[TemplateTable]
    charts: int
    dashboards: list[str]


class UseTemplate(BaseModel):
    # The page to put it under, or null for the top level.
    parent_path: str | None = None
    # The top page's title; the template's name when empty.
    title: str | None = Field(default=None, max_length=200)
    # Example rows and pages to show how it works; without them, tables start empty.
    sample_data: bool = True


class InstructionExampleModel(BaseModel):
    slug: str
    name: str
    description: str
    # One of `instructions.CATEGORIES`, e.g. Productivity, Startups, Sales.
    category: str
    icon: str
    # The instructions, as Markdown, ready to put in a page's AI settings.
    text: str


@router.get("/instructions", response_model=list[InstructionExampleModel])
async def list_instruction_examples() -> list[dict[str, Any]]:
    """Examples of AI instructions to start a page's AI settings from."""
    found = await asyncio.to_thread(instructions.examples)
    return [e.to_json() for e in found]


@router.get("", response_model=list[TemplateModel])
async def list_templates() -> list[dict[str, Any]]:
    found = await asyncio.to_thread(catalog.templates)
    return [t.to_json() for t in found]


@router.post("/{slug}/use", response_model=PageDocModel, status_code=201)
async def use_template(request: Request, slug: str, payload: UseTemplate) -> PageDocModel:
    """Make the template's pages, tables, charts and dashboards; returns the top page."""
    ops: FileOps = request.app.state.fileops
    try:
        doc = await ops.create_from_template(
            payload.parent_path, slug, payload.title, payload.sample_data, UI_ACTOR
        )
    except FileNotFoundError as exc:
        raise HTTPException(404, str(exc) or "That page no longer exists.") from exc
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    return PageDocModel.from_doc(doc)
