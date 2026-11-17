"""Non-secret settings in SQLite; credentials only in the OS keychain."""

from __future__ import annotations

import hashlib
import json
import os
import sqlite3
from ipaddress import ip_address
from pathlib import Path
from typing import Literal
from urllib.parse import urlsplit

import keyring
from pydantic import BaseModel, Field, model_validator

from graite.models.connections import KIND_NAMES, OPENROUTER_URL, get_store


class AIConfig(BaseModel):
    # "openrouter" is accepted for rows written before connections were unified and is
    # normalised to a model server at the OpenRouter endpoint.
    # "graite" is Graite Cloud: its sign-in lives in graite/cloud, not in the keychain entries
    # of connections, and `base_url` follows the configured cloud (see Manager.use).
    provider: Literal["local", "compatible", "anthropic", "openrouter", "graite"] = "local"
    base_url: str = "http://127.0.0.1:1234/v1"
    model: str = ""
    # App-wide connection and saved model this vault currently uses (models/connections.py).
    # `provider`, `base_url` and `model` are derived from them on save and kept for readers.
    connection_id: str | None = None
    saved_model_id: str | None = None
    binary_path: str = ""
    whisper_binary_path: str = ""
    ocr_binary_path: str = ""
    tts_binary_path: str = ""  # crispasr (GGML Chatterbox), the assistant's voice
    model_path: str = ""
    context_size: int = Field(default=8192, ge=2048, le=131072)
    gpu_layers: int = Field(default=-1, ge=-1, le=999)
    resident: bool = True
    embedding_model_id: str = ""
    vision: bool = False
    max_output_tokens: int = Field(default=2048, ge=256, le=32768)
    # How much the model reasons before it answers, where the model has a say (D95).
    # "auto" sends nothing and leaves it to the model's own default.
    thinking: Literal["auto", "on", "off"] = "auto"
    effort: Literal["low", "medium", "high"] = "medium"
    # The most retrieved text one turn may put in front of the model, in tokens (D102):
    # passages and tool results together. Lowest-ranked material is left out first. Deep
    # research may use twice this. Small on purpose: a 4-8B local model reads a few hundred
    # tokens a second, so every thousand tokens is seconds of waiting before the first word.
    context_budget_tokens: int = Field(default=3000, ge=500, le=64000)
    # How many tool calls one chat turn may make before it has to answer.
    max_tool_calls: int = Field(default=8, ge=1, le=64)

    @model_validator(mode="after")
    def valid_url(self) -> AIConfig:
        if self.provider == "openrouter":
            self.provider = "compatible"
            self.base_url = OPENROUTER_URL
        parsed = urlsplit(self.base_url)
        if parsed.username or parsed.password or parsed.query or parsed.fragment:
            raise ValueError("Use a base URL without credentials, query parameters or fragments.")
        if not parsed.hostname or parsed.scheme not in ("http", "https"):
            raise ValueError("Enter an http:// or https:// server URL.")
        if parsed.scheme == "http" and parsed.hostname not in ("localhost", "127.0.0.1", "::1"):
            raise ValueError("Remote servers require HTTPS. HTTP is only allowed on this computer.")
        self.base_url = self.base_url.rstrip("/")
        return self


class SaveConfig(AIConfig):
    api_key: str | None = Field(default=None, max_length=4096, exclude=True)
    clear_key: bool = Field(default=False, exclude=True)


def is_cloud(config: AIConfig) -> bool:
    """Whether what this model is sent leaves the computer.

    Graite's own engine is local, and so is a model server at a loopback address (Ollama,
    LM Studio, a llama.cpp server on this machine). Everything else is cloud, including a
    server elsewhere on the network: `cloud: local-only` pages stay on this computer.
    """
    if config.provider == "local":
        return False
    if config.provider != "compatible":
        return True
    host = (urlsplit(config.base_url).hostname or "").lower()
    if host == "localhost":
        return False
    try:
        return not ip_address(host).is_loopback
    except ValueError:
        return True


