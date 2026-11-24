"""Mail accounts (`~/.graite/mail.json`). Passwords stay in the OS keychain.

Any number of accounts; each has its own keychain entry, its own local copy and its own
sync task, so adding or removing one never touches another.
"""

from __future__ import annotations

import json
import os
import uuid
from datetime import UTC, datetime
from pathlib import Path
from typing import Literal

import keyring
from pydantic import BaseModel, Field

FILE_VERSION = 1
KEYCHAIN_SERVICE = "Graite"
IMAPS_PORT = 993

# Where the mail of a well-known address lives, so the user only types address and password.
HOSTS = {
    "gmail.com": "imap.gmail.com",
    "googlemail.com": "imap.gmail.com",
    "icloud.com": "imap.mail.me.com",
    "me.com": "imap.mail.me.com",
    "mac.com": "imap.mail.me.com",
    "fastmail.com": "imap.fastmail.com",
    "fastmail.fm": "imap.fastmail.com",
    "yahoo.com": "imap.mail.yahoo.com",
    "mailbox.org": "imap.mailbox.org",
    "gmx.com": "imap.gmx.com",
    "gmx.net": "imap.gmx.net",
    "proton.me": "127.0.0.1",  # through Proton Mail Bridge, which gives its own port
    "protonmail.com": "127.0.0.1",
}
# Microsoft switched password sign-in off for mail; these need "Sign in with Microsoft".
SIGN_IN_ONLY = {"outlook.com", "hotmail.com", "live.com", "msn.com", "live.nl", "hotmail.nl"}
SIGN_IN_ONLY_MESSAGE = (
    "Microsoft mail accounts cannot be added with a password. "
    "Choose Microsoft when adding the account and sign in with Microsoft."
)


class Account(BaseModel):
    id: str
    name: str = Field(min_length=1, max_length=80)
    email: str = Field(min_length=3, max_length=320)
    host: str = Field(min_length=1, max_length=255)
    port: int = Field(default=IMAPS_PORT, ge=1, le=65535)
    username: str = Field(min_length=1, max_length=320)
    created_at: str
    # Sending. Empty or 0: worked out from the incoming server (`mail/send.py`).
    sender_name: str = Field(default="", max_length=120, description="Your name on sent mail.")
    smtp_host: str = Field(default="", max_length=255)
    smtp_port: int = Field(default=0, ge=0, le=65535)
    # How it signs in: a password kept in the keychain, or "Sign in with Microsoft"
    # (`mail/oauth.py`), where the keychain holds a token and `client_id` says for which app.
    # The vault folders this mailbox is shown in. Empty: every vault on this computer.
    vaults: list[str] = Field(default_factory=list, max_length=200)
    auth: Literal["password", "microsoft"] = "password"
    client_id: str = Field(default="", max_length=80)


class AccountsFile(BaseModel):
    version: int = FILE_VERSION
    accounts: list[Account] = Field(default_factory=list)


def same_folder(path: str) -> str:
    """A folder's path in one spelling, so two ways of writing it compare equal."""
    return os.path.normcase(os.path.realpath(os.path.expanduser(path)))


def shown_in(account: Account, vault: str) -> bool:
    """Whether a mailbox belongs in a vault: in every vault unless it names its vaults."""
    if not account.vaults:
        return True
    here = same_folder(vault)
    return any(same_folder(path) == here for path in account.vaults)


def domain_of(email: str) -> str:
    return email.rsplit("@", 1)[-1].strip().lower() if "@" in email else ""


def host_for(email: str) -> str | None:
    """The IMAP server of a well-known address, else None (the user enters it)."""
    return HOSTS.get(domain_of(email))


def keychain_account(account_id: str) -> str:
    return f"mail:{account_id}"


def get_password(account_id: str) -> str:
    return keyring.get_password(KEYCHAIN_SERVICE, keychain_account(account_id)) or ""


def set_password(account_id: str, password: str) -> None:
    keyring.set_password(KEYCHAIN_SERVICE, keychain_account(account_id), password)


def delete_password(account_id: str) -> None:
    if keyring.get_password(KEYCHAIN_SERVICE, keychain_account(account_id)):
        keyring.delete_password(KEYCHAIN_SERVICE, keychain_account(account_id))


