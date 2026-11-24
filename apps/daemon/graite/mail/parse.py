"""Turn one raw message into the fields the local copy keeps.

Every message is untrusted input: nothing here follows a link, loads a remote image or runs
anything. The HTML body is kept as sent; the reader shows it in a sandbox (the desktop app).
"""

from __future__ import annotations

import base64
import hashlib
import re
from dataclasses import dataclass, field
from datetime import UTC, datetime
from email import message_from_bytes, policy
from email.message import EmailMessage
from email.utils import getaddresses, parsedate_to_datetime
from html.parser import HTMLParser

SNIPPET_CHARS = 200
BODY_CHARS = 400_000
# Pictures shown inside a mail's text are kept with it, up to this much per mail.
INLINE_BYTES = 1_500_000
SAFE_IMAGES = {
    "image/png",
    "image/jpeg",
    "image/gif",
    "image/webp",
}  # a mail longer than this is cut in the copy, not in the mailbox
_SPACE = re.compile(r"\s+")
_ID = re.compile(r"<[^<>\s]+>")
_REPLY_PREFIX = re.compile(r"^\s*((re|fw|fwd|aw|antw|sv|tr)\s*:\s*)+", re.IGNORECASE)


@dataclass
class Person:
    name: str
    email: str

    def as_dict(self) -> dict[str, str]:
        return {"name": self.name, "email": self.email}


@dataclass
class Attachment:
    name: str
    type: str
    size: int

    def as_dict(self) -> dict[str, str | int]:
        return {"name": self.name, "type": self.type, "size": self.size}


@dataclass
class Parsed:
    message_id: str
    thread_key: str
    references: list[str]
    subject: str
    sender: Person
    to: list[Person]
    cc: list[Person]
    date: datetime | None
    text: str
    html: str
    snippet: str
    attachments: list[Attachment] = field(default_factory=list)


class _Text(HTMLParser):
    """The readable text of an HTML mail, for search and the preview line."""

    SKIP = {"style", "script", "head", "title"}
    BREAK = {"p", "div", "br", "tr", "li", "h1", "h2", "h3", "h4", "table", "blockquote"}

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.parts: list[str] = []
        self._skip = 0

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag in self.SKIP:
            self._skip += 1
        elif tag in self.BREAK:
            self.parts.append("\n")

    def handle_endtag(self, tag: str) -> None:
        if tag in self.SKIP and self._skip:
            self._skip -= 1
        elif tag in self.BREAK:
            self.parts.append("\n")

    def handle_data(self, data: str) -> None:
        if not self._skip:
            self.parts.append(data)


def html_to_text(html: str) -> str:
    parser = _Text()
    try:
        parser.feed(html)
        parser.close()
    except Exception:  # broken markup: keep what was read so far
        pass
    lines = (_SPACE.sub(" ", line).strip() for line in "".join(parser.parts).splitlines())
    return "\n".join(line for line in lines if line)


def _people(message: EmailMessage, header: str) -> list[Person]:
    values = [str(v) for v in message.get_all(header, [])]
    found = []
    for name, email in getaddresses(values):
        if email or name:
            found.append(Person(_SPACE.sub(" ", name).strip(), email.strip().lower()))
    return found


def _header(message: EmailMessage, name: str) -> str:
    try:
        return _SPACE.sub(" ", str(message.get(name, ""))).strip()
    except Exception:  # a header the parser cannot decode
        return ""


def _content(part: EmailMessage) -> str:
    try:
        content = part.get_content()
    except Exception:  # unknown charset or broken encoding
        payload = part.get_payload(decode=True)
        content = payload.decode("utf-8", "replace") if isinstance(payload, bytes) else ""
    return content if isinstance(content, str) else ""


def _is_attachment(part: EmailMessage) -> bool:
    filename = part.get_filename()
    return part.get_content_disposition() == "attachment" or bool(
        filename and not part.get_content_type().startswith("text/")
    )


def _bytes(part: EmailMessage) -> bytes:
    payload = part.get_payload(decode=True)
    return payload if isinstance(payload, bytes) else b""


