from __future__ import annotations

import imaplib
import time
from datetime import UTC, datetime, timedelta
from email.message import EmailMessage
from email.utils import format_datetime
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

from graite.mail import imap
from graite.mail.accounts import Account, AccountStore, get_password
from graite.mail.parse import parse
from graite.mail.store import MailBox, match_query

NOW = datetime.now(UTC).replace(microsecond=0)


def mail(
    subject: str,
    sender: str,
    body: str,
    *,
    message_id: str,
    reply_to: str = "",
    days_ago: float = 1,
    html: str = "",
    attachment: bytes = b"",
) -> bytes:
    message = EmailMessage()
    message["Subject"] = subject
    message["From"] = sender
    message["To"] = "Sam Example <sam@example.org>"
    message["Date"] = format_datetime(NOW - timedelta(days=days_ago))
    message["Message-ID"] = message_id
    if reply_to:
        message["In-Reply-To"] = reply_to
        message["References"] = reply_to
    message.set_content(body)
    if html:
        message.add_alternative(html, subtype="html")
    if attachment:
        message.add_attachment(
            attachment, maintype="application", subtype="pdf", filename="offer.pdf"
        )
    return message.as_bytes()


class FakeServer:
    """A mailbox that answers the way `imaplib` reports a real server's answers."""

    def __init__(self) -> None:
        self.password = "app-password"
        self.user, self.token = "", ""  # for a mailbox that takes a sign-in token
        self.folders: dict[str, dict[int, tuple[bytes, set[str]]]] = {"INBOX": {}}
        self.flags: dict[str, str] = {"INBOX": "\\HasNoChildren"}
        self.validity = 7
        self.commands: list[str] = []
        self.selected = ""
        self.moving = False
        self.capabilities: tuple[str, ...] = ("IMAP4REV1", "MOVE")

    def add_folder(self, name: str, flags: str) -> None:
        self.folders[name] = {}
        self.flags[name] = flags

    def put(self, folder: str, uid: int, raw: bytes, *flags: str) -> None:
        self.folders[folder][uid] = (raw, set(flags))

    # --- the part of imaplib.IMAP4 the sync uses

    def login(self, user: str, password: str) -> tuple[str, list[bytes]]:
        if password != self.password:
            raise imaplib.IMAP4.error("[AUTHENTICATIONFAILED] Invalid credentials")
        return "OK", [b"done"]

    def authenticate(self, mechanism: str, respond: Any) -> tuple[str, list[bytes]]:
        said = respond(b"")
        if (
            mechanism != "XOAUTH2"
            or said != f"user={self.user}\x01auth=Bearer {self.token}\x01\x01".encode()
        ):
            raise imaplib.IMAP4.error("AUTHENTICATE failed.")
        return "OK", [b"done"]

    def logout(self) -> None:
        pass

    def list(self) -> tuple[str, list[bytes]]:
        return "OK", [f'({self.flags[name]}) "/" "{name}"'.encode() for name in self.folders]

    def append(
        self, mailbox: str, flags: str, date: str, message: bytes
    ) -> tuple[str, list[bytes]]:
        folder = self.folders[mailbox.strip('"')]
        folder[max(folder, default=0) + 1] = (message, {"\\Seen"})
        return "OK", [b"done"]

    def select(self, mailbox: str, readonly: bool = False) -> tuple[str, list[bytes]]:
        # Only moving mail (archive, delete) may open a folder for writing; reading never.
        assert readonly or self.moving, "reading must never open a folder for writing"
        self.selected = mailbox.strip('"')
        return "OK", [str(len(self.folders[self.selected])).encode()]

    def expunge(self) -> tuple[str, list[bytes]]:
        folder = self.folders[self.selected]
        for uid in [u for u, (_, flags) in folder.items() if "\\Deleted" in flags]:
            del folder[uid]
        return "OK", [b"done"]

    def response(self, code: str) -> tuple[str, list[bytes]]:
        return code, [str(self.validity).encode()]

    def uid(self, command: str, *args: Any) -> tuple[str, list[Any]]:
        self.commands.append(f"{command} {' '.join(str(a) for a in args)}")
        folder = self.folders[self.selected]
        if command in ("MOVE", "COPY"):
            target = self.folders[args[1].strip('"')]
            for uid in (int(u) for u in args[0].split(",")):
                target[max(target, default=0) + 1] = folder[uid]
                if command == "MOVE":
                    del folder[uid]
            return "OK", [b"done"]
        if command == "STORE":
            for uid in (int(u) for u in args[0].split(",")):
                folder[uid][1].add(args[2].strip("()"))
            return "OK", [b"done"]
        if command == "EXPUNGE":
            return self.expunge()
        if command == "SEARCH":
            return "OK", [" ".join(str(u) for u in sorted(folder)).encode()]
        uids = [int(u) for u in args[0].split(",")]
        stamp = imaplib.Time2Internaldate(time.time())
        data: list[Any] = []
        for number, uid in enumerate(u for u in uids if u in folder):
            raw, flags = folder[uid]
            if "BODY.PEEK[]" in args[1]:
                # Some servers put the uid after the body: the sync must cope with both.
                if number % 2:
                    data += [(f"{uid} (BODY[] {{{len(raw)}}}".encode(), raw)]
                    data += [f" UID {uid})".encode()]
                else:
                    data += [(f"{uid} (UID {uid} BODY[] {{{len(raw)}}}".encode(), raw), b")"]
            elif "BODY.PEEK[HEADER]" in args[1]:
                head = raw.split(b"\n\n", 1)[0]
                data += [(f"{uid} (UID {uid} BODY[HEADER] {{{len(head)}}}".encode(), head), b")"]
            else:
                data.append(
                    f"{uid} (UID {uid} FLAGS ({' '.join(sorted(flags))}) "
                    f"RFC822.SIZE {len(raw)} INTERNALDATE {stamp})".encode()
                )
        return "OK", data


