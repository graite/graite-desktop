"""Authenticated page attachments and explicit, cancellable extraction jobs."""

from __future__ import annotations

import asyncio
import logging
import shutil
import tempfile
import uuid
from pathlib import Path
from typing import Literal
from urllib.parse import quote

import httpx
from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import FileResponse, Response
from pydantic import BaseModel, Field

from graite.media.decode import AUDIO, IMAGES, MAX_BYTES, MIMES, audio_wav, page_count, render_page
from graite.media.ocr import recognize
from graite.models.config import load_config
from graite.models.speech import readable_transcript, transcribe
from graite.vault.fileops import FileOps
from graite.vault.models import PageDoc

log = logging.getLogger("graite.media")

router = APIRouter(prefix="/media", tags=["media"])


class Attachment(BaseModel):
    file: str
    name: str
    kind: Literal["audio", "image", "pdf"]
    pages: int = 1


class ExtractRequest(BaseModel):
    page_id: str
    file: str
    name: str = Field(max_length=200)
    output: Literal["toggle", "page"] = "toggle"


class Extraction(BaseModel):
    id: str
    status: Literal["running", "done", "error", "cancelled"] = "running"
    progress: str = "Waiting for the local model…"
    error: str = ""
    # Only set by jobs finished before results stopped being written to `_assets`.
    file: str = ""
    # The extracted text of an "add here" result. It waits in this record (the local index)
    # until the editor puts it on the page; it never becomes a file in the vault.
    text: str = ""
    title: str = ""
    page: PageDoc | None = None


