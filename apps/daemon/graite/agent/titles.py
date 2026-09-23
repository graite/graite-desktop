"""Short model-generated chat titles, with a readable offline fallback."""

from __future__ import annotations

import asyncio

from graite.agent.loop import visible
from graite.models.config import AIConfig
from graite.models.manager import Manager


async def chat_title(manager: Manager, config: AIConfig, question: str) -> str:
    fallback = " ".join(question.split())[:70] or "New chat"
    try:
        async with asyncio.timeout(20):
            async with manager.use(config) as provider:
                text = ""
                async for delta in provider.chat(
                    [
                        {
                            "role": "system",
                            "content": (
                                "Write a short chat title (3 to 7 words) for the user's message. "
                                "Use the same language as the message. Return only the title, "
                                "without quotes, explanation or thinking. "
                                "Do not answer the message."
                            ),
                        },
                        {"role": "user", "content": question[:2000]},
                    ],
                    [],
                ):
                    text += delta.get("content", "") or ""
                    if len(text) > 2000:
                        break
                title = visible(text).strip().splitlines()
                return (
                    title[0].strip(" #*\"'")[:80]
                    if title and title[0].strip(" #*\"'")
                    else fallback
                )
    except Exception:  # A title must never prevent a saved answer from reaching the user.
        return fallback
