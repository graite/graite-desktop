"""Agents and workflows are Markdown files in `_agents/` and `_workflows/` folders.

They sit next to `_skills/`, at the vault root or inside any page folder, so they are visible
in Obsidian and travel with the pages they work on. Frontmatter holds the settings, the body
holds the instructions. Nothing here writes a file: the API goes through fileops.
"""

from __future__ import annotations

import html
import logging
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Literal

from croniter import croniter
from pydantic import BaseModel, Field

from graite.retrieval.scope import Scope
from graite.vault import frontmatter
from graite.vault.instructions import safe_file
from graite.vault.paths import GRAITE_DIR, slugify, validate_rel

log = logging.getLogger("graite.agents")

AGENTS_DIR = "_agents"
WORKFLOWS_DIR = "_workflows"
MODES = ("ask", "act")
MAX_FILES = 200
EMPTY_MARKER = "<!-- graite:empty -->"
# Chatterbox Multilingual's languages; "auto" follows the language the user spoke.
VOICE_LANGUAGES = (
    "auto ar da de el en es fi fr he hi it ja ko ms nl no pl pt ru sv sw tr zh"
).split()
# Frontmatter the agent editor does not know about but must keep when it saves a file.
ASSISTANT_KEYS = ("assistant", "memory", "voice", "user_name")


def clean_instructions(text: str) -> str:
    """The instruction body as the model should see it.

    The editor round-trips the file verbatim, so the file keeps its empty-paragraph markers
    and entity-escaped spaces; a run drops them. Never applied when parsing: the on-disk body
    must survive a save unchanged.
    """
    lines = [line for line in text.splitlines() if line.strip() != EMPTY_MARKER]
    cleaned = html.unescape("\n".join(lines))
    return re.sub(r"\n{3,}", "\n\n", cleaned).strip()


def agent_query(description: str, task: str, *extra: str | None, limit: int = 300) -> str:
    """A short search query for an agent run: the description plus the first content lines
    of the task (no headings, no bare links) and any trigger page title."""
    parts = [description.strip()] if description.strip() else []
    taken = 0
    for line in task.splitlines():
        stripped = line.strip().lstrip("-*0123456789. ").strip()
        if not stripped or stripped.startswith("#"):
            continue
        if re.fullmatch(r"(\[\[[^\]]+\]\]\s*)+", stripped):
            continue
        parts.append(stripped)
        taken += 1
        if taken == 2:
            break
    parts.extend(e.strip() for e in extra if e and e.strip())
    return " ".join(parts)[:limit].strip()


class AgentTrigger(BaseModel):
    event: Literal["page_created", "page_updated"]
    path: str = Field(min_length=1, max_length=1000)
    enabled: bool = True


class VoiceSettings(BaseModel):
    """How the personal assistant sounds. `reference` names a clip in the memory page's
    `_assets`; it is only ever set together with `consent_at`."""

    language: str = "auto"
    # A voice from the app-wide library (Settings → Voice); None is the model's built-in voice.
    voice_id: str | None = Field(default=None, max_length=40)
    # Older definitions: a clip in the memory page's `_assets`. Still honoured.
    reference: str | None = Field(default=None, max_length=200)
    exaggeration: float = Field(default=0.5, ge=0, le=2)
    cfg: float = Field(default=0.5, ge=0, le=1)
    consent_at: str | None = Field(default=None, max_length=40)


def validate_voice(value: Any) -> dict[str, Any] | None:
    if value is None or value == {}:
        return None
    if not isinstance(value, dict):
        raise ValueError("Voice settings must be a mapping.")
    voice = VoiceSettings.model_validate(value)
    if voice.language not in VOICE_LANGUAGES:
        raise ValueError(f"Unknown voice language '{voice.language}'.")
    if voice.reference and not re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9._-]{0,199}", voice.reference):
        raise ValueError("Invalid voice reference name.")
    if voice.voice_id and not re.fullmatch(r"v_[0-9a-f]{12}|built-in", voice.voice_id):
        raise ValueError("Unknown voice.")
    if voice.reference and not voice.consent_at:
        raise ValueError("A cloned voice needs the consent confirmation.")
    return voice.model_dump(exclude_none=True)


def validate_triggers(value: Any) -> list[dict[str, Any]]:
    if not isinstance(value, list) or len(value) > 20:
        raise ValueError("Use at most 20 page triggers.")
    result = []
    for raw in value:
        trigger = AgentTrigger.model_validate(raw)
        trigger.path = validate_rel(trigger.path)
        result.append(trigger.model_dump())
    return result


