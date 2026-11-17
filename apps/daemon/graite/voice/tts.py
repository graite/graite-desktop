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
    only ever set when the user confirmed they may use that voice. Each engine reads its
    own controls (`controls` on the engine) and ignores the others."""

    language: str = "en"
    reference: Path | None = None
    exaggeration: float = 0.5
    cfg: float = 0.5
    speed: float = 1.0  # ZONOS3's pace, relative to the model's own


class TTSEngine(Protocol):
    name: str
    sample_rate: int
    controls: tuple[str, ...]  # the `Voice` fields this engine listens to, for the settings

    async def load(self) -> None: ...
    async def unload(self) -> None: ...
    def memory_bytes(self) -> int: ...
    def synthesize(self, text: str, voice: Voice) -> AsyncIterator[bytes]:
        """PCM16LE mono at `sample_rate`, in chunks as they become available."""
        ...


class EngineUnavailable(ValueError):
    """The engine cannot run yet; the message tells the user what to set up."""


class EngineCrashed(RuntimeError):
    """The engine process died during a request. It starts again on the next one."""


def voice_model(config: Any, downloads: Any) -> Any:
    """The installed voice model to speak with: the one chosen in Settings while it is
    installed, else whichever is installed (the catalog's first)."""
    installed = [m for m in downloads.items.values() if m.role == "tts" and m.status == "installed"]
    chosen = str(getattr(config, "tts_model", "") or "")
    return next((m for m in installed if m.id == chosen), installed[0] if installed else None)


def runs_on_llama(item: Any) -> bool:
    """Whether a voice model is spoken by the chat engine (ZONOS3) and not by CrispASR."""
    names = [f.filename for f in item.files] or [item.filename]
    return any(name.startswith("mmproj-") for name in names)


def get_engine(config: Any, downloads: Any) -> TTSEngine:
    from graite.voice.engines.crispasr import CrispasrEngine
    from graite.voice.engines.llama_tts import LlamaTtsEngine

    item = voice_model(config, downloads)
    if item is not None and runs_on_llama(item):
        return LlamaTtsEngine.from_item(config, downloads, item)
    return CrispasrEngine.from_settings(config, downloads, item)
