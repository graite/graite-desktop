"""Chat through the user's own Claude Code (graite/agent/claude_code.py).

The SDK's client is replaced by a script: the messages Claude Code would send, and the tool
calls it would make. No test starts the real program or needs a sign-in.
"""

from __future__ import annotations

import json
import stat
import sys
from pathlib import Path
from typing import Any

import claude_agent_sdk as sdk
import pytest
from fastapi.testclient import TestClient

from graite.agent import claude_code as cc
from graite.agent import claude_setup
from graite.models.config import AIConfig


def event(kind: str, **fields: Any) -> sdk.StreamEvent:
    return sdk.StreamEvent(uuid="u", session_id="s", event={"type": kind, **fields})


def text_round(text: str, *, thinking: str = "") -> list[Any]:
    parts: list[Any] = [event("message_start")]
    if thinking:
        parts.append(
            event("content_block_delta", delta={"type": "thinking_delta", "thinking": thinking})
        )
    parts += [
        event("content_block_delta", delta={"type": "text_delta", "text": text}),
        event("message_delta", usage={"input_tokens": 10, "output_tokens": 4}),
        event("message_stop"),
    ]
    return parts


def tool_round(name: str, args: dict[str, Any]) -> list[Any]:
    return [
        event("message_start"),
        event("content_block_start", content_block={"type": "tool_use", "name": name}),
        ("call", name, args),
        event(
            "message_delta",
            usage={"input_tokens": 2, "cache_read_input_tokens": 100, "output_tokens": 7},
        ),
        event("message_stop"),
    ]


def result(**fields: Any) -> sdk.ResultMessage:
    base: dict[str, Any] = {
        "subtype": "success",
        "duration_ms": 1,
        "duration_api_ms": 1,
        "is_error": False,
        "num_turns": 1,
        "session_id": "s",
    }
    return sdk.ResultMessage(**{**base, **fields})


class Registry:
    def __init__(self) -> None:
        self.calls: list[tuple[str, dict[str, Any]]] = []

    def schemas(self) -> list[dict[str, Any]]:
        return [
            {
                "type": "function",
                "function": {
                    "name": name,
                    "description": name,
                    "parameters": {"type": "object", "properties": {}},
                },
            }
            for name in ("read_page", "propose_edit", "request_clarification")
        ]

    def parallel_safe(self, name: str) -> bool:
        return name == "read_page"

    async def invoke(self, name: str, arguments: str) -> str:
        args = json.loads(arguments)
        self.calls.append((name, args))
        if name == "request_clarification":
            return json.dumps({"question": args["question"]})
        return json.dumps({"ok": name})


@pytest.fixture
def script(monkeypatch: pytest.MonkeyPatch) -> dict[str, Any]:
    """Play `script["messages"]` instead of starting Claude Code; record the options."""
    played: dict[str, Any] = {"messages": [], "options": None, "sent": None, "returned": []}

    class Client:
        def __init__(self, options: Any = None) -> None:
            played["options"] = options

        async def __aenter__(self) -> Client:
            if played.get("connect_error"):
                raise played["connect_error"]
            return self

        async def __aexit__(self, *exc: object) -> None:
            played["closed"] = True

        async def query(self, prompt: Any) -> None:
            played["sent"] = [message async for message in prompt]

        async def receive_response(self) -> Any:
            server = played["options"].mcp_servers.get(cc.SERVER, {})
            handlers = {t.name: t.handler for t in server.get("tools", [])}
            for item in played["messages"]:
                if isinstance(item, tuple):
                    played["returned"].append(await handlers[item[1]](item[2]))
                else:
                    yield item

    monkeypatch.setattr(sdk, "ClaudeSDKClient", Client)
    monkeypatch.setattr(sdk, "create_sdk_mcp_server", lambda name, tools: {"tools": tools})
    return played


def provider() -> cc.ClaudeCodeProvider:
    return cc.ClaudeCodeProvider("sonnet", max_tokens=2048, cli="/usr/bin/claude")


def empty_folder(path: str) -> bool:
    return Path(path).is_dir() and not any(Path(path).iterdir())


MESSAGES = [
    {"role": "system", "content": "You help with a vault."},
    {"role": "user", "content": "When is launch?"},
]


async def events_of(script: dict[str, Any], **options: Any) -> tuple[list[dict[str, Any]], Any]:
    registry, model = Registry(), provider()
    seen = [e async for e in cc.run(model, list(MESSAGES), registry, **options)]
    return seen, (registry, model)


