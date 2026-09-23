"""MCP server over the write-free skills registry (docs/design/remote-api-mobile.md, D7).

An MCP client gets exactly the tools a Graite agent has in Act mode: read, search, propose.
Every change it makes is a proposal in the review queue, and the page's autonomy policy
decides whether it is applied, as for any other agent. There is no write tool to call.

The client is an external, usually cloud-hosted model, so it is scoped like a cloud
provider: pages under `cloud: local-only` cannot be read, searched or proposed against.
"""

from __future__ import annotations

import asyncio
import json
import re
from collections.abc import Callable
from typing import Any

import mcp.types as types
from mcp.server.lowlevel import Server
from mcp.server.streamable_http_manager import StreamableHTTPSessionManager
from starlette.responses import JSONResponse
from starlette.types import Receive, Send
from starlette.types import Scope as AsgiScope

from graite import __version__
from graite.config import Settings
from graite.retrieval.scope import ResolvedScope, Scope
from graite.retrieval.scope import resolve as resolve_scope
from graite.retrieval.search import Searcher
from graite.skills import tools as tool_module
from graite.skills.registry import PROPOSE_GROUPS, Registry

CLIENT_HEADER = "x-graite-mcp-client"
# `schedule` queues a local agent run, and a local run may read `cloud: local-only` pages.
# Exposed here it would let a cloud client copy such a page somewhere it is allowed to read.
EXCLUDED = frozenset({"schedule", "search_memory"})  # memory belongs to the assistant

INSTRUCTIONS = (
    "Graite is the user's local knowledge workspace: pages of markdown in a folder tree. "
    "Paths are vault-relative, for example `Projects/Atlas`. Use search_vault and read_page "
    "to find and read pages. You cannot write directly: every propose_* tool files a proposal "
    "that the user reviews in Graite (some pages apply proposals automatically). Tell the "
    "user when a change is waiting for their review. Pages the user keeps local-only are "
    "not available to you."
)


def client_name(headers: dict[str, str]) -> str:
    """A short label for the review queue, from the bridge header or the User-Agent."""
    raw = headers.get(CLIENT_HEADER) or headers.get("user-agent", "").split("/")[0]
    return re.sub(r"[^a-zA-Z0-9._ -]", "", raw).strip()[:40] or "client"


class McpService:
    """Builds the MCP server for one daemon app. A registry is created per request."""

    def __init__(self, state: Callable[[], Any], settings: Settings) -> None:
        self._state = state
        self._settings = settings
        self._scope: tuple[int, ResolvedScope] | None = None
        self.server: Server[Any, Any] = Server(
            "graite", version=__version__, instructions=INSTRUCTIONS
        )
        # Stateless JSON: the daemon gets a new port and token on every launch, so a session
        # would not outlive it anyway, and no tool streams or calls back into the client.
        self.manager = StreamableHTTPSessionManager(
            self.server, json_response=True, stateless=True, security_settings=None
        )
        self._register()

    async def _resolved(self) -> ResolvedScope:
        state = self._state()
        epoch: int = state.fileops.epoch
        if self._scope is None or self._scope[0] != epoch:
            # The whole policy cascade is resolved per page; cache it until the vault changes.
            scope = await asyncio.to_thread(
                resolve_scope, state.db, self._settings.vault, Scope("vault"), cloud_provider=True
            )
            self._scope = (epoch, scope)
        return self._scope[1]

    def _client(self) -> str:
        try:
            request = self.server.request_context.request
        except LookupError:
            return "client"
        headers = getattr(request, "headers", None)
        return client_name({k.lower(): v for k, v in headers.items()}) if headers else "client"

    async def registry(self) -> Registry:
        """A fresh registry: `load_skill` narrows it, so it must not outlive one call."""
        state = self._state()
        registry = Registry(
            state.fileops,
            await self._resolved(),
            searcher=Searcher(state.db, None),  # keyword search: never evicts the chat model
            groups=PROPOSE_GROUPS,
        )
        registry.allowed -= EXCLUDED
        registry.proposals = state.proposals
        registry.state = None
        # The conversation id keeps `list_proposals` to this client's own proposals, and
        # `cloud_model` makes the policy refuse local-only pages even if the scope let one by.
        registry.turn = {
            "run_id": None,
            "conversation_id": f"mcp:{self._client()}",
            "cloud_model": True,
        }
        await registry.load_library(None)
        return registry

    def _register(self) -> None:
        server = self.server

        @server.list_tools()  # type: ignore[no-untyped-call, untyped-decorator]
        async def list_tools() -> list[types.Tool]:
            registry = await self.registry()
            skills = registry.skill_index()
            result = []
            for tool in tool_module.TOOLS.values():
                if tool.name not in registry.allowed or tool.group not in registry.groups:
                    continue
                description = tool.description
                if tool.name == "load_skill" and skills:
                    description += "\n\nAvailable skills:\n" + skills
                result.append(
                    types.Tool(
                        name=tool.name,
                        description=description,
                        inputSchema=tool.schema["function"]["parameters"],
                    )
                )
            return result

        # The registry validates arguments itself and reports problems as tool errors.
        @server.call_tool(validate_input=False)  # type: ignore[untyped-decorator]
        async def call_tool(name: str, arguments: dict[str, Any]) -> types.CallToolResult:
            registry = await self.registry()
            try:
                text = await registry.invoke(name, json.dumps(arguments or {}))
            finally:
                registry.searcher.release()
            try:
                failed = "error" in json.loads(text)
            except (ValueError, TypeError):
                failed = False
            return types.CallToolResult(
                content=[types.TextContent(type="text", text=text)], isError=failed
            )

        @server.list_prompts()  # type: ignore[no-untyped-call, untyped-decorator]
        async def list_prompts() -> list[types.Prompt]:
            registry = await self.registry()
            return [
                types.Prompt(name=name, description=skill["description"])
                for name, skill in registry.library.items()
            ]

        @server.get_prompt()  # type: ignore[no-untyped-call, untyped-decorator]
        async def get_prompt(name: str, arguments: dict[str, str] | None) -> types.GetPromptResult:
            registry = await self.registry()
            skill = registry.library.get(name)
            if skill is None:
                raise ValueError("This skill is not available.")
            return types.GetPromptResult(
                description=skill["description"],
                messages=[
                    types.PromptMessage(
                        role="user", content=types.TextContent(type="text", text=skill["body"])
                    )
                ],
            )


class McpEndpoint:
    """Raw ASGI endpoint for `/mcp`. The bearer middleware has already checked the token."""

    def __init__(self, service: McpService, allowed_origins: list[str]) -> None:
        self._service = service
        self._origins = set(allowed_origins)

    async def __call__(self, scope: AsgiScope, receive: Receive, send: Send) -> None:
        headers = {k.decode("latin-1").lower(): v.decode("latin-1") for k, v in scope["headers"]}
        origin = headers.get("origin")
        # MCP clients are programs, not web pages. A browser origin we do not know is refused.
        if origin is not None and origin not in self._origins:
            await JSONResponse({"detail": "origin not allowed"}, status_code=403)(
                scope, receive, send
            )
            return
        await self._service.manager.handle_request(scope, receive, send)
