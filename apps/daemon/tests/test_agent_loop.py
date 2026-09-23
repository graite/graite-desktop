"""The rounds loop: what happens when a model spends its output budget without answering."""

from __future__ import annotations

import json
from typing import Any

import httpx
import pytest

from graite.agent.loop import run


class ScriptedProvider:
    """Replays one scripted stream per round, recording the tools it was offered."""

    def __init__(self, *rounds: list[dict[str, Any]]) -> None:
        self.rounds = list(rounds)
        self.offered: list[list[str]] = []
        self.bodies: list[dict[str, Any]] = []

    async def chat(
        self, messages: list[dict[str, Any]], tools: list[dict[str, Any]], **options: Any
    ) -> Any:
        self.offered.append([t["function"]["name"] for t in tools])
        self.bodies.append(dict(options))
        for delta in self.rounds.pop(0) if self.rounds else []:
            yield delta


class StubRegistry:
    def schemas(self) -> list[dict[str, Any]]:
        return [{"function": {"name": "search_vault", "description": "", "parameters": {}}}]

    async def invoke(self, name: str, arguments: str) -> str:
        return json.dumps({"ok": name})


class RecordingRegistry(StubRegistry):
    """Has the tool the leaked markup names, and remembers what it was actually called with."""

    def __init__(self) -> None:
        self.invoked: list[tuple[str, str]] = []

    def schemas(self) -> list[dict[str, Any]]:
        return [
            {"function": {"name": name, "description": "", "parameters": {}}}
            for name in ("search_vault", "propose_append")
        ]

    async def invoke(self, name: str, arguments: str) -> str:
        self.invoked.append((name, arguments))
        return json.dumps({"ok": name})


async def collect(provider: Any, registry: Any = None, **kwargs: Any) -> list[dict[str, Any]]:
    return [item async for item in run(provider, [], registry or StubRegistry(), **kwargs)]


def call(name: str = "search_vault") -> dict[str, Any]:
    return {"tool_calls": [{"index": 0, "id": "t1", "function": {"name": name, "arguments": "{}"}}]}


async def test_a_round_that_only_thought_retries_without_thinking_and_keeps_tools() -> None:
    """A reasoning model can spend the whole budget inside <think> and emit nothing sayable.
    The retry disables reasoning and preserves the ability to complete the requested action."""
    provider = ScriptedProvider(
        [{"content": "<think>I should look this"}, {"truncated": True}],
        [{"content": "Bar Alta does the best tosti."}],
    )
    events = await collect(provider, max_rounds=4)
    assert [e["type"] for e in events][-1] == "answer"
    assert events[-1]["text"] == "Bar Alta does the best tosti."
    # Recovery still needs tools to finish the task.
    assert provider.offered == [["search_vault"], ["search_vault"]]
    assert provider.bodies[1]["thinking"] is False


async def test_running_out_of_room_says_so_instead_of_blaming_the_model() -> None:
    provider = ScriptedProvider(
        [{"content": "<think>still thinking"}, {"truncated": True}],
        [{"content": "<think>still thinking"}, {"truncated": True}],
    )
    with pytest.raises(ValueError, match="ran out of room"):
        await collect(provider, max_rounds=2)


async def test_a_genuinely_empty_response_keeps_its_own_message() -> None:
    provider = ScriptedProvider([], [])
    with pytest.raises(ValueError, match="returned no answer"):
        await collect(provider, max_rounds=2)


async def test_the_retry_is_offered_once_per_turn_not_once_per_round() -> None:
    """Otherwise a model that never speaks would burn every round retrying."""
    provider = ScriptedProvider([call()], [], [], [{"content": "Done."}])
    with pytest.raises(ValueError, match="returned no answer"):
        await collect(provider, max_rounds=4)
    # A tool round, an empty one, then the single retry without tools — and it gives up there
    # rather than spending the fourth round.
    assert provider.offered == [["search_vault"], ["search_vault"], ["search_vault"]]


async def test_reasoning_arrives_under_either_field_name() -> None:
    provider = ScriptedProvider(
        [{"reasoning": "openrouter says this"}, {"content": "Hi."}],
    )
    events = await collect(provider, max_rounds=1)
    assert {"type": "thinking", "text": "openrouter says this"} in events

    provider = ScriptedProvider(
        [{"reasoning_content": "llama.cpp says this"}, {"content": "Hi."}],
    )
    events = await collect(provider, max_rounds=1)
    assert {"type": "thinking", "text": "llama.cpp says this"} in events


