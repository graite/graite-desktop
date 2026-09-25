"""Normalize OpenAI-compatible and Anthropic streaming into one delta protocol."""

from __future__ import annotations

import json
import logging
from collections.abc import AsyncIterator
from typing import Any
from urllib.parse import urlsplit

import httpx

log = logging.getLogger("graite.models")

DEFAULT_MAX_TOKENS = 2048
# Fields we add for speed or quality that the answer itself does not depend on. Gateways spell
# them differently and some reject what they do not recognise, so a hint may never cost a turn:
# a 400 on a request carrying them is retried once without them. See `chat`.
OPTIONAL_HINTS = ("reasoning", "chat_template_kwargs", "reasoning_budget_tokens")
# Endpoints that refused them, as (url, model). `ModelManager.use` builds a fresh Provider per
# turn, so remembering here rather than on the instance keeps it to one retry per process.
_NO_HINTS: dict[tuple[str, str], set[str]] = {}
# Error codes of Graite Cloud whose `message` is written for the user ("You've run out of free
# credits today…"); for these the server's own words beat a generic "HTTP 429".
GRAITE_CODES = frozenset(
    {
        "quota_exceeded",
        "quota_insufficient",
        "email_not_verified",
        "model_not_in_plan",
        "concurrency_limit",
        "rate_limited",
        "capacity_reached",
    }
)
_MINIMAL_REASONING: set[tuple[str, str]] = set()


class _HintRejected(Exception):
    """The server refused an optional field. The same request without it may well work."""

    def __init__(self, detail: str) -> None:
        self.detail = detail


