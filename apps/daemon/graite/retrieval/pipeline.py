"""One chat turn: resolve scope, retrieve, assemble, generate, cite, report limits.

Simple questions take one generation call with the sources in the prompt. When evidence is
weak or the question is multi-hop, the same call may use the read/search tools for a few
bounded rounds; tool results become new numbered sources. A follow-up question reuses the
sources the conversation already gathered instead of searching again. Every turn is recorded
as a run.
"""

from __future__ import annotations

import json
import time
import uuid
from collections.abc import AsyncIterator
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any, Literal

from graite.agent.loop import run as agent_loop
from graite.agent.loop import thoughts, visible
from graite.index.db import transaction
from graite.models.config import AIConfig
from graite.retrieval import answer as answering
from graite.retrieval import followup, research
from graite.retrieval.context import Source, build
from graite.retrieval.contextset import ContextSet
from graite.retrieval.scope import ResolvedScope, Scope
from graite.retrieval.scope import resolve as resolve_scope
from graite.retrieval.search import Searcher
from graite.retrieval.strategy import classify
from graite.skills.registry import MODE_TOOLS, Registry, chat_groups_for, groups_for
from graite.skills.tools import TOOLS

PROVIDER_LABELS = {
    "local": "the local model",
    "compatible": "your model server",
    "openrouter": "OpenRouter",
    "anthropic": "Claude",
    "graite": "Graite Cloud",
}


def now() -> str:
    return datetime.now(UTC).isoformat()


@dataclass
class TurnContext:
    state: Any
    conversation_id: str | None
    scope: Scope
    question: str
    history: list[dict[str, Any]]
    config: AIConfig
    mode: str = "ask"
    extra_sources: list[Source] = field(default_factory=list)
    skills_allowlist: list[str] | None = None
    trigger: str = "user"
    page_path: str | None = None
    images: list[tuple[str, str]] = field(default_factory=list)  # (mime, base64)
    resolved: ResolvedScope | None = None
    context: ContextSet = field(default_factory=ContextSet)
    run_kind: str = "chat_turn"
    groups: frozenset[str] | None = None
    agent: str | None = None
    workflow: str | None = None
    parent_run_id: str | None = None
    job_id: str | None = None
    feedback: list[str] = field(default_factory=list)
    # Narrow the callable tools to these names (agent definitions); None keeps the mode's set.
    tools: list[str] | None = None
    # Agent runs: the cleaned instructions (the system prompt's task), a short search query
    # in place of the whole task, and notes to surface (a model fallback, for instance).
    task: str | None = None
    search_query: str | None = None
    notes: list[str] = field(default_factory=list)
    # The personal assistant in conversation: who it is and what it remembers lead the
    # prompt, history is kept and CLARIFY works, unlike an unattended agent run.
    persona: str | None = None
    persona_name: str = "Assistant"
    memory: str = ""
    memory_root: str | None = None
    recalled: str = ""  # memories recalled for this message (the assistant only)
    voice: bool = False
    reply_language: str | None = None  # a language code; spoken turns follow the speaker
    user_name: str | None = None
    thinking: bool | None = None
    # "auto" searches the vault before answering. "on_demand" searches nothing and gives the
    # model the page tree instead, so it opens what the turn actually needs — the assistant
    # talks about far more than the notes, and a spoken "hi" should not cost a vault search.
    retrieve: Literal["auto", "on_demand"] = "auto"
    page_reference: str = ""
    preferred_paths: list[str] = field(default_factory=list)

    @property
    def is_agent(self) -> bool:
        return self.task is not None or self.run_kind in ("agent_run", "live_note")