async def test_a_normal_tool_round_still_answers() -> None:
    provider = ScriptedProvider([call()], [{"content": "Found it."}])
    events = await collect(provider, max_rounds=4)
    assert [e["type"] for e in events if e["type"] in ("tool_start", "tool_end", "answer")] == [
        "tool_start",
        "tool_end",
        "answer",
    ]
    assert events[-1]["text"] == "Found it."


async def _request_body(
    monkeypatch: pytest.MonkeyPatch, url: str, kind: str, thinking: bool | None
) -> dict[str, Any]:
    """The JSON one `Provider.chat` call puts on the wire."""
    import httpx

    from graite.models.providers import Provider

    seen: dict[str, Any] = {}
    original = httpx.AsyncClient

    def handle(request: httpx.Request) -> httpx.Response:
        seen.update(json.loads(request.content))
        return httpx.Response(200, text="data: [DONE]\n\n")

    monkeypatch.setattr(
        httpx,
        "AsyncClient",
        lambda **kw: original(transport=httpx.MockTransport(handle), **kw),
    )
    provider = Provider(kind, url, "some-model", "key")
    async for _ in provider.chat([{"role": "user", "content": "hi"}], [], thinking=thinking):
        pass
    return seen


async def test_openrouter_is_told_to_skip_reasoning_in_its_own_dialect(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """chat_template_kwargs is a llama.cpp/LM Studio field; OpenRouter ignores it and would
    reason anyway, spending the spoken turn's whole budget before saying a word."""
    body = await _request_body(
        monkeypatch, "https://openrouter.ai/api/v1", "compatible", thinking=False
    )
    assert body["reasoning"] == {"effort": "none"}
    assert "chat_template_kwargs" not in body


async def test_a_plain_local_server_is_never_sent_the_openrouter_field(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    body = await _request_body(monkeypatch, "http://127.0.0.1:1234/v1", "local", thinking=False)
    assert "reasoning" not in body
    assert body["chat_template_kwargs"] == {"enable_thinking": False}


async def test_nothing_is_sent_when_no_preference_was_expressed(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    body = await _request_body(
        monkeypatch, "https://openrouter.ai/api/v1", "compatible", thinking=None
    )
    assert "reasoning" not in body and "chat_template_kwargs" not in body


_REAL_ASYNC_CLIENT = httpx.AsyncClient


def _picky_server(
    monkeypatch: pytest.MonkeyPatch, reject: str = "reasoning"
) -> list[dict[str, Any]]:
    """A server that 400s any request carrying `reject`. Returns the bodies it was sent."""
    import httpx

    bodies: list[dict[str, Any]] = []
    original = _REAL_ASYNC_CLIENT

    def handle(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        bodies.append(body)
        if reject in body:
            return httpx.Response(
                400, json={"error": {"message": f"{reject} is not supported for this model"}}
            )
        stream = 'data: {"choices":[{"delta":{"content":"Hi."}}]}\n\ndata: [DONE]\n\n'
        return httpx.Response(200, text=stream)

    monkeypatch.setattr(
        httpx, "AsyncClient", lambda **kw: original(transport=httpx.MockTransport(handle), **kw)
    )
    return bodies


async def _say(
    url: str, model: str = "some-model", thinking: bool | None = False
) -> list[dict[str, Any]]:
    from graite.models.providers import Provider

    provider = Provider("compatible", url, model, "key")
    msgs = [{"role": "user", "content": "hi"}]
    return [d async for d in provider.chat(msgs, [], thinking=thinking)]


async def test_a_refused_hint_costs_the_hint_not_the_turn(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """This is the regression: OpenRouter rejects reasoning.effort for some models, and only
    the voice path sends it, so speaking died with a bare HTTP 400."""
    from graite.models.providers import _NO_HINTS

    _NO_HINTS.clear()
    bodies = _picky_server(monkeypatch)
    deltas = await _say("https://openrouter.ai/api/v1")

    assert [d.get("content") for d in deltas if d.get("content")] == ["Hi."]
    assert len(bodies) == 2
    assert "reasoning" in bodies[0]
    # Which field offended is not said, so the retry drops every optional one.
    assert "reasoning" not in bodies[1] and "chat_template_kwargs" not in bodies[1]
    assert bodies[1]["messages"] == bodies[0]["messages"]


async def test_the_refusal_is_remembered_so_the_retry_is_paid_once(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from graite.models.providers import _NO_HINTS

    _NO_HINTS.clear()
    bodies = _picky_server(monkeypatch)
    await _say("https://openrouter.ai/api/v1")
    await _say("https://openrouter.ai/api/v1")

    assert len(bodies) == 3  # rejected, retried, then straight through
    assert "reasoning" not in bodies[2]
    # A different model on the same gateway has not been ruled out yet.
    await _say("https://openrouter.ai/api/v1", model="another-model")
    assert "reasoning" in bodies[3]


async def test_a_400_that_had_no_hint_to_blame_still_fails(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from graite.models.providers import _NO_HINTS

    _NO_HINTS.clear()
    bodies = _picky_server(monkeypatch, reject="messages")  # every request is refused
    with pytest.raises(ValueError, match="HTTP 400"):
        await _say("https://openrouter.ai/api/v1")
    assert len(bodies) == 2  # one retry, then it gives up rather than looping

    _NO_HINTS.clear()
    bodies = _picky_server(monkeypatch, reject="messages")
    with pytest.raises(ValueError, match="HTTP 400"):
        await _say("http://127.0.0.1:1234/v1", thinking=None)  # nothing to drop: no retry
    assert len(bodies) == 1


async def test_a_rejected_key_and_a_rate_limit_keep_their_own_advice(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Only a 400 means "maybe the body was wrong"; these mean try something else entirely."""
    from graite.models.providers import _NO_HINTS

    original = _REAL_ASYNC_CLIENT

    async def attempt(status: int, expected: str) -> None:
        _NO_HINTS.clear()
        calls: list[int] = []

        def handle(request: httpx.Request) -> httpx.Response:
            calls.append(status)
            return httpx.Response(status, json={"error": "nope"})

        monkeypatch.setattr(
            httpx, "AsyncClient", lambda **kw: original(transport=httpx.MockTransport(handle), **kw)
        )
        with pytest.raises(ValueError, match=expected):
            await _say("https://openrouter.ai/api/v1")
        assert calls == [status]  # not retried

    await attempt(401, "rejected the API key")
    await attempt(429, "busy or your usage limit")


# llama.cpp picks a tool-call parser from the model's chat template; a model that writes a
# different dialect has its call delivered as prose, and the turn silently does nothing.
GLM_LEAK = (
    "<tool_call>propose_append\n"
    "<arg_key>path</arg_key>\n<arg_value>Todos</arg_value>\n"
    "<arg_key>text</arg_key>\n<arg_value>- Call the dentist</arg_value>\n"
    "<arg_key>summary</arg_key>\n<arg_value>Adds a todo</arg_value>\n"
    "</tool_call>"
)
HERMES_LEAK = (
    '<tool_call>{"name": "propose_append", "arguments": '
    '{"path": "Todos", "text": "- Call the dentist", "summary": "Adds a todo"}}</tool_call>'
)
ARGUMENTS = json.dumps({"path": "Todos", "text": "- Call the dentist", "summary": "Adds a todo"})


@pytest.mark.parametrize("leak", [GLM_LEAK, HERMES_LEAK], ids=["glm", "hermes"])
async def test_a_tool_call_left_in_the_text_is_run_instead_of_spoken(leak: str) -> None:
    """The bug this fixes: the markup became the answer, so the user was told nothing
    happened in a sentence made of angle brackets, and the page was never touched."""
    registry = RecordingRegistry()
    provider = ScriptedProvider([{"content": leak}], [{"content": "Added it to Todos."}])
    events = await collect(provider, registry, max_rounds=4)
    assert registry.invoked == [("propose_append", ARGUMENTS)]
    assert "tool_start" in [e["type"] for e in events]
    assert events[-1] == {"type": "answer", "text": "Added it to Todos."}


async def test_an_unterminated_tool_call_never_becomes_the_answer() -> None:
    """Exactly what the user saw: the stream stopped mid-call, so there is nothing to run."""
    registry = RecordingRegistry()
    provider = ScriptedProvider(
        [{"content": "<tool_call>propose_append<arg_key>path</arg_key><arg_value>Todos"}],
        [{"content": "Sorry, I lost that. Say it again?"}],
    )
    events = await collect(provider, registry, max_rounds=4)
    assert registry.invoked == []  # truncated arguments are not worth guessing at
    assert events[-1]["text"] == "Sorry, I lost that. Say it again?"
    assert not any("arg_key" in e.get("text", "") for e in events if e["type"] == "answer")


async def test_markup_naming_a_tool_the_registry_lacks_is_not_invented_into_a_call() -> None:
    registry = RecordingRegistry()
    provider = ScriptedProvider(
        [{"content": '<tool_call>{"name": "delete_everything", "arguments": {}}</tool_call>'}],
        [{"content": "I cannot do that."}],
    )
    events = await collect(provider, registry, max_rounds=4)
    assert registry.invoked == []
    assert events[-1]["text"] == "I cannot do that."


async def test_a_preamble_before_recovered_markup_survives_as_the_assistant_turn() -> None:
    """Text the model wrote before the call is real speech; only the markup is dropped."""
    registry = RecordingRegistry()
    provider = ScriptedProvider(
        [{"content": "Sure, adding that now. " + GLM_LEAK}], [{"content": "Done."}]
    )
    await collect(provider, registry, max_rounds=4)
    assert registry.invoked == [("propose_append", ARGUMENTS)]


async def test_independent_reads_overlap_and_mutations_are_barriers() -> None:
    import asyncio

    class ParallelRegistry(RecordingRegistry):
        def __init__(self) -> None:
            super().__init__()
            self.started: list[str] = []
            self.finished: list[str] = []
            self.both = asyncio.Event()

        def parallel_safe(self, name: str) -> bool:
            return name == "read_page"

        async def invoke(self, name: str, arguments: str) -> str:
            path = json.loads(arguments)["path"]
            self.started.append(path)
            if name == "read_page":
                if len(self.started) == 2:
                    self.both.set()
                await asyncio.wait_for(self.both.wait(), 0.5)
            else:
                assert set(self.finished) == {"A", "B"}
            self.finished.append(path)
            return "{}"

    registry = ParallelRegistry()
    calls = [
        {"index": i, "function": {"name": name, "arguments": json.dumps({"path": path})}}
        for i, (name, path) in enumerate(
            [("read_page", "A"), ("read_page", "B"), ("propose_append", "C")]
        )
    ]
    provider = ScriptedProvider([{"tool_calls": calls}], [{"content": "Done."}])
    messages: list[dict[str, Any]] = []
    events = [e async for e in run(provider, messages, registry, max_rounds=4)]
    assert set(registry.finished[:2]) == {"A", "B"}
    assert registry.finished[2:] == ["C"]
    ids = [e["id"] for e in events if e["type"] == "tool_start"]
    assert len(set(ids)) == 3
    assert [m["tool_call_id"] for m in messages if m["role"] == "tool"] == ids


async def test_clarification_pauses_before_any_mutations_in_the_batch() -> None:
    class Questions(RecordingRegistry):
        async def invoke(self, name: str, arguments: str) -> str:
            self.invoked.append((name, arguments))
            return json.dumps({"question": "Which project should these tasks belong to?"})

    registry = Questions()
    provider = ScriptedProvider(
        [
            {
                "tool_calls": [
                    {"index": 0, "function": {"name": "propose_append", "arguments": "{}"}},
                    {"index": 1, "function": {"name": "request_clarification", "arguments": "{}"}},
                ]
            }
        ]
    )
    events = await collect(provider, registry, max_rounds=4)
    assert [n for n, _ in registry.invoked] == ["request_clarification"]
    assert events[-1]["text"].startswith("CLARIFY: Which project")
    assert len(provider.offered) == 1


async def test_a_truncated_tool_batch_executes_nothing_and_retries_with_tools() -> None:
    registry = RecordingRegistry()
    provider = ScriptedProvider(
        [call("propose_append"), {"truncated": True}],
        [call("propose_append")],
        [{"content": "Done."}],
    )
    await collect(provider, registry, max_rounds=4)
    assert len(registry.invoked) == 1
    assert provider.bodies[1]["thinking"] is False
    assert "propose_append" in provider.offered[1]


async def test_local_reasoning_budget_is_zero_for_voice(monkeypatch: pytest.MonkeyPatch) -> None:
    body = await _request_body(monkeypatch, "http://127.0.0.1:1234/v1", "local", False)
    assert body["reasoning_budget_tokens"] == 0


async def test_mandatory_reasoning_uses_minimal_instead_of_provider_default(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from graite.models.providers import _MINIMAL_REASONING, _NO_HINTS

    _NO_HINTS.clear()
    _MINIMAL_REASONING.clear()
    bodies = []

    def handle(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        bodies.append(body)
        if body.get("reasoning", {}).get("effort") == "none":
            return httpx.Response(
                400, json={"error": {"message": "Reasoning is mandatory; none is unsupported"}}
            )
        return httpx.Response(
            200, text='data: {"choices":[{"delta":{"content":"Hi."}}]}\n\ndata: [DONE]\n\n'
        )

    monkeypatch.setattr(
        httpx,
        "AsyncClient",
        lambda **kw: _REAL_ASYNC_CLIENT(transport=httpx.MockTransport(handle), **kw),
    )
    await _say("https://openrouter.ai/api/v1")
    await _say("https://openrouter.ai/api/v1")
    assert [b["reasoning"]["effort"] for b in bodies] == ["none", "minimal", "minimal"]
    _NO_HINTS.clear()
    _MINIMAL_REASONING.clear()


async def test_cancelling_a_parallel_batch_cancels_every_read() -> None:
    import asyncio

    started = asyncio.Event()
    cancelled: set[str] = set()

    class Reads(RecordingRegistry):
        def parallel_safe(self, name: str) -> bool:
            return True

        async def invoke(self, name: str, arguments: str) -> str:
            started.set()
            try:
                await asyncio.Event().wait()
            finally:
                cancelled.add(arguments)
            return "{}"

    provider = ScriptedProvider(
        [
            {
                "tool_calls": [
                    {"index": i, "function": {"name": "read_page", "arguments": str(i)}}
                    for i in range(2)
                ]
            }
        ]
    )
    task = asyncio.create_task(collect(provider, Reads(), max_rounds=4))
    await started.wait()
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert cancelled == {"0", "1"}


def test_context_compaction_preserves_receipts_and_latest_reads() -> None:
    from graite.agent.loop import compact_results

    receipt = json.dumps({"proposal_id": "p1", "status": "auto_applied", "path": "Todos/Task"})
    messages = [{"role": "tool", "tool_call_id": "receipt", "content": receipt}]
    messages += [
        {
            "role": "tool",
            "tool_call_id": str(i),
            "content": json.dumps({"path": str(i), "body": "long " * 5000}),
        }
        for i in range(8)
    ]
    recent = [m["content"] for m in messages[-4:]]
    assert compact_results(messages, [], 8192, 2048)
    assert messages[0]["content"] == receipt
    assert [m["content"] for m in messages[-4:]] == recent
    assert [m["tool_call_id"] for m in messages] == ["receipt", *map(str, range(8))]
    assert "read again" in messages[1]["content"]


def test_recovery_keeps_each_call_that_parses() -> None:
    """One malformed or unknown call in a leaked batch no longer drops the good ones."""
    from graite.agent.loop import recover_calls

    names = {"search_vault", "propose_append"}
    text = (
        HERMES_LEAK
        + '<tool_call>{"name": "propose_append", "arguments": {broken</tool_call>'
        + '<tool_call>{"name": "delete_everything", "arguments": {}}</tool_call>'
        + GLM_LEAK
    )
    calls = recover_calls(text, names)
    assert [c["function"]["name"] for c in calls] == ["propose_append", "propose_append"]
    assert [json.loads(c["function"]["arguments"]) for c in calls] == [
        json.loads(ARGUMENTS),
        json.loads(ARGUMENTS),
    ]
    assert len({c["id"] for c in calls}) == 2


async def test_a_partly_malformed_leaked_batch_still_runs_the_good_call() -> None:
    registry = RecordingRegistry()
    provider = ScriptedProvider(
        [
            {
                "content": '<tool_call>{"name": "search_vault", "arguments": oops</tool_call>'
                + GLM_LEAK
            }
        ],
        [{"content": "Added it."}],
    )
    events = await collect(provider, registry, max_rounds=4)
    assert registry.invoked == [("propose_append", ARGUMENTS)]
    assert events[-1] == {"type": "answer", "text": "Added it."}
