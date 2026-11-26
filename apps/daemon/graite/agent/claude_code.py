"""Chat through the user's own Claude Code, signed in with their Claude subscription.

Graite holds no Anthropic credential here and never sees one. It starts the `claude` program
the user installed and signed in to themselves (through the Agent SDK, which speaks to that
program over its standard streams) and hands it the turn's tools. Signing in happens in
Claude Code's own flow (`claude auth login`); Graite only asks it "signed in or not"
(`claude auth status`). `claude setup-token` is never called: it would hand Graite a token.

Claude Code runs the tool loop itself, so `run` stands in for `agent/loop.run` and yields the
same events. Its own tools (files, shell, web) are switched off, the user's Claude Code
settings, skills, hooks and MCP servers are not loaded, and it works in an empty folder: the
vault is reached only through Graite's registry, so proposals, review and `cloud: local-only`
apply exactly as they do for every other cloud model.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import sys
import tempfile
from collections import deque
from collections.abc import AsyncIterator, Callable
from pathlib import Path
from typing import Any, Literal

from pydantic import BaseModel

from graite.models.providers import Provider
from graite.proc import NO_WINDOW

log = logging.getLogger("graite.claude_code")

KIND = "claude_code"
# Claude Code's own names for "the current model of this family": they follow its releases,
# so Graite has no model list of its own to keep up to date.
MODELS = ("sonnet", "opus", "haiku")
SERVER = "graite"
PREFIX = f"mcp__{SERVER}__"
INSTALL_URL = "https://claude.com/product/claude-code"

# Credentials in the daemon's environment that would take over from the subscription sign-in
# (Claude Code prefers each of them to it). The SDK merges onto the inherited environment and
# cannot remove a variable, so they are blanked; `status` runs the program itself and drops
# them. CLAUDE_CODE_OAUTH_TOKEN is in the list so that Graite never passes a token along.
_OVERRIDES = (
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_BASE_URL",
    "ANTHROPIC_PROFILE",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "CLAUDE_CODE_USE_BEDROCK",
    "CLAUDE_CODE_USE_VERTEX",
    "CLAUDE_CODE_USE_FOUNDRY",
    "CLAUDE_CODE_USE_ANTHROPIC_AWS",
)

Action = Literal["claude_install", "claude_login"]


class ClaudeCodeError(ValueError):
    """A failure the user can fix. `action` names the button that fixes it, if one does."""

    def __init__(self, message: str, action: Action | None = None) -> None:
        super().__init__(message)
        self.action = action


NOT_INSTALLED = "Claude Code is not installed. Set it up in Settings → Chat."
SIGNED_OUT = "Claude Code is signed out. Sign in again in Settings → Chat."
LIMIT = "Your Claude plan's usage limit was reached. Try again later or choose another model."


class ClaudeStatus(BaseModel):
    installed: bool = False
    signed_in: bool = False
    # How Claude Code is signed in: "claude.ai" is a subscription. Anything else (an API key,
    # a cloud provider) works too, but is billed there and not to a plan.
    method: str = ""
    plan: str = ""
    # Signed in with a Claude subscription: the only state the settings card calls connected.
    connected: bool = False


def find_cli() -> str | None:
    """The user's installed `claude`, or None. Never the copy bundled with the SDK."""
    from graite.mcp.clients import _which

    found = _which("claude")
    if found and sys.platform == "win32" and found.lower().endswith((".cmd", ".bat")):
        # npm's shim: the SDK refuses batch files, and the native install sits next to it.
        native = Path.home() / ".local" / "bin" / "claude.exe"
        return str(native) if native.is_file() else None
    return found


def clean_env() -> dict[str, str]:
    """The daemon's environment without credentials that would replace the sign-in."""
    return {k: v for k, v in os.environ.items() if k.upper() not in _OVERRIDES}


def _blanks() -> dict[str, str]:
    return {k: "" for k in os.environ if k.upper() in _OVERRIDES}


async def status() -> ClaudeStatus:
    """Whether Claude Code is installed and signed in. Reads yes or no, never a token."""
    cli = find_cli()
    if cli is None:
        return ClaudeStatus()
    try:
        process = await asyncio.create_subprocess_exec(
            cli,
            "auth",
            "status",
            stdin=asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL,
            env=clean_env(),
            creationflags=NO_WINDOW,
        )
        try:
            out, _ = await asyncio.wait_for(process.communicate(), 20)
        except TimeoutError:
            process.kill()
            await process.wait()
            return ClaudeStatus(installed=True)
        data = json.loads(out.decode(errors="replace") or "{}")
    except OSError, ValueError:
        return ClaudeStatus(installed=True)
    if not isinstance(data, dict):
        return ClaudeStatus(installed=True)
    signed_in = bool(data.get("loggedIn"))
    method = str(data.get("authMethod") or "") if signed_in else ""
    return ClaudeStatus(
        installed=True,
        signed_in=signed_in,
        method=method,
        plan=str(data.get("subscriptionType") or "") if signed_in else "",
        connected=signed_in and method == "claude.ai",
    )


