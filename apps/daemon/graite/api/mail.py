"""Mail accounts and the local, read-only copy of their mail.

Every route names its account, so any number of accounts sit side by side.
"""

from __future__ import annotations

import asyncio
import time
from pathlib import Path
from typing import Any, Literal

from fastapi import APIRouter, HTTPException, Query, Request, Response
from pydantic import BaseModel, Field

from graite.mail import imap, oauth, parse, richtext, send
from graite.mail.accounts import (
    IMAPS_PORT,
    Account,
    delete_password,
    domain_of,
    set_password,
)
from graite.mail.drafts import Draft
from graite.mail.service import MailService

router = APIRouter(prefix="/mail", tags=["Mail"])

GOOGLE_DOMAINS = {"gmail.com", "googlemail.com"}
GOOGLE_HOST = "imap.gmail.com"  # also a Google Workspace address on its own domain
GOOGLE_HINT = (
    " Google needs an app password here, not your normal password: turn on 2-Step "
    "Verification, then make one at myaccount.google.com/apppasswords."
)


class MailAccount(BaseModel):
    id: str
    name: str
    email: str
    host: str
    port: int
    username: str
    created_at: str
    state: str = Field(description="waiting, syncing, ok or error")
    error: str
    needs_password: bool
    synced_at: str
    unread: int
    drafts: int
    auth: str = Field(description="password, or microsoft: signed in at Microsoft.")
    sender_name: str = Field(description="Your name on sent mail; empty: only the address.")
    smtp_host: str = Field(description="The outgoing server in use, set or worked out.")
    smtp_port: int


class MailAccounts(BaseModel):
    accounts: list[MailAccount]


class NewMailAccount(BaseModel):
    email: str = Field(min_length=3, max_length=320)
    password: str = Field(min_length=1, max_length=1024)
    name: str = Field(default="", max_length=80)
    host: str = Field(default="", max_length=255)
    port: int = Field(default=IMAPS_PORT, ge=1, le=65535)
    username: str = Field(default="", max_length=320)


class PatchMailAccount(BaseModel):
    name: str | None = Field(default=None, max_length=80)
    password: str | None = Field(default=None, min_length=1, max_length=1024)
    sender_name: str | None = Field(default=None, max_length=120)
    smtp_host: str | None = Field(default=None, max_length=255)
    smtp_port: int | None = Field(default=None, ge=0, le=65535)


class MailFolder(BaseModel):
    name: str
    title: str
    role: str
    synced_at: str
    unread: int
    total: int


class MailFolders(BaseModel):
    folders: list[MailFolder]


class MailThreadSummary(BaseModel):
    thread_id: str
    subject: str
    sender_name: str
    sender_email: str
    participants: list[str]
    snippet: str
    date: str
    count: int
    unread: int
    flagged: bool
    has_attachments: bool


class MailThreads(BaseModel):
    threads: list[MailThreadSummary]
    more: bool


class MailPerson(BaseModel):
    name: str
    email: str


class MailAttachment(BaseModel):
    name: str
    type: str
    size: int


class MailMessage(BaseModel):
    id: int
    message_id: str
    subject: str
    sender_name: str
    sender_email: str
    recipients: list[MailPerson]
    cc: list[MailPerson]
    date: str
    seen: bool
    flagged: bool
    body_text: str
    body_html: str
    attachments: list[MailAttachment]
    size: int
    folders: list[str]
    partial: bool = Field(description="Too large to keep whole: only its headers are here.")


class MailThread(BaseModel):
    thread_id: str
    subject: str
    messages: list[MailMessage]


def _service(request: Request) -> MailService:
    service: MailService | None = getattr(request.app.state, "mail", None)
    if service is None:
        raise HTTPException(503, "Mail is not available in this daemon.")
    return service


def _account(service: MailService, account_id: str) -> Account:
    account = service.accounts.account(account_id)
    if account is None:
        raise HTTPException(404, "Mail account not found.")
    return account


