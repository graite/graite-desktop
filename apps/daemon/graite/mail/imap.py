"""Read one account over IMAP into its local copy. Blocking: the service runs it in a thread.

Read-only by construction: folders are opened with EXAMINE and bodies are fetched with
BODY.PEEK, so nothing is marked read, moved or deleted on the server.
"""

from __future__ import annotations

import base64
import imaplib
import logging
import re
import ssl
import time
from collections.abc import Callable, Iterable, Iterator
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any

from graite.mail.accounts import IMAPS_PORT, Account
from graite.mail.parse import parse
from graite.mail.store import MailBox

log = logging.getLogger("graite.mail")

SYNC_DAYS = 90
TIMEOUT_SECONDS = 30
BODY_BATCH = 25
FLAG_BATCH = 500
# A mail larger than this (attachments) is kept as its headers only; the reader says so.
FULL_BYTES = 5 * 1024 * 1024
MONTHS = ("Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec")
LOCAL_HOSTS = {"127.0.0.1", "localhost", "::1"}
# Folders that repeat mail kept elsewhere or that nobody wants in a reader's first version.
SKIPPED_ROLES = {"all", "junk", "trash", "drafts", "flagged", "important"}
ROLE_FLAGS = {
    "\\sent": "sent",
    "\\drafts": "drafts",
    "\\trash": "trash",
    "\\junk": "junk",
    "\\all": "all",
    "\\archive": "archive",
    "\\flagged": "flagged",
    "\\important": "important",
}

_LIST = re.compile(rb'\((?P<flags>[^)]*)\)\s+(?:"[^"]*"|NIL)\s+(?P<name>.*)$', re.DOTALL)
_UID = re.compile(rb"\bUID (\d+)")
_SIZE = re.compile(rb"\bRFC822\.SIZE (\d+)")
_FLAGS = re.compile(rb"\bFLAGS \(([^)]*)\)")
_DATE = re.compile(rb'INTERNALDATE "[^"]+"')
_UTF7 = re.compile(r"&([^-]*)-")

Connect = Callable[[Account], Any]


class MailError(Exception):
    """A failure the user can act on. `auth`: the server refused the sign-in."""

    def __init__(self, message: str, *, auth: bool = False) -> None:
        super().__init__(message)
        self.auth = auth


@dataclass
class Folder:
    name: str  # as the server spells it, for commands
    title: str  # readable
    role: str  # "inbox", "sent", "archive", ... or ""


@dataclass
class SyncResult:
    new: int = 0
    removed: int = 0
    changed: int = 0

    @property
    def any(self) -> bool:
        return bool(self.new or self.removed or self.changed)


def decode_folder(name: str) -> str:
    """Folder names travel in IMAP's modified UTF-7 ("Verz&AOk-nden")."""

    def part(match: re.Match[str]) -> str:
        chunk = match.group(1)
        if not chunk:
            return "&"
        chunk = chunk.replace(",", "/")
        try:
            return base64.b64decode(chunk + "=" * (-len(chunk) % 4)).decode("utf-16-be")
        except ValueError:
            return match.group(0)

    return _UTF7.sub(part, name)


def _quote(name: str) -> str:
    return '"' + name.replace("\\", "\\\\").replace('"', '\\"') + '"'


def _unquote(raw: bytes) -> str:
    text = raw.decode("utf-8", "replace").strip()
    if len(text) >= 2 and text[0] == '"' and text[-1] == '"':
        text = text[1:-1].replace('\\"', '"').replace("\\\\", "\\")
    return text