def _text(blocks: list[dict[str, Any]]) -> str:
    return "\n".join(
        b["text"] if b["type"] == "text" else "[image]" if b["type"] == "image" else ""
        for b in blocks
    ).strip()


def prompt_of(messages: list[dict[str, Any]]) -> tuple[str, list[dict[str, Any]]]:
    """Graite's chat messages as a system prompt and one user message for Claude Code.

    Claude Code takes a new message, not a transcript, so earlier turns go in front of the
    current message as text. Tool calls from earlier turns are not replayed: their results
    are already reflected in the answers that followed.
    """
    body = Provider(KIND, "", "", "").anthropic_body(messages, [], cache=False)
    turns = [
        {
            "role": m["role"],
            "content": [b for b in m["content"] if b["type"] in ("text", "image")],
        }
        for m in body["messages"]
    ]
    turns = [t for t in turns if t["content"]]
    if not turns:
        raise ValueError("There is no message to answer.")
    last = turns[-1]["content"] if turns[-1]["role"] == "user" else []
    earlier = turns[:-1] if last else turns
    if not earlier:
        return body["system"], last
    history = "\n\n".join(
        f"{'User' if t['role'] == 'user' else 'Assistant'}: {_text(t['content'])}" for t in earlier
    )
    intro = {
        "type": "text",
        "text": f"<conversation_so_far>\n{history}\n</conversation_so_far>",
    }
    return body["system"], [intro, *(last or [{"type": "text", "text": "Continue."}])]


def _workdir() -> str:
    """An empty folder for Claude Code to start in: never the vault, never a project."""
    folder = Path(tempfile.gettempdir()) / "graite-claude-code"
    folder.mkdir(mode=0o700, exist_ok=True)
    return str(folder)


def _failure(kind: str | None, text: str = "") -> ClaudeCodeError:
    """What Claude Code reported, as a message the user can act on. The kind it names wins;
    its wording is only read when it names none."""
    lowered = text.lower()
    if kind in ("rate_limit", "billing_error"):
        return ClaudeCodeError(LIMIT)
    if kind == "authentication_failed" or "/login" in lowered or "not logged in" in lowered:
        return ClaudeCodeError(SIGNED_OUT, "claude_login")
    if "usage limit" in lowered:
        return ClaudeCodeError(LIMIT)
    return ClaudeCodeError(
        "Claude Code could not answer. Try again, or check it in Settings → Chat."
    )


def _round_end(number: int, thought: str) -> dict[str, Any]:
    return {"type": "round_end", "round": number, "thinking": thought.strip()}


class ClaudeCodeProvider(Provider):
    """The provider the rest of the daemon sees. `chat` is one answer without tools, which
    is all its direct callers ask for (titles, summaries, Quick and Deep answers, the
    settings check); a turn with tools goes through `run` below."""

    def __init__(self, model: str, *, max_tokens: int, cli: str) -> None:
        super().__init__(KIND, "", model, "", max_tokens=max_tokens)
        self.cli = cli

    def reasoning(self) -> dict[str, bool]:
        # No off switch: the current Claude models refuse a request that disables thinking.
        return {"toggle": False, "effort": True}

    def headers(self) -> dict[str, str]:
        return {}

    async def models(self) -> list[str]:
        return list(MODELS)

    async def list_models(self) -> list[dict[str, Any]]:
        return [{"id": name} for name in MODELS]

    async def embed(self, texts: list[str]) -> list[list[float]]:
        raise ValueError("Claude Code cannot make embeddings. Choose an embedding model.")

    async def chat(
        self,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]],
        *,
        thinking: bool | None = None,
        effort: str | None = None,
    ) -> AsyncIterator[dict[str, Any]]:
        if tools:
            raise ValueError("Claude Code runs its own tool loop; use agent.claude_code.run.")
        async for item in _session(self, messages, None, 1, thinking, effort):
            if item["type"] == "token":
                yield {"content": item["text"]}
            elif item["type"] == "thinking":
                yield {"reasoning_content": item["text"]}
            elif item["type"] == "answer" and item.get("unstreamed"):
                yield {"content": item["text"]}