async def _view(service: MailService, account: Account) -> MailAccount:
    status = service.status(account.id)
    unread = await asyncio.to_thread(service.box(account.id).unread)
    host, port = send.outgoing(account)
    drafts = await asyncio.to_thread(service.drafts.list, account.id)
    return MailAccount(
        **account.model_dump(exclude={"smtp_host", "smtp_port", "client_id"}),
        smtp_host=host,
        smtp_port=port,
        drafts=len(drafts),
        state=status.state,
        error=status.error,
        needs_password=status.needs_password,
        synced_at=status.synced_at,
        unread=unread,
    )


def _refusal(account: Account, exc: imap.MailError) -> str:
    google = domain_of(account.email) in GOOGLE_DOMAINS or account.host == GOOGLE_HOST
    hint = GOOGLE_HINT if exc.auth and google else ""
    return str(exc) + hint


@router.get("/accounts", response_model=MailAccounts)
async def list_accounts(request: Request) -> MailAccounts:
    service = _service(request)
    return MailAccounts(
        accounts=[await _view(service, account) for account in service.accounts.accounts()]
    )


@router.post("/accounts", response_model=MailAccount, status_code=201)
async def add_account(body: NewMailAccount, request: Request) -> MailAccount:
    """Signs in once before anything is saved, so a wrong password never leaves an account."""
    service = _service(request)
    try:
        account = service.accounts.add(
            body.email, name=body.name, host=body.host, port=body.port, username=body.username
        )
    except ValueError as exc:
        raise HTTPException(400, str(exc).split("\n")[-1].strip()) from exc
    try:
        await asyncio.to_thread(imap.check, account, body.password, service.connect)
        await asyncio.to_thread(set_password, account.id, body.password)
    except imap.MailError as exc:
        service.accounts.remove(account.id)
        raise HTTPException(400, _refusal(account, exc)) from exc
    except Exception as exc:  # the keychain refused or did not answer
        service.accounts.remove(account.id)
        raise HTTPException(
            400, "The password could not be saved. Unlock your keychain and try again."
        ) from exc
    service.watch(account.id)
    return await _view(service, account)


@router.patch("/accounts/{account_id}", response_model=MailAccount)
async def patch_account(account_id: str, body: PatchMailAccount, request: Request) -> MailAccount:
    service = _service(request)
    account = _account(service, account_id)
    if body.password is not None and account.auth != "password":
        raise HTTPException(400, "This account signs in with Microsoft and has no password here.")
    if body.password is not None:
        try:
            await asyncio.to_thread(imap.check, account, body.password, service.connect)
        except imap.MailError as exc:
            raise HTTPException(400, _refusal(account, exc)) from exc
        await asyncio.to_thread(set_password, account.id, body.password)
        service.refresh(account.id)
    if body.name is not None:
        account = service.accounts.rename(account_id, body.name)
    if body.sender_name is not None or body.smtp_host is not None or body.smtp_port is not None:
        account = service.accounts.set_sending(
            account_id,
            sender_name=body.sender_name,
            smtp_host=body.smtp_host,
            smtp_port=body.smtp_port,
        )
    return await _view(service, account)


@router.delete("/accounts/{account_id}")
async def delete_account(account_id: str, request: Request) -> dict[str, Any]:
    """Removes the account, its password and its local copy. The mailbox itself is untouched."""
    service = _service(request)
    _account(service, account_id)
    service.accounts.remove(account_id)
    await service.forget(account_id)
    try:
        await asyncio.to_thread(delete_password, account_id)
    except Exception:  # a locked keychain keeps a stale entry; the account is gone all the same
        pass
    return {"ok": True}


@router.post("/accounts/{account_id}/sync")
async def sync_account(account_id: str, request: Request) -> dict[str, Any]:
    service = _service(request)
    _account(service, account_id)
    service.refresh(account_id)
    return {"ok": True}


@router.get("/accounts/{account_id}/folders", response_model=MailFolders)
async def list_folders(account_id: str, request: Request) -> MailFolders:
    service = _service(request)
    _account(service, account_id)
    folders = await asyncio.to_thread(service.box(account_id).folders)
    return MailFolders(folders=[MailFolder.model_validate(f) for f in folders])


