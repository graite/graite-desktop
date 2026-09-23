from __future__ import annotations

import asyncio
from pathlib import Path
from unittest.mock import AsyncMock

import pytest

from graite.media import ocr
from graite.models.config import AIConfig


@pytest.mark.parametrize("cancel", [False, True])
async def test_ocr_releases_runtime_on_truncation_or_cancel(
    monkeypatch: pytest.MonkeyPatch, cancel: bool
) -> None:
    server = type(
        "Server",
        (),
        {"start": AsyncMock(), "stop": AsyncMock(), "url": "http://127.0.0.1/v1", "key": "test"},
    )()
    monkeypatch.setattr(ocr, "LlamaServer", lambda: server)
    monkeypatch.setattr(ocr, "page_count", lambda _: 1)
    monkeypatch.setattr(ocr, "render_page", lambda *_: b"png")
    entered = asyncio.Event()

    async def post(*args: object, **kwargs: object) -> object:
        entered.set()
        if cancel:
            await asyncio.sleep(60)
        return type(
            "Response",
            (),
            {
                "raise_for_status": lambda self: None,
                "json": lambda self: {"choices": [{"finish_reason": "length"}]},
            },
        )()

    monkeypatch.setattr(ocr.httpx.AsyncClient, "post", post)
    task = asyncio.create_task(
        ocr.recognize(
            Path("sample.pdf"), "model.gguf", "projector.gguf", AIConfig(), lambda _: None
        )
    )
    await entered.wait()
    if cancel:
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
    else:
        with pytest.raises(ValueError, match="too dense"):
            await task
    server.stop.assert_awaited_once()
    assert server.start.call_args.kwargs["mmproj"] == "projector.gguf"
