"""Bounded streaming agent with fragmented tool-call support."""

from __future__ import annotations

import asyncio
import json
import re
from collections.abc import AsyncIterator
from typing import Any

from graite.models.providers import Provider
from graite.skills.registry import Registry

# Stripping is lenient (a cut-off call is still not speech); recovery is strict per call,
# because half a call carries half its arguments and proposing with those is worse than asking
# again. A malformed call does not take its well-formed neighbours down with it.
_TOOL_CALL = re.compile(r"<tool_call>.*?(?:</tool_call>|$)", flags=re.DOTALL)
_WHOLE_CALL = re.compile(r"<tool_call>(.*?)</tool_call>", flags=re.DOTALL)
_ARG_PAIR = re.compile(
    r"<arg_key>\s*(.*?)\s*</arg_key>\s*<arg_value>\s*(.*?)\s*</arg_value>", flags=re.DOTALL
)
_ARG_TAG = re.compile(r"</?(?:arg_key|arg_value|tool_call|tool_response)>")


def visible(text: str) -> str:
    text = re.sub(r"<think>.*?(?:</think>|$)", "", text, flags=re.DOTALL)
    # Tool syntax the server failed to parse is never speech; recover_calls has had its turn.
    return _ARG_TAG.sub("", _TOOL_CALL.sub("", text)).strip()


def _one_call(body: str) -> tuple[str, dict[str, Any]] | None:
    """One `<tool_call>` body in either dialect, or None when it is not a call after all."""
    if "<arg_key>" in body:
        # GLM: the name on the first line, then <arg_key>/<arg_value> pairs.
        head = body.split("<arg_key>", 1)[0].strip().splitlines()
        name = head[0].strip() if head else ""
        arguments: dict[str, Any] = {}
        for key, raw in _ARG_PAIR.findall(body):
            # Scalars stay text; only a structured value is worth parsing, and misreading
            # a title of "5" or "null" as a number or nothing would be worse than leaving it.
            try:
                arguments[key] = json.loads(raw) if raw[:1] in "[{" else raw
            except ValueError:
                arguments[key] = raw
        return (name, arguments) if name else None
    # Hermes/Qwen: a JSON object.
    try:
        parsed = json.loads(body.strip())
    except ValueError:
        return None
    if not isinstance(parsed, dict):
        return None
    name = parsed.get("name") or parsed.get("function") or ""
    args = parsed.get("arguments", parsed.get("parameters", {}))
    if isinstance(args, str):
        try:
            args = json.loads(args)
        except ValueError:
            return None
    return (name, args) if isinstance(name, str) and name and isinstance(args, dict) else None


def recover_calls(text: str, names: set[str]) -> list[dict[str, Any]]:
    """Tool calls the server left in the content because it could not parse them.

    llama.cpp picks a tool-call parser from the model's chat template; when the model writes
    a different dialect the call arrives as prose and the turn silently does nothing. Both
    dialects open with `<tool_call>`. Each closed call is judged on its own: one that parses
    into a tool the registry actually has is kept, a malformed or unknown one is dropped, and
    its neighbours still run. A call cut off before `</tool_call>` never matches at all, so
    half-written arguments are still never guessed at.
    """
    recovered: list[dict[str, Any]] = []
    for index, body in enumerate(_WHOLE_CALL.findall(text)):
        parsed = _one_call(body)
        if parsed is None or parsed[0] not in names:
            continue
        recovered.append(
            {
                "id": f"recovered-{index}",
                "type": "function",
                "function": {"name": parsed[0], "arguments": json.dumps(parsed[1])},
            }
        )
    return recovered


def thoughts(text: str) -> str:
    """The bodies of inline <think> blocks (closed or trailing), joined."""
    return "\n".join(
        m.strip() for m in re.findall(r"<think>(.*?)(?:</think>|$)", text, flags=re.DOTALL)
    ).strip()


