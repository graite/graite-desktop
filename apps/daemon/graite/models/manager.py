"""Serialize inference with configuration changes and idle unloading.

Two lanes: `lock` guards the chat model (and every other large model), `embedding_lock`
guards the CPU embedding server. Lock order is always `lock` before `embedding_lock`.
Bulk embedding checks `chat_waiting` between batches so a question never queues behind it.
"""

from __future__ import annotations

import asyncio
import sqlite3
import time
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

from graite.cloud.session import get_cloud
from graite.models.config import REQUEST_ONLY, AIConfig, get_key, load_config
from graite.models.llama_server import LlamaServer
from graite.models.providers import Provider

# Kept loaded between searches: it is small, and Find uses vectors only while it is loaded.
EMBEDDING_IDLE_SECONDS = 900


class EmbeddingBusy(RuntimeError):
    """Loading the embedding model now would evict the resident chat model."""


class Manager:
    def __init__(self, db: sqlite3.Connection) -> None:
        self.db = db
        self.lock = asyncio.Lock()
        self.embedding_lock = asyncio.Lock()
        self.chat_waiting = asyncio.Event()
        self.server = LlamaServer()
        self.embedding_server = LlamaServer()
        self.embedding_path = ""
        self.loaded: AIConfig | None = None
        self.last_used = time.monotonic()
        self.embedding_last_used = time.monotonic()
        self.reaper: asyncio.Task[None] | None = None
        # Calls to the user's other computers (graite/compute), set by the app.
        self.compute: Any = None
        # A voice session keeps the chat model loaded between turns whatever `resident` says.
        self.pinned = False
        # Per model file: whether its chat template has a thinking switch (`enable_thinking`).
        # Learned when the model is loaded; absent means not known yet.
        self.thinking_templates: dict[str, bool] = {}

    async def start(self) -> None:
        self.reaper = asyncio.create_task(self._reap())

    async def _reap(self) -> None:
        while True:
            await asyncio.sleep(30)
            if not self.lock.locked():
                async with self.lock:
                    if (
                        not self.pinned
                        and not load_config(self.db).resident
                        and time.monotonic() - self.last_used > 600
                    ):
                        await self.server.stop()
                        self.loaded = None
            if not self.embedding_lock.locked():
                async with self.embedding_lock:
                    if (
                        self.embedding_server.process
                        and time.monotonic() - self.embedding_last_used > EMBEDDING_IDLE_SECONDS
                    ):
                        await self.embedding_server.stop()
                        self.embedding_path = ""

    async def stop(self) -> None:
        if self.reaper:
            self.reaper.cancel()
            await asyncio.gather(self.reaper, return_exceptions=True)
        await self.server.stop()
        await self.embedding_server.stop()

    def embedding_loaded(self) -> bool:
        process = self.embedding_server.process
        return bool(process and process.returncode is None)

    @asynccontextmanager
    async def use(self, override: AIConfig | None = None) -> AsyncIterator[Provider]:
        """Yield a provider. Only the local llama-server needs the lock: cloud chats run
        side by side and never wait for each other."""
        config = override or load_config(self.db)
        if config.provider != "local":
            if not config.model:
                raise ValueError("Choose a model in Settings → Chat first.")
            if config.provider == "device":
                from graite.compute.transport import DEVICE_URL, DeviceTransport

                if self.compute is None:
                    raise ValueError("Sync is not running, so that computer cannot be reached.")

                # That computer's own engine answers, so this is a local provider in every
                # way but how the request travels.
                yield Provider(
                    "local",
                    DEVICE_URL,
                    "local",
                    "",
                    max_tokens=config.max_output_tokens,
                    transport=DeviceTransport(self.compute, config.device_id, config.model),
                )
                return
            if config.provider == "graite":
                cloud = get_cloud()
                token = await cloud.access_token()
                if not token:
                    raise ValueError("Sign in to Graite Cloud in Settings → Chat.")
                yield Provider(
                    "graite",
                    cloud.api_url,
                    config.model,
                    token,
                    max_tokens=config.max_output_tokens,
                )
                return
            if config.provider == "claude_code":
                from graite.agent.claude_code import (
                    NOT_INSTALLED,
                    ClaudeCodeError,
                    ClaudeCodeProvider,
                    find_cli,
                )

                # The user's own Claude Code and its own sign-in: no key or token here.
                cli = await asyncio.to_thread(find_cli)
                if cli is None:
                    raise ClaudeCodeError(NOT_INSTALLED, "claude_install")
                yield ClaudeCodeProvider(config.model, max_tokens=config.max_output_tokens, cli=cli)
                return
            key = await asyncio.to_thread(get_key, config)
            if config.provider == "anthropic" and not key:
                raise ValueError("Add your Anthropic API key in Settings → Chat.")
            yield Provider(
                config.provider,
                config.base_url,
                config.model,
                key,
                max_tokens=config.max_output_tokens,
            )
            return
        self.chat_waiting.set()
        try:
            await self.lock.acquire()
        finally:
            self.chat_waiting.clear()
        try:
            if (
                self.loaded is None
                or self.loaded.model_dump(exclude=set(REQUEST_ONLY))
                != config.model_dump(exclude=set(REQUEST_ONLY))
                or not self.server.process
                or self.server.process.returncode is not None
            ):
                await self.server.stop()
                await self._make_room_for(config.model_path)
                await self.server.start(config)
                self.loaded = config
                await self._note_thinking_switch(config.model_path)
            provider = Provider(
                "local",
                self.server.url,
                "local",
                self.server.key,
                max_tokens=config.max_output_tokens,
            )
            try:
                yield provider
            finally:
                self.last_used = time.monotonic()
        finally:
            self.lock.release()

    async def _note_thinking_switch(self, model_path: str) -> None:
        """Record whether the loaded model's chat template reads `enable_thinking`, so the
        composer only offers a thinking switch that does something. Unknown stays unknown."""
        import httpx

        try:
            async with httpx.AsyncClient(timeout=3) as client:
                response = await client.get(
                    f"{self.server.url.removesuffix('/v1')}/props",
                    headers={"Authorization": f"Bearer {self.server.key}"},
                )
            template = response.json().get("chat_template") if response.is_success else None
        except httpx.HTTPError, ValueError, AttributeError:
            return
        if isinstance(template, str) and template:
            self.thinking_templates[model_path] = "enable_thinking" in template

    async def _make_room_for(self, model_path: str) -> None:
        """Called with `lock` held: unload the embedding server when RAM is tight."""
        if not self.embedding_loaded() or not model_path:
            return
        if await asyncio.to_thread(_tight, model_path):
            async with self.embedding_lock:
                await self.embedding_server.stop()
                self.embedding_path = ""

    @asynccontextmanager
    async def use_embedding(
        self, path: str, pooling: str = "last", *, release: bool = False, evict_chat: bool = True
    ) -> AsyncIterator[Provider]:
        """Yield the embedding provider; keep it loaded unless `release` is set.

        The idle reaper unloads it after `EMBEDDING_IDLE_SECONDS`; batch indexing keeps
        reusing the process instead of paying the load cost per batch. With `evict_chat`
        off (a query embedding during a chat), a tight memory budget raises `EmbeddingBusy`
        instead of unloading the chat model the user is talking to.
        """
        needs_load = self.embedding_path != path or not self.embedding_loaded()
        if needs_load and self.server.process and await asyncio.to_thread(_tight, path):
            if not evict_chat:
                raise EmbeddingBusy("the chat model stays loaded")
            async with self.lock:
                await self.server.stop()
                self.loaded = None
        async with self.embedding_lock:
            config = load_config(self.db)
            if self.embedding_path != path or not self.embedding_loaded():
                await self.embedding_server.stop()
                await self.embedding_server.start(
                    config.model_copy(
                        update={"model_path": path, "context_size": 2048, "gpu_layers": 0}
                    ),
                    embedding=True,
                    pooling=pooling,
                )
                self.embedding_path = path
            try:
                yield Provider(
                    "local", self.embedding_server.url, "embedding", self.embedding_server.key
                )
            finally:
                self.embedding_last_used = time.monotonic()
                if release:
                    await self.embedding_server.stop()
                    self.embedding_path = ""

    async def release_embedding(self) -> None:
        async with self.embedding_lock:
            await self.embedding_server.stop()
            self.embedding_path = ""


def _tight(model_path: str) -> bool:
    from graite.models.hardware import detect

    try:
        weight = Path(model_path).expanduser().stat().st_size / 2**30
    except OSError:
        return False
    return detect().available_gb < weight + 2