def parse_folders(lines: Iterable[Any]) -> list[Folder]:
    found = []
    for line in lines:
        literal = None
        if isinstance(line, tuple):  # the name came as a literal: (prefix, name)
            line, literal = line[0], line[1]
        if not isinstance(line, bytes):
            continue
        match = _LIST.match(line)
        if match is None:
            continue
        flags = {f.lower() for f in match.group("flags").decode("ascii", "replace").split()}
        if "\\noselect" in flags or "\\nonexistent" in flags:
            continue
        name = literal.decode("utf-8", "replace") if literal else _unquote(match.group("name"))
        role = next((ROLE_FLAGS[f] for f in flags if f in ROLE_FLAGS), "")
        if name.upper() == "INBOX":
            role = "inbox"
        title = "Inbox" if role == "inbox" else decode_folder(name).rsplit("/", 1)[-1]
        found.append(Folder(name, title, role))
    return found


def open_connection(account: Account) -> Any:
    # A mail bridge on this machine (Proton) signs its own certificate.
    context = ssl.create_default_context()
    if account.host in LOCAL_HOSTS:
        context.check_hostname = False
        context.verify_mode = ssl.CERT_NONE
    if account.port == IMAPS_PORT:
        return imaplib.IMAP4_SSL(
            account.host, account.port, ssl_context=context, timeout=TIMEOUT_SECONDS
        )
    connection = imaplib.IMAP4(account.host, account.port, timeout=TIMEOUT_SECONDS)
    connection.starttls(context)
    return connection


def _login(account: Account, password: str, connect: Connect) -> Any:
    if not password:
        raise MailError("The password of this account is missing. Enter it again.", auth=True)
    try:
        connection = connect(account)
    except (OSError, imaplib.IMAP4.error) as exc:
        raise MailError(f"Could not reach the mail server {account.host}.") from exc
    try:
        if account.auth == "microsoft":
            # `password` is a token here (`mail/oauth.py`), handed over the XOAUTH2 way.
            connection.authenticate("XOAUTH2", lambda _: xoauth2(account.username, password))
        else:
            connection.login(account.username, password)
    except imaplib.IMAP4.error as exc:
        _close(connection)
        raise MailError(
            "Microsoft refused the sign-in for this mailbox. Sign in with Microsoft again."
            if account.auth == "microsoft"
            else "The mail server refused the sign-in. Check the address and the password.",
            auth=True,
        ) from exc
    except OSError as exc:
        _close(connection)
        raise MailError(f"Could not reach the mail server {account.host}.") from exc
    return connection


def xoauth2(user: str, token: str) -> bytes:
    return f"user={user}\x01auth=Bearer {token}\x01\x01".encode()


def _close(connection: Any) -> None:
    try:
        connection.logout()
    except Exception:  # already gone
        pass


def check(account: Account, password: str, connect: Connect = open_connection) -> None:
    """Sign in once and leave: raises `MailError` when the account cannot be used."""
    _close(_login(account, password, connect))


def _ok(response: tuple[str, list[Any]], what: str) -> list[Any]:
    status, data = response
    if status != "OK":
        raise MailError(f"The mail server could not {what}.")
    return data


def _batches(uids: list[int], size: int) -> Iterator[list[int]]:
    for start in range(0, len(uids), size):
        yield uids[start : start + size]


def _since(days: int) -> str:
    day = datetime.now(UTC) - timedelta(days=days)
    return f"{day.day:02d}-{MONTHS[day.month - 1]}-{day.year}"


def _received(line: bytes) -> datetime:
    match = _DATE.search(line)
    parsed = imaplib.Internaldate2tuple(match.group(0)) if match else None
    if parsed is None:
        return datetime.now(UTC)
    return datetime.fromtimestamp(time.mktime(parsed), UTC)


def _flags(line: bytes) -> tuple[bool, bool]:
    match = _FLAGS.search(line)
    flags = match.group(1).lower().split() if match else []
    return b"\\seen" in flags, b"\\flagged" in flags


def _bodies(data: list[Any]) -> Iterator[tuple[int, bytes]]:
    """`(uid, raw)` from a FETCH answer. The uid may come before or after the body."""
    for index, item in enumerate(data):
        if not isinstance(item, tuple) or len(item) < 2:
            continue
        match = _UID.search(item[0])
        if match is None and index + 1 < len(data) and isinstance(data[index + 1], bytes):
            match = _UID.search(data[index + 1])
        if match is not None and isinstance(item[1], bytes):
            yield int(match.group(1)), item[1]


