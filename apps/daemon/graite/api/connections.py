"""App-wide model connections and saved models; keys stay in the OS keychain."""

from __future__ import annotations

import asyncio
from typing import Any

import httpx
from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

from graite.models.config import (
    AIConfig,
    delete_connection_key,
    key_for,
    key_saved_for,
    load_config,
    set_key_for,
)
from graite.models.connections import KINDS, Connection, SavedModel, Store, get_store
from graite.models.providers import Provider

router = APIRouter(prefix="/ai", tags=["AI"])


def _store() -> Store:
    store = get_store()
    if store is None:
        raise HTTPException(503, "Connections are not available in this daemon.")
    return store


async def _with_keys(connections: list[Connection]) -> list[Connection]:
    def check() -> list[Connection]:
        return [
            c.model_copy(update={"key_saved": key_saved_for(c.kind, c.base_url, c.id)})
            for c in connections
        ]

    return await asyncio.to_thread(check)


class ConnectionsResponse(BaseModel):
    connections: list[Connection]
    models: list[SavedModel]


class NewConnection(BaseModel):
    name: str = Field(default="", max_length=80)
    kind: str
    base_url: str | None = None
    api_key: str | None = Field(default=None, max_length=4096)


class PatchConnection(BaseModel):
    name: str | None = Field(default=None, max_length=80)
    base_url: str | None = None
    api_key: str | None = Field(default=None, max_length=4096)
    clear_key: bool = False


class DiscoveredModel(BaseModel):
    id: str
    name: str
    context_length: int | None = None
    pricing: dict[str, str] | None = None


class DiscoveredModels(BaseModel):
    models: list[DiscoveredModel]


class NewSavedModel(BaseModel):
    model: str = Field(min_length=1, max_length=300)
    label: str | None = Field(default=None, max_length=120)
    context_length: int | None = None


def _validate_url(kind: str, base_url: str | None) -> str:
    if kind not in KINDS:
        raise HTTPException(
            400, "Connection kind must be compatible (a model server) or anthropic."
        )
    if kind == "compatible":
        if not base_url:
            raise HTTPException(
                400,
                "Enter the server address, including /v1 (for example https://openrouter.ai/api/v1).",
            )
        try:
            return AIConfig(provider="compatible", base_url=base_url).base_url
        except ValueError as exc:
            raise HTTPException(400, str(exc).split("\n")[-1].strip()) from exc
    return ""


@router.get("/connections", response_model=ConnectionsResponse)
async def list_connections() -> ConnectionsResponse:
    store = _store()
    return ConnectionsResponse(
        connections=await _with_keys(store.connections()), models=store.models()
    )


@router.post("/connections", response_model=Connection, status_code=201)
async def add_connection(body: NewConnection) -> Connection:
    store = _store()
    url = _validate_url(body.kind, body.base_url)
    connection = store.add_connection(body.name, body.kind, url or None)
    if body.api_key:
        try:
            await asyncio.to_thread(
                set_key_for, connection.kind, connection.base_url, body.api_key, connection.id
            )
        except ValueError as exc:
            store.remove_connection(connection.id)
            raise HTTPException(400, str(exc)) from exc
    return (await _with_keys([connection]))[0]


@router.patch("/connections/{connection_id}", response_model=Connection)
async def patch_connection(connection_id: str, body: PatchConnection) -> Connection:
    store = _store()
    current = store.connection(connection_id)
    if current is None:
        raise HTTPException(404, "Connection not found.")
    url = None
    if body.base_url is not None and current.kind == "compatible":
        url = _validate_url("compatible", body.base_url)
    try:
        connection = store.update_connection(connection_id, name=body.name, base_url=url)
    except KeyError as exc:
        raise HTTPException(404, "Connection not found.") from exc
    if body.api_key or body.clear_key:
        try:
            await asyncio.to_thread(
                set_key_for,
                connection.kind,
                connection.base_url,
                None if body.clear_key else body.api_key,
                connection.id,
            )
        except ValueError as exc:
            raise HTTPException(400, str(exc)) from exc
    return (await _with_keys([connection]))[0]


@router.delete("/connections/{connection_id}")
async def delete_connection(connection_id: str, request: Request) -> dict[str, Any]:
    store = _store()
    if store.connection(connection_id) is None:
        raise HTTPException(404, "Connection not found.")
    removed = store.remove_connection(connection_id)
    await asyncio.to_thread(delete_connection_key, connection_id)
    db = request.app.state.db
    config = load_config(db)
    if config.connection_id == connection_id:
        # The vault pointed at this connection: fall back to an unconfigured local setup.
        fallback = config.model_copy(
            update={"provider": "local", "connection_id": None, "saved_model_id": None, "model": ""}
        )
        db.execute(
            "INSERT OR REPLACE INTO meta VALUES ('ai_config', ?)", (fallback.model_dump_json(),)
        )
    return {"ok": True, "removed_models": removed}


@router.post("/connections/{connection_id}/discover", response_model=DiscoveredModels)
async def discover_models(connection_id: str) -> DiscoveredModels:
    store = _store()
    connection = store.connection(connection_id)
    if connection is None:
        raise HTTPException(404, "Connection not found.")
    key = await asyncio.to_thread(key_for, connection.kind, connection.base_url, connection.id)
    if connection.kind == "anthropic" and not key:
        raise HTTPException(400, "Add the API key of this connection first.")
    try:
        provider = Provider(connection.kind, connection.base_url, "", key)
        return DiscoveredModels(
            models=[DiscoveredModel.model_validate(m) for m in await provider.list_models()]
        )
    except (ValueError, httpx.HTTPError) as exc:
        detail = str(exc) if isinstance(exc, ValueError) else "Could not connect to the server."
        raise HTTPException(400, detail) from exc


@router.post("/connections/{connection_id}/models", response_model=SavedModel, status_code=201)
async def save_model(connection_id: str, body: NewSavedModel) -> SavedModel:
    try:
        return _store().add_model(
            connection_id, body.model, label=body.label, context_length=body.context_length
        )
    except KeyError as exc:
        raise HTTPException(404, "Connection not found.") from exc


@router.delete("/models/{model_id}")
async def delete_model(model_id: str, request: Request) -> dict[str, Any]:
    store = _store()
    if store.model(model_id) is None:
        raise HTTPException(404, "Saved model not found.")
    db = request.app.state.db
    config = load_config(db)
    if config.saved_model_id == model_id:
        raise HTTPException(409, "Choose another model before removing the selected one.")
    store.remove_model(model_id)
    return {"ok": True}