def attachment(request: Request, page_id: str, file: str) -> Path:
    try:
        path: Path = request.app.state.fileops.attachment_path(page_id, file)
        if not path.is_file():
            raise FileNotFoundError("The local attachment is missing.")
        return path
    except FileNotFoundError as exc:
        raise HTTPException(404, str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc


@router.post("/upload", response_model=Attachment)
async def upload(request: Request, page_id: str, name: str) -> Attachment:
    suffix = Path(name).suffix.lower()
    if suffix not in AUDIO and suffix not in IMAGES and suffix != ".pdf":
        raise HTTPException(400, "Choose audio, a PDF, or a PNG, JPEG, WebP or TIFF image.")
    data = bytearray()
    async for chunk in request.stream():
        data.extend(chunk)
        if len(data) > MAX_BYTES:
            raise HTTPException(413, "Files can be up to 200 MB.")
    if not data:
        raise HTTPException(400, "This file is empty.")
    try:
        file = await request.app.state.fileops.add_attachment(page_id, name, bytes(data))
        return Attachment(
            file=file,
            name=Path(name).name,
            kind="audio" if suffix in AUDIO else "pdf" if suffix == ".pdf" else "image",
        )
    except (ValueError, FileNotFoundError) as exc:
        raise HTTPException(400, str(exc)) from exc


@router.get("/file")
async def get_file(request: Request, page_id: str, file: str) -> FileResponse:
    path = attachment(request, page_id, file)
    return FileResponse(
        path,
        media_type=MIMES.get(path.suffix.lower(), "application/octet-stream"),
        headers={"X-Content-Type-Options": "nosniff", "Cache-Control": "no-store"},
    )


@router.get("/preview")
async def preview(request: Request, page_id: str, file: str, page: int = 0) -> Response:
    path = attachment(request, page_id, file)
    if path.suffix.lower() not in IMAGES and path.suffix.lower() != ".pdf":
        raise HTTPException(400, "This attachment has no document preview.")
    try:
        count = await asyncio.to_thread(page_count, path)
        if not 0 <= page < count:
            raise ValueError("That page does not exist.")
        data = await asyncio.to_thread(render_page, path, page)
        return Response(data, media_type="image/png", headers={"Cache-Control": "no-store"})
    except (ValueError, OSError) as exc:
        raise HTTPException(400, str(exc)) from exc


@router.get("/info")
async def info(request: Request, page_id: str, file: str) -> dict[str, int]:
    path = attachment(request, page_id, file)
    try:
        return {"pages": await asyncio.to_thread(page_count, path)}
    except (ValueError, OSError) as exc:
        raise HTTPException(400, str(exc)) from exc


async def run_extraction(request: Request, payload: ExtractRequest, job: Extraction) -> None:
    state = request.app.state
    ops: FileOps = state.fileops
    try:
        async with state.models.lock:
            # Resolve by stable page id after queueing (the user may rename the page).
            path = attachment(request, payload.page_id, payload.file)
            speech = path.suffix.lower() in AUDIO
            item = state.downloads.items["whisper-large-v3-turbo-q8" if speech else "glm-ocr-q8"]
            if item.status != "installed":
                raise ValueError(
                    "Download "
                    + ("Whisper Turbo" if speech else "GLM-OCR")
                    + " under Settings → Documents first."
                )
            await state.models.server.stop()
            state.models.loaded = None
            config = load_config(state.db)
            # A private working copy keeps multi-page OCR stable while its page is renamed.
            with tempfile.TemporaryDirectory(prefix="graite-media-") as directory:
                working = Path(directory) / ("source" + path.suffix.lower())
                await asyncio.to_thread(shutil.copyfile, path, working)
                if speech:
                    job.progress = "Preparing audio…"
                    audio = await asyncio.to_thread(audio_wav, working)
                    job.progress = "Transcribing on device…"
                    result = await transcribe(
                        audio, item.local_path, config.whisper_binary_path, max_seconds=3600
                    )
                    text = readable_transcript(str(result["text"]))
                    if not text.strip():
                        raise ValueError("No speech was detected in this recording.")
                else:
                    files = state.downloads.parts(item)
                    text = await recognize(
                        working,
                        item.local_path,
                        str(state.downloads.file_target(item, files[1])),
                        config,
                        lambda message: setattr(job, "progress", message),
                    )
            title = ("Transcript" if speech else "Document text") + " · " + payload.name
            if payload.output == "page":
                # A new page only: generation never overwrites the user's page or a result.
                source = quote("../_assets/" + payload.file)
                clean_title = title.replace("\n", " ")
                label = payload.name.replace("[", "").replace("]", "").replace("\n", " ")
                body = f"# {clean_title}\n\nSource: [{label}]({source})\n\n{text.strip()}\n"
                job.page = await ops.create_media_page(payload.page_id, title, body)
            else:
                # The editor inserts this under the file. `_assets` holds what the user
                # attached, not a second copy of text that ends up in page.md anyway.
                job.text = text.strip()
            job.title, job.status, job.progress = title, "done", "Saved locally"
    except asyncio.CancelledError:
        job.status, job.progress = "cancelled", "Cancelled"
        raise
    except (ValueError, OSError, httpx.HTTPError, HTTPException) as exc:
        job.status = "error"
        job.error = (
            str(exc)
            if isinstance(exc, (ValueError, HTTPException))
            else "The local model could not finish. Check the file and engine in Settings."
        )
    except Exception:
        log.exception("Media extraction failed")
        job.status, job.error = "error", "Extraction failed. Check the local engine and try again."

    finally:
        state.db.execute(
            "INSERT OR REPLACE INTO media_jobs VALUES (?, ?)", (job.id, job.model_dump_json())
        )


@router.post("/extract", response_model=Extraction)
async def extract(request: Request, payload: ExtractRequest) -> Extraction:
    path = attachment(request, payload.page_id, payload.file)
    if (
        path.suffix.lower() not in AUDIO
        and path.suffix.lower() not in IMAGES
        and path.suffix.lower() != ".pdf"
    ):
        raise HTTPException(400, "Choose an audio file, image or PDF.")
    state = request.app.state
    from graite.api.ai import model_busy

    if model_busy(state):
        raise HTTPException(409, "Wait for the current model task to finish.")
    job = Extraction(id=uuid.uuid4().hex)
    # Keep only a bounded history; running jobs are never removed.
    for key in list(state.media_jobs):
        if len(state.media_jobs) < 100:
            break
        if state.media_jobs[key].status != "running":
            state.media_jobs.pop(key)
            state.db.execute("DELETE FROM media_jobs WHERE id=?", (key,))
    state.media_jobs[job.id] = job
    state.db.execute("INSERT INTO media_jobs VALUES (?,?)", (job.id, job.model_dump_json()))
    task = asyncio.create_task(run_extraction(request, payload, job))
    state.media_tasks[job.id] = task
    task.add_done_callback(lambda _: state.media_tasks.pop(job.id, None))
    return job


@router.get("/jobs/{job_id}", response_model=Extraction)
async def get_job(request: Request, job_id: str) -> Extraction:
    job: Extraction | None = request.app.state.media_jobs.get(job_id)
    if not job:
        raise HTTPException(404, "This task ended when Graite closed. You can run it again.")
    return job


@router.delete("/jobs/{job_id}", response_model=Extraction)
async def cancel_job(request: Request, job_id: str) -> Extraction:
    job = await get_job(request, job_id)
    task = request.app.state.media_tasks.get(job_id)
    if task:
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)
    return job


