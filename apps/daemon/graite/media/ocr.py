"""GLM-OCR Q8 via the same local llama.cpp engine family as chat/embeddings."""

from __future__ import annotations

import asyncio
import base64
from collections.abc import Callable
from pathlib import Path

import httpx

from graite.media.decode import page_count, render_page
from graite.models.config import AIConfig
from graite.models.llama_server import LlamaServer


async def recognize(
    path: Path, model: str, projector: str, config: AIConfig, progress: Callable[[str], None]
) -> str:
    count = await asyncio.to_thread(page_count, path)
    server = LlamaServer()
    try:
        progress("Loading GLM-OCR…")
        await server.start(
            config.model_copy(
                update={
                    "model_path": model,
                    "binary_path": config.ocr_binary_path or config.binary_path,
                    "context_size": 16384,
                }
            ),
            mmproj=projector,
        )
        result = []
        async with httpx.AsyncClient(timeout=600) as client:
            for index in range(count):
                progress(f"Reading page {index + 1} of {count}…")
                png = await asyncio.to_thread(render_page, path, index)
                response = await client.post(
                    server.url + "/chat/completions",
                    headers={"Authorization": "Bearer " + server.key},
                    json={
                        "model": "glm-ocr",
                        "temperature": 0,
                        "max_tokens": 12000,
                        "messages": [
                            {
                                "role": "user",
                                "content": [
                                    {
                                        "type": "image_url",
                                        "image_url": {
                                            "url": "data:image/png;base64,"
                                            + base64.b64encode(png).decode()
                                        },
                                    },
                                    {"type": "text", "text": "Text Recognition:"},
                                ],
                            }
                        ],
                    },
                )
                response.raise_for_status()
                choice = response.json()["choices"][0]
                if choice.get("finish_reason") == "length":
                    raise ValueError(
                        f"Page {index + 1} is too dense. Split or crop this page and retry."
                    )
                text = choice["message"]["content"].strip()
                if not text:
                    raise ValueError(f"No text was recognized on page {index + 1}.")
                if text.startswith("```markdown\n") and text.endswith("```"):
                    text = text[12:-3].strip()
                result.append((f"## Page {index + 1}\n\n" if count > 1 else "") + text)
        return "\n\n".join(result)
    finally:
        await server.stop()