class Provider:
    def __init__(
        self, kind: str, url: str, model: str, key: str, *, max_tokens: int = DEFAULT_MAX_TOKENS
    ) -> None:
        self.kind, self.url, self.model, self.key = kind, url, model, key
        self.max_tokens = max_tokens
        self.metrics: dict[str, Any] = {}

    @property
    def is_openrouter(self) -> bool:
        return self.kind == "openrouter" or (urlsplit(self.url).hostname or "").endswith(
            "openrouter.ai"
        )

    def headers(self) -> dict[str, str]:
        if self.kind == "anthropic":
            return {"x-api-key": self.key, "anthropic-version": "2023-06-01"}
        headers = {"Authorization": f"Bearer {self.key}"} if self.key else {}
        if self.is_openrouter:
            # OpenRouter attributes usage to the app named here.
            headers.update(
                {"HTTP-Referer": "https://github.com/graite/graite-desktop", "X-Title": "Graite"}
            )
        return headers

    async def models(self) -> list[str]:
        return [m["id"] for m in await self.list_models()]

    async def list_models(self) -> list[dict[str, Any]]:
        """Models the endpoint offers: id, name and, where the API says so, context length
        and pricing (OpenRouter and Anthropic return more than the bare id)."""
        url = "https://api.anthropic.com/v1" if self.kind == "anthropic" else self.url
        async with httpx.AsyncClient(timeout=15) as client:
            response = await client.get(url + "/models", headers=self.headers())
            self.check(response)
            found: list[dict[str, Any]] = []
            for m in response.json().get("data", []):
                if not isinstance(m, dict) or not m.get("id"):
                    continue
                pricing = m.get("pricing") if isinstance(m.get("pricing"), dict) else None
                found.append(
                    {
                        "id": str(m["id"]),
                        "name": str(m.get("name") or m.get("display_name") or m["id"]),
                        "context_length": (
                            int(m["context_length"])
                            if isinstance(m.get("context_length"), int | float)
                            else None
                        ),
                        "pricing": (
                            {
                                "prompt": str(pricing.get("prompt", "")),
                                "completion": str(pricing.get("completion", "")),
                            }
                            if pricing
                            else None
                        ),
                    }
                )
            return sorted(found, key=lambda m: m["id"])

    async def embed(self, texts: list[str]) -> list[list[float]]:
        if self.kind == "anthropic":
            raise ValueError("Anthropic does not provide embeddings through this connection.")
        async with httpx.AsyncClient(timeout=120) as client:
            response = await client.post(
                self.url + "/embeddings",
                headers=self.headers(),
                json={"model": self.model, "input": texts},
            )
            self.check(response)
            return [
                list(map(float, row["embedding"]))
                for row in sorted(response.json()["data"], key=lambda row: row["index"])
            ]

    @staticmethod
    def check(response: httpx.Response) -> None:
        """Translate a failure into something the user can act on, and record what the server
        actually said. Only ever the response body: the request carries the user's pages."""
        if response.is_success:
            return
        try:
            detail = response.text[:800]
        except httpx.ResponseNotRead:  # a streaming response; `_failed` reads it first
            detail = ""
        log.warning(
            "model server %s returned HTTP %s: %s", response.url, response.status_code, detail
        )
        message = _graite_message(detail)
        if message:
            raise ValueError(message)
        if response.status_code in (401, 403):
            raise ValueError("The provider rejected the API key. Check it in Settings → Chat.")
        if response.status_code == 429:
            raise ValueError(
                "The provider is busy or your usage limit was reached. Try again later."
            )
        raise ValueError(f"The model server returned HTTP {response.status_code}.")

    def anthropic_body(
        self, messages: list[dict[str, Any]], tools: list[dict[str, Any]]
    ) -> dict[str, Any]:
        system = "\n".join(m["content"] for m in messages if m["role"] == "system")
        converted: list[dict[str, Any]] = []
        for m in messages:
            if m["role"] == "system":
                continue
            role = "user" if m["role"] == "tool" else m["role"]
            content: list[dict[str, Any]] = []
            if m["role"] == "tool":
                content.append(
                    {
                        "type": "tool_result",
                        "tool_use_id": m["tool_call_id"],
                        "content": m["content"],
                    }
                )
            else:
                raw = m.get("content")
                if isinstance(raw, list):
                    for part in raw:
                        if part.get("type") == "text" and part.get("text"):
                            content.append({"type": "text", "text": part["text"]})
                        elif part.get("type") == "image_url":
                            url = str(part.get("image_url", {}).get("url", ""))
                            header, _, data = url.partition(",")
                            media_type = (
                                header[5:].split(";", 1)[0]
                                if header.startswith("data:")
                                else "image/png"
                            )
                            content.append(
                                {
                                    "type": "image",
                                    "source": {
                                        "type": "base64",
                                        "media_type": media_type,
                                        "data": data,
                                    },
                                }
                            )
                elif raw:
                    content.append({"type": "text", "text": raw})
                for t in m.get("tool_calls", []):
                    content.append(
                        {
                            "type": "tool_use",
                            "id": t["id"],
                            "name": t["function"]["name"],
                            "input": json.loads(t["function"]["arguments"] or "{}"),
                        }
                    )
            if converted and converted[-1]["role"] == role:
                converted[-1]["content"].extend(content)
            else:
                converted.append({"role": role, "content": content})
        return {
            "model": self.model,
            "system": system,
            "messages": converted,
            "max_tokens": self.max_tokens,
            "stream": True,
            "tools": [
                {
                    "name": t["function"]["name"],
                    "description": t["function"]["description"],
                    "input_schema": t["function"]["parameters"],
                }
                for t in tools
            ],
        }

    def _body(
        self,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]],
        thinking: bool | None,
    ) -> tuple[str, dict[str, Any]]:
        """The endpoint and the JSON for one request."""
        if self.kind == "anthropic":
            return "https://api.anthropic.com/v1/messages", self.anthropic_body(messages, tools)
        body: dict[str, Any] = {
            "model": self.model,
            "messages": messages,
            "tools": tools,
            "stream": True,
            "max_tokens": self.max_tokens,
        }
        if not tools:
            body.pop("tools", None)
        if thinking is not None and self.kind in ("local", "compatible") and not self.is_openrouter:
            # llama-server and LM Studio pass this into the chat template.
            body["chat_template_kwargs"] = {"enable_thinking": thinking}
        if thinking is False and self.is_openrouter:
            # OpenRouter ignores chat_template_kwargs; "none" is its own off switch.
            body["reasoning"] = {"effort": "none"}
        if thinking is False and self.kind == "local":
            body["reasoning_budget_tokens"] = 0
        if self.kind == "local":
            body["stream_options"] = {"include_usage": True}
            body["cache_prompt"] = True  # llama-server reuses the KV prefix across turns
        return self.url + "/chat/completions", body

    async def _failed(self, url: str, response: httpx.Response, *, droppable: bool) -> None:
        """A non-2xx streaming response: say what the server said, in the log only.

        The response body is safe to record; the *request* body never is — it carries the
        system prompt, the page tree and whatever the assistant has read.
        """
        await response.aread()  # streaming responses carry no body until asked
        if droppable and response.status_code == 400:
            log.warning("model server %s returned HTTP 400: %s", url, response.text[:800])
            raise _HintRejected(response.text[:800])
        self.check(response)

    async def _once(
        self, url: str, body: dict[str, Any], *, droppable: bool
    ) -> AsyncIterator[dict[str, Any]]:
        """One request, its deltas. Raises `_HintRejected` before yielding anything, so the
        caller can retry without the optional fields and nobody downstream notices."""
        completed = False
        async with httpx.AsyncClient(timeout=httpx.Timeout(120, connect=15)) as client:
            async with client.stream("POST", url, headers=self.headers(), json=body) as response:
                if not response.is_success:
                    await self._failed(url, response, droppable=droppable)
                async for line in response.aiter_lines():
                    if not line.startswith("data:"):
                        continue
                    raw = line[5:].strip()
                    if raw == "[DONE]":
                        completed = True
                        break
                    try:
                        data = json.loads(raw)
                    except ValueError:
                        continue  # keep-alive or comment frame
                    if data.get("timings"):
                        self.metrics.update(data["timings"])
                    if data.get("usage"):
                        self.metrics.update(data["usage"])
                    if data.get("error") or data.get("type") == "error":
                        raise ValueError("The provider interrupted the answer. Please try again.")
                    if self.kind != "anthropic":
                        for choice in data.get("choices", []):
                            if choice.get("finish_reason"):
                                completed = True
                                if choice["finish_reason"] == "length":
                                    yield {"truncated": True}
                            yield choice.get("delta", {})
                    elif data["type"] == "message_stop":
                        completed = True
                    elif data["type"] == "message_delta":
                        if data.get("delta", {}).get("stop_reason") == "max_tokens":
                            yield {"truncated": True}
                    elif data["type"] == "content_block_start":
                        block = data["content_block"]
                        if block["type"] == "tool_use":
                            yield {
                                "tool_calls": [
                                    {
                                        "index": data["index"],
                                        "id": block["id"],
                                        "function": {"name": block["name"], "arguments": ""},
                                    }
                                ]
                            }
                    elif data["type"] == "content_block_delta":
                        delta = data["delta"]
                        if delta["type"] == "text_delta":
                            yield {"content": delta["text"]}
                        elif delta["type"] == "thinking_delta":
                            yield {"reasoning_content": delta["thinking"]}
                        elif delta["type"] == "input_json_delta":
                            yield {
                                "tool_calls": [
                                    {
                                        "index": data["index"],
                                        "function": {"arguments": delta["partial_json"]},
                                    }
                                ]
                            }
        if not completed:
            raise ValueError("Connection ended before the answer finished. Please try again.")

    async def chat(
        self,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]],
        *,
        thinking: bool | None = None,
    ) -> AsyncIterator[dict[str, Any]]:
        """`thinking=False` asks a reasoning model to answer directly (spoken replies cannot
        wait for it). Every gateway spells that differently, so we send the one its own API
        documents — and when a server refuses the hint, we drop the hint, not the turn."""
        url, body = self._body(messages, tools, thinking)
        endpoint = (self.url, self.model)
        hinted = [key for key in OPTIONAL_HINTS if key in body]
        for key in _NO_HINTS.get(endpoint, set()):
            body.pop(key, None)
        hinted = [key for key in hinted if key in body]
        # A mandatory-reasoning model cannot accept 'none'; use its smallest effort on
        # later turns instead of silently reverting to the provider's expensive default.
        if self.is_openrouter and thinking is False and endpoint in _MINIMAL_REASONING:
            body["reasoning"] = {"effort": "minimal"}
        try:
            async for delta in self._once(url, body, droppable=bool(hinted)):
                yield delta
            return
        except _HintRejected as exc:
            # Raised before the first delta, so nothing has been yielded twice. The server does
            # not say which field offended, so all of them go.
            log.info(
                "%s refused %s; sending without it from now on", self.url, " and ".join(hinted)
            )
            rejected = [key for key in hinted if key in exc.detail] or hinted
            _NO_HINTS.setdefault(endpoint, set()).update(rejected)
            for key in rejected:
                body.pop(key, None)
            if (
                "reasoning" in rejected
                and self.is_openrouter
                and thinking is False
                and any(
                    term in exc.detail.lower() for term in ("none", "mandatory", "cannot disable")
                )
            ):
                body["reasoning"] = {"effort": "minimal"}
                _MINIMAL_REASONING.add(endpoint)
        try:
            async for delta in self._once(url, body, droppable=endpoint in _MINIMAL_REASONING):
                yield delta
        except _HintRejected:
            _MINIMAL_REASONING.discard(endpoint)
            body.pop("reasoning", None)
            async for delta in self._once(url, body, droppable=False):
                yield delta


def _graite_message(detail: str) -> str | None:
    """The user-facing message of a Graite Cloud error body, if that is what this is."""
    try:
        error = json.loads(detail).get("error")
    except (ValueError, AttributeError):
        return None
    if not isinstance(error, dict) or error.get("code") not in GRAITE_CODES:
        return None
    message = error.get("message")
    return str(message)[:300] if message else None