def _split(message: EmailMessage) -> tuple[str, str, list[EmailMessage]]:
    """`(text, html, files)`. Pictures the HTML shows in place (`cid:` links) are put into
    the HTML itself, so they show without the network and are not listed as files."""
    text, html = "", ""
    files: list[EmailMessage] = []
    pictures: dict[str, EmailMessage] = {}
    for part in message.walk():
        if part.is_multipart():
            continue
        assert isinstance(part, EmailMessage)
        kind = part.get_content_type()
        cid = str(part.get("Content-ID", "")).strip().strip("<>")
        if cid and kind.startswith("image/") and part.get_content_disposition() != "attachment":
            pictures[cid] = part
        elif _is_attachment(part):
            files.append(part)
        elif kind == "text/plain" and not text.strip():
            text = _content(part)
        elif kind == "text/html" and not html:
            html = _content(part)
    budget = INLINE_BYTES
    for cid, part in pictures.items():
        data = _bytes(part)
        link = "cid:" + cid
        if link in html and data and len(data) <= budget and part.get_content_type() in SAFE_IMAGES:
            budget -= len(data)
            encoded = base64.b64encode(data).decode("ascii")
            html = html.replace(link, f"data:{part.get_content_type()};base64,{encoded}")
        else:
            files.append(part)  # not shown in the text, too large, or not a plain picture
    return text, html, files


def attachment(raw: bytes, index: int) -> tuple[str, str, bytes] | None:
    """`(name, type, content)` of the attachment `parse` lists at `index`, or None."""
    message = message_from_bytes(raw, policy=policy.default)
    assert isinstance(message, EmailMessage)
    files = _split(message)[2]
    if not 0 <= index < len(files):
        return None
    part = files[index]
    return str(part.get_filename() or "attachment"), part.get_content_type(), _bytes(part)


def files(raw: bytes) -> list[tuple[str, str, bytes]]:
    """Every attachment `parse` lists, as `(name, type, content)`: to send them on."""
    message = message_from_bytes(raw, policy=policy.default)
    assert isinstance(message, EmailMessage)
    return [
        (str(part.get_filename() or "attachment"), part.get_content_type(), _bytes(part))
        for part in _split(message)[2]
    ]


def thread_id(key: str) -> str:
    return hashlib.sha1(key.encode("utf-8", "replace"), usedforsecurity=False).hexdigest()[:16]


def plain_subject(subject: str) -> str:
    """The subject without "Re:" and the like, for threads whose mails carry no references."""
    return _REPLY_PREFIX.sub("", subject).strip().lower()


def parse(raw: bytes) -> Parsed:
    message = message_from_bytes(raw, policy=policy.default)
    assert isinstance(message, EmailMessage)
    subject = _header(message, "Subject")
    senders = _people(message, "From")
    sender = senders[0] if senders else Person("", "")

    text, html, files = _split(message)
    attachments = [
        Attachment(str(f.get_filename() or "attachment"), f.get_content_type(), len(_bytes(f)))
        for f in files
    ]
    if not text.strip() and html:  # no plain part, or an empty one
        text = html_to_text(html)
    text = text.replace("\r\n", "\n").strip()[:BODY_CHARS]
    html = html[: BODY_CHARS + INLINE_BYTES * 2]

    own = (_ID.findall(_header(message, "Message-ID")) or [""])[0]
    references = _ID.findall(_header(message, "References"))
    reply_to = _ID.findall(_header(message, "In-Reply-To"))
    if not own:
        # No id of its own: one made from what the mail says, so it is stable across syncs.
        own = f"<{thread_id(subject + sender.email + _header(message, 'Date'))}@no-id>"
    key = (references or reply_to or [own])[0]

    date: datetime | None
    try:
        date = parsedate_to_datetime(_header(message, "Date"))
        if date.tzinfo is None:
            date = date.replace(tzinfo=UTC)
        date = date.astimezone(UTC)
    except TypeError, ValueError:
        date = None

    return Parsed(
        message_id=own,
        thread_key=key,
        references=references + [r for r in reply_to if r not in references],
        subject=subject,
        sender=sender,
        to=_people(message, "To"),
        cc=_people(message, "Cc"),
        date=date,
        text=text,
        html=html,
        snippet=_SPACE.sub(" ", text)[:SNIPPET_CHARS].strip(),
        attachments=attachments,
    )
