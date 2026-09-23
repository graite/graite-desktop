"""FastAPI application factory."""

from __future__ import annotations

import asyncio
import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from starlette.routing import Route

from graite import __version__
from graite.agents import builder
from graite.agents.definitions import Definitions
from graite.agents.triggers import PageTriggers
from graite.api import (
    ai,
    automation,
    clientlog,
    connections,
    events,
    feedback,
    health,
    media,
    pages,
    review,
    trash,
)
from graite.api import assistant as assistant_api
from graite.api import engines as engines_api
from graite.api import mcp as mcp_api
from graite.api import voice as voice_api
from graite.api.auth import BearerAuthMiddleware
from graite.assistant.presence import ForegroundGate
from graite.config import Settings
from graite.events import EventBus
from graite.index import db
from graite.index.embedder import Embedder
from graite.jobs.cron import Cron
from graite.jobs.handlers import HANDLERS
from graite.jobs.queue import PRIORITY_BULK, PRIORITY_HOT, JobQueue
from graite.jobs.worker import Worker
from graite.mcp import runtime
from graite.mcp.server import McpEndpoint, McpService
from graite.models.config import initialize
from graite.models.connections import Store, set_store
from graite.models.downloader import Downloader
from graite.models.engines import EngineInstaller, set_installer
from graite.models.manager import Manager
from graite.review.proposals import Proposals
from graite.vault import indexer
from graite.vault.fileops import FileOps
from graite.vault.indexer import ScanResult
from graite.vault.watcher import Watcher
from graite.voice.runtime import VoiceRuntime

log = logging.getLogger("graite")

API_PREFIX = "/api/v1"
WEBVIEW_ORIGINS = [
    "tauri://localhost",
    "http://tauri.localhost",
    "https://tauri.localhost",
    "http://localhost:1420",
]