def credential_id_for(kind: str, base_url: str, connection_id: str | None = None) -> str:
    """Keychain account of a connection.

    A named connection keeps its own key (two connections to the same host may hold two
    accounts). Keys saved before connections existed live under the provider kind and
    endpoint; those accounts stay readable as a fallback, and OpenRouter counts as a model
    server there so nothing has to be re-entered.
    """
    if connection_id:
        return hashlib.sha256(f"connection:{connection_id}".encode()).hexdigest()
    provider = "compatible" if kind == "openrouter" else kind
    endpoint = "https://api.anthropic.com" if kind == "anthropic" else base_url.rstrip("/")
    return hashlib.sha256(f"{provider}:{endpoint}".encode()).hexdigest()


def credential_id(config: AIConfig) -> str:
    return credential_id_for(config.provider, config.base_url, config.connection_id)


def _accounts(kind: str, base_url: str, connection_id: str | None) -> list[str]:
    """The connection's own account first, then the legacy kind+endpoint one."""
    legacy = credential_id_for(kind, base_url)
    if not connection_id:
        return [legacy]
    return [credential_id_for(kind, base_url, connection_id), legacy]


def _read_key(kind: str, base_url: str, connection_id: str | None) -> str:
    for account in _accounts(kind, base_url, connection_id):
        found = keyring.get_password("Graite", account)
        if found:
            return str(found)
    return ""


def key_for(kind: str, base_url: str, connection_id: str | None = None) -> str:
    """The saved key of a connection, or "" (a locked keychain also reads as no key)."""
    try:
        return _read_key(kind, base_url, connection_id)
    except Exception:  # noqa: BLE001
        return ""


def key_saved_for(kind: str, base_url: str, connection_id: str | None = None) -> bool:
    return bool(key_for(kind, base_url, connection_id))


def set_key_for(
    kind: str, base_url: str, api_key: str | None, connection_id: str | None = None
) -> None:
    """Store or clear the key of a connection. Raises ValueError when the keychain fails.

    Clearing removes the connection's own account and, so the key really is gone, the
    legacy kind+endpoint account it would otherwise fall back to.
    """
    accounts = _accounts(kind, base_url, connection_id)
    try:
        if api_key:
            keyring.set_password("Graite", accounts[0], api_key)
            return
        for account in accounts:
            if keyring.get_password("Graite", account):
                keyring.delete_password("Graite", account)
    except Exception as exc:
        raise ValueError("Could not save to the OS keychain. Unlock it and try again.") from exc


def delete_connection_key(connection_id: str) -> None:
    """Best effort: a removed connection takes its own keychain account with it."""
    account = credential_id_for("", "", connection_id)
    try:
        if keyring.get_password("Graite", account):
            keyring.delete_password("Graite", account)
    except Exception:  # noqa: BLE001 - the connection is gone either way
        pass


def get_key(config: AIConfig) -> str:
    if config.provider in ("local", "graite"):  # Graite Cloud: graite/cloud/session.py
        return ""
    try:
        return _read_key(config.provider, config.base_url, config.connection_id)
    except Exception as exc:
        if (
            config.provider == "compatible"
            and urlsplit(config.base_url).hostname in ("localhost", "127.0.0.1", "::1")
            and keyring.get_keyring().priority <= 0
        ):
            return ""
        raise ValueError("Your OS keychain is unavailable. Unlock it and try again.") from exc


