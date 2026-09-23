from contextlib import asynccontextmanager

import pytest

from graite.agent.titles import chat_title
from graite.models.config import AIConfig


class TitleModel:
    def __init__(self, result):
        self.result = result

    @asynccontextmanager
    async def use(self, config):
        yield self

    async def chat(self, messages, tools):
        assert tools == []
        assert "title" in messages[0]["content"]
        if isinstance(self.result, Exception):
            raise self.result
        yield {"content": self.result}


@pytest.mark.asyncio
async def test_model_title_strips_thinking_and_quotes():
    assert (
        await chat_title(
            TitleModel('<think>reason</think>"Planning the next release"'), AIConfig(), "help plan"
        )
        == "Planning the next release"
    )


@pytest.mark.asyncio
async def test_failed_title_preserves_readable_fallback():
    assert (
        await chat_title(TitleModel(ValueError("offline")), AIConfig(), "Plan\n  my release")
        == "Plan my release"
    )


def test_all_history_includes_page_and_vault_chats(client):
    page = client.post("/api/v1/pages", json={"title": "Notes"}).json()
    for body in (
        {"page_path": page["path"]},
        {"scope": {"kind": "vault", "roots": [], "excluded": []}},
    ):
        assert client.post("/api/v1/ai/conversations", json=body).status_code == 200
    assert len(client.get("/api/v1/ai/conversations?scope=all").json()) == 2
    assert len(client.get("/api/v1/ai/conversations?scope=vault").json()) == 1
