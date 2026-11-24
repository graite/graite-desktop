"""Sign in with Microsoft, for mailboxes that no longer take a password.

The user signs in on Microsoft's own page in their browser; Graite never sees the password.
What comes back is a token to read and send that mailbox's mail. The long-lived half (the
refresh token) is kept in the OS keychain like a password; the short-lived half is asked for
again when it runs out. Graite is a public client (PKCE): there is no app secret.
"""

from __future__ import annotations

import asyncio
import base64
import hashlib
import html
import json
import logging
import secrets
import time
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any
from urllib.parse import parse_qs, urlencode, urlsplit

import httpx

from graite.mail.accounts import Account, AccountStore, get_password, set_password
from graite.mail.imap import MailError

log = logging.getLogger("graite.mail")

AUTHORITY = "https://login.microsoftonline.com/common/oauth2/v2.0"
SCOPES = (
    "https://outlook.office.com/IMAP.AccessAsUser.All "
    "https://outlook.office.com/SMTP.Send offline_access openid email profile"
)
IMAP_HOST = "outlook.office365.com"
SMTP_HOST, SMTP_PORT = "smtp.office365.com", 587
SIGN_IN_SECONDS = 600
AGAIN = "Microsoft no longer accepts this sign-in. Sign in with Microsoft again."

# Short-lived tokens, per account: `(token, good until)`. Never written to disk.
_access: dict[str, tuple[str, float]] = {}


def _post(data: dict[str, str]) -> dict[str, Any]:
    response = httpx.post(AUTHORITY + "/token", data=data, timeout=20)
    try:
        body = response.json()
    except ValueError:
        body = {}
    if response.status_code != 200 or "access_token" not in body:
        detail = str(body.get("error_description") or body.get("error") or "")
        raise MailError(
            detail.split("\r\n")[0][:300] or "Microsoft refused the sign-in.", auth=True
        )
    return dict(body)


# Replaced in tests; everything that talks to Microsoft's token endpoint goes through it.
post: Callable[[dict[str, str]], dict[str, Any]] = _post


def _remember(account_id: str, body: dict[str, Any]) -> str:
    token = str(body["access_token"])
    _access[account_id] = (token, time.time() + float(body.get("expires_in", 3600)) - 120)
    if body.get("refresh_token"):  # Microsoft hands out a new one with each use
        set_password(account_id, str(body["refresh_token"]))
    return token


def secret(account: Account, client_id: str = "") -> str:
    """What signs this account in to its mail server right now: its password, or for a
    Microsoft account a token that is still good (fetched again when it has run out)."""
    if account.auth != "microsoft":
        return get_password(account.id)
    known = _access.get(account.id)
    if known and known[1] > time.time():
        return known[0]
    stored = get_password(account.id)
    if not stored:
        raise MailError(AGAIN, auth=True)
    try:
        body = post(
            {
                "client_id": client_id or account.client_id,
                "grant_type": "refresh_token",
                "refresh_token": stored,
                "scope": SCOPES,
            }
        )
    except MailError as exc:
        raise MailError(AGAIN, auth=True) from exc
    except httpx.HTTPError as exc:
        raise MailError("Could not reach Microsoft to sign in. Check your connection.") from exc
    return _remember(account.id, body)


def forget(account_id: str) -> None:
    _access.pop(account_id, None)


def claims(id_token: str) -> dict[str, Any]:
    """Who signed in. The token came straight from Microsoft over TLS, so it is only read."""
    try:
        part = id_token.split(".")[1]
        found = json.loads(base64.urlsafe_b64decode(part + "=" * (-len(part) % 4)))
        return found if isinstance(found, dict) else {}
    except IndexError, ValueError:
        return {}


@dataclass
class SignIn:
    id: str
    state: str
    verifier: str
    redirect: str
    url: str
    account_id: str | None  # set when an existing account signs in again
    status: str = "waiting"  # "waiting" | "done" | "error"
    error: str = ""
    server: asyncio.Server | None = None


PAGE = (
    "<!doctype html><meta charset=utf-8><title>Graite</title>"
    "<body style='font:16px system-ui;max-width:32rem;margin:18vh auto;padding:0 1.5rem'>"
    "<h1 style='font-size:1.25rem'>{title}</h1><p>{text}</p>"
)


