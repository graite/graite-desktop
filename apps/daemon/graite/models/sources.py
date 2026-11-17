"""Where reading documents (OCR) and listening (speech to text) run.

Each is "local" (a model on this computer) or "graite" (Graite Cloud). The setting is a
preference; the rule that applies it is the same everywhere (media extraction, chat
attachments, the speech check and live voice):

- "local": the local model when it is installed. A listener without a local Whisper still
  works through Graite Cloud when this computer is signed in, so voice never breaks.
- "graite": Graite Cloud when signed in, else the local model when it is installed.
- "auto": the local model when it is installed, else Graite Cloud when signed in.

`None` means neither is available; callers say what to do about it.
"""

from __future__ import annotations

from typing import Any, Literal

from graite.cloud.session import get_cloud

Source = Literal["local", "graite"]
OCR_MODEL = "glm-ocr-q8"
SPEECH_MODEL = "whisper-large-v3-turbo-q8"


def _installed(downloads: Any, item_id: str) -> bool:
    item = downloads.items.get(item_id) if downloads is not None else None
    return bool(item is not None and item.status == "installed")


async def _signed_in() -> bool:
    try:
        cloud = get_cloud()
    except RuntimeError:  # tests and tools without a cloud session
        return False
    return await cloud.signed_in()


def signed_in_now() -> bool:
    """The same check as `_signed_in`, for synchronous callers (the voice runtime)."""
    try:
        return get_cloud().has_sign_in()
    except RuntimeError:
        return False


def pick_now(preference: str, local: bool, *, fall_back: bool = True) -> Source | None:
    """`_pick` for synchronous callers."""
    if preference == "graite":
        if signed_in_now():
            return "graite"
        return "local" if local else None
    if local:
        return "local"
    if preference == "local" and not fall_back:
        return None
    return "graite" if signed_in_now() else None


async def _pick(preference: str, local: bool, *, fall_back: bool) -> Source | None:
    if preference == "graite":
        if await _signed_in():
            return "graite"
        return "local" if local else None
    if local:
        return "local"
    if preference == "local" and not fall_back:
        return None
    return "graite" if await _signed_in() else None


async def ocr_source(config: Any, downloads: Any) -> Source | None:
    local = _installed(downloads, OCR_MODEL)
    return await _pick(config.ocr_provider, local, fall_back=False)


async def stt_source(
    config: Any, downloads: Any, *, local_ready: bool | None = None
) -> Source | None:
    """`local_ready` lets a caller add its own engine check to "the model is installed"."""
    local = _installed(downloads, SPEECH_MODEL) if local_ready is None else local_ready
    return await _pick(config.stt_provider, local, fall_back=True)


def unavailable(kind: Literal["ocr", "stt"]) -> str:
    what = "read documents" if kind == "ocr" else "turn speech into text"
    where = "Documents" if kind == "ocr" else "Speech"
    return (
        f"To {what}, sign in to Graite Cloud, or turn on “Use local AI on my computer” under "
        f"Settings → {where} and download the model."
    )
