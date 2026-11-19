"""The user's app-wide profile: what they told Graite about themselves, shared by all vaults."""

from __future__ import annotations

import json
import os
from pathlib import Path

from pydantic import BaseModel, Field, field_validator

NAME_LIMIT = 60


def clean_name(value: str | None) -> str:
    """One line, trimmed and capped: the name goes into prompts."""
    return " ".join((value or "").split())[:NAME_LIMIT].strip()


class Profile(BaseModel):
    first_name: str = Field(default="", description="What the user likes to be called.")

    @field_validator("first_name", mode="before")
    @classmethod
    def _clean(cls, value: object) -> str:
        return clean_name(value if isinstance(value, str) else "")


class ProfileStore:
    """The only writer of the profile file. Small and shared between daemons, so every read
    goes to disk (as with connections)."""

    def __init__(self, path: Path) -> None:
        self.path = path

    def load(self) -> Profile:
        try:
            raw = json.loads(self.path.read_text(encoding="utf-8"))
            return Profile.model_validate(raw)
        except OSError, ValueError:
            return Profile()

    def save(self, profile: Profile) -> Profile:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.path.with_name(f".{self.path.name}.tmp-{os.getpid()}")
        tmp.write_text(
            json.dumps(profile.model_dump(), indent=2, ensure_ascii=False) + "\n",
            encoding="utf-8",
        )
        os.replace(tmp, self.path)
        return profile


_store: ProfileStore | None = None


def get_profile_store() -> ProfileStore | None:
    return _store


def set_profile_store(store: ProfileStore | None) -> None:
    global _store
    _store = store


def first_name() -> str | None:
    """The user's first name for prompts, or None when they have not given one."""
    if _store is None:
        return None
    return _store.load().first_name or None
