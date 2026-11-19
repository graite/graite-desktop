"""The signed-in Graite Cloud account of this computer.

Sign-in runs in the system browser (Authorization Code + PKCE, RFC 8252): the daemon builds
the authorize URL, the backend's own pages handle the password, and the browser comes back
to this daemon's loopback callback (`/api/v1/cloud/callback`) with a one-time code. The
tokens live only in the OS keychain, shared by every vault, and are never logged. Access
tokens are short-lived; `access_token()` refreshes them before they expire.
"""

from __future__ import annotations

import asyncio
import base64
import hashlib
import json
import logging
import platform
import secrets
import socket
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib.parse import urlencode

import httpx
import keyring
from pydantic import BaseModel

from graite import __version__

log = logging.getLogger(__name__)

CLIENT_ID = "graite-desktop"
CALLBACK_PATH = "/api/v1/cloud/callback"
LOGIN_TTL = 600  # seconds a started sign-in may take in the browser
REFRESH_MARGIN = 120  # refresh access tokens this long before they expire
# What one request to Graite Cloud may carry (the server enforces the same limits).
OCR_PAGES = 20
STT_SECONDS = 3600
UNREACHABLE = "Graite Cloud can’t be reached. Check your internet connection and try again."
KEYCHAIN_DOWN = "Your OS keychain is unavailable. Unlock it and try again."


class CloudUsage(BaseModel):
    limit: int | None
    used: int
    remaining: int | None
    percent_used: int | None
    resets_at: str


class CloudStatus(BaseModel):
    signed_in: bool
    cloud_url: str
    email: str | None = None
    plan: str | None = None
    # The plan's code; "free" is the default plan everyone starts on.
    plan_id: str | None = None
    email_verified: bool | None = None
    # An unconfirmed account stops working at this moment; null once confirmed.
    verify_by: str | None = None
    today: CloudUsage | None = None
    # Set when the account could not be reached; the rest may then be partial.
    error: str | None = None


class CloudModel(BaseModel):
    id: str
    name: str
    context_length: int | None = None
    available: bool = True
    min_plan: str | None = None


class Tokens(BaseModel):
    access_token: str
    refresh_token: str
    expires_at: float
    email: str


@dataclass
class _Pending:
    verifier: str
    redirect_uri: str
    expires_at: float


