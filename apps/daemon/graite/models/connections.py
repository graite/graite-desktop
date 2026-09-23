"""App-wide model connections and saved models (`~/.graite/connections.json`).

A connection is a place models come from: a model server (any OpenAI-compatible endpoint,
on this machine or hosted, OpenRouter included) or Anthropic. The user names it. A saved
model is one model on one connection with a label, so it can be picked in any chat of any
vault. Keys never live here; they stay in the OS keychain (`models/config.py`).
The local connection is implicit: its models are the installed catalog models.
"""

from __future__ import annotations

import json
import os
import uuid
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Literal

from pydantic import BaseModel, Field

Kind = Literal["compatible", "anthropic"]
KINDS: tuple[str, ...] = ("compatible", "anthropic")
OPENROUTER_URL = "https://openrouter.ai/api/v1"
ANTHROPIC_URL = "https://api.anthropic.com"
KIND_NAMES = {"compatible": "Model server", "anthropic": "Claude"}
FILE_VERSION = 2  # 1 had a separate "openrouter" kind; 2 folds it into "compatible"


def now() -> str:
    return datetime.now(UTC).isoformat()


class Connection(BaseModel):
    id: str
    name: str = Field(min_length=1, max_length=80)
    kind: Kind
    base_url: str
    created_at: str
    key_saved: bool = False  # filled in by the API, never stored


class SavedModel(BaseModel):
    id: str
    connection_id: str
    model: str = Field(min_length=1, max_length=300)
    label: str = Field(min_length=1, max_length=120)
    context_length: int | None = None
    added_at: str


class ConnectionsFile(BaseModel):
    version: int = FILE_VERSION
    connections: list[Connection] = Field(default_factory=list)
    models: list[SavedModel] = Field(default_factory=list)


def default_url(kind: str, base_url: str | None) -> str:
    if kind == "anthropic":
        return ANTHROPIC_URL
    return (base_url or "").rstrip("/")


def _migrate(raw: dict[str, Any]) -> tuple[dict[str, Any], bool]:
    """Version 1 files: OpenRouter rows become model servers at the OpenRouter endpoint."""
    changed = False
    for connection in raw.get("connections") or []:
        if connection.get("kind") == "openrouter":
            connection["kind"] = "compatible"
            connection["base_url"] = OPENROUTER_URL
            changed = True
    if raw.get("version") != FILE_VERSION:
        raw["version"] = FILE_VERSION
        changed = changed or bool(raw.get("connections"))
    return raw, changed


class Store:
    """The only writer of the connections file.

    The file is a few kilobytes and other vaults' daemons may write it too, so every read
    goes to disk: a timestamp cache could miss a write landing within the filesystem's
    resolution.
    """

    def __init__(self, path: Path) -> None:
        self.path = path

    def load(self) -> ConnectionsFile:
        try:
            raw = json.loads(self.path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return ConnectionsFile()
        if not isinstance(raw, dict):
            return ConnectionsFile()
        raw, changed = _migrate(raw)
        try:
            data = ConnectionsFile.model_validate(raw)
        except ValueError:
            return ConnectionsFile()
        if changed:
            self.save(data)
        return data

    def save(self, data: ConnectionsFile) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.path.with_name(f".{self.path.name}.tmp-{os.getpid()}")
        tmp.write_text(
            json.dumps(
                data.model_dump(exclude={"connections": {"__all__": {"key_saved"}}}),
                indent=2,
                ensure_ascii=False,
            )
            + "\n",
            encoding="utf-8",
        )
        os.replace(tmp, self.path)

    # ------------------------------------------------------------- connections

    def connections(self) -> list[Connection]:
        return list(self.load().connections)

    def connection(self, connection_id: str) -> Connection | None:
        return next((c for c in self.load().connections if c.id == connection_id), None)

    def find_connection(self, kind: str, base_url: str) -> Connection | None:
        url = default_url(kind, base_url)
        return next(
            (c for c in self.load().connections if c.kind == kind and c.base_url == url), None
        )

    def add_connection(self, name: str, kind: str, base_url: str | None = None) -> Connection:
        if kind not in KINDS:
            raise ValueError("Connection kind must be compatible (a model server) or anthropic.")
        data = self.load()
        connection = Connection(
            id="c_" + uuid.uuid4().hex[:8],
            name=name.strip() or KIND_NAMES[kind],
            kind=kind,  # type: ignore[arg-type]
            base_url=default_url(kind, base_url),
            created_at=now(),
        )
        data.connections.append(connection)
        self.save(data)
        return connection

    def update_connection(
        self, connection_id: str, *, name: str | None = None, base_url: str | None = None
    ) -> Connection:
        data = self.load()
        connection = next((c for c in data.connections if c.id == connection_id), None)
        if connection is None:
            raise KeyError(connection_id)
        if name is not None and name.strip():
            connection.name = name.strip()
        if base_url is not None and connection.kind == "compatible":
            connection.base_url = base_url.rstrip("/")
        self.save(data)
        return connection

    def remove_connection(self, connection_id: str) -> list[str]:
        """Remove a connection and its saved models; returns the removed model ids."""
        data = self.load()
        removed = [m.id for m in data.models if m.connection_id == connection_id]
        data.connections = [c for c in data.connections if c.id != connection_id]
        data.models = [m for m in data.models if m.connection_id != connection_id]
        self.save(data)
        return removed

    # ------------------------------------------------------------- models

    def models(self, connection_id: str | None = None) -> list[SavedModel]:
        return [
            m
            for m in self.load().models
            if connection_id is None or m.connection_id == connection_id
        ]

    def model(self, model_id: str) -> SavedModel | None:
        return next((m for m in self.load().models if m.id == model_id), None)

    def add_model(
        self,
        connection_id: str,
        model: str,
        *,
        label: str | None = None,
        context_length: int | None = None,
    ) -> SavedModel:
        data = self.load()
        if not any(c.id == connection_id for c in data.connections):
            raise KeyError(connection_id)
        model = model.strip()
        for existing in data.models:
            if existing.connection_id == connection_id and existing.model == model:
                return existing
        saved = SavedModel(
            id="m_" + uuid.uuid4().hex[:8],
            connection_id=connection_id,
            model=model,
            label=(label or "").strip() or model.rsplit("/", 1)[-1],
            context_length=context_length,
            added_at=now(),
        )
        data.models.append(saved)
        self.save(data)
        return saved

    def remove_model(self, model_id: str) -> None:
        data = self.load()
        data.models = [m for m in data.models if m.id != model_id]
        self.save(data)

    def resolve(self, model_id: str) -> tuple[Connection, SavedModel] | None:
        saved = self.model(model_id)
        if saved is None:
            return None
        connection = self.connection(saved.connection_id)
        return (connection, saved) if connection else None


_store: Store | None = None


def get_store() -> Store | None:
    return _store


def set_store(store: Store | None) -> None:
    global _store
    _store = store