async def test_a_tool_turn_yields_the_agent_loops_events(script: dict[str, Any]) -> None:
    script["messages"] = [
        *tool_round("read_page", {"path": "Projects/Atlas"}),
        *text_round("4 March.", thinking="It says so. "),
        result(),
    ]
    seen, (registry, model) = await events_of(script, max_rounds=6)
    assert [e["type"] for e in seen] == [
        "round_start",
        "round_end",
        "reset",
        "tool_start",
        "tool_end",
        "round_start",
        "thinking",
        "token",
        "round_end",
        "answer",
    ]
    start, end = seen[3], seen[4]
    assert start["name"] == "read_page" and json.loads(start["arguments"]) == {
        "path": "Projects/Atlas"
    }
    assert end["id"] == start["id"] and end["result"] == {"ok": "read_page"}
    assert seen[8]["thinking"] == "It says so."
    assert seen[-1] == {"type": "answer", "text": "4 March."}
    assert registry.calls == [("read_page", {"path": "Projects/Atlas"})]
    # Tokens of both requests, cached input included, for the turn's counters.
    # What came from the prompt cache is also kept apart, so the turn can show it as reused.
    assert model.metrics == {
        "input_tokens": 112,
        "output_tokens": 11,
        "cache_read_input_tokens": 100,
    }
    assert script["returned"][0] == {
        "content": [{"type": "text", "text": json.dumps({"ok": "read_page"})}]
    }
    assert script["closed"]


async def test_claude_code_gets_graites_tools_and_none_of_its_own(
    script: dict[str, Any], monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-not-used")
    monkeypatch.setenv("CLAUDE_CODE_OAUTH_TOKEN", "never-passed-on")
    script["messages"] = [*text_round("Hello."), result()]
    await events_of(script, max_rounds=6, effort="high")
    options = script["options"]
    assert options.tools == []  # no files, shell or web
    assert options.setting_sources == [] and options.strict_mcp_config is True
    assert options.permission_mode == "dontAsk"
    assert sorted(options.allowed_tools) == [
        "mcp__graite__propose_edit",
        "mcp__graite__read_page",
        "mcp__graite__request_clarification",
    ]
    assert options.cli_path == "/usr/bin/claude"  # the user's own, never the bundled copy
    assert options.system_prompt == "You help with a vault."
    assert options.model == "sonnet" and options.effort == "high" and options.max_turns == 6
    # Credentials in the daemon's environment must not replace the subscription sign-in.
    assert options.env == {"ANTHROPIC_API_KEY": "", "CLAUDE_CODE_OAUTH_TOKEN": ""}
    assert "no-session-persistence" in options.extra_args
    assert empty_folder(options.cwd)
    assert script["sent"][0]["message"] == {
        "role": "user",
        "content": [{"type": "text", "text": "When is launch?"}],
    }


async def test_a_clarifying_question_ends_the_turn(script: dict[str, Any]) -> None:
    script["messages"] = [
        *tool_round("request_clarification", {"question": "Which page?"}),
        *text_round("never reached"),
        result(),
    ]
    seen, _ = await events_of(script)
    assert seen[-2:] == [
        {"type": "token", "text": "Which page?"},
        {"type": "answer", "text": "CLARIFY: Which page?"},
    ]


async def test_tool_calls_stop_at_the_turns_limit(script: dict[str, Any]) -> None:
    script["messages"] = [
        *tool_round("read_page", {"path": "A"}),
        *tool_round("read_page", {"path": "B"}),
        *text_round("Only A was read."),
        result(),
    ]
    seen, (registry, _) = await events_of(script, max_tool_calls=1)
    assert registry.calls == [("read_page", {"path": "A"})]
    assert script["returned"][1]["is_error"] is True
    assert [e["type"] for e in seen].count("tool_start") == 1
    assert seen[-1]["text"] == "Only A was read."


@pytest.mark.parametrize(
    ("error", "message", "action"),
    [
        ("authentication_failed", cc.SIGNED_OUT, "claude_login"),
        ("rate_limit", cc.LIMIT, None),
        ("billing_error", cc.LIMIT, None),
    ],
)
async def test_failures_say_what_to_do(
    script: dict[str, Any], error: str, message: str, action: str | None
) -> None:
    script["messages"] = [
        event("message_start"),
        sdk.AssistantMessage(content=[], model="m", error=error),  # type: ignore[arg-type]
        result(is_error=True, result="Please run /login"),
    ]
    with pytest.raises(cc.ClaudeCodeError) as raised:
        await events_of(script)
    assert str(raised.value) == message and raised.value.action == action


async def test_a_missing_program_offers_to_install_it(script: dict[str, Any]) -> None:
    script["connect_error"] = sdk.CLINotFoundError("Claude Code not found")
    with pytest.raises(cc.ClaudeCodeError) as raised:
        await events_of(script)
    assert raised.value.action == "claude_install"


async def test_the_step_limit_reads_like_graites_own(script: dict[str, Any]) -> None:
    script["messages"] = [result(subtype="error_max_turns", is_error=True)]
    with pytest.raises(ValueError, match="step limit"):
        await events_of(script)


async def test_chat_is_one_answer_without_tools(script: dict[str, Any]) -> None:
    script["messages"] = [*text_round("Ready", thinking="hm"), result()]
    model = provider()
    deltas = [d async for d in model.chat([{"role": "user", "content": "Say Ready"}], [])]
    assert deltas == [{"reasoning_content": "hm"}, {"content": "Ready"}]
    options = script["options"]
    assert options.max_turns == 1 and options.mcp_servers == {} and options.allowed_tools == []
    with pytest.raises(ValueError):
        [d async for d in model.chat(MESSAGES, [{"type": "function"}])]


def test_earlier_turns_travel_as_text_in_front_of_the_message() -> None:
    system, content = cc.prompt_of(
        [
            {"role": "system", "content": "Rules."},
            {"role": "user", "content": "Hi"},
            {"role": "assistant", "content": "Hello!"},
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": "What is this?"},
                    {"type": "image_url", "image_url": {"url": "data:image/png;base64,AAAA"}},
                ],
            },
        ]
    )
    assert system == "Rules."
    assert content[0]["text"] == (
        "<conversation_so_far>\nUser: Hi\n\nAssistant: Hello!\n</conversation_so_far>"
    )
    assert content[1] == {"type": "text", "text": "What is this?"}
    assert content[2]["type"] == "image" and content[2]["source"]["data"] == "AAAA"