class CloudSession:
    def __init__(
        self,
        cloud_url: str,
        app_dir: Path,
        *,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        self.cloud_url = cloud_url.rstrip("/")
        self.app_dir = app_dir
        self.transport = transport
        self._pending: dict[str, _Pending] = {}
        self._lock = asyncio.Lock()

    @property
    def api_url(self) -> str:
        """The OpenAI-compatible base URL chat requests go to."""
        return f"{self.cloud_url}/v1"

    @property
    def account_url(self) -> str:
        return f"{self.cloud_url}/account"

    def _client(self) -> httpx.AsyncClient:
        return httpx.AsyncClient(
            base_url=self.cloud_url,
            timeout=httpx.Timeout(20, connect=10),
            transport=self.transport,
        )

    # --- keychain -------------------------------------------------------------------------

    def _account(self) -> str:
        return hashlib.sha256(f"cloud:{self.cloud_url}".encode()).hexdigest()

    def _read(self) -> Tokens | None:
        """Raises ValueError when the keychain cannot be read."""
        try:
            raw = keyring.get_password("Graite", self._account())
        except Exception as exc:
            raise ValueError(KEYCHAIN_DOWN) from exc
        try:
            tokens = Tokens.model_validate_json(raw) if raw else None
        except ValueError:
            tokens = None
        self._mark(tokens is not None)
        return tokens

    def _write(self, tokens: Tokens | None) -> None:
        try:
            if tokens is not None:
                keyring.set_password("Graite", self._account(), tokens.model_dump_json())
            elif keyring.get_password("Graite", self._account()):
                keyring.delete_password("Graite", self._account())
        except Exception as exc:
            raise ValueError(KEYCHAIN_DOWN) from exc
        self._mark(tokens is not None)

    # --- sign-in marker -------------------------------------------------------------------
    # Whether this computer is signed in, without reading the keychain: a flag next to the
    # install id in `cloud.json`, kept in step by every keychain read and write. All vaults'
    # daemons share the file, so a sign-in from one is seen by the others. It holds no secret;
    # requests still take their token from the keychain.

    def _state(self) -> dict[str, Any]:
        try:
            found = json.loads((self.app_dir / "cloud.json").read_text(encoding="utf-8"))
            return found if isinstance(found, dict) else {}
        except OSError, ValueError:
            return {}

    def _mark(self, signed_in: bool) -> None:
        state = self._state()
        key = f"signed_in:{self._account()}"
        if state.get(key) is signed_in:
            return
        state[key] = signed_in
        path = self.app_dir / "cloud.json"
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            temp = path.with_suffix(".json.tmp")
            temp.write_text(json.dumps(state), encoding="utf-8")
            temp.replace(path)
        except OSError:
            log.warning("Could not record the Graite Cloud sign-in state", exc_info=True)

    def install_id(self) -> str:
        return self._install_id()

    def _install_id(self) -> str:
        """A random id for this installation, so the account page can tell devices apart."""
        path = self.app_dir / "cloud.json"
        try:
            found = json.loads(path.read_text(encoding="utf-8")).get("install_id")
            if isinstance(found, str) and found:
                return found
        except OSError, ValueError:
            pass
        install_id = secrets.token_urlsafe(16)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps({**self._state(), "install_id": install_id}), encoding="utf-8")
        return install_id

    # --- sign-in ---------------------------------------------------------------------------

    def begin_login(self, port: int, *, signup: bool = False) -> str:
        """The URL to open in the browser. With `signup` it starts at "Create an account"
        and continues to the same authorization afterwards."""
        now = time.monotonic()
        self._pending = {s: p for s, p in self._pending.items() if p.expires_at > now}
        verifier = secrets.token_urlsafe(48)
        challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest())
        state = secrets.token_urlsafe(32)
        redirect_uri = f"http://127.0.0.1:{port}{CALLBACK_PATH}"
        self._pending[state] = _Pending(verifier, redirect_uri, now + LOGIN_TTL)
        query = urlencode(
            {
                "client_id": CLIENT_ID,
                "redirect_uri": redirect_uri,
                "state": state,
                "code_challenge": challenge.rstrip(b"=").decode(),
                "code_challenge_method": "S256",
                "install_id": self._install_id(),
                "device_name": (socket.gethostname() or "Graite desktop")[:100],
                "platform": platform.system().lower()[:64],
                "app_version": __version__,
            }
        )
        authorize = f"/auth/desktop/authorize?{query}"
        if signup:
            return f"{self.cloud_url}/signup?{urlencode({'next': authorize})}"
        return f"{self.cloud_url}{authorize}"

    def cancel_login(self, state: str) -> None:
        self._pending.pop(state, None)

    async def finish_login(self, state: str, code: str) -> str:
        """Exchange the browser's code for tokens. Returns the account's email."""
        pending = self._pending.pop(state, None)
        if pending is None or pending.expires_at < time.monotonic():
            raise ValueError("This sign-in link has expired. Start again from Graite.")
        try:
            async with self._client() as client:
                response = await client.post(
                    "/auth/desktop/token",
                    data={
                        "grant_type": "authorization_code",
                        "client_id": CLIENT_ID,
                        "code": code,
                        "redirect_uri": pending.redirect_uri,
                        "code_verifier": pending.verifier,
                    },
                )
        except httpx.HTTPError as exc:
            raise ValueError(UNREACHABLE) from exc
        if not response.is_success:
            raise ValueError("Graite Cloud did not accept this sign-in. Start again from Graite.")
        tokens = _tokens_from(response.json())
        await asyncio.to_thread(self._write, tokens)
        return tokens.email

    async def access_token(self) -> str | None:
        """A valid access token, refreshed when needed; None when signed out."""
        async with self._lock:
            # Re-read: another vault's daemon may have refreshed (and rotated) meanwhile.
            tokens = await asyncio.to_thread(self._read)
            if tokens is None:
                return None
            if tokens.expires_at - time.time() > REFRESH_MARGIN:
                return tokens.access_token
            try:
                async with self._client() as client:
                    response = await client.post(
                        "/auth/desktop/token",
                        data={
                            "grant_type": "refresh_token",
                            "client_id": CLIENT_ID,
                            "refresh_token": tokens.refresh_token,
                        },
                    )
            except httpx.HTTPError as exc:
                raise ValueError(UNREACHABLE) from exc
            if response.status_code in (400, 401):
                # The sign-in was revoked or expired: sign out here too.
                log.info("Graite Cloud refresh refused; signing out")
                await asyncio.to_thread(self._write, None)
                return None
            if not response.is_success:
                raise ValueError(f"Graite Cloud returned HTTP {response.status_code}.")
            fresh = _tokens_from(response.json(), email=tokens.email)
            await asyncio.to_thread(self._write, fresh)
            return fresh.access_token

    async def sign_out(self) -> None:
        tokens = await asyncio.to_thread(self._read)
        if tokens is not None:
            try:
                async with self._client() as client:
                    await client.post("/auth/desktop/revoke", data={"token": tokens.refresh_token})
            except httpx.HTTPError:
                pass  # signed out here either way; the sign-in expires on its own
        await asyncio.to_thread(self._write, None)

    # --- account ---------------------------------------------------------------------------

    async def _get(self, path: str) -> httpx.Response | None:
        """GET with the access token; None when signed out (or the sign-in was revoked)."""
        token = await self.access_token()
        if token is None:
            return None
        try:
            async with self._client() as client:
                response = await client.get(path, headers={"Authorization": f"Bearer {token}"})
        except httpx.HTTPError as exc:
            raise ValueError(UNREACHABLE) from exc
        if response.status_code == 401:
            await asyncio.to_thread(self._write, None)
            return None
        return response

    async def status(self) -> CloudStatus:
        signed_out = CloudStatus(signed_in=False, cloud_url=self.cloud_url)
        try:
            tokens = await asyncio.to_thread(self._read)
        except ValueError as exc:
            return signed_out.model_copy(update={"error": str(exc)})
        if tokens is None:
            return signed_out
        try:
            response = await self._get("/api/v1/usage")
        except ValueError as exc:
            return CloudStatus(
                signed_in=True, cloud_url=self.cloud_url, email=tokens.email, error=str(exc)
            )
        if response is None:
            return signed_out
        if not response.is_success:
            return CloudStatus(
                signed_in=True,
                cloud_url=self.cloud_url,
                email=tokens.email,
                error=f"Graite Cloud returned HTTP {response.status_code}.",
            )
        body = response.json()
        today = body.get("today") or {}
        return CloudStatus(
            signed_in=True,
            cloud_url=self.cloud_url,
            email=body.get("email") or tokens.email,
            plan=(body.get("plan") or {}).get("name"),
            plan_id=(body.get("plan") or {}).get("id"),
            email_verified=body.get("email_verified"),
            verify_by=body.get("verify_by"),
            today=CloudUsage(
                limit=today.get("limit"),
                used=int(today.get("used") or 0) + int(today.get("reserved") or 0),
                remaining=today.get("remaining"),
                percent_used=today.get("percent_used"),
                resets_at=str(today.get("resets_at") or ""),
            ),
        )

    def has_sign_in(self) -> bool:
        """Whether this computer is signed in to Graite Cloud, from the marker in `cloud.json`
        (no keychain, no network). Sign-ins made before the marker existed are recorded the
        first time the keychain is read anyway (cloud status, a chat request)."""
        return self._state().get(f"signed_in:{self._account()}") is True

    async def signed_in(self) -> bool:
        return await asyncio.to_thread(self.has_sign_in)

    async def _post(
        self, path: str, *, purpose: str, seconds: float, **kwargs: Any
    ) -> dict[str, Any]:
        """POST to Graite Cloud with the access token; the server's own words on failure."""
        from graite.models.providers import _graite_message

        token = await self.access_token()
        if token is None:
            raise ValueError("Sign in to Graite Cloud under Settings → Graite Cloud first.")
        headers = {"Authorization": f"Bearer {token}", "X-Graite-Purpose": purpose}
        try:
            async with httpx.AsyncClient(
                base_url=self.cloud_url,
                timeout=httpx.Timeout(seconds, connect=10),
                transport=self.transport,
            ) as client:
                response = await client.post(path, headers=headers, **kwargs)
        except httpx.HTTPError as exc:
            raise ValueError(UNREACHABLE) from exc
        if response.status_code == 401:
            await asyncio.to_thread(self._write, None)
            raise ValueError("Your Graite Cloud sign-in expired. Sign in again in Settings.")
        if not response.is_success:
            detail = response.text[:800]
            log.warning("Graite Cloud %s returned HTTP %s: %s", path, response.status_code, detail)
            raise ValueError(
                _graite_message(detail)
                or f"Graite Cloud could not finish this (HTTP {response.status_code})."
            )
        body = response.json()
        if not isinstance(body, dict):
            raise ValueError("Graite Cloud sent an answer Graite does not understand.")
        return body

    async def ocr(self, images: list[bytes]) -> list[dict[str, Any]]:
        """Text of up to `OCR_PAGES` PNG pages, read by Graite Cloud's OCR model."""
        body = await self._post(
            "/v1/ocr",
            purpose="ocr",
            seconds=600,
            json={
                "pages": [
                    {"image": "data:image/png;base64," + base64.b64encode(png).decode()}
                    for png in images
                ]
            },
        )
        pages = body.get("pages")
        if not isinstance(pages, list) or len(pages) != len(images):
            raise ValueError("Graite Cloud sent an answer Graite does not understand.")
        return [page if isinstance(page, dict) else {} for page in pages]

    async def transcribe(
        self, audio: bytes, *, filename: str, mime: str, purpose: str = "transcribe"
    ) -> dict[str, Any]:
        """Speech to text by Graite Cloud's Whisper; `purpose` "voice" for a live turn."""
        return await self._post(
            "/v1/audio/transcriptions",
            purpose=purpose,
            seconds=900 if purpose != "voice" else 30,
            files={"file": (filename, audio, mime)},
            data={"purpose": purpose},
        )

    async def models(self) -> list[CloudModel]:
        response = await self._get("/v1/models")
        if response is None:
            raise ValueError("Sign in to Graite Cloud first.")
        if not response.is_success:
            raise ValueError(f"Graite Cloud returned HTTP {response.status_code}.")
        found: list[CloudModel] = []
        for item in response.json().get("data", []):
            if not isinstance(item, dict) or not item.get("id"):
                continue
            traits: dict[str, Any] = item.get("graite") or {}
            if traits.get("kind", "chat") != "chat":  # OCR and Whisper are not chat models
                continue
            found.append(
                CloudModel(
                    id=str(item["id"]),
                    name=str(item.get("name") or item["id"]),
                    context_length=item.get("context_length"),
                    available=bool(traits.get("available", True)),
                    min_plan=traits.get("min_plan"),
                )
            )
        return found


def _tokens_from(body: dict[str, Any], *, email: str = "") -> Tokens:
    user = body.get("user") or {}
    return Tokens(
        access_token=str(body["access_token"]),
        refresh_token=str(body["refresh_token"]),
        expires_at=time.time() + float(body.get("expires_in") or 0),
        email=str(user.get("email") or email),
    )


_cloud: CloudSession | None = None


def get_cloud() -> CloudSession:
    if _cloud is None:
        raise RuntimeError("Graite Cloud is not set up in this process.")
    return _cloud


def set_cloud(cloud: CloudSession | None) -> None:
    global _cloud
    _cloud = cloud