def _options(
    provider: ClaudeCodeProvider,
    system: str,
    server: Any,
    names: list[str],
    max_turns: int,
    thinking: bool | None,
    effort: str | None,
    stderr: Callable[[str], None],
) -> Any:
    from claude_agent_sdk import ClaudeAgentOptions

    options = ClaudeAgentOptions(
        system_prompt=system or "You are a helpful assistant.",
        tools=[],  # none of Claude Code's own: no files, no shell, no web
        mcp_servers={SERVER: server} if server is not None else {},
        allowed_tools=[PREFIX + name for name in names],
        strict_mcp_config=True,  # not the user's MCP servers or claude.ai connectors
        setting_sources=[],  # not the user's settings, hooks or CLAUDE.md
        permission_mode="dontAsk",  # anything not allowed above is refused, never asked
        max_turns=max_turns,
        cli_path=provider.cli,
        cwd=_workdir(),
        env=_blanks(),
        include_partial_messages=True,
        # Graite keeps the conversation; Claude Code's own history stays out of it.
        extra_args={"no-session-persistence": None, "disable-slash-commands": None},
        stderr=stderr,
    )
    if provider.model and provider.model != "default":
        options.model = provider.model
    if thinking is False:
        # Asking for no thinking is refused by the newer models; the least effort is the
        # nearest thing every one of them accepts.
        options.effort = "low"
    else:
        options.thinking = {"type": "adaptive", "display": "summarized"}
        if effort in ("low", "medium", "high"):
            options.effort = effort  # type: ignore[assignment]
    return options


