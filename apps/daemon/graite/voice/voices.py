"""Voices the assistant can speak with: an app-wide library of cloned voices.

`<app_dir>/voices/<id>/voice.wav` (24 kHz mono, what the engine reads) and `meta.json`. It is
shared by every vault, like connections and models, and is not vault content. A voice is
only ever stored together with the confirmation that the user may use it.
"""

from __future__ import annotations

import json
import re
import secrets
import shutil
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from pydantic import BaseModel

ID = re.compile(r"v_[0-9a-f]{12}")
BUILT_IN = "built-in"


class VoiceInfo(BaseModel):
    id: str
    name: str
    seconds: float
    created_at: str
    consent_at: str


class VoiceLibrary:
    def __init__(self, app_dir: Path) -> None:
        self.root = app_dir / "voices"

    def _folder(self, voice_id: str) -> Path:
        if not ID.fullmatch(voice_id):
            raise ValueError("Unknown voice.")
        return self.root / voice_id

    def all(self) -> list[VoiceInfo]:
        found = []
        for meta in sorted(self.root.glob("v_*/meta.json")) if self.root.is_dir() else []:
            try:
                info = VoiceInfo.model_validate_json(meta.read_text(encoding="utf-8"))
            except (OSError, ValueError):
                continue
            if (meta.parent / "voice.wav").is_file():
                found.append(info)
        return sorted(found, key=lambda v: v.created_at)

    def get(self, voice_id: str) -> VoiceInfo | None:
        return next((v for v in self.all() if v.id == voice_id), None)

    def path(self, voice_id: str | None) -> Path | None:
        """The reference clip of a voice, or None for the built-in voice or a missing one."""
        if not voice_id or voice_id == BUILT_IN:
            return None
        try:
            clip = self._folder(voice_id) / "voice.wav"
        except ValueError:
            return None
        return clip if clip.is_file() else None

    def add(self, name: str, wav: bytes, seconds: float) -> VoiceInfo:
        now = datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")
        info = VoiceInfo(
            id="v_" + secrets.token_hex(6),
            name=name.strip()[:60] or "My voice",
            seconds=round(seconds, 1),
            created_at=now,
            consent_at=now,
        )
        folder = self._folder(info.id)
        folder.mkdir(parents=True)
        (folder / "voice.wav").write_bytes(wav)
        (folder / "meta.json").write_text(info.model_dump_json(), encoding="utf-8")
        return info

    def rename(self, voice_id: str, name: str) -> VoiceInfo:
        info = self.get(voice_id)
        if info is None:
            raise ValueError("Unknown voice.")
        info.name = name.strip()[:60] or info.name
        (self._folder(voice_id) / "meta.json").write_text(info.model_dump_json(), encoding="utf-8")
        return info

    def remove(self, voice_id: str) -> None:
        shutil.rmtree(self._folder(voice_id), ignore_errors=True)

    def to_json(self) -> list[dict[str, Any]]:
        return [json.loads(v.model_dump_json()) for v in self.all()]
