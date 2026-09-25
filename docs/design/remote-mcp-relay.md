# Remote MCP through Graite Cloud

Status: design, not built. Decision D64. Builds on D7 (proposals by tool set), D19 (per-page
AI settings), D30/D31 (local MCP server and stdio bridge) and D63 (Graite Cloud sign-in).
The cloud half is Phase 3 of `graite-inference/PLAN.md`.

## Why

The daemon already serves MCP (`graite/mcp/server.py`): stateless JSON, propose-only, and
scoped as a cloud model so `cloud: local-only` pages are invisible. It only listens on
loopback with a per-launch token, so Claude Code and Claude Desktop can use it through the
stdio bridge, but claude.ai, ChatGPT and other hosted clients cannot. They call from their
own servers and need a public HTTPS URL with OAuth.

The fix is a relay through Graite Cloud:
- The daemon opens an **outbound WebSocket** to Graite Cloud.
- Graite Cloud serves `POST /mcp` behind MCP-SDK OAuth and forwards each JSON-RPC request
  over that socket.
- The daemon replays the request against its own `/mcp` and sends the response back.
- Nothing about the vault is stored in the cloud.

## Rules

- **Every change is a proposal.** Remote clients get the same tool set as the local MCP
  server: read, navigate, search, propose. The page's autonomy policy decides whether a
  proposal is auto-applied (D7, `review/policy.py`). There is no write scope.
- **Only cloud-allowed pages are shared.** The remote client is a cloud model:
  - pages are resolved with `resolve_scope(cloud_provider=True)`, and the turn runs with
    `cloud_model=True`;
  - so `cloud: local-only` subtrees cannot be read, listed, searched, navigated or proposed
    against.
  - New tools read only through `registry.scoped()` / `registry.paths()`.
- **Page instructions reach the model.** Every read, navigate and propose result carries
  the page's effective, cascaded `ai_instructions`. For a new page these are the parent's.
  Instructions are read-only to the model; they change only through the UI
  (`PUT /pages/{p}/ai-settings`).
- **Remote access is opt-in per vault**, and it needs a Graite Cloud sign-in.

## Daemon tools (`graite/skills/tools.py`)

Existing tools stay as they are:
- `read_page`, `list_children`, `search_vault`, `request_clarification`, `load_skill`
- `propose_create`, `propose_edit`, `propose_append`, `propose_properties`,
  `propose_move`, `propose_delete`, `list_proposals`

New tools use `@tool(group, description)`, so in-app agents get them too.

| Tool | Group | Does |
|---|---|---|
| `navigate(path="", depth=2)` | read | Returns the page tree under `path`, with `depth` 1–6 (a high depth is "deep navigation"). Branches that don't fit collapse to `— N more (navigate …)`, using `retrieval/navigation.py`'s tree rendering (new `render_subtree`). Also returns `ai_instructions` for `path` and marks the nodes that carry their own instructions. |
| `find_pages(names)` | read | Answers "which pages are meant". Returns ranked candidates `{path, title, parent, evidence}` plus `ambiguous`, using the matching behind `navigation.page_reference` (factored into `match_names`). When the result is ambiguous, the client is told to ask the user. |
| `propose_view(path, view, summary, group=None, show=None, fields=None)` | propose | Builds a `graite:view` fence and validates it with `vault/blocks.py`. It then proposes an append to an existing page, or a create for a new one. Cards stay `propose_create` with `parent_path`, following the `page-views` skill. |

Other changes:
- `_propose` returns `ai_instructions` for its target.
- `list_children` adds `has_instructions`.
- The MCP `INSTRUCTIONS` text tells the client:
  - follow `ai_instructions` before writing;
  - use `find_pages` when the user's page name is unclear, and ask the user when the
    result is ambiguous;
  - tell the user when a change is waiting for review.

## Graite Cloud (`graite-inference`)