class RunRecorder:
    """Writes the `runs` and `run_steps` rows of one turn and announces every change as a
    `run_update` event, so the Runs view can follow a run while it happens."""

    def __init__(self, db: Any, ctx: TurnContext, events: Any | None = None) -> None:
        self.db = db
        self.events = events
        self.id = uuid.uuid4().hex
        self.ord = 0
        self.kind = ctx.run_kind
        self.agent = ctx.agent
        self.job_id = ctx.job_id
        cloud = ctx.config.provider != "local"
        input_data: dict[str, Any] = {"question": ctx.question[:2000]}
        if ctx.task is not None:
            input_data["task"] = ctx.task[:4000]
        if ctx.search_query:
            input_data["search_query"] = ctx.search_query[:300]
        if ctx.notes:
            input_data["notes"] = ctx.notes[:5]
        with transaction(db):
            db.execute(
                "INSERT INTO runs (id, kind, trigger, conversation_id, job_id, parent_run_id, "
                "agent, workflow, page_path, scope_json, mode, provider, model, cloud, status, "
                "input_json, started_at) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'running', ?, ?)",
                (
                    self.id,
                    ctx.run_kind,
                    ctx.trigger,
                    ctx.conversation_id,
                    ctx.job_id,
                    ctx.parent_run_id,
                    ctx.agent,
                    ctx.workflow,
                    ctx.page_path,
                    json.dumps(ctx.scope.to_dict()),
                    ctx.mode,
                    ctx.config.provider,
                    ctx.config.model or ctx.config.model_path,
                    int(cloud),
                    json.dumps(input_data, ensure_ascii=False),
                    now(),
                ),
            )
        self._publish("running")

    def _publish(self, status: str, step: dict[str, Any] | None = None) -> None:
        if self.events is None:
            return
        self.events.publish(
            "run_update",
            {
                "id": self.id,
                "kind": self.kind,
                "agent": self.agent,
                "job_id": self.job_id,
                "status": status,
                "step": step,
            },
        )

    def step(self, kind: str, name: str | None = None, /, **data: Any) -> int:
        self.ord += 1
        payload = json.dumps(data, ensure_ascii=False)[:20000]
        with transaction(self.db):
            cursor = self.db.execute(
                "INSERT INTO run_steps (run_id, ord, kind, name, input_json, status, started_at) "
                "VALUES (?, ?, ?, ?, ?, 'running', ?)",
                (self.id, self.ord, kind, name, payload, now()),
            )
        self._publish(
            "running",
            {"ord": self.ord, "kind": kind, "name": name, "status": "running", "input": data},
        )
        return int(cursor.lastrowid or 0)

    def finish_step(self, step_id: int, status: str = "succeeded", /, **data: Any) -> None:
        payload = json.dumps(data, ensure_ascii=False)[:20000]
        with transaction(self.db):
            self.db.execute(
                "UPDATE run_steps SET status=?, output_json=?, finished_at=? WHERE id=?",
                (status, payload, now(), step_id),
            )
            row = self.db.execute(
                "SELECT ord, kind, name FROM run_steps WHERE id=?", (step_id,)
            ).fetchone()
        if row is not None:
            self._publish(
                "running",
                {
                    "ord": row["ord"],
                    "kind": row["kind"],
                    "name": row["name"],
                    "status": status,
                    "output": _small(data),
                },
            )

    def finish(self, status: str, *, error: str | None = None, **output: Any) -> None:
        output = {k: v for k, v in output.items() if v is not None}
        with transaction(self.db):
            self.db.execute(
                "UPDATE runs SET status=?, error=?, output_json=?, finished_at=?, "
                "tokens_in=?, tokens_out=? WHERE id=?",
                (
                    status,
                    error,
                    json.dumps(output, ensure_ascii=False)[:50000],
                    now(),
                    (output.get("tokens") or {}).get("prompt"),
                    (output.get("tokens") or {}).get("completion"),
                    self.id,
                ),
            )
            self.db.execute(
                "UPDATE run_steps SET status='failed', finished_at=? "
                "WHERE run_id=? AND status='running'",
                (now(), self.id),
            )
        self._publish(status)


def _small(data: dict[str, Any]) -> dict[str, Any]:
    """The scalar part of a step payload: events stay small, lists stay in the database."""
    return {k: v for k, v in data.items() if not isinstance(v, (list, dict))}