@dataclass
class AgentDef:
    name: str
    description: str
    path: str  # vault-relative file path
    folder: str  # page folder that owns the _agents dir ("" = vault root)
    scope: Scope
    mode: str = "act"
    instructions: str = ""
    model: str | None = None
    skills: list[str] | None = None
    tools: list[str] | None = None
    schedule: str | None = None
    triggers: list[dict[str, Any]] = field(default_factory=list)
    # The personal assistant: one definition per vault carries `assistant: true`, the id of
    # the page its memory lives under, and how it sounds.
    assistant: bool = False
    memory: str | None = None
    voice: dict[str, Any] | None = None
    user_name: str | None = None  # what the assistant calls the user ("Hi Sam.")

    def to_dict(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "description": self.description,
            "path": self.path,
            "folder": self.folder,
            "scope": self.scope.to_dict(),
            "mode": self.mode,
            "instructions": self.instructions,
            "model": self.model,
            "skills": self.skills,
            "tools": self.tools,
            "schedule": self.schedule,
            "triggers": self.triggers,
            "assistant": self.assistant,
        }


@dataclass
class Step:
    agent: str
    instructions: str | None = None
    scope: Scope | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "agent": self.agent,
            "instructions": self.instructions,
            "scope": self.scope.to_dict() if self.scope else None,
        }


@dataclass
class WorkflowDef:
    name: str
    description: str
    path: str
    folder: str
    steps: list[Step] = field(default_factory=list)
    schedule: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "description": self.description,
            "path": self.path,
            "folder": self.folder,
            "steps": [s.to_dict() for s in self.steps],
            "schedule": self.schedule,
        }


def validate_cron(expr: str | None) -> str | None:
    if expr is None or not str(expr).strip():
        return None
    expr = " ".join(str(expr).split())
    from graite.jobs.when import parse_interval

    if parse_interval(expr) is not None:
        return expr
    if len(expr.split()) != 5 or not croniter.is_valid(expr):
        raise ValueError("Use a five-field cron expression, for example '0 7 * * 1-5'.")
    return expr


def _scope(value: Any, folder: str) -> Scope:
    if value:
        return Scope.parse(value)
    return Scope("folder", [folder]) if folder else Scope("vault")


def _strings(value: Any) -> list[str] | None:
    if value is None:
        return None
    if isinstance(value, str):
        value = value.replace(",", " ").split()
    if not isinstance(value, list):
        raise ValueError("Expected a list of names.")
    return [str(v).strip() for v in value if str(v).strip()][:100]


def parse_agent(path: str, folder: str, text: str) -> AgentDef:
    meta, body = frontmatter.split(text)
    name = str(meta.get("name") or Path(path).stem).strip()
    mode = str(meta.get("mode") or "act")
    if mode not in MODES:
        raise ValueError("Agent mode must be ask or act.")
    model = meta.get("model")
    memory = meta.get("memory")
    return AgentDef(
        name=name,
        description=str(meta.get("description") or "")[:300],
        path=path,
        folder=folder,
        scope=_scope(meta.get("scope"), folder),
        mode=mode,
        instructions=body.strip(),
        model=str(model).strip() if isinstance(model, str) and model.strip() else None,
        skills=_strings(meta.get("skills")),
        tools=_strings(meta.get("tools")),
        schedule=validate_cron(meta.get("schedule")),
        triggers=validate_triggers(meta.get("triggers") or []),
        assistant=meta.get("assistant") is True,
        memory=str(memory).strip() if isinstance(memory, str) and memory.strip() else None,
        voice=validate_voice(meta.get("voice")),
        user_name=str(meta.get("user_name") or "").strip()[:60] or None,
    )


def parse_workflow(path: str, folder: str, text: str) -> WorkflowDef:
    meta, _ = frontmatter.split(text)
    raw_steps = meta.get("steps") or []
    if not isinstance(raw_steps, list) or not raw_steps:
        raise ValueError("A workflow needs at least one step.")
    steps: list[Step] = []
    for raw in raw_steps:
        if isinstance(raw, str):
            raw = {"agent": raw}
        if not isinstance(raw, dict) or not str(raw.get("agent") or "").strip():
            raise ValueError("Every step names an agent.")
        steps.append(
            Step(
                agent=str(raw["agent"]).strip(),
                instructions=(str(raw["instructions"]).strip() or None)
                if raw.get("instructions")
                else None,
                scope=Scope.parse(raw["scope"]) if raw.get("scope") else None,
            )
        )
    return WorkflowDef(
        name=str(meta.get("name") or Path(path).stem).strip(),
        description=str(meta.get("description") or "")[:300],
        path=path,
        folder=folder,
        steps=steps,
        schedule=validate_cron(meta.get("schedule")),
    )


