"""Keeps every account's local copy fresh: one task per account, so a slow or broken
account never holds up another.

New mail is looked for every `POLL_SECONDS` while Graite runs, and at once when asked
(`refresh`). Nothing is fetched while the app is closed.
"""

from __future__ import annotations

import asyncio
import logging
import shutil
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path

from graite.events import EventBus
from graite.mail import imap, oauth, send
from graite.mail.accounts import Account, AccountStore
from graite.mail.drafts import DraftStore
from graite.mail.store import MailBox

log = logging.getLogger("graite.mail")

POLL_SECONDS = 120.0
# After a failure the next try waits longer each time, up to this.
RETRY_CAP_SECONDS = 1800.0


@dataclass
class Status:
    state: str = "waiting"  # "waiting" | "syncing" | "ok" | "error"
    error: str = ""
    needs_password: bool = False
    synced_at: str = ""


class MailService:
    def __init__(
        self,
        accounts: AccountStore,
        folder: Path,
        events: EventBus,
        connect: imap.Connect = imap.open_connection,
        smtp: send.Connect = send.open_smtp,
    ) -> None:
        self.accounts = accounts
        self.folder = folder
        self.events = events
        self.connect = connect
        self.smtp = smtp
        self.drafts = DraftStore(accounts.path.with_name("mail-drafts.json"))
        self._tasks: dict[str, asyncio.Task[None]] = {}
        self._wake: dict[str, asyncio.Event] = {}
        self._status: dict[str, Status] = {}
        self._boxes: dict[str, MailBox] = {}

    async def start(self) -> None:
        for account in self.accounts.accounts():
            self.watch(account.id)

    async def stop(self) -> None:
        tasks = list(self._tasks.values())
        self._tasks.clear()
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)

    def box(self, account_id: str) -> MailBox:
        box = self._boxes.get(account_id)
        if box is None:
            box = self._boxes[account_id] = MailBox(self.folder / account_id)
        return box

    def status(self, account_id: str) -> Status:
        return self._status.setdefault(account_id, Status())

    def watch(self, account_id: str) -> None:
        """Start keeping an account fresh (at startup and when one is added)."""
        if account_id in self._tasks:
            return
        self._wake[account_id] = asyncio.Event()
        self._tasks[account_id] = asyncio.create_task(self._run(account_id))

    def refresh(self, account_id: str) -> None:
        wake = self._wake.get(account_id)
        if wake is not None:
            wake.set()

    async def forget(self, account_id: str) -> None:
        """Stop an account's task and delete its local copy."""
        task = self._tasks.pop(account_id, None)
        if task is not None:
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)
        self._wake.pop(account_id, None)
        self._status.pop(account_id, None)
        self._boxes.pop(account_id, None)
        oauth.forget(account_id)
        await asyncio.to_thread(shutil.rmtree, self.folder / account_id, True)
        await asyncio.to_thread(self.drafts.remove_account, account_id)

    def _publish(self, account_id: str, **data: object) -> None:
        self.events.publish("mail_changed", {"account_id": account_id, **data})

    async def _run(self, account_id: str) -> None:
        wake = self._wake[account_id]
        delay = POLL_SECONDS
        while True:
            account = self.accounts.account(account_id)
            if account is None:
                return  # removed by another vault's daemon
            failed = not await self._sync(account)
            delay = min(delay * 2, RETRY_CAP_SECONDS) if failed else POLL_SECONDS
            try:
                await asyncio.wait_for(wake.wait(), delay)
            except TimeoutError:
                pass
            wake.clear()

    async def _sync(self, account: Account) -> bool:
        status = self.status(account.id)
        status.state = "syncing"
        self._publish(account.id, state="syncing")
        box = self.box(account.id)
        try:
            password = await asyncio.to_thread(oauth.secret, account)
            result = await asyncio.to_thread(
                imap.sync,
                account,
                password,
                box,
                connect=self.connect,
                on_folder=lambda _: self._publish(account.id, state="syncing"),
            )
        except imap.MailError as exc:
            status.state, status.error, status.needs_password = "error", str(exc), exc.auth
            self._publish(account.id, state="error")
            return False
        except asyncio.CancelledError:
            raise
        except Exception:
            # The keychain not answering, a full disk: say so and try again later.
            log.exception("mail sync failed")
            status.state, status.error = "error", "Mail could not be updated. Graite will retry."
            status.needs_password = False
            self._publish(account.id, state="error")
            return False
        status.state, status.error, status.needs_password = "ok", "", False
        status.synced_at = datetime.now(UTC).isoformat()
        self._publish(account.id, state="ok", new=result.new)
        return True