@router.get("/accounts/{account_id}/threads", response_model=MailThreads)
async def list_threads(
    account_id: str,
    request: Request,
    folder: str = Query(default="", description="Folder name; empty means every folder."),
    q: str = Query(default="", max_length=200, description="Search the whole account."),
    before: str = Query(default="", description="Only conversations older than this date."),
    limit: int = Query(default=50, ge=1, le=200),
) -> MailThreads:
    service = _service(request)
    _account(service, account_id)
    found = await asyncio.to_thread(
        lambda: service.box(account_id).threads(
            folder=folder, query=q, before=before, limit=limit + 1
        )
    )
    return MailThreads(
        threads=[MailThreadSummary.model_validate(t) for t in found[:limit]],
        more=len(found) > limit,
    )


@router.get("/accounts/{account_id}/threads/{thread_id}", response_model=MailThread)
async def read_thread(account_id: str, thread_id: str, request: Request) -> MailThread:
    service = _service(request)
    _account(service, account_id)
    messages = await asyncio.to_thread(service.box(account_id).thread, thread_id)
    if not messages:
        raise HTTPException(404, "Conversation not found.")
    return MailThread(
        thread_id=thread_id,
        subject=messages[0]["subject"],
        messages=[MailMessage.model_validate(m) for m in messages],
    )


FILE_KEEP_SECONDS = 3600
PREVIEW_SUFFIXES = {".pdf", ".png", ".jpg", ".jpeg", ".webp", ".gif", ".tif", ".tiff"}
TEXT_SUFFIXES = {
    ".txt",
    ".md",
    ".markdown",
    ".csv",
    ".tsv",
    ".json",
    ".log",
    ".yml",
    ".yaml",
    ".xml",
    ".ics",
}


async def _file(request: Request, account_id: str, message_id: int, index: int) -> Path:
    """An attachment as a file. Attachments are not part of the local copy: the mail is
    fetched from the mail server when one is asked for, and the file is kept for an hour so
    that looking at it, page after page, and then saving it is one fetch."""
    service = _service(request)
    account = _account(service, account_id)
    folder = service.box(account_id).folder / "files"

    def kept() -> Path | None:
        now = time.time()
        found = None
        for path in folder.glob("*") if folder.is_dir() else []:
            if now - path.stat().st_mtime > FILE_KEEP_SECONDS:
                path.unlink(missing_ok=True)
            elif path.name.startswith(f"{message_id}-{index}-"):
                found = path
        return found

    existing = await asyncio.to_thread(kept)
    if existing is not None:
        return existing
    where = await asyncio.to_thread(service.box(account_id).location, message_id)
    if where is None:
        raise HTTPException(404, "Mail not found.")
    try:
        password = await asyncio.to_thread(oauth.secret, account)
        raw = await asyncio.to_thread(
            imap.fetch, account, password, where[0], where[1], service.connect
        )
    except imap.MailError as exc:
        raise HTTPException(502, _refusal(account, exc)) from exc
    found = await asyncio.to_thread(parse.attachment, raw, index)
    if found is None:
        raise HTTPException(404, "Attachment not found.")
    name, _, content = found
    safe = "".join(c if c.isalnum() or c in "._-" else "_" for c in name)[-120:] or "attachment"
    path = folder / f"{message_id}-{index}-{safe}"

    def write() -> None:
        folder.mkdir(parents=True, exist_ok=True)
        path.write_bytes(content)

    await asyncio.to_thread(write)
    return path


def _shown_name(path: Path) -> str:
    return path.name.split("-", 2)[-1]


class MailFileInfo(BaseModel):
    name: str
    kind: str = Field(description="pdf, image, text or other: whether it can be looked at here.")
    pages: int
    size: int


class SaveMailFile(BaseModel):
    page_id: str
    extract: bool = Field(
        default=False, description="Also read its text (OCR) into the page, next to the file."
    )


class SavedMailFile(BaseModel):
    file: str
    name: str
    page_path: str
    job_id: str | None = Field(description="The text extraction that was started, if asked.")