ACCOUNT = Account(
    id="ma_test",
    name="Work",
    email="sam@example.org",
    host="imap.example.org",
    username="sam@example.org",
    created_at="2026-01-01T00:00:00+00:00",
)


def filled() -> FakeServer:
    server = FakeServer()
    server.add_folder("Sent", "\\HasNoChildren \\Sent")
    server.add_folder("[Gmail]/All Mail", "\\All")
    server.add_folder("Verz&AOk-nden", "\\HasNoChildren")
    server.put(
        "INBOX",
        1,
        mail(
            "Quote for the roof",
            "Kim Roofer <kim@roof.example>",
            "We can start in May.",
            message_id="<a1@roof.example>",
            days_ago=3,
        ),
        "\\Seen",
    )
    server.put(
        "INBOX",
        2,
        mail(
            "Re: Quote for the roof",
            "Kim Roofer <kim@roof.example>",
            "Updated price attached.",
            message_id="<a3@roof.example>",
            reply_to="<a2@example.org>",
            days_ago=1,
            attachment=b"%PDF-1.4 fake",
        ),
    )
    server.put(
        "INBOX",
        3,
        mail(
            "Newsletter",
            "News <news@letters.example>",
            "",
            message_id="<n1@letters.example>",
            days_ago=2,
            html="<html><style>p{color:red}</style><p>Big <b>sale</b> today</p></html>",
        ),
    )
    server.put(
        "Sent",
        1,
        mail(
            "Re: Quote for the roof",
            "Sam Example <sam@example.org>",
            "May works for us.",
            message_id="<a2@example.org>",
            reply_to="<a1@roof.example>",
            days_ago=2,
        ),
        "\\Seen",
    )
    return server


def test_parse_reads_text_people_and_attachments() -> None:
    parsed = parse(
        mail(
            "Re: Hello",
            '"Roofer, Kim" <KIM@roof.example>',
            "Line one.\n\nLine two.",
            message_id="<x@y>",
            reply_to="<w@y>",
            attachment=b"12345",
        )
    )
    assert parsed.subject == "Re: Hello" and parsed.message_id == "<x@y>"
    assert parsed.sender.name == "Roofer, Kim" and parsed.sender.email == "kim@roof.example"
    assert parsed.to[0].email == "sam@example.org" and parsed.thread_key == "<w@y>"
    assert parsed.snippet == "Line one. Line two."
    assert [(a.name, a.type, a.size) for a in parsed.attachments] == [
        ("offer.pdf", "application/pdf", 5)
    ]
    # A mail with only HTML still has text to search and to preview; styles are not text.
    only_html = parse(mail("x", "a@b.example", "", message_id="<h@y>", html="<p>Hi <b>you</b></p>"))
    assert only_html.text == "Hi you" and "<b>you</b>" in only_html.html
    broken = parse(b"Subject: =?utf-8?b?4pyT?= ok\r\n\r\nbody")
    assert broken.subject == "✓ ok" and broken.message_id.endswith("@no-id>")
    assert broken.date is None and broken.text == "body"


def test_folder_names_and_search_words() -> None:
    assert imap.decode_folder("Verz&AOk-nden") == "Verzénden"
    assert imap.decode_folder("Tom &- Jerry") == "Tom & Jerry"
    folders = imap.parse_folders(
        [
            b'(\\HasNoChildren) "/" "INBOX"',
            b'(\\Noselect \\HasChildren) "/" "[Gmail]"',
            b'(\\HasNoChildren \\Sent) "/" "[Gmail]/Sent Mail"',
            (b'(\\HasNoChildren) "/" {9}', b'A "q" box'),
            b"garbage",
        ]
    )
    assert [(f.name, f.title, f.role) for f in folders] == [
        ("INBOX", "Inbox", "inbox"),
        ("[Gmail]/Sent Mail", "Sent Mail", "sent"),
        ('A "q" box', 'A "q" box', ""),
    ]
    assert match_query('roof "quote') == '"roof" "quote"*'
    assert match_query(" - . ") == ""


def test_sync_copies_reads_only_and_follows_the_server(tmp_path: Path) -> None:
    server = filled()
    box = MailBox(tmp_path / "ma_test")
    result = imap.sync(ACCOUNT, "app-password", box, connect=lambda _: server)
    assert (result.new, result.removed) == (4, 0)
    assert all("PEEK" in c or "BODY" not in c for c in server.commands)

    folders = {f["title"]: f for f in box.folders()}
    assert list(folders) == ["Inbox", "Sent", "Verzénden"]  # "All Mail" repeats the rest
    assert folders["Inbox"]["unread"] == 2 and folders["Inbox"]["total"] == 3
    assert box.unread() == 2

    threads = box.threads(folder="INBOX")
    assert [t["subject"] for t in threads] == ["Re: Quote for the roof", "Newsletter"]
    roof = threads[0]
    # The reply from Sent belongs to the conversation, although it is not in the inbox.
    assert roof["count"] == 3 and roof["unread"] == 1 and roof["has_attachments"]
    assert roof["participants"] == ["Kim Roofer", "Sam Example"]
    # What the row shows is the newest mail of the conversation, here the one with the file.
    assert (
        roof["snippet"].startswith("Updated price attached.")
        and roof["sender_name"] == "Kim Roofer"
    )
    server_flagged = box.threads(folder="Sent")[0]
    assert server_flagged["subject"] == "Re: Quote for the roof" and server_flagged["count"] == 3
    assert threads[1]["snippet"] == "Big sale today"
    messages = box.thread(roof["thread_id"])
    assert [m["sender_email"] for m in messages] == [
        "kim@roof.example",
        "sam@example.org",
        "kim@roof.example",
    ]
    assert (
        messages[1]["folders"] == ["Sent"] and messages[2]["attachments"][0]["name"] == "offer.pdf"
    )

    assert [t["subject"] for t in box.threads(query="sale")] == ["Newsletter"]
    assert [t["thread_id"] for t in box.threads(query="may wor")] == [roof["thread_id"]]
    assert box.threads(folder="INBOX", before=threads[0]["date"]) == threads[1:]

    # Read elsewhere, one deleted, one new: a second sync fetches only the new mail.
    server.folders["INBOX"][2][1].add("\\Seen")
    del server.folders["INBOX"][3]
    server.put(
        "INBOX",
        4,
        mail("Hello", "kim@roof.example", "Hi", message_id="<b1@roof.example>", days_ago=0),
    )
    server.commands.clear()
    result = imap.sync(ACCOUNT, "app-password", box, connect=lambda _: server)
    assert (result.new, result.removed, result.changed) == (1, 1, 1)
    assert [c for c in server.commands if "BODY" in c] == ["FETCH 4 (UID BODY.PEEK[])"]
    assert [t["subject"] for t in box.threads(folder="INBOX")] == [
        "Hello",
        "Re: Quote for the roof",
    ]
    assert box.threads(query="sale") == []

    # The server renumbered the folder: what was kept is dropped and fetched again.
    server.validity = 8
    result = imap.sync(ACCOUNT, "app-password", box, connect=lambda _: server)
    assert result.new == 4 and len(box.threads()) == 2  # inbox and Sent, both again


