# ruff: noqa: E501
from __future__ import annotations

from pathlib import Path

import pytest

from graite.agents.definitions import (
    Definitions,
    definition_path,
    discover,
    parse_agent,
    parse_workflow,
    render_agent,
    render_workflow,
)
from tests.test_indexer import write_page


def test_parse_agent_defaults_and_validation() -> None:
    agent = parse_agent(
        "Projects/_agents/weekly.md",
        "Projects",
        "---\nname: weekly-review\ndescription: Sum up the week.\nschedule: '0 7 * * 1'\n"
        "tools: read_page, propose_append\n---\nSummarise the meetings.\n",
    )
    assert agent.name == "weekly-review" and agent.mode == "act"
    assert agent.scope.kind == "folder" and agent.scope.roots == ["Projects"]
    assert agent.tools == ["read_page", "propose_append"] and agent.schedule == "0 7 * * 1"
    assert agent.instructions == "Summarise the meetings."
    root = parse_agent("_agents/inbox.md", "", "Sort the inbox.\n")
    assert root.name == "inbox" and root.scope.kind == "vault"
    with pytest.raises(ValueError, match="mode"):
        parse_agent("_agents/x.md", "", "---\nmode: write\n---\n")
    with pytest.raises(ValueError, match="cron"):
        parse_agent("_agents/x.md", "", "---\nschedule: every monday\n---\n")


def test_parse_workflow_steps() -> None:
    workflow = parse_workflow(
        "_workflows/monday.md",
        "",
        "---\nname: monday\nsteps:\n  - weekly-review\n  - {agent: inbox, instructions: Use the "
        "review above., scope: {kind: folder, roots: [Inbox]}}\n---\n",
    )
    assert [s.agent for s in workflow.steps] == ["weekly-review", "inbox"]
    assert workflow.steps[1].instructions == "Use the review above."
    assert workflow.steps[1].scope is not None and workflow.steps[1].scope.roots == ["Inbox"]
    with pytest.raises(ValueError, match="at least one step"):
        parse_workflow("_workflows/x.md", "", "---\nname: x\n---\n")


def test_discover_walks_the_vault_and_reports_problems(tmp_path: Path) -> None:
    vault = tmp_path / "vault"
    write_page(vault, "Projects", "Projects", "")
    (vault / "_agents").mkdir()
    (vault / "_agents" / "inbox.md").write_text("Sort things.\n")
    (vault / "Projects" / "_agents").mkdir()
    (vault / "Projects" / "_agents" / "review.md").write_text(
        "---\nname: review\nschedule: '0 7 * * 1'\n---\nReview.\n"
    )
    (vault / "Projects" / "_agents" / "broken.md").write_text("---\nmode: nope\n---\n")
    (vault / "_workflows").mkdir()
    (vault / "_workflows" / "monday.md").write_text("---\nsteps: [review, inbox]\n---\n")
    (vault / ".graite" / "_agents").mkdir(parents=True)
    (vault / ".graite" / "_agents" / "hidden.md").write_text("Never.\n")
    agents, workflows, problems = discover(vault)
    assert sorted(agents) == ["inbox", "review"]
    assert agents["review"].folder == "Projects" and agents["inbox"].folder == ""
    assert list(workflows) == ["monday"] and workflows["monday"].steps[0].agent == "review"
    assert problems and "broken.md" in problems[0]
    epoch = [0]
    definitions = Definitions(vault, lambda: epoch[0])
    assert [a.name for a in definitions.agents()] == ["inbox", "review"]
    (vault / "_agents" / "later.md").write_text("Later.\n")
    assert definitions.agent("later") is None  # cached until the vault changes
    epoch[0] += 1
    assert definitions.agent("later") is not None


def test_render_round_trips() -> None:
    text = render_agent(
        {
            "name": "weekly",
            "description": "d",
            "mode": "act",
            "schedule": "0 7 * * 1",
            "model": None,
        },
        "Do it.",
    )
    agent = parse_agent("_agents/weekly.md", "", text)
    assert agent.schedule == "0 7 * * 1" and agent.instructions == "Do it." and "model" not in text
    flow = render_workflow({"name": "m", "steps": [{"agent": "weekly"}]})
    assert parse_workflow("_workflows/m.md", "", flow).steps[0].agent == "weekly"
    assert (
        definition_path("agent", "Projects", "Weekly Review") == "Projects/_agents/Weekly Review.md"
    )
    assert definition_path("workflow", None, "monday") == "_workflows/monday.md"