@router.get(
    "/accounts/{account_id}/messages/{message_id}/attachments/{index}",
    response_class=Response,
    responses={200: {"content": {"application/octet-stream": {}}}},
)
async def read_attachment(
    account_id: str, message_id: int, index: int, request: Request
) -> Response:
    """An attachment's content, to save or to hand to the chat."""
    path = await _file(request, account_id, message_id, index)
    content = await asyncio.to_thread(path.read_bytes)
    return Response(
        content,
        media_type="application/octet-stream",  # never rendered by the app as a page
        headers={
            "Content-Disposition": f'attachment; filename="{_shown_name(path)}"',
            "X-Content-Type-Options": "nosniff",
        },
    )


@router.get(
    "/accounts/{account_id}/messages/{message_id}/attachments/{index}/info",
    response_model=MailFileInfo,
)
async def attachment_info(
    account_id: str, message_id: int, index: int, request: Request
) -> MailFileInfo:
    from graite.media.decode import page_count

    path = await _file(request, account_id, message_id, index)
    suffix = path.suffix.lower()
    kind, pages = "other", 0
    if suffix in TEXT_SUFFIXES:
        kind = "text"  # read as it is: the app shows the words, nothing is run
    elif suffix in PREVIEW_SUFFIXES:
        try:
            pages = await asyncio.to_thread(page_count, path)
            kind = "pdf" if suffix == ".pdf" else "image"
        except ValueError, OSError:
            pass  # damaged or not what its name says: offered as a download only
    return MailFileInfo(name=_shown_name(path), kind=kind, pages=pages, size=path.stat().st_size)


@router.get(
    "/accounts/{account_id}/messages/{message_id}/attachments/{index}/preview",
    response_class=Response,
    responses={200: {"content": {"image/png": {}}}},
)
async def attachment_preview(
    account_id: str, message_id: int, index: int, request: Request, page: int = 0
) -> Response:
    """One page of a PDF, or a picture, drawn by the daemon as a PNG: the app shows a plain
    image and never opens the file itself."""
    from graite.media.decode import page_count, render_page

    path = await _file(request, account_id, message_id, index)
    if path.suffix.lower() not in PREVIEW_SUFFIXES:
        raise HTTPException(400, "This attachment has no preview.")
    try:
        if not 0 <= page < await asyncio.to_thread(page_count, path):
            raise ValueError("That page does not exist.")
        data = await asyncio.to_thread(render_page, path, page)
    except (ValueError, OSError) as exc:
        raise HTTPException(400, str(exc)) from exc
    return Response(data, media_type="image/png", headers={"Cache-Control": "no-store"})


@router.post(
    "/accounts/{account_id}/messages/{message_id}/attachments/{index}/save",
    response_model=SavedMailFile,
)
async def save_attachment(
    account_id: str, message_id: int, index: int, body: SaveMailFile, request: Request
) -> SavedMailFile:
    """Put an attachment on a page: the file becomes the page's own and shows at its end.
    With `extract`, its text is read into the page as well (a PDF's text, or OCR)."""
    from graite.api.media import ExtractRequest, _queue_extraction
    from graite.media.decode import AUDIO, IMAGES

    path = await _file(request, account_id, message_id, index)
    name, suffix = _shown_name(path), path.suffix.lower()
    if suffix not in AUDIO and suffix not in IMAGES and suffix != ".pdf":
        raise HTTPException(400, "Pages take PDFs, pictures and audio. Download this file instead.")
    kind = "audio" if suffix in AUDIO else "pdf" if suffix == ".pdf" else "image"
    ops = request.app.state.fileops
    try:
        content = await asyncio.to_thread(path.read_bytes)
        file = await ops.add_attachment(body.page_id, name, content)
        await ops.attach_file(body.page_id, file, name, kind)
        page_path = ops.page_by_id(body.page_id)
    except (ValueError, FileNotFoundError, KeyError) as exc:
        raise HTTPException(400, "That page could not take the file.") from exc
    job_id = None
    if body.extract:
        job_id = _queue_extraction(
            request.app.state, ExtractRequest(page_id=body.page_id, file=file, name=name)
        ).id
    return SavedMailFile(file=file, name=name, page_path=page_path, job_id=job_id)


# ----------------------------------------------------------------- writing and sending