def _link(config: AIConfig) -> AIConfig:
    """Tie a remote config to the app-wide connection store.

    A `saved_model_id` wins and fills in provider, endpoint and model, whatever the rest of
    the payload says; a local config without one is left alone. Otherwise a remote config
    that only names provider/endpoint/model (older rows, API clients) gets a connection and a
    saved model created for it, so the chat picker can offer it later.
    """
    if config.provider == "graite":  # Graite Cloud is not a connection in the store
        return config.model_copy(update={"connection_id": None, "saved_model_id": None})
    store = get_store()
    if store is None:
        return config
    if config.saved_model_id:
        found = store.resolve(config.saved_model_id)
        if found is None:
            raise ValueError("That saved model no longer exists. Choose another model.")
        connection, saved = found
        return config.model_copy(
            update={
                "provider": connection.kind,
                "base_url": connection.base_url,
                "model": saved.model,
                "connection_id": connection.id,
            }
        )
    if config.provider == "local":
        return config.model_copy(update={"connection_id": None})
    if not config.model:
        return config
    existing = (
        store.connection(config.connection_id) if config.connection_id else None
    ) or store.find_connection(config.provider, config.base_url)
    connection = existing or store.add_connection(
        KIND_NAMES[config.provider], config.provider, config.base_url
    )
    saved = store.add_model(connection.id, config.model)
    return config.model_copy(
        update={
            "base_url": connection.base_url,
            "connection_id": connection.id,
            "saved_model_id": saved.id,
        }
    )


def load_config(db: sqlite3.Connection) -> AIConfig:
    row = db.execute("SELECT value FROM meta WHERE key='ai_config'").fetchone()
    config = AIConfig.model_validate_json(row[0]) if row else AIConfig()
    if config.provider != "local" and config.saved_model_id is None and config.model:
        try:
            linked = _link(config)
        except ValueError:
            return config
        if linked != config:
            db.execute(
                "INSERT OR REPLACE INTO meta VALUES ('ai_config', ?)", (linked.model_dump_json(),)
            )
            return linked
    return config


def executable_path(value: str, name: str) -> str:
    """A path the user typed for an engine executable, cleaned up and checked.

    Accepts what people paste: quotes around it, `~`, or the folder the executable is in.
    Raises with words for the settings page when nothing runnable is there.
    """
    text = value.strip().strip("\"'").strip()
    if not text:
        return ""
    path = Path(text).expanduser()
    if path.is_dir():
        inside = [path / name, path / f"{name}.exe", path / "bin" / name]
        found = next((p for p in inside if p.is_file()), None)
        if found is None:
            raise ValueError(f"{path} is a folder without {name} in it. Give the file itself.")
        path = found
    if not path.is_file():
        raise ValueError(f"There is no file at {path}. Give the full path to {name}.")
    if not os.access(path, os.X_OK):
        raise ValueError(f"{path} is not an executable file.")
    return str(path)


def save_config(db: sqlite3.Connection, config: SaveConfig) -> AIConfig:
    previous = load_config(db)
    if config.whisper_binary_path != previous.whisper_binary_path:
        # Checked when it changes, so a path that has since gone missing cannot block saving
        # other settings; speech then reports it where it is used.
        config = config.model_copy(
            update={
                "whisper_binary_path": executable_path(config.whisper_binary_path, "whisper-server")
            }
        )
    clean = _link(AIConfig.model_validate(config.model_dump()))
    if config.api_key or config.clear_key:
        set_key_for(clean.provider, clean.base_url, None if config.clear_key else config.api_key)
    db.execute("INSERT OR REPLACE INTO meta VALUES ('ai_config', ?)", (clean.model_dump_json(),))
    return clean


def initialize(db: sqlite3.Connection, token: str) -> None:
    """Record the UI token (tables come from index/schema.sql)."""
    db.execute(
        "INSERT OR REPLACE INTO tokens VALUES ('ui', 'ui', ?, ?)",
        (json.dumps(["read", "write", "admin"]), hashlib.sha256(token.encode()).hexdigest()),
    )


# Settings that only change what is sent with a request: no engine restart is needed for them.
REQUEST_ONLY = frozenset(
    {"max_output_tokens", "thinking", "effort", "context_budget_tokens", "max_tool_calls"}
)


def save_reasoning(db: sqlite3.Connection, thinking: str | None, effort: str | None) -> AIConfig:
    """Change `thinking` and `effort` and nothing else (the composer's control)."""
    update = {k: v for k, v in (("thinking", thinking), ("effort", effort)) if v is not None}
    config = AIConfig.model_validate({**load_config(db).model_dump(), **update})
    db.execute("INSERT OR REPLACE INTO meta VALUES ('ai_config', ?)", (config.model_dump_json(),))
    return config
