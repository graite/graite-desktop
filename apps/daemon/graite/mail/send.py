"""Send one mail over SMTP. Blocking: run in a thread.

Nothing here decides to send: the only caller is the route behind the Send button. Agents
have no tool that reaches it.
"""

from __future__ import annotations

import smtplib
import ssl
from collections.abc import Callable
from datetime import UTC, datetime
from email.message import EmailMessage
from email.utils import format_datetime, formataddr, getaddresses, make_msgid
from typing import Any

from graite.mail import richtext
from graite.mail.accounts import Account, domain_of
from graite.mail.drafts import Draft
from graite.mail.imap import LOCAL_HOSTS, TIMEOUT_SECONDS, MailError, xoauth2

SMTPS_PORT = 465
# Where a well-known incoming server's mail goes out. Others: "imap." becomes "smtp.".
OUTGOING = {
    "imap.gmail.com": ("smtp.gmail.com", 465),
    "imap.mail.me.com": ("smtp.mail.me.com", 587),
    "imap.fastmail.com": ("smtp.fastmail.com", 465),
    "imap.mail.yahoo.com": ("smtp.mail.yahoo.com", 465),
    "imap.mailbox.org": ("smtp.mailbox.org", 465),
    "imap.gmx.com": ("mail.gmx.com", 587),
    "imap.gmx.net": ("mail.gmx.net", 587),
    "127.0.0.1": ("127.0.0.1", 1025),  # Proton Mail Bridge
}
# These keep a copy of what they send in Sent themselves; saving one too would double it.
SAVES_SENT_ITSELF = {"imap.gmail.com"}

Connect = Callable[[Account], Any]


def outgoing(account: Account) -> tuple[str, int]:
    if account.smtp_host:
        return account.smtp_host, account.smtp_port or SMTPS_PORT
    if account.host in OUTGOING:
        return OUTGOING[account.host]
    host = account.host
    guess = "smtp." + host[5:] if host.startswith("imap.") else "smtp." + domain_of(account.email)
    return guess, account.smtp_port or SMTPS_PORT


def recipients(*fields: str) -> list[tuple[str, str]]:
    """`(name, address)` of everyone typed into To, Cc or Bcc. Raises on a broken address."""
    found = []
    for name, address in getaddresses([f for f in fields if f.strip()]):
        if not address and not name:
            continue
        if "@" not in address or " " in address or address.startswith("@"):
            raise MailError(f"“{address or name}” is not an email address.")
        found.append((name, address))
    return found


def build(
    account: Account, draft: Draft, files: list[tuple[str, str, bytes]] | None = None
) -> EmailMessage:
    """The mail as it will be sent: the text, the same text with its formatting when the
    draft has any, and the files that go along as `(name, type, content)`."""
    if not recipients(draft.to, draft.cc, draft.bcc):
        raise MailError("Add at least one recipient.")
    message = EmailMessage()
    message["From"] = formataddr((account.sender_name, account.email))
    for header, value in (("To", draft.to), ("Cc", draft.cc), ("Bcc", draft.bcc)):
        people = recipients(value)
        if people:
            message[header] = ", ".join(formataddr(p) for p in people)
    message["Subject"] = draft.subject.replace("\r", " ").replace("\n", " ").strip()
    message["Date"] = format_datetime(datetime.now(UTC))
    message["Message-ID"] = make_msgid(domain=domain_of(account.email) or "localhost")
    if draft.in_reply_to:
        message["In-Reply-To"] = draft.in_reply_to
        message["References"] = " ".join([*draft.references, draft.in_reply_to][-20:])
    message.set_content(draft.body.replace("\r\n", "\n"))
    if draft.html:
        message.add_alternative(richtext.page(draft.html), subtype="html")
    for name, kind, content in files or []:
        main, _, sub = kind.partition("/")
        message.add_attachment(
            content, maintype=main or "application", subtype=sub or "octet-stream", filename=name
        )
    return message


def open_smtp(account: Account) -> Any:
    host, port = outgoing(account)
    context = ssl.create_default_context()
    if host in LOCAL_HOSTS:  # a mail bridge on this machine signs its own certificate
        context.check_hostname = False
        context.verify_mode = ssl.CERT_NONE
    if port == SMTPS_PORT:
        return smtplib.SMTP_SSL(host, port, context=context, timeout=TIMEOUT_SECONDS)
    connection = smtplib.SMTP(host, port, timeout=TIMEOUT_SECONDS)
    connection.starttls(context=context)
    return connection


def deliver(
    account: Account, password: str, message: EmailMessage, connect: Connect = open_smtp
) -> None:
    """Hand the mail to the outgoing server. Raises `MailError` and sends nothing on failure."""
    host, _ = outgoing(account)
    if not password:
        raise MailError("The password of this account is missing. Enter it again.", auth=True)
    try:
        connection = connect(account)
    except (OSError, smtplib.SMTPException) as exc:
        raise MailError(
            f"Could not reach the outgoing mail server {host}. "
            "Check it under the account's sending settings."
        ) from exc
    try:
        if account.auth == "microsoft":
            connection.ehlo()
            connection.auth(
                "XOAUTH2",
                lambda challenge=None: xoauth2(account.username, password).decode(),
                initial_response_ok=True,
            )
        else:
            connection.login(account.username, password)
        connection.send_message(message)  # leaves the Bcc line out of what is transmitted
    except smtplib.SMTPAuthenticationError as exc:
        raise MailError(
            "The outgoing mail server refused the sign-in. Check the password.", auth=True
        ) from exc
    except smtplib.SMTPRecipientsRefused as exc:
        refused = ", ".join(exc.recipients) or "a recipient"
        raise MailError(f"The mail server refused {refused}. Nothing was sent.") from exc
    except (OSError, smtplib.SMTPException) as exc:
        raise MailError("The mail could not be sent. Nothing was sent; try again.") from exc
    finally:
        try:
            connection.quit()
        except Exception:  # already gone
            pass


def quoted(sender: str, date: str, text: str) -> str:
    """The mail being answered, under the reply, the way mail apps quote it."""
    lines = "\n".join("> " + line if line else ">" for line in text.strip().splitlines())
    return f"\n\nOn {date}, {sender} wrote:\n{lines}\n"
