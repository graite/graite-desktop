"""Keeps a Linux keyring that does not answer from hanging the app.

A locked keyring (GNOME Keyring, KWallet) does not refuse a read: it waits for the user to
unlock it, for as long as that takes; and a read can also simply never get its answer. Every
caller already turns a keychain error into "unlock it and try again", so this turns the wait
into that error after a few seconds.

All reads and writes go through one worker thread, one at a time. When a call does not come
back, that worker is left to its wait and the next call, a while later, starts a fresh one: so
an unlocked keyring works again by itself, and one lost answer never blocks the keychain for
good. Until that next try, calls fail at once. Callers keep using `keyring`.
"""

from __future__ import annotations

import queue
import sys
import threading
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any

import keyring
from keyring.backend import KeyringBackend
from keyring.errors import KeyringLocked

WAIT_SECONDS = 5.0
# After a call that did not come back: when the next one is tried, doubling up to the cap,
# so a keyring locked all day leaves a few dozen waiting threads behind, not thousands.
RETRY_SECONDS = 15.0
RETRY_CAP_SECONDS = 600.0


@dataclass
class _Job:
    action: Callable[..., Any]
    args: tuple[str, ...]
    done: threading.Event = field(default_factory=threading.Event)
    dropped: bool = False
    result: Any = None
    failure: BaseException | None = None


class Guarded(KeyringBackend):
    priority = 1.0  # only ever wraps a working keyring (see `install`)

    def __init__(
        self, inner: KeyringBackend, wait: float = WAIT_SECONDS, retry: float = RETRY_SECONDS
    ) -> None:
        super().__init__()  # type: ignore[no-untyped-call]
        self.inner = inner
        self.wait = wait
        self.retry = retry
        self._lock = threading.Lock()
        self._jobs: queue.Queue[_Job] | None = None
        self._closed_until = 0.0
        self._next_retry = retry

    def _work(self, jobs: queue.Queue[_Job]) -> None:
        while True:
            job = jobs.get()
            if not job.dropped:
                try:
                    job.result = job.action(*job.args)
                except BaseException as exc:
                    job.failure = exc
                job.done.set()
            if self._jobs is not jobs:
                return  # this worker was given up on while it waited

    def _call(self, action: Callable[..., Any], *args: str) -> Any:
        job = _Job(action, args)
        with self._lock:
            if time.monotonic() < self._closed_until:
                raise KeyringLocked("the keyring does not answer")
            if self._jobs is None:
                self._jobs = queue.Queue()
                threading.Thread(
                    target=self._work, args=(self._jobs,), name="keychain", daemon=True
                ).start()
            jobs = self._jobs
            jobs.put(job)
        if not job.done.wait(self.wait):
            job.dropped = True
            with self._lock:
                if self._jobs is jobs:  # the first to notice gives this worker up
                    self._jobs = None
                    self._closed_until = time.monotonic() + self._next_retry
                    self._next_retry = min(self._next_retry * 2, RETRY_CAP_SECONDS)
            raise KeyringLocked("the keyring does not answer")
        with self._lock:
            self._next_retry = self.retry
        if job.failure is not None:
            raise job.failure
        return job.result

    def get_password(self, service: str, username: str) -> str | None:
        found: str | None = self._call(self.inner.get_password, service, username)
        return found

    def set_password(self, service: str, username: str, password: str) -> None:
        self._call(self.inner.set_password, service, username, password)

    def delete_password(self, service: str, username: str) -> None:
        self._call(self.inner.delete_password, service, username)


def install() -> None:
    """Called once at startup. Linux only: on macOS a read may rightly wait for the user to
    allow access, and neither macOS nor Windows waits on a locked store."""
    inner = keyring.get_keyring()
    if sys.platform.startswith("linux") and inner.priority > 0:
        keyring.set_keyring(Guarded(inner))