class SignIns:
    """Sign-ins in progress. Each one listens on its own port of this computer for the browser
    coming back from Microsoft, for ten minutes at most, and only once."""

    def __init__(
        self,
        accounts: AccountStore,
        client_id: str,
        on_done: Callable[[Account], None],
    ) -> None:
        self.accounts = accounts
        self.client_id = client_id
        self.on_done = on_done
        self._open: dict[str, SignIn] = {}
        self._tasks: set[asyncio.Task[None]] = set()

    def get(self, sign_in_id: str) -> SignIn | None:
        return self._open.get(sign_in_id)

    async def start(self, account_id: str | None = None) -> SignIn:
        if not self.client_id:
            raise MailError("Signing in with Microsoft is not set up in this build.")
        state = secrets.token_urlsafe(24)
        verifier = secrets.token_urlsafe(64)
        challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest())
        sign_in = SignIn(secrets.token_hex(8), state, verifier, "", "", account_id)

        async def handle(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
            try:
                line = (await asyncio.wait_for(reader.readline(), 10)).decode("latin-1")
                target = line.split(" ")[1] if line.count(" ") >= 2 else ""
                query = parse_qs(urlsplit(target).query)
                if query.get("state", [""])[0] != state:
                    body = PAGE.format(title="Not found", text="")
                    head = f"HTTP/1.1 404 Not Found\r\nContent-Length: {len(body)}\r\n\r\n"
                    writer.write((head + body).encode())
                    return
                code = query.get("code", [""])[0]
                if code and sign_in.status == "waiting":
                    title, text = "Signed in", "You can close this window and go back to Graite."
                    task = asyncio.create_task(self._finish(sign_in, code))
                    self._tasks.add(task)
                    task.add_done_callback(self._tasks.discard)
                else:
                    reason = query.get("error_description", query.get("error", [""]))[0]
                    title, text = "Sign-in did not finish", html.escape(reason.split("\r\n")[0])
                    self._fail(sign_in, reason.split("\r\n")[0] or "The sign-in was cancelled.")
                body = PAGE.format(title=title, text=text)
                writer.write(
                    b"HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\n"
                    b"Cache-Control: no-store\r\nConnection: close\r\n"
                    + f"Content-Length: {len(body.encode())}\r\n\r\n".encode()
                    + body.encode()
                )
            except TimeoutError, OSError, IndexError:
                pass
            finally:
                try:
                    await writer.drain()
                    writer.close()
                except OSError:
                    pass

        sign_in.server = await asyncio.start_server(handle, "127.0.0.1", 0)
        port = sign_in.server.sockets[0].getsockname()[1]
        sign_in.redirect = f"http://localhost:{port}"
        sign_in.url = (
            AUTHORITY
            + "/authorize?"
            + urlencode(
                {
                    "client_id": self.client_id,
                    "response_type": "code",
                    "redirect_uri": sign_in.redirect,
                    "response_mode": "query",
                    "scope": SCOPES,
                    "state": state,
                    "code_challenge": challenge.rstrip(b"=").decode(),
                    "code_challenge_method": "S256",
                    "prompt": "select_account",
                }
            )
        )
        self._open[sign_in.id] = sign_in
        timeout = asyncio.create_task(self._expire(sign_in))
        self._tasks.add(timeout)
        timeout.add_done_callback(self._tasks.discard)
        return sign_in

    async def _expire(self, sign_in: SignIn) -> None:
        await asyncio.sleep(SIGN_IN_SECONDS)
        if sign_in.status == "waiting":
            self._fail(sign_in, "The sign-in took too long. Start it again.")
        self._close(sign_in)
        await asyncio.sleep(SIGN_IN_SECONDS)
        self._open.pop(sign_in.id, None)

    def _close(self, sign_in: SignIn) -> None:
        if sign_in.server is not None:
            sign_in.server.close()
            sign_in.server = None

    def _fail(self, sign_in: SignIn, reason: str) -> None:
        sign_in.status, sign_in.error = "error", reason

    async def _finish(self, sign_in: SignIn, code: str) -> None:
        try:
            body = await asyncio.to_thread(
                post,
                {
                    "client_id": self.client_id,
                    "grant_type": "authorization_code",
                    "code": code,
                    "redirect_uri": sign_in.redirect,
                    "code_verifier": sign_in.verifier,
                    "scope": SCOPES,
                },
            )
            who = claims(str(body.get("id_token", "")))
            email = str(who.get("email") or who.get("preferred_username") or "").strip()
            if "@" not in email or not body.get("refresh_token"):
                raise MailError("Microsoft did not say which mailbox this is. Try again.")
            if sign_in.account_id:
                account = self.accounts.account(sign_in.account_id)
                if account is None:
                    raise MailError("That account is no longer in Graite.")
                if account.email.lower() != email.lower():
                    raise MailError(
                        f"You signed in as {email}, but this account is {account.email}."
                    )
            else:
                account = self.accounts.add_signed_in(
                    email,
                    host=IMAP_HOST,
                    smtp_host=SMTP_HOST,
                    smtp_port=SMTP_PORT,
                    client_id=self.client_id,
                    sender_name=str(who.get("name") or ""),
                )
            await asyncio.to_thread(_remember, account.id, body)
            sign_in.account_id = account.id
            sign_in.status = "done"
            self.on_done(account)
        except (MailError, ValueError) as exc:
            self._fail(sign_in, str(exc))
        except Exception:
            log.exception("Microsoft sign-in failed")
            self._fail(sign_in, "The sign-in could not be finished. Try again.")
        finally:
            self._close(sign_in)

    async def stop(self) -> None:
        for sign_in in self._open.values():
            self._close(sign_in)
        for task in list(self._tasks):
            task.cancel()
        await asyncio.gather(*self._tasks, return_exceptions=True)