def test_a_large_mail_is_kept_as_its_headers(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    server = FakeServer()
    server.put("INBOX", 1, mail("Photos", "kim@roof.example", "x" * 4000, message_id="<big@x>"))
    monkeypatch.setattr(imap, "FULL_BYTES", 1000)
    box = MailBox(tmp_path / "ma_test")
    imap.sync(ACCOUNT, "app-password", box, connect=lambda _: server)
    message = box.thread(box.threads()[0]["thread_id"])[0]
    assert message["partial"] and message["subject"] == "Photos" and message["body_text"] == ""


def test_sign_in_failures_say_what_to_do() -> None:
    server = FakeServer()
    with pytest.raises(imap.MailError) as wrong:
        imap.check(ACCOUNT, "nope", lambda _: server)
    assert wrong.value.auth and "refused" in str(wrong.value)

    def unreachable(_: Account) -> Any:
        raise OSError("no route")

    with pytest.raises(imap.MailError) as down:
        imap.check(ACCOUNT, "app-password", unreachable)
    assert not down.value.auth and "imap.example.org" in str(down.value)
    with pytest.raises(imap.MailError) as missing:
        imap.check(ACCOUNT, "", lambda _: server)
    assert missing.value.auth


def test_account_store_knows_servers_and_refuses_doubles(tmp_path: Path) -> None:
    store = AccountStore(tmp_path / "app" / "mail.json")
    first = store.add("sam@gmail.com", name="Private")
    assert first.host == "imap.gmail.com" and first.port == 993 and first.id.startswith("ma_")
    second = store.add("sam@own.example", host="mail.own.example", username="sam")
    assert second.name == "sam@own.example" and second.username == "sam"
    assert [a.id for a in AccountStore(store.path).accounts()] == [first.id, second.id]
    for email, host in (
        ("sam", ""),
        ("sam@own.example", ""),
        ("SAM@gmail.com", ""),
        ("sam@outlook.com", ""),
    ):
        with pytest.raises(ValueError):
            store.add(email, host=host)
    assert '"password":' not in store.path.read_text()  # how it signs in, never the secret
    assert store.rename(first.id, " Home ").name == "Home"
    store.remove(first.id)
    assert [a.id for a in store.accounts()] == [second.id]


def wait_for(check: Any, seconds: float = 5.0) -> None:
    end = time.monotonic() + seconds
    while time.monotonic() < end:
        if check():
            return
        time.sleep(0.05)
    raise AssertionError("timed out")


def test_api_adds_reads_and_removes_accounts(client: TestClient, settings: Any) -> None:
    servers = {"imap.gmail.com": filled(), "mail.own.example": FakeServer()}
    client.app.state.mail.connect = lambda account: servers[account.host]  # type: ignore[attr-defined]
    assert client.get("/api/v1/mail/accounts").json() == {"accounts": []}

    wrong = client.post("/api/v1/mail/accounts", json={"email": "sam@gmail.com", "password": "x"})
    assert wrong.status_code == 400 and "app password" in wrong.json()["detail"]
    assert client.get("/api/v1/mail/accounts").json() == {"accounts": []}
    unknown = client.post("/api/v1/mail/accounts", json={"email": "a@own.example", "password": "x"})
    assert unknown.status_code == 400 and "IMAP" in unknown.json()["detail"]

    added = client.post(
        "/api/v1/mail/accounts",
        json={"email": "sam@gmail.com", "password": "app-password", "name": "Private"},
    )
    assert added.status_code == 201
    first = added.json()["id"]
    assert get_password(first) == "app-password" and "password" not in added.json()
    second = client.post(
        "/api/v1/mail/accounts",
        json={"email": "sam@own.example", "password": "app-password", "host": "mail.own.example"},
    ).json()["id"]

    def synced() -> bool:
        rows = client.get("/api/v1/mail/accounts").json()["accounts"]
        return all(r["state"] == "ok" for r in rows)

    wait_for(synced)
    rows = {r["id"]: r for r in client.get("/api/v1/mail/accounts").json()["accounts"]}
    assert rows[first]["unread"] == 2 and rows[second]["unread"] == 0 and rows[first]["synced_at"]
    assert (settings.graite_dir / "mail" / first / "mail.sqlite").is_file()

    folders = client.get(f"/api/v1/mail/accounts/{first}/folders").json()["folders"]
    assert [f["title"] for f in folders] == ["Inbox", "Sent", "Verzénden"]
    page = client.get(
        f"/api/v1/mail/accounts/{first}/threads", params={"folder": "INBOX", "limit": 1}
    ).json()
    assert page["more"] and page["threads"][0]["subject"] == "Re: Quote for the roof"
    rest = client.get(
        f"/api/v1/mail/accounts/{first}/threads",
        params={"folder": "INBOX", "before": page["threads"][0]["date"]},
    ).json()
    assert [t["subject"] for t in rest["threads"]] == ["Newsletter"] and not rest["more"]
    thread = client.get(
        f"/api/v1/mail/accounts/{first}/threads/{page['threads'][0]['thread_id']}"
    ).json()
    assert len(thread["messages"]) == 3 and thread["subject"] == "Quote for the roof"
    assert client.get(f"/api/v1/mail/accounts/{second}/threads").json()["threads"] == []
    assert client.get(f"/api/v1/mail/accounts/{first}/threads/nope").status_code == 404
    assert client.get("/api/v1/mail/accounts/ma_nope/folders").status_code == 404

    # New mail shows up after asking for a sync; a changed password is checked first.
    servers["imap.gmail.com"].put(
        "INBOX", 9, mail("Fresh", "kim@roof.example", "Now", message_id="<f@x>", days_ago=0)
    )
    assert client.post(f"/api/v1/mail/accounts/{first}/sync").json() == {"ok": True}
    wait_for(
        lambda: (
            client.get(f"/api/v1/mail/accounts/{first}/threads").json()["threads"][0]["subject"]
            == "Fresh"
        )
    )
    # An attachment is fetched from the mail server when asked for, without marking the mail.
    with_file = next(m for m in thread["messages"] if m["attachments"])
    servers["imap.gmail.com"].commands.clear()
    got = client.get(f"/api/v1/mail/accounts/{first}/messages/{with_file['id']}/attachments/0")
    assert got.status_code == 200 and got.content == b"%PDF-1.4 fake"
    assert "offer.pdf" in got.headers["content-disposition"]
    assert all("PEEK" in c for c in servers["imap.gmail.com"].commands)
    missing = f"/api/v1/mail/accounts/{first}/messages/{with_file['id']}/attachments/5"
    assert client.get(missing).status_code == 404
    assert (
        client.get(f"/api/v1/mail/accounts/{first}/messages/999/attachments/0").status_code == 404
    )

    bad = client.patch(f"/api/v1/mail/accounts/{first}", json={"password": "nope"})
    assert bad.status_code == 400 and get_password(first) == "app-password"
    renamed = client.patch(f"/api/v1/mail/accounts/{first}", json={"name": "Home"}).json()
    assert renamed["name"] == "Home"

    assert client.delete(f"/api/v1/mail/accounts/{first}").json() == {"ok": True}
    assert get_password(first) == "" and not (settings.graite_dir / "mail" / first).exists()
    assert [r["id"] for r in client.get("/api/v1/mail/accounts").json()["accounts"]] == [second]


def test_a_refused_sign_in_later_asks_for_the_password(client: TestClient) -> None:
    server = FakeServer()
    client.app.state.mail.connect = lambda account: server  # type: ignore[attr-defined]
    account = client.post(
        "/api/v1/mail/accounts",
        json={"email": "sam@own.example", "password": "app-password", "host": "mail.own.example"},
    ).json()["id"]
    wait_for(lambda: client.get("/api/v1/mail/accounts").json()["accounts"][0]["state"] == "ok")
    server.password = "changed-on-the-server"
    client.post(f"/api/v1/mail/accounts/{account}/sync")
    wait_for(lambda: client.get("/api/v1/mail/accounts").json()["accounts"][0]["state"] == "error")
    row = client.get("/api/v1/mail/accounts").json()["accounts"][0]
    assert row["needs_password"] and "refused" in row["error"]
    fixed = client.patch(
        f"/api/v1/mail/accounts/{account}", json={"password": "changed-on-the-server"}
    )
    assert fixed.status_code == 200
    wait_for(lambda: client.get("/api/v1/mail/accounts").json()["accounts"][0]["state"] == "ok")


class FakeSmtp:
    """The outgoing server: remembers what was handed to it."""

    def __init__(self) -> None:
        self.password = "app-password"
        self.sent: list[Any] = []
        self.tokens: list[tuple[str, str]] = []
        self.refuse = False

    def login(self, user: str, password: str) -> None:
        import smtplib

        if password != self.password:
            raise smtplib.SMTPAuthenticationError(535, b"bad credentials")

    def ehlo(self) -> None:
        pass

    def auth(self, mechanism: str, respond: Any, initial_response_ok: bool = True) -> None:
        self.tokens.append((mechanism, respond()))

    def send_message(self, message: Any) -> None:
        import smtplib

        if self.refuse:
            raise smtplib.SMTPRecipientsRefused({"nobody@nowhere.example": (550, b"no")})
        self.sent.append(message)

    def quit(self) -> None:
        pass


def test_drafts_replies_and_sending(client: TestClient, settings: Any) -> None:
    servers = {"mail.own.example": filled(), "imap.gmail.com": FakeServer()}
    smtp = FakeSmtp()
    service = client.app.state.mail  # type: ignore[attr-defined]
    service.connect = lambda account: servers[account.host]
    service.smtp = lambda account: smtp
    own = client.post(
        "/api/v1/mail/accounts",
        json={"email": "sam@example.org", "password": "app-password", "host": "mail.own.example"},
    ).json()
    assert (own["smtp_host"], own["smtp_port"], own["drafts"]) == ("smtp.example.org", 465, 0)
    base = f"/api/v1/mail/accounts/{own['id']}"
    wait_for(lambda: client.get("/api/v1/mail/accounts").json()["accounts"][0]["state"] == "ok")
    named = client.patch(base, json={"sender_name": " Sam  Example ", "smtp_host": "out.example"})
    assert (
        named.json()["sender_name"] == "Sam Example" and named.json()["smtp_host"] == "out.example"
    )

    # A new mail: saved as typed, changed, listed; nothing leaves until Send.
    draft = client.post(f"{base}/drafts", json={"to": "kim@roof.example", "subject": "Hello"})
    assert draft.status_code == 201
    draft_id = draft.json()["id"]
    changed = client.put(f"{base}/drafts/{draft_id}", json={"body": "See you in May.\n"})
    assert changed.json()["body"] == "See you in May.\n" and changed.json()["subject"] == "Hello"
    assert [d["id"] for d in client.get(f"{base}/drafts").json()["drafts"]] == [draft_id]
    assert client.get("/api/v1/mail/accounts").json()["accounts"][0]["drafts"] == 1
    assert smtp.sent == []
    assert (settings.app_dir / "mail-drafts.json").is_file()  # not under the vault's .graite

    # Broken address, refused recipient, wrong password: nothing is sent and the draft stays.
    client.put(f"{base}/drafts/{draft_id}", json={"to": "kim at roof"})
    bad = client.post(f"{base}/drafts/{draft_id}/send")
    assert bad.status_code == 400 and "not an email address" in bad.json()["detail"]
    client.put(f"{base}/drafts/{draft_id}", json={"to": "Kim Roofer <kim@roof.example>"})
    smtp.refuse = True
    assert client.post(f"{base}/drafts/{draft_id}/send").status_code == 400
    smtp.refuse, smtp.password = False, "other"
    assert client.post(f"{base}/drafts/{draft_id}/send").status_code == 401
    smtp.password = "app-password"
    assert len(client.get(f"{base}/drafts").json()["drafts"]) == 1 and smtp.sent == []

    sent = client.post(f"{base}/drafts/{draft_id}/send")
    assert sent.json() == {"ok": True, "saved_copy": True}
    message = smtp.sent[0]
    assert message["From"] == "Sam Example <sam@example.org>"
    assert message["To"] == "Kim Roofer <kim@roof.example>" and message["Subject"] == "Hello"
    assert message.get_content() == "See you in May.\n" and message["Message-ID"]
    assert client.get(f"{base}/drafts").json()["drafts"] == []
    # The copy went to the mailbox's Sent folder, and shows up after the next sync.
    assert any(
        b"See you in May." in raw for raw, _ in servers["mail.own.example"].folders["Sent"].values()
    )
    wait_for(
        lambda: any(
            t["subject"] == "Hello" for t in client.get(f"{base}/threads").json()["threads"]
        )
    )

    # A reply: addressed, quoted and tied to the conversation it answers.
    inbox = client.get(f"{base}/threads", params={"folder": "INBOX"}).json()["threads"]
    roof = next(t for t in inbox if "roof" in t["subject"])
    last = client.get(f"{base}/threads/{roof['thread_id']}").json()["messages"][-1]
    reply = client.post(
        f"{base}/drafts", json={"reply_to": last["id"], "reply_all": True, "body": "Thanks!"}
    ).json()
    assert reply["to"] == "Kim Roofer <kim@roof.example>" and reply["cc"] == ""
    assert reply["subject"] == "Re: Quote for the roof" and reply["thread_id"] == roof["thread_id"]
    assert (
        reply["body"].startswith("Thanks!\n\nOn ") and "> Updated price attached." in reply["body"]
    )
    assert reply["in_reply_to"] == "<a3@roof.example>" and "<a2@example.org>" in reply["references"]
    assert client.post(f"{base}/drafts/{reply['id']}/send").json()["ok"]
    assert smtp.sent[1]["In-Reply-To"] == "<a3@roof.example>"
    assert "<a2@example.org> <a3@roof.example>" in smtp.sent[1]["References"]
    wait_for(lambda: len(client.get(f"{base}/threads/{roof['thread_id']}").json()["messages"]) == 4)
    assert client.post(f"{base}/drafts", json={"reply_to": 9999}).status_code == 404

    # Gmail files what it sends itself: no second copy. Bcc reaches the server, not the mail.
    gmail = client.post(
        "/api/v1/mail/accounts", json={"email": "sam@gmail.com", "password": "app-password"}
    ).json()
    assert gmail["smtp_host"] == "smtp.gmail.com"
    g = f"/api/v1/mail/accounts/{gmail['id']}"
    hidden = client.post(
        f"{g}/drafts",
        json={"to": "a@x.example", "bcc": "b@x.example", "subject": "Hi", "body": "x"},
    ).json()
    assert client.post(f"{g}/drafts/{hidden['id']}/send").json() == {"ok": True, "saved_copy": True}
    assert smtp.sent[2]["Bcc"] == "b@x.example"  # smtplib leaves this line out on the wire
    assert "Sent" not in servers["imap.gmail.com"].folders
    empty = client.post(f"{g}/drafts", json={"subject": "No one"}).json()
    assert "recipient" in client.post(f"{g}/drafts/{empty['id']}/send").json()["detail"]
    assert client.delete(f"{g}/drafts/{empty['id']}").json() == {"ok": True}
    assert client.delete(f"{g}/drafts/{empty['id']}").status_code == 404

    # Removing an account takes its drafts along.
    client.post(f"{g}/drafts", json={"subject": "Left over"})
    client.delete(g)
    assert "Left over" not in (settings.app_dir / "mail-drafts.json").read_text()


def test_pictures_inside_the_text_are_kept_with_the_mail() -> None:
    message = EmailMessage()
    message["Subject"] = "Logo"
    message["From"] = "kim@roof.example"
    message["Message-ID"] = "<pic@x>"
    message.set_content("See the logo.")
    message.add_alternative(
        '<p>See <img src="cid:logo1"> and <img src="cid:gone"></p>', subtype="html"
    )
    html_part = message.get_payload()[1]
    html_part.add_related(b"\x89PNG-bytes", maintype="image", subtype="png", cid="<logo1>")
    message.add_attachment(b"%PDF", maintype="application", subtype="pdf", filename="a.pdf")
    raw = message.as_bytes()
    parsed = parse(raw)
    assert (
        "data:image/png;base64,iVBORy1ieXRlcw==" in parsed.html and "cid:logo1" not in parsed.html
    )
    assert "cid:gone" in parsed.html  # nothing to show for it: left as it was
    # The picture is part of the text now, not a file; the real attachment keeps its place.
    assert [a.name for a in parsed.attachments] == ["a.pdf"]
    from graite.mail.parse import attachment

    assert (
        attachment(raw, 0) == ("a.pdf", "application/pdf", b"%PDF") and attachment(raw, 1) is None
    )


def test_archive_and_delete_move_mail_in_the_mailbox(client: TestClient) -> None:
    server = filled()
    server.add_folder("Archive", "\\HasNoChildren \\Archive")
    server.add_folder("Trash", "\\HasNoChildren \\Trash")
    gmail = filled()
    gmail.capabilities = ("IMAP4REV1",)  # no MOVE: copy, mark, expunge
    gmail.add_folder("[Gmail]/Trash", "\\Trash")
    servers = {"mail.own.example": server, "imap.gmail.com": gmail}
    client.app.state.mail.connect = lambda account: servers[account.host]  # type: ignore[attr-defined]
    own = client.post(
        "/api/v1/mail/accounts",
        json={"email": "sam@example.org", "password": "app-password", "host": "mail.own.example"},
    ).json()["id"]
    google = client.post(
        "/api/v1/mail/accounts", json={"email": "sam@gmail.com", "password": "app-password"}
    ).json()["id"]
    wait_for(
        lambda: all(
            a["state"] == "ok" for a in client.get("/api/v1/mail/accounts").json()["accounts"]
        )
    )
    server.moving = gmail.moving = True

    def subjects(account: str, folder: str = "INBOX") -> list[str]:
        found = client.get(f"/api/v1/mail/accounts/{account}/threads", params={"folder": folder})
        return [t["subject"] for t in found.json()["threads"]]

    def thread(account: str, subject: str) -> str:
        found = client.get(f"/api/v1/mail/accounts/{account}/threads").json()["threads"]
        return next(t["thread_id"] for t in found if t["subject"] == subject)

    # Archive: out of the inbox into Archive; the reply in Sent stays where it is.
    roof = thread(own, "Re: Quote for the roof")
    done = client.post(f"/api/v1/mail/accounts/{own}/threads/{roof}/archive")
    assert done.json() == {"ok": True, "moved": 2}
    assert subjects(own) == ["Newsletter"] and sorted(server.folders["INBOX"]) == [3]
    assert len(server.folders["Archive"]) == 2 and len(server.folders["Sent"]) == 1
    wait_for(lambda: "Re: Quote for the roof" in subjects(own, "Archive"))
    again = client.post(f"/api/v1/mail/accounts/{own}/threads/{roof}/archive")
    assert again.status_code == 404  # nothing of it is in the inbox any more

    # Delete: the whole conversation goes to the mailbox's Trash, where it can be put back.
    news = thread(own, "Newsletter")
    assert client.post(f"/api/v1/mail/accounts/{own}/threads/{news}/trash").json()["moved"] == 1
    assert subjects(own) == [] and len(server.folders["Trash"]) == 1
    gone = client.post(f"/api/v1/mail/accounts/{own}/threads/{roof}/trash").json()
    assert gone["moved"] == 3 and len(server.folders["Trash"]) == 4
    assert server.folders["Sent"] == {} and server.folders["Archive"] == {}

    # A server without MOVE, and Gmail's ways: archive is "All Mail", Trash has its own name.
    g_roof = thread(google, "Re: Quote for the roof")
    assert (
        client.post(f"/api/v1/mail/accounts/{google}/threads/{g_roof}/archive").json()["moved"] == 2
    )
    assert sorted(gmail.folders["INBOX"]) == [3] and len(gmail.folders["[Gmail]/All Mail"]) == 2
    g_news = thread(google, "Newsletter")
    assert (
        client.post(f"/api/v1/mail/accounts/{google}/threads/{g_news}/trash").json()["moved"] == 1
    )
    assert gmail.folders["INBOX"] == {} and len(gmail.folders["[Gmail]/Trash"]) == 1

    # Opening a conversation marks it read: here at once, in the mailbox right after.
    gmail.put("INBOX", 30, mail("Unread", "a@b.example", "x", message_id="<u@x>", days_ago=0))
    client.post(f"/api/v1/mail/accounts/{google}/sync")
    wait_for(lambda: "Unread" in subjects(google))
    unread = thread(google, "Unread")
    assert client.get("/api/v1/mail/accounts").json()["accounts"][1]["unread"] == 1
    marked = client.post(f"/api/v1/mail/accounts/{google}/threads/{unread}/read")
    assert marked.json() == {"ok": True, "moved": 1}
    assert client.get("/api/v1/mail/accounts").json()["accounts"][1]["unread"] == 0
    wait_for(lambda: "\\Seen" in gmail.folders["INBOX"][30][1])
    again = client.post(f"/api/v1/mail/accounts/{google}/threads/{unread}/read")
    assert again.json()["moved"] == 0
    client.post(f"/api/v1/mail/accounts/{google}/threads/{unread}/trash")

    # Several at once: one request, whatever folders they are in.
    gmail.put("INBOX", 20, mail("One", "a@b.example", "x", message_id="<one@x>", days_ago=0))
    gmail.put("INBOX", 21, mail("Two", "a@b.example", "x", message_id="<two@x>", days_ago=0))
    client.post(f"/api/v1/mail/accounts/{google}/sync")
    wait_for(lambda: {"One", "Two"} <= set(subjects(google)))
    both = client.post(
        f"/api/v1/mail/accounts/{google}/move",
        json={"threads": [thread(google, "One"), thread(google, "Two")], "to": "trash"},
    )
    assert both.json() == {"ok": True, "moved": 2} and gmail.folders["INBOX"] == {}
    assert len(gmail.folders["[Gmail]/Trash"]) == 4  # the newsletter, "Unread", and these two
    wrong = client.post(
        f"/api/v1/mail/accounts/{google}/move", json={"threads": ["x"], "to": "erase"}
    )
    assert wrong.status_code == 422

    # No Trash folder at all: said plainly, nothing moved.
    bare = FakeServer()
    bare.moving = True
    bare.put("INBOX", 1, mail("Hi", "a@b.example", "x", message_id="<bare@x>"))
    servers["mail.bare.example"] = bare
    third = client.post(
        "/api/v1/mail/accounts",
        json={"email": "s@bare.example", "password": "app-password", "host": "mail.bare.example"},
    ).json()["id"]
    wait_for(lambda: subjects(third) == ["Hi"])
    refused = client.post(f"/api/v1/mail/accounts/{third}/threads/{thread(third, 'Hi')}/trash")
    assert refused.status_code == 400 and "no Trash folder" in refused.json()["detail"]
    assert len(bare.folders["INBOX"]) == 1


def test_linked_pictures_are_only_fetched_from_the_open_internet(client: TestClient) -> None:
    for url in (
        "http://127.0.0.1:8765/api/v1/health",
        "http://localhost/x.png",
        "http://192.168.1.1/x.png",
        "http://[::1]/x.png",
        "file:///etc/passwd",
        "ftp://example.org/x.png",
    ):
        refused = client.get("/api/v1/mail/image", params={"url": url})
        assert refused.status_code == 400, url


def test_attachments_can_be_looked_at_and_put_on_a_page(client: TestClient, settings: Any) -> None:
    import io

    from PIL import Image

    picture = Image.new("RGB", (40, 30), "white")
    as_pdf, as_png = io.BytesIO(), io.BytesIO()
    picture.save(as_pdf, format="PDF")
    picture.save(as_png, format="PNG")
    message = EmailMessage()
    message["Subject"] = "Files"
    message["From"] = "kim@roof.example"
    message["Date"] = format_datetime(NOW)
    message["Message-ID"] = "<files@x>"
    message.set_content("Three files.")
    message.add_attachment(
        as_pdf.getvalue(), maintype="application", subtype="pdf", filename="offer v2.pdf"
    )
    message.add_attachment(as_png.getvalue(), maintype="image", subtype="png", filename="photo.png")
    message.add_attachment(b"a,b\n1,2\n", maintype="text", subtype="csv", filename="rows.csv")
    server = FakeServer()
    server.put("INBOX", 1, message.as_bytes())
    client.app.state.mail.connect = lambda account: server  # type: ignore[attr-defined]
    account = client.post(
        "/api/v1/mail/accounts",
        json={"email": "sam@own.example", "password": "app-password", "host": "mail.own.example"},
    ).json()["id"]
    base = f"/api/v1/mail/accounts/{account}"
    wait_for(lambda: client.get(f"{base}/threads").json()["threads"])
    thread = client.get(f"{base}/threads").json()["threads"][0]["thread_id"]
    mail_id = client.get(f"{base}/threads/{thread}").json()["messages"][0]["id"]
    files = f"{base}/messages/{mail_id}/attachments"

    # What it is, and a drawn page of it. The mail is fetched once for all of this.
    server.commands.clear()
    assert client.get(f"{files}/0/info").json() == {
        "name": "offer_v2.pdf",
        "kind": "pdf",
        "pages": 1,
        "size": len(as_pdf.getvalue()),
    }
    page = client.get(f"{files}/0/preview")
    assert page.status_code == 200 and page.content.startswith(b"\x89PNG")
    assert client.get(f"{files}/0/preview", params={"page": 3}).status_code == 400
    assert client.get(f"{files}/0").content == as_pdf.getvalue()
    assert len([c for c in server.commands if "BODY.PEEK[]" in c]) == 1
    assert client.get(f"{files}/1/info").json()["kind"] == "image"
    assert client.get(f"{files}/1/preview").content.startswith(b"\x89PNG")
    assert client.get(f"{files}/2/info").json() == {
        "name": "rows.csv",
        "kind": "other",
        "pages": 0,
        "size": 8,
    }
    assert client.get(f"{files}/2/preview").status_code == 400

    # Onto a page: the file becomes the page's own and shows at its end, once.
    target = client.post("/api/v1/pages", json={"title": "Roof"}).json()
    saved = client.post(f"{files}/0/save", json={"page_id": target["id"]}).json()
    assert (
        saved["page_path"] == "Roof" and saved["name"] == "offer_v2.pdf" and saved["job_id"] is None
    )
    body = client.get("/api/v1/pages/Roof").json()["body"]
    assert "```graite:media" in body and f"file: {saved['file']}" in body and "kind: pdf" in body
    listed = client.get("/api/v1/media/attachments", params={"page_id": target["id"]}).json()
    assert [item["file"] for item in listed] == [saved["file"]]
    # With its text read as well: an extraction is queued for that file.
    read = client.post(f"{files}/1/save", json={"page_id": target["id"], "extract": True}).json()
    assert read["job_id"] and client.get(f"/api/v1/media/jobs/{read['job_id']}").status_code == 200
    assert "kind: image" in client.get("/api/v1/pages/Roof").json()["body"]
    # What a page cannot hold, and a page that is not there.
    assert client.post(f"{files}/2/save", json={"page_id": target["id"]}).status_code == 400
    assert client.post(f"{files}/0/save", json={"page_id": "nope"}).status_code == 400


def test_microsoft_accounts_sign_in_at_microsoft(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    import base64
    import json
    import webbrowser
    from urllib.parse import parse_qs, urlsplit

    import httpx

    from graite.mail import oauth

    opened: list[str] = []
    monkeypatch.setattr(webbrowser, "open", lambda url: opened.append(url) or True)
    asked: list[dict[str, str]] = []
    answers = {"n": 0}

    def token_endpoint(data: dict[str, str]) -> dict[str, Any]:
        asked.append(data)
        if data.get("refresh_token") == "revoked":
            raise imap.MailError("AADSTS70000: revoked", auth=True)
        answers["n"] += 1
        who = {"email": "Sam@Outlook.com", "name": "Sam Example"}
        packed = base64.urlsafe_b64encode(json.dumps(who).encode()).decode().rstrip("=")
        return {
            "access_token": f"access-{answers['n']}",
            "refresh_token": f"refresh-{answers['n']}",
            "expires_in": 3600,
            "id_token": f"x.{packed}.y",
        }

    monkeypatch.setattr(oauth, "post", token_endpoint)
    server, smtp = filled(), FakeSmtp()
    server.user, server.token = "Sam@Outlook.com", "access-1"
    service = client.app.state.mail  # type: ignore[attr-defined]
    service.connect = lambda account: server
    service.smtp = lambda account: smtp

    # Start: Microsoft's page is opened with Graite's app id, PKCE and the mail permissions.
    started = client.post("/api/v1/mail/oauth/microsoft", json={}).json()
    assert started["opened"] and opened == [started["url"]]
    query = parse_qs(urlsplit(started["url"]).query)
    assert query["client_id"] == ["11e74e8c-13ce-48c1-95b4-4bef6fcc3499"]
    assert (
        query["code_challenge_method"] == ["S256"] and "IMAP.AccessAsUser.All" in query["scope"][0]
    )
    redirect = query["redirect_uri"][0]
    assert redirect.startswith("http://localhost:")
    state = f"/api/v1/mail/oauth/{started['id']}"
    assert client.get(state).json() == {"status": "waiting", "error": "", "account_id": None}

    # The browser comes back. A wrong state is nobody's sign-in; the right one finishes it.
    assert httpx.get(redirect, params={"code": "c", "state": "guess"}).status_code == 404
    back = httpx.get(redirect, params={"code": "the-code", "state": query["state"][0]})
    assert back.status_code == 200 and "go back to Graite" in back.text
    wait_for(lambda: client.get(state).json()["status"] == "done")
    account_id = client.get(state).json()["account_id"]
    assert (
        asked[0]["code"] == "the-code"
        and asked[0]["code_verifier"]
        and "client_secret" not in asked[0]
    )
    account = client.get("/api/v1/mail/accounts").json()["accounts"][0]
    assert (account["id"], account["auth"], account["email"]) == (
        account_id,
        "microsoft",
        "Sam@Outlook.com",
    )
    assert (account["host"], account["smtp_host"], account["smtp_port"]) == (
        "outlook.office365.com",
        "smtp.office365.com",
        587,
    )
    assert account["sender_name"] == "Sam Example" and "client_id" not in account
    # The keychain holds the long-lived token, never a password; the file holds neither.
    assert get_password(account_id) == "refresh-1"
    assert "refresh-1" not in service.accounts.path.read_text()

    # Reading and sending use the token, the XOAUTH2 way.
    wait_for(lambda: client.get("/api/v1/mail/accounts").json()["accounts"][0]["state"] == "ok")
    base = f"/api/v1/mail/accounts/{account_id}"
    assert len(client.get(f"{base}/threads").json()["threads"]) == 2
    draft = client.post(
        f"{base}/drafts", json={"to": "kim@roof.example", "subject": "Hi", "body": "x"}
    )
    assert client.post(f"{base}/drafts/{draft.json()['id']}/send").json()["ok"]
    assert smtp.tokens == [("XOAUTH2", "user=Sam@Outlook.com\x01auth=Bearer access-1\x01\x01")]
    assert client.patch(base, json={"password": "x"}).status_code == 400

    # The short-lived token runs out: a new one is fetched with the stored one, which rotates.
    oauth.forget(account_id)
    server.token = "access-2"
    client.post(f"{base}/sync")
    wait_for(lambda: get_password(account_id) == "refresh-2")
    assert asked[-1]["grant_type"] == "refresh_token" and asked[-1]["refresh_token"] == "refresh-1"

    # Microsoft takes the sign-in away: the account asks to sign in again, with the same mailbox.
    oauth.forget(account_id)
    from graite.mail.accounts import set_password

    set_password(account_id, "revoked")
    client.post(f"{base}/sync")
    wait_for(lambda: client.get("/api/v1/mail/accounts").json()["accounts"][0]["needs_password"])
    assert "again" in client.get("/api/v1/mail/accounts").json()["accounts"][0]["error"]
    again = client.post("/api/v1/mail/oauth/microsoft", json={"account_id": account_id}).json()
    again_query = parse_qs(urlsplit(again["url"]).query)
    server.token = "access-3"
    httpx.get(
        again_query["redirect_uri"][0], params={"code": "c2", "state": again_query["state"][0]}
    )
    wait_for(lambda: client.get(f"/api/v1/mail/oauth/{again['id']}").json()["status"] == "done")
    wait_for(lambda: client.get("/api/v1/mail/accounts").json()["accounts"][0]["state"] == "ok")
    assert len(client.get("/api/v1/mail/accounts").json()["accounts"]) == 1

    # Cancelled at Microsoft: said so, nothing added.
    third = client.post("/api/v1/mail/oauth/microsoft", json={}).json()
    third_query = parse_qs(urlsplit(third["url"]).query)
    httpx.get(
        third_query["redirect_uri"][0],
        params={
            "error": "access_denied",
            "error_description": "The user cancelled.",
            "state": third_query["state"][0],
        },
    )
    wait_for(lambda: client.get(f"/api/v1/mail/oauth/{third['id']}").json()["status"] == "error")
    assert "cancelled" in client.get(f"/api/v1/mail/oauth/{third['id']}").json()["error"]
    assert client.get("/api/v1/mail/oauth/nope").status_code == 404