def _tool_input(arguments: str) -> dict[str, Any]:
    try:
        args = json.loads(arguments) if arguments.strip() else {}
    except ValueError:
        return {"raw": arguments[:400]}
    if not isinstance(args, dict):
        return {"raw": str(args)[:400]}
    return {k: (v[:400] if isinstance(v, str) else v) for k, v in args.items()}


def _tool_output(args: dict[str, Any], result: Any) -> dict[str, Any]:
    data = result if isinstance(result, dict) else {}
    summary = args.get("summary") or data.get("message")
    out = {
        "page": args.get("path") or data.get("path") or data.get("new_path"),
        "proposal_id": data.get("proposal_id"),
        "proposal_status": data.get("status") if data.get("proposal_id") else None,
        "summary": str(summary)[:300] if summary else None,
        "error": data.get("error"),
        "source": data.get("source"),
        "items": len(result) if isinstance(result, list) else None,
    }
    return {k: v for k, v in out.items() if v is not None}


def _tokens(metrics: dict[str, Any]) -> tuple[int, int]:
    prompt = metrics.get("prompt_tokens", metrics.get("prompt_n", metrics.get("input_tokens")))
    completion = metrics.get(
        "completion_tokens", metrics.get("predicted_n", metrics.get("output_tokens"))
    )
    return int(prompt or 0), int(completion or 0)


def open_run(db: Any, **columns: Any) -> str:
    """A run row for something that is not a chat turn (a workflow wrapping its steps)."""
    run_id = uuid.uuid4().hex
    columns = {"status": "running", "scope_json": "{}", **columns}
    keys = ", ".join(["id", *columns, "started_at"])
    marks = ", ".join("?" * (len(columns) + 2))
    with transaction(db):
        db.execute(
            f"INSERT INTO runs ({keys}) VALUES ({marks})", (run_id, *columns.values(), now())
        )
    return run_id


def close_run(
    db: Any, run_id: str, status: str, *, error: str | None = None, **output: Any
) -> None:
    with transaction(db):
        db.execute(
            "UPDATE runs SET status=?, error=?, output_json=?, finished_at=? WHERE id=?",
            (status, error, json.dumps(output, ensure_ascii=False)[:50000], now(), run_id),
        )


def resolve_for(ctx: TurnContext) -> ResolvedScope:
    return resolve_scope(
        ctx.state.db,
        ctx.state.settings.vault,
        ctx.scope,
        cloud_provider=ctx.config.provider != "local",
    )


def _source_from(data: dict[str, Any]) -> Source:
    return Source(
        0,
        data["kind"],
        data["page_path"],
        data.get("page_id"),
        data["title"],
        list(data.get("heading_path") or []),
        data["text"],
        data.get("hash"),
        list(data.get("chunk_ids") or []),
    )