- **OAuth server:** implement the `mcp` SDK's `OAuthAuthorizationServerProvider` over the
  existing `oauth_clients`, `oauth_codes`, `auth_sessions`, `refresh_tokens` and
  `access_tokens` tables (`auth/mcp_oauth.py`).
  - Dynamic client registration.
  - `authorize()` goes through the existing login and a new MCP consent page.
  - Tokens have scope `mcp` and `resource = {public_url}/mcp`.
  - The SDK routes mount at the reserved root paths `/authorize`, `/token`, `/register`,
    `/revoke` and `/.well-known/*`.
  - A migration adds the missing columns: `oauth_clients.secret_hash` and
    `oauth_clients.metadata`, `oauth_codes.resource` and
    `oauth_codes.redirect_uri_provided_explicitly`, and `resource` on `auth_sessions` and
    `access_tokens`.
- **Relay scope:** desktop sign-in adds the scope `relay`. Sessions signed in before this
  change have to sign in again to enable remote access.
- **`WS /relay/v1/connect`** (scope `relay`):
  - The daemon sends a `hello` with `{install_id, vault_name, version, tools}`.
  - Requests go down as `{id, client, body}`; responses come up as `{id, status, body}`.
  - Ping every 25 s.
  - Registry: an in-memory map `user_id → connection` (single replica). The newest
    connection wins.
  - The token is checked with a short DB session before the loop, never held open.
- **`POST /mcp`** (scope `mcp`, resource checked):
  - Forwards the request to the user's daemon with the OAuth client's name, so the review
    queue shows "via ChatGPT". Times out after 30 s.
  - When the daemon is offline, `initialize` and `tools/list` answer from the tool list
    cached at the last `hello`, and `tools/call` returns `isError` "Open Graite on your
    computer".
  - `GET` and `DELETE` return 405 (stateless).
- Only path and status are logged, never bodies.

## Daemon relay client (`graite/cloud/relay.py`)

- A lifespan task connects to `{cloud_url}/relay/v1/connect` when two conditions hold:
  - the user is signed in to Graite Cloud;
  - `.graite/config.toml` has `[mcp] remote = true`.
- It gets its token from `CloudSession.access_token()`, and reconnects with backoff.
- Each request is replayed in-process (`httpx.ASGITransport(app)`, `POST /mcp`, daemon
  token, `X-Graite-MCP-Client: <client>`). Local and remote clients therefore share one
  code path: `McpEndpoint` → `McpService`.
- `GET /api/v1/mcp/info` gains `remote: {enabled, connected, url}`.
  `models/McpCard.tsx` shows the switch and the URL to paste into Claude or ChatGPT.

## Running it locally

```
# graite-inference
uv run alembic upgrade head && uv run graite-cloud serve --reload     # :8000
# daemon with GRAITE_CLOUD_URL=http://127.0.0.1:8000; sign in; Settings → MCP → Remote access
claude mcp add --transport http graite http://127.0.0.1:8000/mcp     # OAuth in the browser
# claude.ai / ChatGPT need public HTTPS:
cloudflared tunnel --url http://localhost:8000    # set PUBLIC_URL to the tunnel URL, restart
# then add https://<tunnel>/mcp as a custom connector
```

## Tests

- **graite-inference:**
  - `test_mcp_oauth.py`: registration → consent → token; an inference token gets 401 at
    `/mcp`.
  - `test_relay.py`, with a fake daemon over `TestClient.websocket_connect`: forwarding,
    offline `tools/list`, the offline tool-call error, the timeout, newest-connection-wins.
  - `test_migrations.py`: no drift.
- **Daemon, `test_mcp.py`:**
  - `navigate` depth and collapsing;
  - `find_pages` ambiguity;
  - `propose_view`: a bad key is refused, and a valid view is filed;
  - `ai_instructions` in propose results;
  - local-only pages absent from `navigate` and `find_pages`.
  - Plus `test_relay_client.py`, which replays an envelope through the app.
- **End to end,** from Claude Code and then ChatGPT through the tunnel:
  - "show me the whole workspace structure";
  - "which page is Atlas?";
  - "make a kanban view in Todos with three cards";
  - "set Status to Done on X".
  - Proposals appear in the review queue labelled with the client, and local-only pages
    are never mentioned.