async def _session(
    provider: ClaudeCodeProvider,
    messages: list[dict[str, Any]],
    registry: Any,
    max_turns: int,
    thinking: bool | None,
    effort: str | None,
    max_tool_calls: int | None = None,
) -> AsyncIterator[dict[str, Any]]:
    """One Claude Code session as the agent loop's events.

    The session runs in a task of its own and reports through a queue: the SDK's streams
    must be opened and closed by the same task, and this generator may be closed from
    another one when a turn is cancelled.
    """
    from claude_agent_sdk import (
        AssistantMessage,
        ClaudeSDKClient,
        CLINotFoundError,
        RateLimitEvent,
        ResultMessage,
        StreamEvent,
        create_sdk_mcp_server,
        tool,
    )

    system, content = prompt_of(messages)
    queue: asyncio.Queue[dict[str, Any]] = asyncio.Queue()
    errors: deque[str] = deque(maxlen=20)
    state = {"round": 0, "executed": 0}
    writing = asyncio.Lock()
    parallel_safe = getattr(registry, "parallel_safe", lambda _: False)

    def handler(name: str) -> Callable[[dict[str, Any]], Any]:
        async def call(args: dict[str, Any]) -> dict[str, Any]:
            if max_tool_calls is not None and state["executed"] >= max_tool_calls:
                return {
                    "content": [
                        {
                            "type": "text",
                            "text": json.dumps(
                                {
                                    "error": "No tool calls are left in this turn. Finish "
                                    "with what the tools confirmed and say what is left."
                                }
                            ),
                        }
                    ],
                    "is_error": True,
                }
            state["executed"] += 1
            call_id = f"call-{state['round']}-{state['executed']}"
            arguments = json.dumps(args, ensure_ascii=False)
            await queue.put(
                {
                    "type": "tool_start",
                    "id": call_id,
                    "round": state["round"],
                    "name": name,
                    "arguments": arguments,
                }
            )
            if parallel_safe(name):
                result = await registry.invoke(name, arguments)
            else:
                async with writing:  # one change at a time, as in Graite's own loop
                    result = await registry.invoke(name, arguments)
            await queue.put(
                {
                    "type": "tool_end",
                    "id": call_id,
                    "round": state["round"],
                    "name": name,
                    "result": json.loads(result),
                }
            )
            return {"content": [{"type": "text", "text": result}]}

        return call

    schemas = registry.schemas() if registry is not None and max_turns > 1 else []
    names = [s["function"]["name"] for s in schemas]
    server = (
        create_sdk_mcp_server(
            SERVER,
            tools=[
                tool(
                    s["function"]["name"],
                    s["function"].get("description", ""),
                    s["function"].get("parameters") or {"type": "object", "properties": {}},
                )(handler(s["function"]["name"]))
                for s in schemas
            ],
        )
        if schemas
        else None
    )
    options = _options(provider, system, server, names, max_turns, thinking, effort, errors.append)

    async def one_message() -> AsyncIterator[dict[str, Any]]:
        yield {
            "type": "user",
            "message": {"role": "user", "content": content},
            "parent_tool_use_id": None,
        }

    async def pump() -> None:
        try:
            async with ClaudeSDKClient(options=options) as client:
                await client.query(one_message())
                async for message in client.receive_response():
                    await queue.put({"type": "sdk", "message": message})
            await queue.put({"type": "done"})
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001 - reported to the reader below
            await queue.put({"type": "done", "error": exc})

    task = asyncio.create_task(pump())
    text = thought = ""
    used_tools = closed = False
    failed: str | None = None
    final = ""
    try:
        while True:
            item = await queue.get()
            if item["type"] == "done":
                exc = item.get("error")
                if exc is None:
                    raise ValueError("Claude Code ended before it answered. Please try again.")
                if isinstance(exc, CLINotFoundError):
                    raise ClaudeCodeError(NOT_INSTALLED, "claude_install") from exc
                log.warning("Claude Code failed: %s; stderr: %s", exc, " | ".join(errors)[-800:])
                raise _failure(failed, " ".join(errors)) from exc
            if item["type"] == "tool_start":
                if not closed:
                    # The call arrives before the message that asked for it has ended.
                    closed = True
                    yield {
                        "type": "round_end",
                        "round": state["round"],
                        "thinking": thought.strip(),
                    }
                    yield {"type": "reset"}
                yield item
                continue
            if item["type"] == "tool_end":
                yield item
                result = item["result"]
                if (
                    item["name"] == "request_clarification"
                    and isinstance(result, dict)
                    and result.get("question")
                ):
                    yield {"type": "token", "text": result["question"]}
                    yield {"type": "answer", "text": "CLARIFY: " + result["question"]}
                    return
                continue
            message = item["message"]
            if isinstance(message, StreamEvent):
                if message.parent_tool_use_id:
                    continue
                event = message.event
                kind = event.get("type")
                if kind == "message_start":
                    state["round"] += 1
                    text = thought = ""
                    used_tools = closed = False
                    yield {"type": "round_start", "round": state["round"]}
                elif kind == "content_block_start":
                    used_tools |= event.get("content_block", {}).get("type") == "tool_use"
                elif kind == "content_block_delta":
                    delta = event.get("delta", {})
                    if delta.get("type") == "text_delta" and delta.get("text"):
                        text += delta["text"]
                        yield {"type": "token", "text": delta["text"]}
                    elif delta.get("type") == "thinking_delta" and delta.get("thinking"):
                        thought += delta["thinking"]
                        yield {"type": "thinking", "text": delta["thinking"]}
                elif kind == "message_delta":
                    usage = event.get("usage") or {}
                    read = sum(
                        int(usage.get(key) or 0)
                        for key in (
                            "input_tokens",
                            "cache_creation_input_tokens",
                            "cache_read_input_tokens",
                        )
                    )
                    metrics = provider.metrics
                    metrics["input_tokens"] = metrics.get("input_tokens", 0) + read
                    metrics["output_tokens"] = metrics.get("output_tokens", 0) + int(
                        usage.get("output_tokens") or 0
                    )
                elif kind == "message_stop":
                    if not closed:
                        closed = True
                        yield {
                            "type": "round_end",
                            "round": state["round"],
                            "thinking": thought.strip(),
                        }
                        if used_tools:
                            yield {"type": "reset"}
                    if not used_tools:
                        final = text
            elif isinstance(message, AssistantMessage):
                if message.error:
                    failed = str(message.error)
            elif isinstance(message, RateLimitEvent):
                if message.rate_limit_info.status == "rejected":
                    failed = failed or "rate_limit"
            elif isinstance(message, ResultMessage):
                if message.subtype == "error_max_turns":
                    raise ValueError(
                        "The assistant reached its step limit. Ask it to continue the "
                        "remaining work."
                    )
                if message.is_error or failed:
                    log.warning(
                        "Claude Code turn failed: %s %s %s",
                        message.subtype,
                        failed,
                        message.api_error_status,
                    )
                    raise _failure(failed, message.result or "")
                answer = final.strip() or (message.result or "").strip()
                if not answer:
                    raise ValueError(
                        "The model returned no answer. Try again or choose another model."
                    )
                yield {"type": "answer", "text": answer, "unstreamed": not final.strip()}
                return
    finally:
        task.cancel()
        try:
            await task
        except BaseException:  # noqa: BLE001 - the session is over either way
            pass


async def run(
    provider: Provider,
    messages: list[dict[str, Any]],
    registry: Any,
    *,
    max_rounds: int = 10,
    thinking: bool | None = None,
    effort: str | None = None,
    context_size: int | None = None,
    max_tool_calls: int | None = None,
    nudge: Callable[[str], str | None] | None = None,
) -> AsyncIterator[dict[str, Any]]:
    """`agent/loop.run` for Claude Code: the same arguments, the same events.

    `context_size` and `nudge` are for small local models (Claude Code keeps its own context
    in bounds, and Claude does not announce a read without making it) and are not used."""
    if not isinstance(provider, ClaudeCodeProvider):
        raise TypeError("run() needs a ClaudeCodeProvider.")
    async for item in _session(
        provider, messages, registry, max(1, max_rounds), thinking, effort, max_tool_calls
    ):
        item.pop("unstreamed", None)
        yield item
