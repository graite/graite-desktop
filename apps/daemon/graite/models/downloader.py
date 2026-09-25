"""Resumable downloads with checksums, progress, cancellation and atomic publication."""

from __future__ import annotations

import asyncio
import json
import sqlite3
from pathlib import Path
from urllib.parse import quote

import httpx
from pydantic import BaseModel, Field

from graite.events import EventBus
from graite.models.fetch import fetch

CATALOG_PATH = Path(__file__).with_name("catalog.json")


class ModelFile(BaseModel):
    filename: str
    size: int
    sha256: str


class CatalogModel(BaseModel):
    id: str
    name: str
    role: str
    repo: str
    revision: str
    filename: str
    sha256: str
    size: int
    ctx: int
    min_ram_gb: int
    tier: str
    notes: str
    verified_llama: str | None
    # Plain-language facts for the beginner model picker (starter models only).
    level: str = ""
    summary: str = ""
    needs: str = ""
    min_vram_gb: int | None = None
    hidden: bool = False  # superseded: listed only once it is installed
    source: str = "recommended"
    files: list[ModelFile] = Field(default_factory=list)
    pooling: str = "last"
    embedding_family: str = ""
    status: str = "available"
    progress: float = 0
    error: str | None = None
    local_path: str = ""


def catalog() -> list[CatalogModel]:
    return [CatalogModel.model_validate(m) for m in json.loads(CATALOG_PATH.read_text())["models"]]


class Downloader:
    def __init__(self, db: sqlite3.Connection, events: EventBus, directory: Path) -> None:
        self.db, self.events, self.directory = db, events, directory
        self.tasks: dict[str, asyncio.Task[None]] = {}
        self.items = {m.id: m for m in catalog()}
        for row in db.execute("SELECT id,state FROM model_downloads").fetchall():
            saved = CatalogModel.model_validate_json(row[1])
            if row[0] not in self.items:
                self.items[row[0]] = saved
            item = self.items[row[0]]
            item.status, item.progress = saved.status, saved.progress
            item.error, item.local_path = saved.error, saved.local_path
            if item.status in ("downloading", "verifying"):
                item.status = "paused"
            if item.status == "installed" and not all(
                self.file_target(item, f).is_file() for f in self.parts(item)
            ):
                item.status, item.local_path = (
                    "missing" if item.source == "local" else "available",
                    "",
                )

    def parts(self, item: CatalogModel) -> list[ModelFile]:
        return item.files or [ModelFile(filename=item.filename, size=item.size, sha256=item.sha256)]

    def file_target(self, item: CatalogModel, file: ModelFile) -> Path:
        if item.source == "local":
            return Path(file.filename)
        return self.directory / item.id / file.filename

    def target(self, item: CatalogModel) -> Path:
        return self.file_target(item, self.parts(item)[0])

    def register(self, item: CatalogModel) -> CatalogModel:
        existing = self.items.get(item.id)
        if item.source != "local" and not existing:
            existing = next(
                (
                    candidate
                    for candidate in self.items.values()
                    if (candidate.repo, candidate.revision, candidate.filename)
                    == (item.repo, item.revision, item.filename)
                ),
                None,
            )
        if existing and existing.status != "missing":
            return existing
        self.items[item.id] = item
        self.publish(item)
        return item

    def publish(self, item: CatalogModel) -> None:
        self.db.execute(
            "INSERT OR REPLACE INTO model_downloads VALUES (?,?)", (item.id, item.model_dump_json())
        )
        self.events.publish("model_progress", item.model_dump())

    def start(self, model_id: str) -> CatalogModel:
        item = self.items[model_id]
        if item.source == "local":
            raise ValueError("Local files cannot be downloaded. Scan their folder again.")
        if model_id in self.tasks or item.status == "installed":
            return item
        item.status, item.error = "downloading", None
        self.publish(item)
        task = asyncio.create_task(self.download(item))
        self.tasks[item.id] = task
        task.add_done_callback(lambda _: self.tasks.pop(item.id, None))
        return item

    async def download(self, item: CatalogModel) -> None:
        try:
            completed = 0
            for file in self.parts(item):
                await self.download_file(item, file, completed)
                completed += file.size
            item.status, item.progress, item.local_path = "installed", 100, str(self.target(item))
        except asyncio.CancelledError:
            item.status = "paused"
            raise
        except (OSError, ValueError, httpx.HTTPError):
            item.status, item.error = (
                "error",
                "Download could not finish. Check disk space and connection, then retry.",
            )
        finally:
            self.publish(item)

    async def download_file(self, item: CatalogModel, file: ModelFile, completed: int) -> None:
        item.status = "downloading"
        last_progress = -1

        def progress(received: int) -> None:
            nonlocal last_progress
            item.progress = round((completed + received) / item.size * 100, 1)
            if int(item.progress) != last_progress:
                self.publish(item)
                last_progress = int(item.progress)

        def verifying() -> None:
            item.status = "verifying"
            self.publish(item)

        filename = quote(file.filename, safe="/")
        await fetch(
            f"https://huggingface.co/{item.repo}/resolve/{item.revision}/{filename}",
            self.file_target(item, file),
            size=file.size,
            sha256=file.sha256,
            on_progress=progress,
            on_verify=verifying,
        )

    async def cancel(self, model_id: str) -> None:
        task = self.tasks.get(model_id)
        if task:
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)

    async def remove(self, model_id: str) -> None:
        await self.cancel(model_id)
        item = self.items[model_id]
        if item.source == "local":
            self.items.pop(model_id)
            self.db.execute("DELETE FROM model_downloads WHERE id=?", (model_id,))
            self.events.publish("model_progress", {"id": model_id, "status": "removed"})
            return
        for file in self.parts(item):
            await asyncio.to_thread(self.file_target(item, file).unlink, missing_ok=True)
            await asyncio.to_thread(
                self.file_target(item, file).with_suffix(".part").unlink, missing_ok=True
            )
        item.status, item.progress, item.local_path, item.error = "available", 0, "", None
        self.publish(item)

    async def stop(self) -> None:
        tasks = list(self.tasks.values())
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