class NewMailDraft(BaseModel):
    reply_to: int | None = Field(
        default=None,
        description="Id of the mail this answers: recipients, subject and the "
        "quoted text are filled in.",
    )
    reply_all: bool = False
    to: str = Field(default="", max_length=4000)
    cc: str = Field(default="", max_length=4000)
    bcc: str = Field(default="", max_length=4000)
    subject: str = Field(default="", max_length=998)
    body: str = Field(default="", max_length=400_000)
    html: str = Field(
        default="",
        max_length=800_000,
        description="The message with formatting (bold, italic, lists, links). Anything "
        "else is taken out. Given instead of `body`.",
    )


class PatchMailDraft(BaseModel):
    to: str | None = Field(default=None, max_length=4000)
    cc: str | None = Field(default=None, max_length=4000)
    bcc: str | None = Field(default=None, max_length=4000)
    subject: str | None = Field(default=None, max_length=998)
    body: str | None = Field(default=None, max_length=400_000)
    html: str | None = Field(default=None, max_length=800_000)


def _written(body: str | None, html: str | None) -> dict[str, str]:
    """A message as both its formatted and its plain form, from whichever was given."""
    if html is not None and html.strip():
        clean = richtext.clean(html)
        return {"html": clean, "body": richtext.to_text(clean)}
    if body is not None:
        return {"html": richtext.from_text(body), "body": body}
    return {}


class MailDrafts(BaseModel):
    drafts: list[Draft]


class MailSent(BaseModel):
    ok: bool
    saved_copy: bool = Field(description="A copy is in the mailbox's Sent folder.")


def _person(name: str, email: str) -> str:
    return f"{name} <{email}>" if name else email


def _reply(account: Account, mail: dict[str, Any], reply_all: bool) -> dict[str, Any]:
    own = account.email.lower()
    subject = str(mail["subject"])
    if parse.plain_subject(subject) == subject.strip().lower():
        subject = "Re: " + subject
    others = [p for p in [*mail["recipients"], *mail["cc"]] if p["email"].lower() != own]
    others = [p for p in others if p["email"].lower() != mail["sender_email"].lower()]
    sender = _person(mail["sender_name"], mail["sender_email"])
    return {
        "to": sender,
        "cc": ", ".join(_person(p["name"], p["email"]) for p in others) if reply_all else "",
        "subject": subject,
        "quote": richtext.quoted(
            sender, str(mail["date"])[:16].replace("T", " "), mail["body_text"]
        ),
        "in_reply_to": mail["message_id"],
        "references": mail["references"],
        "thread_id": mail["thread_id"],
    }


@router.get("/accounts/{account_id}/drafts", response_model=MailDrafts)
async def list_drafts(account_id: str, request: Request) -> MailDrafts:
    service = _service(request)
    _account(service, account_id)
    return MailDrafts(drafts=await asyncio.to_thread(service.drafts.list, account_id))


@router.post("/accounts/{account_id}/drafts", response_model=Draft, status_code=201)
async def create_draft(account_id: str, body: NewMailDraft, request: Request) -> Draft:
    """A new mail, or with `reply_to` a reply. Writing a draft never sends anything."""
    service = _service(request)
    account = _account(service, account_id)
    fields: dict[str, Any] = body.model_dump(exclude={"reply_to", "reply_all", "body", "html"})
    written = _written(body.body or None, body.html or None)
    if body.reply_to is not None:
        mail = await asyncio.to_thread(service.box(account_id).message, body.reply_to)
        if mail is None:
            raise HTTPException(404, "Mail not found.")
        filled = _reply(account, mail, body.reply_all)
        quote = filled.pop("quote")
        # What the caller gave wins over what the reply fills in (a text written by AI).
        fields = {**filled, **{k: v for k, v in fields.items() if v}}
        # The reply above, the mail it answers quoted under it.
        html = written.get("html", "") + quote
        written = {"html": html, "body": richtext.to_text(html)}
    fields.update(written)
    return await asyncio.to_thread(lambda: service.drafts.create(account_id, **fields))


