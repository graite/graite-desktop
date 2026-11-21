"""Keys and sealing for sync. Graite Cloud only ever holds what this module sealed.

Three keys, all 32 random bytes:
- the **account key**, made on the first device. Graite Cloud stores it wrapped with a key
  derived from the sync passphrase (Argon2id), so a new device needs the passphrase once;
- a **space key** per synced vault, stored wrapped with the account key;
- an X25519 key pair per account, for sharing later: its private half wrapped the same way.

Sealing is libsodium's XChaCha20-Poly1305 with a random nonce (PyNaCl). Nothing here is
invented: derive, seal, open.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import secrets
from collections.abc import Iterable
from typing import Any

from nacl import bindings, pwhash, utils
from nacl.exceptions import CryptoError
from nacl.public import PrivateKey

from graite.sync.words import WORDS

KEY_BYTES = 32
_NONCE = bindings.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES
# Argon2id "moderate": about a second and 256 MB, once per device.
PASSPHRASE_WORDS = 6
KDF_OPS = pwhash.argon2id.OPSLIMIT_MODERATE
KDF_MEM = pwhash.argon2id.MEMLIMIT_MODERATE
WRONG_PASSPHRASE = "That passphrase does not open this account's sync key."


def b64(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def unb64(text: str) -> bytes:
    try:
        return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))
    except ValueError as exc:
        raise ValueError("Not a sealed value.") from exc


def new_key() -> bytes:
    return utils.random(KEY_BYTES)


def seal(key: bytes, data: bytes) -> bytes:
    nonce = utils.random(_NONCE)
    return nonce + bindings.crypto_aead_xchacha20poly1305_ietf_encrypt(data, None, nonce, key)


def open_sealed(key: bytes, sealed: bytes) -> bytes:
    """Raises ValueError when the key is wrong or the bytes were changed."""
    try:
        return bindings.crypto_aead_xchacha20poly1305_ietf_decrypt(
            sealed[_NONCE:], None, sealed[:_NONCE], key
        )
    except (CryptoError, ValueError) as exc:
        raise ValueError("This could not be opened with the key.") from exc


def derive(passphrase: str, salt: bytes, ops: int, mem: int) -> bytes:
    return pwhash.argon2id.kdf(KEY_BYTES, normalize(passphrase).encode("utf-8"), salt, ops, mem)


def new_passphrase() -> str:
    """Six random words: easy to read off one device and type on another, and far too many
    possibilities to guess (Graite Cloud holds a key wrapped with it)."""
    return " ".join(secrets.choice(WORDS) for _ in range(PASSPHRASE_WORDS))


def normalize(passphrase: str) -> str:
    """Typed with capitals, dashes or extra spaces, it is still the same passphrase."""
    return " ".join(passphrase.lower().replace("-", " ").split())


def make_account(passphrase: str) -> tuple[bytes, dict[str, Any]]:
    """A new account key, and what Graite Cloud stores for it (all of it sealed or public)."""
    ops, mem = KDF_OPS, KDF_MEM
    account_key = new_key()
    salt = utils.random(pwhash.argon2id.SALTBYTES)
    private = PrivateKey.generate()
    stored = {
        "kdf_salt": b64(salt),
        "kdf_params": {"ops": ops, "mem": mem},
        "wrapped_account_key": b64(seal(derive(passphrase, salt, ops, mem), account_key)),
        "public_key": b64(bytes(private.public_key)),
        "wrapped_private_key": b64(seal(account_key, bytes(private))),
    }
    return account_key, stored


def unlock_account(passphrase: str, stored: dict[str, Any]) -> bytes:
    """The account key, from what Graite Cloud stores and the passphrase."""
    params = stored.get("kdf_params") or {}
    try:
        wrapping = derive(
            passphrase, unb64(str(stored["kdf_salt"])), int(params["ops"]), int(params["mem"])
        )
        return open_sealed(wrapping, unb64(str(stored["wrapped_account_key"])))
    except (KeyError, ValueError, CryptoError) as exc:
        raise ValueError(WRONG_PASSPHRASE) from exc


def check_account_key(account_key: bytes, stored: dict[str, Any]) -> bool:
    """Whether a key this device holds is still this account's (sync may have been reset)."""
    try:
        open_sealed(account_key, unb64(str(stored["wrapped_private_key"])))
    except KeyError, ValueError:
        return False
    return True


def state_digest(space_key: bytes, files: Iterable[tuple[str, str]]) -> str:
    """What a device holds, as a keyed hash over (path, content hash): equal on two devices
    exactly when their files are, and meaningless to anyone without the space key."""
    mac = hmac.new(space_key, digestmod=hashlib.sha256)
    for path, content_hash in sorted(files):
        mac.update(path.encode("utf-8") + b"\0" + content_hash.encode("ascii") + b"\n")
    return mac.hexdigest()