@router.post("/attach-recording")
async def attach_recording(request: Request, payload: ExtractRequest) -> dict[str, bool]:
    path = attachment(request, payload.page_id, payload.file)
    if path.suffix.lower() not in AUDIO:
        raise HTTPException(400, "Choose an audio recording.")
    await request.app.state.fileops.attach_recording(payload.page_id, payload.file, payload.name)
    return {"saved": True}


@router.get("/location")
async def location(request: Request, page_id: str, file: str) -> dict[str, str]:
    path = attachment(request, page_id, file)
    return {"folder": str(path.parent), "path": str(path)}


class AttachmentInfo(BaseModel):
    file: str
    name: str
    kind: Literal["audio", "image", "pdf", "text", "other"]
    size: int
    modified: str
    referenced: bool
    referenced_by: list[str]
    # Extraction text left behind by earlier versions, not something the user attached.
    generated: bool = False


class TrashedAttachment(BaseModel):
    trash_id: str


def _kind(name: str) -> Literal["audio", "image", "pdf", "text", "other"]:
    suffix = Path(name).suffix.lower()
    if suffix in AUDIO:
        return "audio"
    if suffix in IMAGES:
        return "image"
    if suffix == ".pdf":
        return "pdf"
    return "text" if suffix in (".md", ".txt") else "other"


@router.get("/attachments", response_model=list[AttachmentInfo])
async def list_attachments(request: Request, page_id: str) -> list[AttachmentInfo]:
    """Every file in this page's _assets folder, and which pages still use it."""
    try:
        entries = await request.app.state.fileops.list_attachments(page_id)
    except FileNotFoundError as exc:
        raise HTTPException(404, str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    return [
        AttachmentInfo(
            file=e.file,
            name=e.name,
            kind=_kind(e.file),
            size=e.size,
            modified=e.modified,
            referenced=bool(e.referenced_by),
            referenced_by=e.referenced_by,
            generated=e.generated,
        )
        for e in entries
    ]


@router.delete(
    "/attachments",
    response_model=TrashedAttachment,
    responses={409: {"description": "Still used on a page; repeat with force=true."}},
)
async def trash_attachment(
    request: Request, page_id: str, file: str, force: bool = False
) -> TrashedAttachment:
    """Move one attachment to the trash. Pages are never rewritten."""
    from graite.vault.models import AttachmentInUse

    try:
        trash_id = await request.app.state.fileops.trash_attachment(
            page_id, file, "ui", force=force
        )
    except AttachmentInUse as exc:
        raise HTTPException(409, "Still used on: " + ", ".join(exc.paths) + ".") from exc
    except FileNotFoundError as exc:
        raise HTTPException(404, str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    return TrashedAttachment(trash_id=trash_id)


class MoveMediaRequest(BaseModel):
    source_id: str
    target_path: str
    file: str
    block: str = Field(max_length=10000)
    base_hash: str


@router.post("/move")
async def move_media(request: Request, payload: MoveMediaRequest) -> dict[str, str]:
    from graite.vault.models import ConflictError
    from graite.vault.paths import VaultPathError

    ops: FileOps = request.app.state.fileops
    try:
        return await ops.move_media_block(
            payload.source_id, payload.target_path, payload.file, payload.block, payload.base_hash
        )
    except ConflictError as exc:
        raise HTTPException(409, "The source page changed. Reload it before moving media.") from exc
    except (ValueError, VaultPathError) as exc:
        raise HTTPException(400, str(exc)) from exc
    except FileNotFoundError as exc:
        raise HTTPException(404, "The page or media file no longer exists.") from exc