@router.put("/accounts/{account_id}/drafts/{draft_id}", response_model=Draft)
async def update_draft(
    account_id: str, draft_id: str, body: PatchMailDraft, request: Request
) -> Draft:
    service = _service(request)
    _account(service, account_id)
    changes = body.model_dump(exclude_none=True, exclude={"body", "html"})
    changes.update(_written(body.body, body.html))
    draft = await asyncio.to_thread(lambda: service.drafts.update(account_id, draft_id, **changes))
    if draft is None:
        raise HTTPException(404, "Draft not found.")
    return draft


DRAFT_FILE_BYTES = 20 * 1024 * 1024
DRAFT_FILES_BYTES = 25 * 1024 * 1024  # what most mail providers accept for one mail


@router.post("/accounts/{account_id}/drafts/{draft_id}/attachments", response_model=Draft)
async def attach_to_draft(
    account_id: str, draft_id: str, request: Request, name: str = Query(max_length=200)
) -> Draft:
    """Add a file to a draft. It is kept with the draft until the mail is sent or discarded."""
    import mimetypes

    service = _service(request)
    _account(service, account_id)
    draft = await asyncio.to_thread(service.drafts.get, account_id, draft_id)
    if draft is None:
        raise HTTPException(404, "Draft not found.")
    data = bytearray()
    async for chunk in request.stream():
        data.extend(chunk)
        if len(data) > DRAFT_FILE_BYTES:
            raise HTTPException(413, "A file can be up to 20 MB.")
    if not data:
        raise HTTPException(400, "This file is empty.")
    if sum(f.size for f in draft.attachments) + len(data) > DRAFT_FILES_BYTES:
        raise HTTPException(413, "The files of one mail can be 25 MB together.")
    kind = mimetypes.guess_type(name)[0] or "application/octet-stream"
    changed = await asyncio.to_thread(
        service.drafts.add_file, account_id, draft_id, name, kind, bytes(data)
    )
    if changed is None:
        raise HTTPException(404, "Draft not found.")
    return changed


@router.delete(
    "/accounts/{account_id}/drafts/{draft_id}/attachments/{file_id}", response_model=Draft
)
async def detach_from_draft(
    account_id: str, draft_id: str, file_id: str, request: Request
) -> Draft:
    service = _service(request)
    _account(service, account_id)
    changed = await asyncio.to_thread(service.drafts.remove_file, account_id, draft_id, file_id)
    if changed is None:
        raise HTTPException(404, "Attachment not found.")
    return changed


@router.delete("/accounts/{account_id}/drafts/{draft_id}")
async def delete_draft(account_id: str, draft_id: str, request: Request) -> dict[str, Any]:
    service = _service(request)
    _account(service, account_id)
    if not await asyncio.to_thread(service.drafts.remove, account_id, draft_id):
        raise HTTPException(404, "Draft not found.")
    return {"ok": True}


@router.post("/accounts/{account_id}/drafts/{draft_id}/send", response_model=MailSent)
async def send_draft(account_id: str, draft_id: str, request: Request) -> MailSent:
    """Send a draft. The only way mail leaves Graite: the user pressing Send on a draft
    they can read in full. If sending fails, the draft is kept."""
    service = _service(request)
    account = _account(service, account_id)
    draft = await asyncio.to_thread(service.drafts.get, account_id, draft_id)
    if draft is None:
        raise HTTPException(404, "Draft not found.")
    try:
        files = await asyncio.to_thread(
            lambda: [
                (f.name, f.type, service.drafts.file_path(draft_id, f).read_bytes())
                for f in draft.attachments
            ]
        )
        message = send.build(account, draft, files)
        password = await asyncio.to_thread(oauth.secret, account)
        await asyncio.to_thread(send.deliver, account, password, message, service.smtp)
    except OSError as exc:
        raise HTTPException(400, "A file of this draft is missing. Add it again.") from exc
    except imap.MailError as exc:
        raise HTTPException(400 if not exc.auth else 401, _refusal(account, exc)) from exc
    await asyncio.to_thread(service.drafts.remove, account_id, draft_id)
    saved = account.host in send.SAVES_SENT_ITSELF
    if not saved:
        folder = await asyncio.to_thread(service.box(account_id).sent_folder)
        if folder is not None:
            try:
                await asyncio.to_thread(
                    imap.append, account, password, folder, message.as_bytes(), service.connect
                )
                saved = True
            except imap.MailError:
                saved = False  # the mail is sent; only its copy in Sent is missing
    service.refresh(account_id)
    return MailSent(ok=True, saved_copy=saved)