async def answer_turn(ctx: TurnContext) -> AsyncIterator[dict[str, Any]]:
    """Yield SSE-shaped events for one turn. The caller persists the answer and context."""
    state = ctx.state
    recorder = RunRecorder(state.db, ctx, getattr(state, "events", None))
    yield {"type": "run", "run_id": recorder.id}
    query = ctx.search_query or ctx.question
    started = time.monotonic()
    embedder = getattr(state, "embedder", None)
    searcher = Searcher(state.db, embedder)
    context = ctx.context
    try:
        scope = ctx.resolved or resolve_for(ctx)
        if embedder is not None and hasattr(embedder, "touch"):
            embedder.touch(scope.scope.roots)
        yield {
            "type": "meta",
            "run_id": recorder.id,
            "scope": scope.scope.to_dict(),
            "pages": len(scope.paths),
            "excluded_local_only": scope.excluded_local_only,
            "instructions": [i["source"] for i in scope.policy.instructions],
        }
        if ctx.config.provider != "local":
            if not scope.policy.cloud_allowed:
                raise ValueError("This page allows local models only. Choose a local model.")
            if any(
                e.source.page_path and not scope.policy_for(e.source.page_path).cloud_allowed
                for e in context.entries
            ):
                raise ValueError(
                    "This conversation contains pages that now allow local models only. "
                    "Choose a local model or start a new conversation."
                )
            if any(
                s.page_path and not scope.policy_for(s.page_path).cloud_allowed
                for s in ctx.extra_sources
            ):
                raise ValueError(
                    "The selected page allows local models only. Choose a local model."
                )
        context.entries = [
            e
            for e in context.entries
            if not e.source.page_path or scope.contains(e.source.page_path)
        ]
        context.begin_turn()
        context.refresh(state.db)
        extra_numbers = {context.add(source) for source in ctx.extra_sources}
        if ctx.is_agent:
            # Unattended: nobody can be asked, so the pages the task links to come along.
            # In conversation they do not — the tree is listed and the model opens what it needs.
            from graite.agents.knowledge import linked_sources

            context.add_many(linked_sources(state, ctx.task or ctx.persona or ctx.question, scope))
        plan = classify(query)
        decision = followup.decide(query, ctx.history, context.texts())
        budget = answering.source_budget(ctx.config.context_size, ctx.task or ctx.question)
        candidates = []
        retrieved = False
        if ctx.retrieve == "on_demand":
            step = recorder.step("on_demand", "the model searches when it needs to")
            recorder.finish_step(step, reused=len(context))
            is_weak = False
            max_rounds = 2
        elif decision.retrieve:
            retrieved = True
            step = recorder.step(
                "retrieve", plan.label, question=query[:500], pages=len(scope.paths)
            )
            yield {"type": "status", "text": "Searching your pages…"}
            candidates = await searcher.search(query, scope, plan=plan)
            added = context.add_many(build(state.db, candidates, budget))
            recorder.finish_step(
                step,
                candidates=len(candidates),
                sources=[s.to_dict(snippet_chars=80) for s in context.sources if s.n in added],
                semantic=searcher.semantic_available,
            )
            is_weak = research.weak(
                candidates, plan, semantic_available=searcher.semantic_available
            )
            max_rounds = research.rounds(
                candidates, plan, semantic_available=searcher.semantic_available
            )
        else:
            step = recorder.step("followup", decision.reason, question=query[:500])
            recorder.finish_step(step, reused=len(context))
            is_weak = False
            max_rounds = 2
        index_status = embedder.status() if embedder is not None else {}
        # Agents and the assistant follow their definition's mode (Ask = report only);
        # interactive chat may propose in every mode, narrowed per mode.
        chat = not ctx.is_agent and ctx.persona is None
        groups = ctx.groups or (chat_groups_for(ctx.mode) if chat else groups_for(ctx.mode))
        registry = Registry(state.fileops, scope, searcher=searcher, groups=groups)
        narrow = MODE_TOOLS.get(ctx.mode)
        if narrow is not None and "propose" in groups:
            registry.narrow(narrow, group="propose")
        if ctx.tools is not None:
            registry.allowed &= set(ctx.tools)
        if ctx.is_agent:
            registry.allowed.discard("request_clarification")
        if not ctx.memory_root:
            registry.allowed.discard("search_memory")
        registry.proposals = getattr(state, "proposals", None)
        registry.state = state
        registry.turn = {
            "run_id": recorder.id,
            "conversation_id": ctx.conversation_id,
            "cloud_model": ctx.config.provider != "local",
            "memory_root": ctx.memory_root,
        }
        try:
            await registry.load_library(ctx.skills_allowlist)
        except (ValueError, OSError):
            registry.library = {}
        registry.result_limit = min(6000, ctx.config.context_size // 2)
        read_numbers: set[int] = set()

        def note_source(data: dict[str, Any]) -> int:
            number = context.add(_source_from(data))
            read_numbers.add(number)
            return number

        registry.on_source = note_source
        prefetched = 0
        if (
            ctx.retrieve == "on_demand"
            and len(ctx.preferred_paths) == 1
            and "read_page" in registry.allowed
            and "read" in groups
        ):
            # A concrete page question already authorizes reading that page. Ground the
            # first response even when a small model declines to call its read tool.
            path = ctx.preferred_paths[0]
            step = recorder.step("tool", "read_page", path=path)
            yield {"type": "status", "text": f"Reading {path}…"}
            normal_limit = registry.result_limit
            registry.result_limit = max(normal_limit, min(12000, budget - 600))
            try:
                result = json.loads(await registry.invoke("read_page", json.dumps({"path": path})))
            finally:
                registry.result_limit = normal_limit
            recorder.finish_step(
                step,
                "failed" if result.get("error") else "succeeded",
                **_tool_output({"path": path}, result),
            )
            prefetched = 1
            if result.get("source"):
                ctx.page_reference += (
                    f" Source [{result['source']}] was freshly read from {json.dumps(path)} "
                    "for this request. Use the supplied content before reading it again."
                )
            if result.get("truncated"):
                ctx.page_reference += (
                    f" The initial read of {json.dumps(path)} is partial; continue with "
                    f"read_page at offset {result['next_offset']} before claiming completeness."
                )
        if ctx.retrieve == "on_demand":
            # Keep citation identities, but do not push a backlog of unrelated excerpts
            # into every spoken turn. Dialogue supplies continuity; tools open current
            # page content when the question needs it. Explicit current attachments stay.
            current = extra_numbers | read_numbers
            prompt_sources = [s for s in context.sources if s.n in current]
        else:
            prompt_sources = context.fit(budget, preferred_paths=ctx.preferred_paths)
        if ctx.persona is not None and ctx.memory_root:
            # These notes already have their own budgeted memory section. Duplicating them
            # as old search hits used to outweigh the current request and its corrections.
            prompt_sources = [
                s
                for s in prompt_sources
                if s.page_path != ctx.memory_root
                and not (s.page_path or "").startswith(ctx.memory_root + "/")
            ]
        from copy import deepcopy

        prompt_policy = deepcopy(scope.policy)
        seen_instructions = {i["source"] for i in prompt_policy.instructions}
        for source in prompt_sources:
            if not source.page_path or not scope.contains(source.page_path):
                continue
            for instruction in scope.policy_for(source.page_path).instructions:
                if instruction["source"] not in seen_instructions:
                    prompt_policy.instructions.append(
                        {
                            "source": instruction["source"],
                            "text": f"For page {source.page_path}: {instruction['text']}",
                        }
                    )
                    seen_instructions.add(instruction["source"])
        propose_names = {t.name for t in TOOLS.values() if t.group == "propose"}
        can_propose = "propose" in groups and bool(registry.allowed & propose_names)
        if ctx.is_agent:
            prompt, included = answering.agent_messages(
                prompt_policy,
                prompt_sources,
                registry.paths(),
                ctx.task if ctx.task is not None else ctx.question,
                ctx.question if ctx.task is not None else "Run now.",
                ctx.config.context_size,
                propose=can_propose,
                skills_index=registry.skill_index(),
                feedback=ctx.feedback,
                notes=ctx.notes,
            )
        elif ctx.persona is not None:
            prompt, included = answering.assistant_messages(
                prompt_policy,
                prompt_sources,
                registry.paths(),
                ctx.history,
                ctx.question,
                ctx.config.context_size,
                name=ctx.persona_name,
                persona=ctx.persona,
                memory=ctx.memory,
                memory_root=ctx.memory_root,
                recalled=ctx.recalled,
                mode=ctx.mode if can_propose else "ask",
                voice=ctx.voice,
                reply_language=answering.LANGUAGE_NAMES.get(ctx.reply_language or ""),
                user_name=ctx.user_name,
                skills_index=registry.skill_index(),
                feedback=ctx.feedback,
                page_reference=ctx.page_reference,
            )
        else:
            prompt, included = answering.messages(
                prompt_policy,
                prompt_sources,
                registry.paths(),
                ctx.history,
                ctx.question,
                ctx.config.context_size,
                mode=ctx.mode,
                propose=can_propose,
                weak=is_weak,
                skills_index=registry.skill_index(),
                reused=not retrieved and bool(len(context)),
                feedback=ctx.feedback,
            )
        # Only claim the passages the model was actually given: anything gathered this turn
        # that did not fit was never shown and is dropped; older ones stay citable.
        if ctx.page_path:
            prompt[0]["content"] += (
                f"\n## Current page\nThe user is working on [[{ctx.page_path}]]. "
                "Requests for a board, table, list or content on this page belong in its body. "
                "Use its direct children for cards; create a separate board page only when "
                "the user explicitly requests one. Read the page before changing it.\n"
            )
        context.keep_only([s.n for s in prompt_sources[:included]])
        context.drop_unseen()

        def sources_event() -> dict[str, Any]:
            return {
                "type": "sources",
                "sources": [s.to_dict() for s in context.sources],
                "new": context.new_numbers(),
            }

        yield sources_event()
        if ctx.images:
            prompt[-1]["content"] = [
                {"type": "text", "text": prompt[-1]["content"]},
                *(
                    {"type": "image_url", "image_url": {"url": f"data:{mime};base64,{data}"}}
                    for mime, data in ctx.images
                ),
            ]
        # What the retrieval plan asked for names the step; what the loop is given is the
        # round count recorded on it. They are not the same thing.
        deep = max_rounds > 2
        if groups & {"read", "search", "propose"}:
            # Look something up, act on it, then answer: two rounds cannot cover that, and an
            # on-demand turn does all of its reading here.
            max_rounds = max(max_rounds, 6)
        if ctx.is_agent:
            max_rounds = max(max_rounds, 8)  # unattended: read, propose, then a report
        if can_propose:
            max_rounds = max(max_rounds, 12)
        gen = recorder.step(
            "research" if deep else "generate", included=included, rounds=max_rounds
        )
        yield {"type": "status", "text": "Preparing your model…"}
        answer_text = ""
        tool_calls = prefetched
        searched = retrieved
        reasoning = ""
        raw_rounds: list[str] = []
        raw = ""
        proposals_made: list[str] = []
        tokens_in = tokens_out = 0
        tool_steps: dict[str, tuple[int, dict[str, Any]]] = {}
        activity: list[dict[str, Any]] = []

        def take_tokens() -> None:
            nonlocal tokens_in, tokens_out
            prompt_n, completion_n = _tokens(provider.metrics)
            tokens_in += prompt_n
            tokens_out += completion_n
            provider.metrics.clear()

        async with state.models.use(ctx.config) as provider:
            async for item in agent_loop(
                provider,
                prompt,
                registry,
                max_rounds=max_rounds,
                thinking=ctx.thinking,
                context_size=ctx.config.context_size,
            ):
                if item["type"] == "answer":
                    answer_text = item["text"]
                    continue
                if item["type"] == "token":
                    raw += item["text"]
                elif item["type"] == "thinking":
                    reasoning += item["text"]
                elif item["type"] == "reset":
                    raw_rounds.append(raw)
                    raw = ""
                    take_tokens()
                elif item["type"] == "round_end":
                    if item.get("thinking") and not ctx.voice:
                        activity_step = {
                            "id": f"thinking-{item['round']}",
                            "round": item["round"],
                            "kind": "thinking",
                            "name": "Thinking",
                            "status": "succeeded",
                            "text": item["thinking"],
                        }
                        activity.append(activity_step)
                        yield {"type": "activity", "step": activity_step}
                elif item["type"] == "tool_start":
                    tool_calls += 1
                    searched |= item["name"] == "search_vault"
                    tool_args = _tool_input(item["arguments"])
                    tool_steps[item["id"]] = (
                        recorder.step("tool", item["name"], **tool_args),
                        tool_args,
                    )
                    activity_step = {
                        "id": item["id"],
                        "round": item["round"],
                        "kind": "tool",
                        "name": item["name"],
                        "status": "running",
                        "text": str(tool_args.get("summary") or tool_args.get("path") or ""),
                    }
                    activity.append(activity_step)
                    yield {"type": "activity", "step": dict(activity_step)}
                elif item["type"] == "sources":
                    continue
                yield item
                if item["type"] == "tool_end":
                    result = item.get("result")
                    failed = isinstance(result, dict) and bool(result.get("error"))
                    if item["id"] in tool_steps:
                        tool_step, tool_args = tool_steps.pop(item["id"])
                        recorder.finish_step(
                            tool_step,
                            "failed" if failed else "succeeded",
                            **_tool_output(tool_args, result),
                        )
                    activity_step = next(s for s in activity if s["id"] == item["id"])
                    activity_step["status"] = "failed" if failed else "succeeded"
                    if failed:
                        activity_step["text"] = (
                            str(result.get("error")) if isinstance(result, dict) else "Tool failed."
                        )
                    yield {"type": "activity", "step": dict(activity_step)}
                    while registry.pending_events:
                        event = registry.pending_events.pop(0)
                        if event["type"] == "proposal":
                            proposals_made.append(event["proposal"]["id"])
                        yield event
            take_tokens()
            if tool_calls:
                yield sources_event()
        raw_rounds.append(raw)
        thinking = "\n".join(t for t in [reasoning.strip(), thoughts("\n".join(raw_rounds))] if t)
        clarify, text = answering.clarification(visible(answer_text))
        if clarify:
            # Persist the question itself. An empty assistant message loses the decision
            # on reload and leaves the next model unable to interpret the user's reply.
            text = "\n\n".join(t for t in (text, clarify) if t)
        cited, text = answering.validate_citations(text, {s.n for s in context.sources})
        context.mark_cited(cited)
        lines = answering.limits(
            plan,
            scope,
            context.sources if retrieved else context.prompt_sources(),
            cited,
            provider_label=PROVIDER_LABELS.get(ctx.config.provider, ctx.config.provider),
            semantic_used=searcher.semantic_available,
            pending_chunks=int(index_status.get("pending_chunks") or 0),
            embedding_model=index_status.get("embedding_model"),
            researched=tool_calls > 0,
            weak=is_weak,
            missing_terms=(searcher.missing_terms(ctx.question, scope) if retrieved else None),
            reused=not retrieved and ctx.retrieve == "auto",
            on_demand=ctx.retrieve == "on_demand",
            semantic_skipped=searcher.semantic_skipped,
            semantic_error=searcher.last_semantic_error,
            read_count=sum(s.kind == "page" and s.n in read_numbers for s in context.sources),
            searched=searched,
            clarifying=bool(clarify),
        )
        recorder.finish_step(gen, cited=cited, tool_calls=tool_calls, chars=len(text))
        if clarify:
            yield {"type": "clarify", "question": clarify}
        status = "needs_input" if clarify else "succeeded"
        yield {
            "type": "limits",
            "items": lines,
            "excluded_local_only": scope.excluded_local_only,
            "pending_chunks": int(index_status.get("pending_chunks") or 0),
        }
        yield {
            "type": "answer",
            "text": text,
            "cited": cited,
            "sources": [s.to_dict() for s in context.sources if s.n in cited],
            "new_sources": [s.to_dict() for s in context.new_sources()],
            "thinking": thinking,
            "activity": activity,
            "proposals": proposals_made,
            "limits": lines,
            "run_id": recorder.id,
        }
        recorder.finish(
            status,
            answer=text[:20000] if ctx.is_agent else None,
            question=clarify,
            cited=cited,
            sources=len(context),
            new_sources=len(context.new_numbers()),
            tool_calls=tool_calls,
            proposals=proposals_made,
            retrieved=retrieved,
            tokens={"prompt": tokens_in, "completion": tokens_out}
            if tokens_in or tokens_out
            else None,
            seconds=round(time.monotonic() - started, 2),
        )
    except BaseException as exc:
        status = "cancelled" if exc.__class__.__name__ == "CancelledError" else "failed"
        recorder.finish(status, error=str(exc)[:1000] or exc.__class__.__name__)
        raise
    finally:
        searcher.release()