def fake_cli(folder: Path, body: str) -> str:
    path = folder / "claude"
    path.write_text("#!/bin/sh\n" + body, encoding="utf-8")
    path.chmod(stat.S_IRWXU)
    return str(path)


@pytest.mark.skipif(sys.platform == "win32", reason="the stand-in program is a shell script")
async def test_status_reads_yes_or_no_and_hides_other_credentials(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    # The stand-in reports an API key when it can see one: Graite must not let it.
    cli = fake_cli(
        tmp_path,
        'if [ -n "$ANTHROPIC_API_KEY" ]; then M=apiKey; else M=claude.ai; fi\n'
        'echo "{\\"loggedIn\\": true, \\"authMethod\\": \\"$M\\", '
        '\\"subscriptionType\\": \\"max\\", \\"email\\": \\"someone@example.com\\"}"\n',
    )
    monkeypatch.setattr(cc, "find_cli", lambda: cli)
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-not-used")
    found = await cc.status()
    assert found == cc.ClaudeStatus(
        installed=True, signed_in=True, method="claude.ai", plan="max", connected=True
    )
    assert "email" not in found.model_dump()

    monkeypatch.setattr(
        cc, "find_cli", lambda: fake_cli(tmp_path, 'echo "{\\"loggedIn\\": false}"')
    )
    assert await cc.status() == cc.ClaudeStatus(installed=True)
    monkeypatch.setattr(cc, "find_cli", lambda: None)
    assert await cc.status() == cc.ClaudeStatus()


async def test_setup_only_opens_claude_codes_own_commands(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    opened: list[str] = []
    monkeypatch.setattr(claude_setup, "find_cli", lambda: "/opt/my tools/claude")
    monkeypatch.setattr(claude_setup, "_open_terminal", lambda c: opened.append(c) or True)
    launch = await claude_setup.start_login(headless=False)
    assert launch.opened and opened == [launch.command]
    assert launch.command.endswith("auth login --claudeai") and "setup-token" not in launch.command
    # Without a desktop there is no terminal to open: the command is shown instead.
    headless = await claude_setup.start_login(headless=True)
    assert not headless.opened and headless.command == launch.command and len(opened) == 1
    monkeypatch.setattr(claude_setup, "find_cli", lambda: None)
    with pytest.raises(ValueError):
        await claude_setup.start_login(headless=False)
    monkeypatch.setattr(claude_setup, "install_command", lambda: None)
    assert (await claude_setup.start_install(headless=False)).url == cc.INSTALL_URL


def test_the_setting_is_saved_without_a_key_or_a_connection(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    saved = client.put("/api/v1/ai/config", json={"provider": "claude_code", "model": "opus"})
    assert saved.status_code == 200, saved.text
    body = saved.json()
    assert body["provider"] == "claude_code" and body["model"] == "opus"
    assert body["connection_id"] is None and body["saved_model_id"] is None

    async def signed_out() -> cc.ClaudeStatus:
        return cc.ClaudeStatus(installed=True)

    monkeypatch.setattr("graite.api.claude_code.status", signed_out)
    info = client.get("/api/v1/ai/claude-code/status").json()
    assert info["installed"] and not info["connected"] and info["models"] == list(cc.MODELS)
    assert "token" not in json.dumps(info).lower()


async def test_the_manager_hands_out_the_users_own_program(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    state = client.app.state  # type: ignore[attr-defined]
    config = AIConfig(provider="claude_code", model="haiku")
    monkeypatch.setattr(cc, "find_cli", lambda: "/usr/local/bin/claude")
    async with state.models.use(config) as model:
        assert isinstance(model, cc.ClaudeCodeProvider)
        assert model.cli == "/usr/local/bin/claude" and model.key == "" and model.kind == cc.KIND
    monkeypatch.setattr(cc, "find_cli", lambda: None)
    with pytest.raises(cc.ClaudeCodeError) as raised:
        async with state.models.use(config):
            pass
    assert raised.value.action == "claude_install"