# ----------------------------------------------------------------- archive and delete


class MailMoved(BaseModel):
    ok: bool
    moved: int


class MoveMail(BaseModel):
    threads: list[str] = Field(min_length=1, max_length=500, description="Conversation ids.")
    to: Literal["archive", "trash"]


async def _move(request: Request, account_id: str, threads: list[str], role: str) -> MailMoved:
    service = _service(request)
    account = _account(service, account_id)
    box = service.box(account_id)
    # Archiving takes a conversation out of the inbox; deleting takes all of it.
    places: dict[str, list[int]] = {}
    for thread_id in dict.fromkeys(threads):
        found = await asyncio.to_thread(box.places, thread_id, "inbox" if role == "archive" else "")
        for folder, uids in found.items():
            places.setdefault(folder, []).extend(uids)
    if not places:
        raise HTTPException(
            404, "Nothing to archive here." if role == "archive" else "Conversation not found."
        )
    try:
        password = await asyncio.to_thread(oauth.secret, account)
        moved = await asyncio.to_thread(imap.move, account, password, places, role, service.connect)
    except imap.MailError as exc:
        raise HTTPException(400, _refusal(account, exc)) from exc
    for folder, uids in places.items():
        await asyncio.to_thread(box.drop, folder, set(uids))
    service.refresh(account_id)
    return MailMoved(ok=True, moved=moved)


@router.post("/accounts/{account_id}/move", response_model=MailMoved)
async def move_threads(account_id: str, body: MoveMail, request: Request) -> MailMoved:
    """Archive or delete several conversations at once, over one connection."""
    return await _move(request, account_id, body.threads, body.to)


@router.post("/accounts/{account_id}/threads/{thread_id}/archive", response_model=MailMoved)
async def archive_thread(account_id: str, thread_id: str, request: Request) -> MailMoved:
    """Take a conversation out of the inbox, into the mailbox's Archive (Gmail: All Mail)."""
    return await _move(request, account_id, [thread_id], "archive")


@router.post("/accounts/{account_id}/threads/{thread_id}/trash", response_model=MailMoved)
async def trash_thread(account_id: str, thread_id: str, request: Request) -> MailMoved:
    """Move a conversation to the mailbox's Trash. The provider erases it later, not Graite."""
    return await _move(request, account_id, [thread_id], "trash")


@router.post("/accounts/{account_id}/threads/{thread_id}/read", response_model=MailMoved)
async def read_thread_mark(account_id: str, thread_id: str, request: Request) -> MailMoved:
    """Mark a conversation as read, here at once and in the mailbox in the background, so
    opening a mail never waits for the mail server."""
    service = _service(request)
    account = _account(service, account_id)
    box = service.box(account_id)
    places = await asyncio.to_thread(box.unseen, thread_id)
    count = sum(len(uids) for uids in places.values())
    if not count:
        return MailMoved(ok=True, moved=0)
    await asyncio.to_thread(box.mark_seen, places)

    async def on_server() -> None:
        try:
            password = await asyncio.to_thread(oauth.secret, account)
            await asyncio.to_thread(imap.mark_seen, account, password, places, service.connect)
            # A sync that ran meanwhile read the mailbox before it knew: say it again here.
            await asyncio.to_thread(box.mark_seen, places)
            service.events.publish("mail_changed", {"account_id": account_id, "state": "ok"})
        except Exception:  # the next sync shows what the mailbox says
            service.refresh(account_id)

    task = asyncio.create_task(on_server())
    request.app.state.background_tasks.add(task)
    task.add_done_callback(request.app.state.background_tasks.discard)
    return MailMoved(ok=True, moved=count)


# ----------------------------------------------------------------- pictures from the web