def _sync_folder(connection: Any, box: MailBox, folder: Folder, days: int) -> SyncResult:
    result = SyncResult()
    _ok(connection.select(_quote(folder.name), readonly=True), f"open {folder.title}")
    validity = connection.response("UIDVALIDITY")[1]
    kept = box.open_folder(folder.name, int(validity[0]) if validity and validity[0] else 0)
    found = _ok(connection.uid("SEARCH", None, "SINCE", _since(days)), "list the mail")
    on_server = {int(u) for u in (found[0] or b"").split()} if found else set()

    gone = kept - on_server
    if gone:
        box.drop(folder.name, gone)
        result.removed = len(gone)

    meta: dict[int, bytes] = {}
    for batch in _batches(sorted(on_server), FLAG_BATCH):
        uid_set = ",".join(map(str, batch))
        for line in _ok(
            connection.uid("FETCH", uid_set, "(UID FLAGS RFC822.SIZE INTERNALDATE)"),
            "read the mail",
        ):
            match = _UID.search(line) if isinstance(line, bytes) else None
            if match is not None:
                meta[int(match.group(1))] = line
    result.changed = box.set_flags(
        folder.name, {uid: _flags(line) for uid, line in meta.items() if uid in kept}
    )

    # Newest first, so the top of the inbox is there while older mail is still coming in.
    fresh = sorted(on_server - kept, reverse=True)
    small: list[int] = []
    large: list[int] = []
    for uid in fresh:
        size = _SIZE.search(meta.get(uid, b""))
        (large if size and int(size.group(1)) > FULL_BYTES else small).append(uid)
    for uids, part, partial in ((small, "BODY.PEEK[]", False), (large, "BODY.PEEK[HEADER]", True)):
        for batch in _batches(uids, BODY_BATCH):
            data = _ok(
                connection.uid("FETCH", ",".join(map(str, batch)), f"(UID {part})"),
                "read the mail",
            )
            for uid, raw in _bodies(data):
                line = meta.get(uid, b"")
                size = _SIZE.search(line)
                seen, flagged = _flags(line)
                try:
                    parsed = parse(raw)
                except Exception:  # one unreadable mail must not stop the folder
                    log.warning("skipped a mail that could not be read (uid %d)", uid)
                    continue
                box.add(
                    folder.name,
                    uid,
                    parsed,
                    seen=seen,
                    flagged=flagged,
                    size=int(size.group(1)) if size else len(raw),
                    received=_received(line),
                    partial=partial,
                )
                result.new += 1
    box.close_folder(folder.name)
    return result


def fetch(
    account: Account,
    password: str,
    folder: str,
    uid: int,
    connect: Connect = open_connection,
) -> bytes:
    """One whole mail, fetched when asked for (an attachment is opened). Read-only."""
    connection = _login(account, password, connect)
    try:
        _ok(connection.select(_quote(folder), readonly=True), "open the folder")
        data = _ok(connection.uid("FETCH", str(uid), "(UID BODY.PEEK[])"), "read the mail")
        for _, raw in _bodies(data):
            return raw
        raise MailError("This mail is no longer in the mailbox.")
    except (OSError, imaplib.IMAP4.error) as exc:
        raise MailError("The connection to the mail server was lost.") from exc
    finally:
        _close(connection)


def mark_seen(
    account: Account,
    password: str,
    places: dict[str, list[int]],
    connect: Connect = open_connection,
) -> None:
    """Mark mails as read in the mailbox, so every mail app agrees on what is read."""
    connection = _login(account, password, connect)
    try:
        for folder, uids in places.items():
            if not uids:
                continue
            _ok(connection.select(_quote(folder)), "open the folder")
            for batch in _batches(sorted(uids), FLAG_BATCH):
                _ok(
                    connection.uid("STORE", ",".join(map(str, batch)), "+FLAGS.SILENT", "(\\Seen)"),
                    "mark the mail as read",
                )
    except (OSError, imaplib.IMAP4.error) as exc:
        raise MailError("The connection to the mail server was lost.") from exc
    finally:
        _close(connection)


