"""Short model-generated chat titles, with a readable offline fallback."""

from __future__ import annotations

import asyncio

from graite.agent.loop import visible
from graite.models.config import AIConfig
from graite.models.manager import Manager

TITLE_TASK = (
    "Write a very short chat title (2 to 4 words) for the user's message. "
    "Use the same language as the message. Return only the title, "
    "without quotes, explanation or thinking. "
    "Do not answer the message."
)


async def chat_title(
    manager: Manager,
    config: AIConfig,
    question: str,
    *,
    system: str = "",
    answer: str = "",
) -> str:
    """A title for a new chat.

    With `system` (the system prompt of the turn that was just answered) the request starts
    with the same messages as that turn and only adds the title task at the end, so a local
    llama-server answers from its cached prefix instead of reading a new prompt and losing
    the conversation's cache for the next question.
    """
    fallback = " ".join(question.split())[:70] or "New chat"
    if system:
        messages = [
            {"role": "system", "content": system},
            {"role": "user", "content": question[:2000]},
            {"role": "assistant", "content": answer[:600] or "…"},
            {"role": "user", "content": TITLE_TASK.replace("the user's message", "this chat")},
        ]
    else:
        messages = [
            {"role": "system", "content": TITLE_TASK},
            {"role": "user", "content": question[:2000]},
        ]
    try:
        async with asyncio.timeout(20):
            async with manager.use(config) as provider:
                text = ""
                async for delta in provider.chat(messages, []):
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