def render_agent(
    values: dict[str, Any], instructions: str, *, keep: dict[str, Any] | None = None
) -> str:
    """`keep` is the frontmatter of the file being replaced: keys the caller does not manage
    (the assistant's, or ones a user added by hand) survive the save."""
    meta = {k: v for k, v in values.items() if v is not None and v != ""}
    for key, value in (keep or {}).items():
        if key not in values and value is not None:
            meta[key] = value
    return frontmatter.join(meta, instructions.strip() + "\n" if instructions.strip() else "")


def render_workflow(values: dict[str, Any]) -> str:
    meta = {k: v for k, v in values.items() if v not in (None, "", [])}
    return frontmatter.join(meta, "")


def discover(vault: Path) -> tuple[dict[str, AgentDef], dict[str, WorkflowDef], list[str]]:
    """Every definition in the vault, keyed by name, plus the problems found on the way."""
    root = vault.resolve()
    agents: dict[str, AgentDef] = {}
    workflows: dict[str, WorkflowDef] = {}
    problems: list[str] = []
    seen = 0
    for kind, directory in (("agent", AGENTS_DIR), ("workflow", WORKFLOWS_DIR)):
        for file in sorted(root.rglob(f"{directory}/*.md")):
            rel = file.relative_to(root).as_posix()
            if rel.startswith(GRAITE_DIR + "/") or file.name.startswith("."):
                continue
            seen += 1
            if seen > MAX_FILES:
                problems.append(f"More than {MAX_FILES} definitions; the rest were skipped.")
                break
            folder = rel.split("/" + directory + "/")[0] if "/" + directory + "/" in rel else ""
            try:
                text = safe_file(root, rel).read_text(encoding="utf-8")[:64000]
                if kind == "agent":
                    definition = parse_agent(rel, folder, text)
                    if definition.name in agents:
                        problems.append(f"{rel}: duplicate agent name '{definition.name}'.")
                        continue
                    if definition.assistant and any(a.assistant for a in agents.values()):
                        problems.append(f"{rel}: a vault has one personal assistant.")
                        definition.assistant = False
                    agents[definition.name] = definition
                else:
                    workflow = parse_workflow(rel, folder, text)
                    if workflow.name in workflows:
                        problems.append(f"{rel}: duplicate workflow name '{workflow.name}'.")
                        continue
                    workflows[workflow.name] = workflow
            except (OSError, ValueError) as exc:
                problems.append(f"{rel}: {exc}")
            except Exception as exc:  # noqa: BLE001 - malformed YAML must not hide the rest
                problems.append(f"{rel}: {exc.__class__.__name__}")
    return agents, workflows, problems


class Definitions:
    """Discovered definitions, re-read when the vault changed (`FileOps.epoch`)."""

    def __init__(self, vault: Path, epoch: Any) -> None:
        self.vault = vault
        self._epoch = epoch  # callable returning the current fileops epoch
        self._loaded_at: int | None = None
        self._agents: dict[str, AgentDef] = {}
        self._workflows: dict[str, WorkflowDef] = {}
        self.problems: list[str] = []

    def refresh(self, *, force: bool = False) -> None:
        epoch = int(self._epoch())
        if not force and self._loaded_at == epoch:
            return
        self._agents, self._workflows, self.problems = discover(self.vault)
        self._loaded_at = epoch
        for problem in self.problems:
            log.warning("definition skipped: %s", problem)

    def agents(self) -> list[AgentDef]:
        self.refresh()
        return sorted(self._agents.values(), key=lambda a: a.name.lower())

    def workflows(self) -> list[WorkflowDef]:
        self.refresh()
        return sorted(self._workflows.values(), key=lambda w: w.name.lower())

    def agent(self, name: str) -> AgentDef | None:
        self.refresh()
        return self._agents.get(name)

    def workflow(self, name: str) -> WorkflowDef | None:
        self.refresh()
        return self._workflows.get(name)

    def assistant(self) -> AgentDef | None:
        self.refresh()
        return next((a for a in self._agents.values() if a.assistant), None)


def definition_path(kind: str, folder: str | None, name: str) -> str:
    directory = AGENTS_DIR if kind == "agent" else WORKFLOWS_DIR
    return (
        f"{folder}/{directory}/{slugify(name)}.md" if folder else f"{directory}/{slugify(name)}.md"
    )
