"""Daemon settings.

Resolved from CLI arguments first, then environment / `.env` (dev mode only).
"""

from __future__ import annotations

from pathlib import Path

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="GRAITE_", env_file=".env", extra="ignore")

    vault: Path = Field(description="Vault root directory.")
    host: str = "127.0.0.1"
    port: int = Field(default=0, description="0 = pick a free port and print it on stdout.")
    token: str = Field(description="Bearer token every request must present.")
    models_dir: Path = Field(default_factory=lambda: Path.home() / ".graite/models")
    app_dir: Path = Field(
        default_factory=lambda: Path.home() / ".graite",
        description="App-wide state shared by every vault (connections, saved models).",
    )
    feedback_url: str = Field(
        default="",
        description="Where 'Send feedback' posts to (GRAITE_FEEDBACK_URL); empty hides it.",
    )
    cloud_url: str = Field(
        default="https://api.getgraite.com",
        description="Graite Cloud, the optional hosted account and models (GRAITE_CLOUD_URL).",
    )
    dev: bool = False
    serve: bool = Field(default=False, description="Headless: do not exit when stdin closes.")
    no_watch: bool = Field(default=False, description="Do not watch the vault for external edits.")

    @property
    def graite_dir(self) -> Path:
        return self.vault / ".graite"