def move(
    account: Account,
    password: str,
    places: dict[str, list[int]],
    role: str,
    connect: Connect = open_connection,
) -> int:
    """Move mails to the mailbox's own Trash or Archive folder (`role`); returns how many.

    Nothing is erased: a mail in Trash can be put back from any mail app until the provider
    empties it. Raises `MailError` when the mailbox has no such folder."""
    connection = _login(account, password, connect)
    moved = 0
    try:
        folders = parse_folders(_ok(connection.list(), "list the folders"))
        # Gmail has no Archive folder: archiving is taking a mail out of the inbox, which
        # moving it to "All Mail" does.
        wanted = [role, "all"] if role == "archive" else [role]
        target = next((f for r in wanted for f in folders if f.role == r), None)
        if target is None:
            name = "Archive" if role == "archive" else "Trash"
            raise MailError(f"This mailbox has no {name} folder.")
        capabilities = {str(c).upper() for c in getattr(connection, "capabilities", ())}
        for folder, uids in places.items():
            if folder == target.name or not uids:
                continue
            _ok(connection.select(_quote(folder)), "open the folder")
            for batch in _batches(sorted(uids), FLAG_BATCH):
                uid_set = ",".join(map(str, batch))
                if "MOVE" in capabilities:
                    _ok(connection.uid("MOVE", uid_set, _quote(target.name)), "move the mail")
                else:
                    _ok(connection.uid("COPY", uid_set, _quote(target.name)), "move the mail")
                    _ok(
                        connection.uid("STORE", uid_set, "+FLAGS.SILENT", "(\\Deleted)"),
                        "move the mail",
                    )
                    if "UIDPLUS" in capabilities:
                        connection.uid("EXPUNGE", uid_set)
                    else:
                        connection.expunge()
                moved += len(batch)
    except (OSError, imaplib.IMAP4.error) as exc:
        raise MailError("The connection to the mail server was lost.") from exc
    finally:
        _close(connection)
    return moved


def append(
    account: Account,
    password: str,
    folder: str,
    raw: bytes,
    connect: Connect = open_connection,
) -> None:
    """Put a copy of a sent mail in a folder, marked read. The one thing Graite adds to a
    mailbox: only ever a mail the user just sent."""
    connection = _login(account, password, connect)
    try:
        _ok(
            connection.append(
                _quote(folder), "(\\Seen)", imaplib.Time2Internaldate(time.time()), raw
            ),
            "save the sent mail",
        )
    except (OSError, imaplib.IMAP4.error) as exc:
        raise MailError("The connection to the mail server was lost.") from exc
    finally:
        _close(connection)


def sync(
    account: Account,
    password: str,
    box: MailBox,
    *,
    days: int = SYNC_DAYS,
    connect: Connect = open_connection,
    on_folder: Callable[[SyncResult], None] | None = None,
) -> SyncResult:
    """Bring the local copy in line with the server for the last `days` days."""
    total = SyncResult()
    connection = _login(account, password, connect)
    try:
        folders = [
            f
            for f in parse_folders(_ok(connection.list(), "list the folders"))
            if f.role not in SKIPPED_ROLES
        ]
        folders.sort(key=lambda f: (f.role != "inbox", f.role != "sent"))
        box.set_folders([(f.name, f.title, f.role) for f in folders])
        for folder in folders:
            try:
                result = _sync_folder(connection, box, folder, days)
            except MailError:
                log.warning("skipped a mail folder that could not be read")
                continue
            total.new += result.new
            total.removed += result.removed
            total.changed += result.changed
            if on_folder is not None and result.any:
                on_folder(result)
    except (OSError, imaplib.IMAP4.error) as exc:
        raise MailError("The connection to the mail server was lost.") from exc
    finally:
        _close(connection)
    return total
