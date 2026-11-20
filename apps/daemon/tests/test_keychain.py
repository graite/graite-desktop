from __future__ import annotations

import threading
import time

import pytest
from keyring.errors import KeyringLocked

from graite.keychain import Guarded
from tests.conftest import MemoryKeyring


class Stuck(MemoryKeyring):
    """Reads wait, like on a locked keyring, until `release` is set."""

    def __init__(self) -> None:
        super().__init__()
        self.release = threading.Event()
        self.reads = 0

    def get_password(self, service: str, username: str) -> str | None:
        self.reads += 1
        self.release.wait(10)
        return super().get_password(service, username)


def test_a_keyring_that_does_not_answer_is_an_error_not_a_hang() -> None:
    inner = Stuck()
    inner.values[("Graite", "a")] = "one"
    guarded = Guarded(inner, wait=0.05, retry=0.3)
    with pytest.raises(KeyringLocked):
        guarded.get_password("Graite", "a")
    # Until the next try is due, calls answer at once and nothing new starts waiting.
    started = time.monotonic()
    with pytest.raises(KeyringLocked):
        guarded.get_password("Graite", "a")
    with pytest.raises(KeyringLocked):
        guarded.set_password("Graite", "b", "two")
    assert time.monotonic() - started < 0.04
    assert inner.reads == 1 and ("Graite", "b") not in inner.values


def test_it_works_again_by_itself_even_if_the_first_call_never_returns() -> None:
    inner = Stuck()
    inner.values[("Graite", "a")] = "one"
    guarded = Guarded(inner, wait=0.05, retry=0.1)
    with pytest.raises(KeyringLocked):
        guarded.get_password("Graite", "a")
    # The first read is still waiting (its answer got lost); later reads come back.
    inner.get_password = lambda service, username: inner.values.get((service, username))  # type: ignore[method-assign]
    time.sleep(0.15)
    assert guarded.get_password("Graite", "a") == "one"
    guarded.set_password("Graite", "b", "two")
    guarded.delete_password("Graite", "a")
    assert inner.values == {("Graite", "b"): "two"}
    inner.release.set()


def test_calls_run_one_at_a_time() -> None:
    running, most = 0, 0
    gate = threading.Lock()

    class Counting(MemoryKeyring):
        def get_password(self, service: str, username: str) -> str | None:
            nonlocal running, most
            with gate:
                running += 1
                most = max(most, running)
            time.sleep(0.01)
            with gate:
                running -= 1
            return None

    guarded = Guarded(Counting(), wait=2)
    threads = [
        threading.Thread(target=guarded.get_password, args=("Graite", "a")) for _ in range(8)
    ]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    assert most == 1


def test_errors_from_the_keyring_pass_through() -> None:
    class Broken(MemoryKeyring):
        def get_password(self, service: str, username: str) -> str | None:
            raise RuntimeError("no keyring")

    with pytest.raises(RuntimeError):
        Guarded(Broken(), wait=1).get_password("Graite", "a")
