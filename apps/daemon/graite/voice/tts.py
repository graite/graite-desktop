"""Text to speech behind one small protocol, so the engine is a detail of one module.

This is deliberately not the chat `Provider`: a voice engine has no messages or tools, and
it streams PCM, not text. `get_engine` is the only place that knows which engines exist.
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Protocol


@dataclass
class Voice:
    """How to sound. `reference` is a prepared 24 kHz mono WAV of the voice to clone; it is
    only ever set when the user confirmed they may use that voice."""

    language: str = "en"
    reference: Path | None = None
    exaggeration: float = 0.5
    cfg: float = 0.5


class TTSEngine(Protocol):
    name: str
    sample_rate: int

    async def load(self) -> None: ...
    async def unload(self) -> None: ...
    def memory_bytes(self) -> int: ...
    def synthesize(self, text: str, voice: Voice) -> AsyncIterator[bytes]:
        """PCM16LE mono at `sample_rate`, in chunks as they become available."""
        ...


class EngineUnavailable(ValueError):
    """The engine cannot run yet; the message tells the user what to set up."""


def get_engine(config: Any, downloads: Any) -> TTSEngine:
    from graite.voice.engines.crispasr import CrispasrEngine

    return CrispasrEngine.from_settings(config, downloads)