def compact_results(
    messages: list[dict[str, Any]],
    schemas: list[dict[str, Any]],
    context_size: int,
    output_tokens: int,
) -> bool:
    """Bound accumulated read results without removing tool ids or mutation receipts.

    Keep the latest batch intact for exact edits. Older long bodies can be read again;
    losing proposal ids or completed actions would risk repeating writes.
    """
    budget = max(4000, (context_size - min(output_tokens, context_size // 2)) * 3)

    def size() -> int:
        return len(json.dumps([messages, schemas], ensure_ascii=False).encode())

    changed = False
    results = [m for m in messages if m.get("role") == "tool"]
    for message in results[:-4]:
        if size() <= budget:
            break
        raw = message.get("content", "")
        if len(raw) < 1500:
            continue
        try:
            value = json.loads(raw)
        except ValueError:
            continue

        def shorten(value: Any) -> Any:
            if isinstance(value, dict):
                return {
                    k: shorten(v) if k in {"body", "snippet", "instructions"} else v
                    for k, v in value.items()
                }
            if isinstance(value, list):
                return [shorten(v) for v in value]
            if isinstance(value, str) and len(value) > 500:
                return value[:500] + " [Earlier result shortened; read again for exact text.]"
            return value

        message["content"] = json.dumps(shorten(value), ensure_ascii=False)
        changed |= message["content"] != raw
    return changed


async def run(
    provider: Provider,
    messages: list[dict[str, Any]],
    registry: Registry,
    *,
    max_rounds: int = 10,
    thinking: bool | None = None,
    context_size: int | None = None,
) -> AsyncIterator[dict[str, Any]]:
    rounds = max(1, max_rounds)
    options: dict[str, Any] = {} if thinking is None else {"thinking": thinking}
    retried = False
    seen_ids: set[str] = set()
    for round_index in range(rounds):
        round_number = round_index + 1
        yield {"type": "round_start", "round": round_number}
        calls: dict[int, dict[str, Any]] = {}
        content = reasoning = ""
        reasoning_details: dict[int, dict[str, Any]] = {}
        truncated = False
        last_round = round_index == rounds - 1
        schemas = [] if last_round else registry.schemas()
        if context_size and compact_results(messages, schemas, context_size, provider.max_tokens):
            yield {"type": "status", "text": "Keeping earlier results concise while continuing…"}
        if last_round and round_index:
            messages.append(
                {
                    "role": "user",
                    "content": (
                        "Finish with the results confirmed by the tools. State any unfinished work "
                        "or missing decision clearly. Do not claim unexecuted actions succeeded."
                    ),
                }
            )
        async for delta in provider.chat(messages, schemas, **options):
            if delta.get("content"):
                content += delta["content"]
                yield {"type": "token", "text": delta["content"]}
            thought = delta.get("reasoning_content") or delta.get("reasoning")
            if thought:
                reasoning += thought
                yield {"type": "thinking", "text": thought}
            # Some gateways require signed reasoning blocks to accompany the tool calls.
            for detail in delta.get("reasoning_details") or []:
                slot = detail.get("index", 0)
                block = reasoning_details.setdefault(slot, {})
                for key, value in detail.items():
                    if key in {"text", "summary", "data", "signature"} and isinstance(value, str):
                        block[key] = block.get(key, "") + value
                    else:
                        block[key] = value
            if delta.get("truncated"):
                truncated = True
                yield {
                    "type": "status",
                    "text": "The model reached its output limit; checking progress…",
                }
            for fragment in delta.get("tool_calls", []):
                slot = fragment.get("index", 0)
                call = calls.setdefault(
                    slot, {"id": "", "type": "function", "function": {"name": "", "arguments": ""}}
                )
                if fragment.get("id"):
                    call["id"] = fragment["id"]
                fn = fragment.get("function", {})
                call["function"]["name"] += fn.get("name") or ""
                call["function"]["arguments"] += fn.get("arguments") or ""
        yield {
            "type": "round_end",
            "round": round_number,
            "thinking": "\n".join(t for t in (reasoning.strip(), thoughts(content)) if t),
        }
        if not calls and not last_round:
            calls = dict(
                enumerate(recover_calls(content, {s["function"]["name"] for s in schemas}))
            )
        # A truncated batch may contain a complete first mutation and half the next. Execute
        # none of it: retry once with tools intact and smaller batches, without duplicate writes.
        if truncated and calls:
            calls = {}
            content = ""
        if not calls:
            if visible(content):
                yield {"type": "answer", "text": visible(content)}
                return
            if not retried and not last_round:
                retried = True
                options["thinking"] = False
                messages.append(
                    {
                        "role": "user",
                        "content": (
                            "The previous response ended before producing an answer or a complete "
                            "tool call. No actions from it were executed. Continue without "
                            "reasoning; call "
                            "one tool at a time with concise arguments, or answer briefly."
                        ),
                    }
                )
                yield {"type": "reset"}
                continue
            raise ValueError(
                "The model ran out of room before it answered. Choose a model with optional "
                "reasoning or increase the answer length in Settings."
                if truncated or reasoning or thoughts(content)
                else "The model returned no answer. Try again or choose another model."
            )
        if last_round:
            break
        if len(calls) > 16:
            raise ValueError("The model requested too many tools at once.")
        ordered = [calls[k] for k in sorted(calls)]
        # A clarification is a pause, not an invitation to execute the other calls in a batch.
        questions = [c for c in ordered if c["function"]["name"] == "request_clarification"]
        if questions:
            ordered = questions[:1]
        for index, call in enumerate(ordered):
            if not call["id"] or call["id"] in seen_ids:
                call["id"] = f"call-{round_number}-{index}"
            seen_ids.add(call["id"])
        turn: dict[str, Any] = {"role": "assistant", "tool_calls": ordered}
        if visible(content):
            turn["content"] = visible(content)
        if reasoning:
            turn["reasoning_content"] = reasoning
        if reasoning_details:
            turn["reasoning_details"] = list(reasoning_details.values())
        messages.append(turn)
        yield {"type": "reset"}
        offset = 0
        while offset < len(ordered):
            batch = [ordered[offset]]
            parallel_safe = getattr(registry, "parallel_safe", lambda _: False)
            if parallel_safe(batch[0]["function"]["name"]):
                for following in ordered[offset + 1 : offset + 4]:
                    if not parallel_safe(following["function"]["name"]):
                        break
                    batch.append(following)
            for call in batch:
                fn = call["function"]
                yield {
                    "type": "tool_start",
                    "id": call["id"],
                    "round": round_number,
                    "name": fn["name"],
                    "arguments": fn["arguments"],
                }
            tasks = [
                asyncio.create_task(
                    registry.invoke(c["function"]["name"], c["function"]["arguments"])
                )
                for c in batch
            ]
            try:
                results = await asyncio.gather(*tasks)
            finally:
                for task in tasks:
                    if not task.done():
                        task.cancel()
                await asyncio.gather(*tasks, return_exceptions=True)
            for call, result in zip(batch, results, strict=True):
                messages.append({"role": "tool", "tool_call_id": call["id"], "content": result})
                parsed = json.loads(result)
                yield {
                    "type": "tool_end",
                    "id": call["id"],
                    "round": round_number,
                    "name": call["function"]["name"],
                    "result": parsed,
                }
                if call["function"]["name"] == "request_clarification" and parsed.get("question"):
                    # Also emit tokens so the spoken path can read the question immediately.
                    yield {"type": "token", "text": parsed["question"]}
                    yield {"type": "answer", "text": "CLARIFY: " + parsed["question"]}
                    return
            offset += len(batch)
    raise ValueError("The assistant reached its step limit. Ask it to continue the remaining work.")