class AccountStore:
    """The only writer of the accounts file. Reads go to disk: another vault's daemon may
    have written it (same reasoning as `models/connections.py`)."""

    def __init__(self, path: Path) -> None:
        self.path = path

    def load(self) -> AccountsFile:
        try:
            raw = json.loads(self.path.read_text(encoding="utf-8"))
            return AccountsFile.model_validate(raw)
        except OSError, ValueError:
            return AccountsFile()

    def save(self, data: AccountsFile) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.path.with_name(f".{self.path.name}.tmp-{os.getpid()}")
        tmp.write_text(
            json.dumps(data.model_dump(), indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
        )
        os.replace(tmp, self.path)

    def accounts(self) -> list[Account]:
        return list(self.load().accounts)

    def account(self, account_id: str) -> Account | None:
        return next((a for a in self.load().accounts if a.id == account_id), None)

    def add(
        self,
        email: str,
        *,
        name: str = "",
        host: str = "",
        port: int = IMAPS_PORT,
        username: str = "",
    ) -> Account:
        email = email.strip()
        if not domain_of(email):
            raise ValueError("Enter a full email address.")
        if domain_of(email) in SIGN_IN_ONLY and not host.strip():
            raise ValueError(SIGN_IN_ONLY_MESSAGE)
        server = host.strip() or host_for(email)
        if not server:
            raise ValueError("Enter the incoming mail (IMAP) server of this address.")
        data = self.load()
        user = username.strip() or email
        if any(a.host == server and a.username.lower() == user.lower() for a in data.accounts):
            raise ValueError("This account was already added.")
        account = Account(
            id="ma_" + uuid.uuid4().hex[:8],
            name=name.strip() or email,
            email=email,
            host=server,
            port=port,
            username=user,
            created_at=datetime.now(UTC).isoformat(),
        )
        data.accounts.append(account)
        self.save(data)
        return account

    def add_signed_in(
        self,
        email: str,
        *,
        host: str,
        smtp_host: str,
        smtp_port: int,
        client_id: str,
        sender_name: str = "",
    ) -> Account:
        """An account that signed in at its provider instead of giving a password."""
        data = self.load()
        if any(a.host == host and a.username.lower() == email.lower() for a in data.accounts):
            raise ValueError("This account was already added.")
        account = Account(
            id="ma_" + uuid.uuid4().hex[:8],
            name=email,
            email=email,
            host=host,
            username=email,
            created_at=datetime.now(UTC).isoformat(),
            sender_name=" ".join(sender_name.split())[:120],
            smtp_host=smtp_host,
            smtp_port=smtp_port,
            auth="microsoft",
            client_id=client_id,
        )
        data.accounts.append(account)
        self.save(data)
        return account

    def rename(self, account_id: str, name: str) -> Account:
        data = self.load()
        account = next((a for a in data.accounts if a.id == account_id), None)
        if account is None:
            raise KeyError(account_id)
        if name.strip():
            account.name = name.strip()
        self.save(data)
        return account

    def set_vaults(self, account_id: str, vaults: list[str]) -> Account:
        data = self.load()
        account = next((a for a in data.accounts if a.id == account_id), None)
        if account is None:
            raise KeyError(account_id)
        account.vaults = list(dict.fromkeys(v.strip() for v in vaults if v.strip()))
        self.save(data)
        return account

    def set_sending(
        self,
        account_id: str,
        *,
        sender_name: str | None = None,
        smtp_host: str | None = None,
        smtp_port: int | None = None,
    ) -> Account:
        data = self.load()
        account = next((a for a in data.accounts if a.id == account_id), None)
        if account is None:
            raise KeyError(account_id)
        if sender_name is not None:
            account.sender_name = " ".join(sender_name.split())
        if smtp_host is not None:
            account.smtp_host = smtp_host.strip()
        if smtp_port is not None:
            account.smtp_port = smtp_port
        self.save(data)
        return account

    def remove(self, account_id: str) -> None:
        data = self.load()
        data.accounts = [a for a in data.accounts if a.id != account_id]
        self.save(data)
