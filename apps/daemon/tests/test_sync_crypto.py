"""Keys and sealing for sync (graite/sync/crypto.py)."""

from __future__ import annotations

import pytest
from nacl import pwhash

from graite.sync import crypto


@pytest.fixture(autouse=True)
def fast_kdf(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(crypto, "KDF_OPS", pwhash.argon2id.OPSLIMIT_MIN)
    monkeypatch.setattr(crypto, "KDF_MEM", pwhash.argon2id.MEMLIMIT_MIN)


def test_the_passphrase_opens_the_account_key_and_nothing_else_does() -> None:
    key, stored = crypto.make_account("correct horse battery")
    assert crypto.unlock_account("correct horse battery", stored) == key
    with pytest.raises(ValueError, match="passphrase"):
        crypto.unlock_account("wrong horse battery", stored)
    # What Graite Cloud stores never contains the key itself.
    assert crypto.b64(key) not in str(stored)
    assert set(stored) == {
        "kdf_salt",
        "kdf_params",
        "wrapped_account_key",
        "public_key",
        "wrapped_private_key",
    }


def test_a_device_can_tell_its_key_is_no_longer_the_accounts() -> None:
    key, stored = crypto.make_account("correct horse battery")
    assert crypto.check_account_key(key, stored)
    assert not crypto.check_account_key(crypto.new_key(), stored)


def test_sealed_bytes_open_only_unchanged_and_with_the_key() -> None:
    key = crypto.new_key()
    sealed = crypto.seal(key, b"Projects/Atlas/page.md")
    assert b"Atlas" not in sealed
    assert crypto.open_sealed(key, sealed) == b"Projects/Atlas/page.md"
    assert crypto.seal(key, b"same") != crypto.seal(key, b"same")
    tampered = sealed[:-1] + bytes([sealed[-1] ^ 1])
    for bad_key, bad_bytes in ((key, tampered), (crypto.new_key(), sealed), (key, b"short")):
        with pytest.raises(ValueError):
            crypto.open_sealed(bad_key, bad_bytes)


def test_the_digest_depends_on_the_files_and_the_key_not_their_order() -> None:
    key = crypto.new_key()
    files = [("b/page.md", "2" * 64), ("a/page.md", "1" * 64)]
    assert crypto.state_digest(key, files) == crypto.state_digest(key, reversed(files))
    assert crypto.state_digest(key, files) != crypto.state_digest(key, files[:1])
    assert crypto.state_digest(key, files) != crypto.state_digest(crypto.new_key(), files)


def test_a_passphrase_is_six_words_and_forgiving_to_type() -> None:
    phrase = crypto.new_passphrase()
    assert len(phrase.split()) == 6 and phrase == crypto.normalize(phrase)
    assert len(set(crypto.WORDS)) == len(crypto.WORDS) > 7700
    assert crypto.new_passphrase() != phrase
    assert crypto.normalize("  Abacus-Yoyo   zebra ") == "abacus yoyo zebra"