IMAGE_BYTES = 8 * 1024 * 1024
IMAGE_TYPES = {"image/png", "image/jpeg", "image/gif", "image/webp", "image/avif", "image/bmp"}


def _public(host: str) -> bool:
    """Whether a host name leads only to addresses on the open internet. A mail must not be
    able to make Graite fetch from this computer or the local network."""
    import ipaddress
    import socket

    try:
        infos = socket.getaddrinfo(host, None)
    except OSError:
        return False
    for info in infos:
        address = ipaddress.ip_address(info[4][0])
        if not address.is_global:
            return False
    return bool(infos)


@router.get(
    "/image",
    response_class=Response,
    responses={200: {"content": {"image/*": {}}}},
)
async def remote_image(
    url: str = Query(max_length=4000, description="The picture a mail links to."),
) -> Response:
    """Fetch a picture a mail links to, when the user asked to see a mail's pictures.
    Fetching tells the sender's server that the mail was opened, as in any mail app."""
    import httpx

    current = url
    async with httpx.AsyncClient(timeout=10, follow_redirects=False) as client:
        for _ in range(4):
            parts = httpx.URL(current)
            if parts.scheme not in ("http", "https") or not parts.host:
                raise HTTPException(400, "Not a web address.")
            if not await asyncio.to_thread(_public, parts.host):
                raise HTTPException(400, "This address is not on the open internet.")
            try:
                response = await client.get(current, headers={"User-Agent": "Mozilla/5.0"})
            except httpx.HTTPError as exc:
                raise HTTPException(502, "The picture could not be fetched.") from exc
            if response.is_redirect and response.headers.get("location"):
                current = str(parts.join(response.headers["location"]))
                continue
            kind = response.headers.get("content-type", "").split(";")[0].strip().lower()
            if response.status_code != 200 or kind not in IMAGE_TYPES:
                raise HTTPException(502, "That address did not give a picture.")
            if len(response.content) > IMAGE_BYTES:
                raise HTTPException(502, "The picture is too large.")
            return Response(
                response.content,
                media_type=kind,
                headers={
                    "X-Content-Type-Options": "nosniff",
                    "Cache-Control": "private, max-age=3600",
                },
            )
    raise HTTPException(502, "The picture could not be fetched.")


# ----------------------------------------------------------------- sign in with Microsoft


class StartSignIn(BaseModel):
    account_id: str | None = Field(
        default=None, description="An account whose sign-in ran out, to sign in again."
    )


class SignInStarted(BaseModel):
    id: str
    url: str = Field(description="Microsoft's sign-in page; also shown, in case no browser opened.")
    opened: bool


class SignInState(BaseModel):
    status: str = Field(description="waiting, done or error")
    error: str
    account_id: str | None


def _sign_ins(request: Request) -> oauth.SignIns:
    found: oauth.SignIns | None = getattr(request.app.state, "mail_sign_ins", None)
    if found is None:
        raise HTTPException(503, "Mail is not available in this daemon.")
    return found


@router.post("/oauth/microsoft", response_model=SignInStarted)
async def start_microsoft(body: StartSignIn, request: Request) -> SignInStarted:
    """Open Microsoft's sign-in page in the browser. The password is typed there, never in
    Graite; what comes back is a token for that mailbox, kept in the OS keychain."""
    import webbrowser

    if body.account_id is not None:
        _account(_service(request), body.account_id)
    try:
        sign_in = await _sign_ins(request).start(body.account_id)
    except imap.MailError as exc:
        raise HTTPException(400, str(exc)) from exc
    try:
        opened = await asyncio.to_thread(webbrowser.open, sign_in.url)
    except Exception:  # the UI shows the link instead
        opened = False
    return SignInStarted(id=sign_in.id, url=sign_in.url, opened=bool(opened))


@router.get("/oauth/{sign_in_id}", response_model=SignInState)
async def sign_in_state(sign_in_id: str, request: Request) -> SignInState:
    sign_in = _sign_ins(request).get(sign_in_id)
    if sign_in is None:
        raise HTTPException(404, "That sign-in is over. Start it again.")
    return SignInState(status=sign_in.status, error=sign_in.error, account_id=sign_in.account_id)