def create_app(settings: Settings) -> FastAPI:
    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        # Startup order (ARCHITECTURE.md §3): db -> models -> fileops/watcher -> indexer ->
        # embeddings -> jobs -> cron -> live notes. Only db and the event bus exist in M0.
        settings.vault.mkdir(parents=True, exist_ok=True)
        # No index yet means Graite never opened this folder: the UI can greet a new vault.
        app.state.fresh_vault = not (settings.graite_dir / "index.sqlite").exists()
        conn = db.connect(settings.graite_dir / "index.sqlite")
        app.state.db = conn
        app.state.vec_version = db.vec_version(conn)
        app.state.events = EventBus()
        app.state.events.bind(asyncio.get_running_loop())
        initialize(conn, settings.token)
        app.state.active_chats = {}
        app.state.media_jobs = {}
        for row in conn.execute("SELECT id, state FROM media_jobs").fetchall():
            job = media.Extraction.model_validate_json(row[1])
            if job.status == "running":
                job.status, job.error = (
                    "error",
                    "Graite closed before this task finished. Run it again.",
                )
            app.state.media_jobs[job.id] = job
        app.state.media_tasks = {}
        set_store(Store(settings.app_dir / "connections.json"))
        app.state.downloads = Downloader(conn, app.state.events, settings.models_dir)
        app.state.models = Manager(conn)
        await app.state.models.start()
        app.state.fileops = FileOps(settings.vault, conn, app.state.events)
        app.state.proposals = Proposals(conn, app.state.fileops, app.state.events)
        app.state.definitions = Definitions(settings.vault, lambda: app.state.fileops.epoch)
        app.state.engines = EngineInstaller(settings.app_dir, app.state.events)
        set_installer(app.state.engines)
        app.state.queue = JobQueue(conn, app.state.events)
        app.state.embedder = Embedder(conn, app.state.models, app.state.downloads, app.state.events)
        app.state.hot_paths = app.state.embedder.hot_paths

        def on_indexed(result: ScanResult) -> None:
            if not result.chunked:
                return
            hot = any(
                rel == root or rel.startswith(root + "/")
                for rel in result.chunked
                for root in app.state.hot_paths
            )
            app.state.queue.enqueue(
                "embed", key="embed", priority=PRIORITY_HOT if hot else PRIORITY_BULK
            )

        app.state.fileops.on_indexed = on_indexed
        count = await app.state.fileops.rescan()
        app.state.worker = Worker(app.state.queue, HANDLERS, app.state)
        app.state.foreground = ForegroundGate(app.state.worker, app.state.queue)
        app.state.worker.gate = app.state.foreground.clear
        app.state.voice = VoiceRuntime(app.state)
        await app.state.worker.start()
        app.state.cron = Cron(conn, app.state.queue, app.state.events, app.state.definitions)
        app.state.worker.on_finished = app.state.cron.on_job_finished
        await app.state.cron.start()
        app.state.page_triggers = PageTriggers(app.state)
        await app.state.page_triggers.start()
        if indexer.pending_embeddings(conn):
            app.state.queue.enqueue("embed", key="embed", priority=PRIORITY_BULK)
        app.state.watcher = Watcher(settings.vault, app.state.fileops, app.state.events)
        if not settings.no_watch:
            await app.state.watcher.start()
        log.info(
            "index open at %s (sqlite-vec %s), %d pages",
            settings.graite_dir,
            app.state.vec_version,
            count,
        )
        try:
            # The MCP session manager owns a task group for the lifetime of the app.
            async with mcp_service.manager.run():
                yield
        finally:
            tasks = list(app.state.media_tasks.values())
            for task in tasks:
                task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)
            await app.state.voice.stop()
            await app.state.engines.stop()
            set_installer(None)
            await app.state.watcher.stop()
            await app.state.page_triggers.stop()
            await app.state.cron.stop()
            await app.state.worker.stop()
            await app.state.downloads.stop()
            await app.state.models.stop()
            conn.close()
            # Here rather than after `server.run()`: uvicorn re-raises SIGTERM once the
            # lifespan has ended, which kills the process before the CLI could clean up.
            runtime.clear(settings.app_dir)
            log.info("index closed")

    app = FastAPI(title="graite-daemon", version=__version__, lifespan=lifespan)
    app.state.settings = settings
    # One per app: the session manager can only be run once.
    mcp_service = McpService(lambda: app.state, settings)
    app.state.mcp = mcp_service
    app.add_middleware(BearerAuthMiddleware, token=settings.token)
    # The webview origin (tauri://localhost, http://tauri.localhost, or the Vite dev server)
    # differs from the daemon's, so every fetch with an Authorization header is preflighted.
    # Added last = outermost, so CORS answers OPTIONS before auth sees it.
    app.add_middleware(
        CORSMiddleware,
        allow_origins=WEBVIEW_ORIGINS,
        allow_methods=["*"],
        allow_headers=["Authorization", "Content-Type", "X-Graite-Request"],
    )
    from graite.api import workspace

    app.include_router(workspace.router, prefix=API_PREFIX)
    app.include_router(ai.router, prefix=API_PREFIX)
    app.include_router(connections.router, prefix=API_PREFIX)
    app.include_router(review.router, prefix=API_PREFIX)
    app.include_router(automation.router, prefix=API_PREFIX)
    app.include_router(assistant_api.router, prefix=API_PREFIX)
    app.include_router(voice_api.router, prefix=API_PREFIX)
    app.include_router(engines_api.router, prefix=API_PREFIX)
    app.include_router(builder.router, prefix=API_PREFIX)
    app.include_router(media.router, prefix=API_PREFIX)
    app.include_router(health.router, prefix=API_PREFIX)
    app.include_router(clientlog.router, prefix=API_PREFIX)
    app.include_router(feedback.router, prefix=API_PREFIX)
    app.include_router(pages.router, prefix=API_PREFIX)
    app.include_router(trash.router, prefix=API_PREFIX)
    app.include_router(mcp_api.router, prefix=API_PREFIX)
    app.include_router(events.router)
    # MCP over streamable HTTP, behind the same bearer token. A plain route, not a mount:
    # clients POST to `/mcp` exactly and a mount would redirect them to `/mcp/`.
    app.router.routes.append(
        Route("/mcp", endpoint=McpEndpoint(mcp_service, WEBVIEW_ORIGINS), methods=["POST"])
    )
    return app
