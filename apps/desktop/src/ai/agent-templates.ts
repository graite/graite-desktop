import type { AgentBody, AgentInfo } from "@/lib/automation";

export const blankAgent = (): AgentBody => ({
  name: "Untitled agent",
  description: "",
  instructions:
    "## Overview\n\nDescribe what this agent helps you with.\n\n## Workflow\n\n1. Read the relevant knowledge pages.\n2. Prepare an answer or propose changes for review.\n\n## Guidelines\n\nAsk when important information is missing.\n",
  folder: null,
  scope: { kind: "vault", roots: [], excluded: [] },
  mode: "act",
  model: null,
  tools: null,
  skills: null,
  schedule: null,
  triggers: [],
});
export const agentBody = (agent: AgentInfo): AgentBody => ({
  name: agent.name,
  description: agent.description,
  instructions: agent.instructions,
  folder: agent.folder || null,
  scope: agent.scope,
  mode: agent.mode,
  model: agent.model,
  tools: agent.tools,
  skills: agent.skills,
  schedule: agent.schedule,
  triggers: agent.triggers ?? [],
});
export const AGENT_TEMPLATES = [
  {
    icon: "☀️",
    name: "Morning brief",
    description: "Start the day with priorities and open questions.",
    instructions:
      "## Overview\n\nHelp me start the day with a clear picture of my work.\n\n## Workflow\n\n1. Read the selected knowledge pages.\n2. Summarize priorities, upcoming deadlines and unresolved questions.\n3. Suggest three practical next steps, with links to the source pages.\n\n## Guidelines\n\nKeep the brief concise. Ask which pages and time to use before setting up automatic runs.\n",
  },
  {
    icon: "📝",
    name: "Meeting follow-up",
    description: "Turn meeting notes into clear action items.",
    instructions:
      "## Overview\n\nIdentify action items in meeting notes.\n\n## Workflow\n\n1. Read the meeting page and its relevant knowledge links.\n2. Identify explicit tasks, owners and due dates.\n3. Propose a checklist linked back to the original meeting.\n\n## Guidelines\n\nDo not invent owners or dates. Avoid duplicates. If no action items exist, leave the page unchanged. Ask which meeting page to watch before configuring a trigger.\n",
  },
  {
    icon: "📚",
    name: "Knowledge assistant",
    description: "Answer questions using your trusted pages.",
    instructions:
      "## Overview\n\nAnswer questions using the selected knowledge pages.\n\n## Workflow\n\n1. Find the most relevant pages.\n2. Read the full context needed for the question.\n3. Give a clear answer with links to supporting pages.\n\n## Guidelines\n\nSay when the knowledge base does not contain the answer. Ask follow-up questions when the request is ambiguous.\n",
  },
  {
    icon: "🌿",
    name: "Weekly review",
    description: "Reflect on progress and plan the week ahead.",
    instructions:
      "## Overview\n\nHelp me reflect on the week and prepare the next one.\n\n## Workflow\n\n1. Review the selected project and journal pages.\n2. Summarize completed work, blockers and decisions.\n3. Propose next-week priorities with links to the relevant pages.\n\n## Guidelines\n\nSeparate facts from suggestions. Ask which pages and schedule to use before enabling automatic runs.\n",
  },
];
