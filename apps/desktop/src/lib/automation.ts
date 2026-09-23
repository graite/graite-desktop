import { request } from "./api";
import type { components } from "@graite/api-types";

export type AgentInfo = components["schemas"]["AgentInfo"];
export type BuilderMessage = components["schemas"]["BuilderMessage"];
export type BuilderReply = components["schemas"]["BuilderReply"];
export type AgentTrigger = components["schemas"]["AgentTrigger"];
export type AgentBody = components["schemas"]["AgentBody"];
export type ScheduleInfo = components["schemas"]["ScheduleInfo"];
export type RunInfo = components["schemas"]["RunInfo"];
export type RunDetail = components["schemas"]["RunDetail"];

const enc = encodeURIComponent;
const json = (body: unknown) => ({ body: JSON.stringify(body) });

/** Agents, schedules and runs (the daemon's automation routes). */
export const automation = {
  buildAgent: (draft: AgentBody, messages: BuilderMessage[], signal?: AbortSignal) =>
    request<BuilderReply>("/api/v1/ai/agent-builder", {
      method: "POST",
      ...json({ draft, messages }),
      signal,
    }),
  agents: () => request<AgentInfo[]>("/api/v1/ai/agents"),
  createAgent: (body: AgentBody) =>
    request<AgentInfo>("/api/v1/ai/agents", { method: "POST", ...json(body) }),
  updateAgent: (name: string, body: AgentBody) =>
    request<AgentInfo>(`/api/v1/ai/agents/${enc(name)}`, { method: "PUT", ...json(body) }),
  deleteAgent: (name: string) =>
    request<{ ok: boolean }>(`/api/v1/ai/agents/${enc(name)}`, { method: "DELETE" }),
  runAgent: (name: string, instructions?: string) =>
    request<{ job_id: string }>(`/api/v1/ai/agents/${enc(name)}/run`, {
      method: "POST",
      ...json({ instructions: instructions || null }),
    }),
  schedules: () => request<ScheduleInfo[]>("/api/v1/ai/schedules"),
  createSchedule: (body: {
    name: string;
    expr: string;
    job_kind?: string;
    payload?: Record<string, unknown>;
    page_path?: string | null;
  }) => request<ScheduleInfo>("/api/v1/ai/schedules", { method: "POST", ...json(body) }),
  patchSchedule: (id: string, body: { name?: string; expr?: string; enabled?: boolean }) =>
    request<ScheduleInfo>(`/api/v1/ai/schedules/${enc(id)}`, { method: "PATCH", ...json(body) }),
  deleteSchedule: (id: string) =>
    request<{ ok: boolean }>(`/api/v1/ai/schedules/${enc(id)}`, { method: "DELETE" }),
  runSchedule: (id: string) =>
    request<{ job_id: string }>(`/api/v1/ai/schedules/${enc(id)}/run`, { method: "POST" }),
  runs: (params: { kind?: string; status?: string; agent?: string; limit?: number } = {}) => {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(params))
      if (value !== undefined) query.set(key, String(value));
    const suffix = query.toString();
    return request<RunInfo[]>(`/api/v1/ai/runs${suffix ? `?${suffix}` : ""}`);
  },
  run: (id: string) => request<RunDetail>(`/api/v1/ai/runs/${enc(id)}`),
};

/** "in 3 h", "2 min ago" style relative times for lists. */
export function relative(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return "never";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return iso;
  const diff = then - now;
  const abs = Math.abs(diff);
  const unit =
    abs < 60_000
      ? [Math.round(abs / 1000), "s"]
      : abs < 3_600_000
        ? [Math.round(abs / 60_000), "min"]
        : abs < 86_400_000
          ? [Math.round(abs / 3_600_000), "h"]
          : [Math.round(abs / 86_400_000), "d"];
  return diff < 0 ? `${unit[0]} ${unit[1]} ago` : `in ${unit[0]} ${unit[1]}`;
}

export const RUN_KIND_LABELS: Record<string, string> = {
  chat_turn: "Chat",
  agent_run: "Agent",
  workflow_run: "Workflow",
  live_note: "Live note",
  assistant_turn: "Assistant",
  assistant_loop: "Assistant · background",
  assistant_reflect: "Assistant · memory",
  assistant_tidy: "Assistant · memory tidy",
};

export const RUN_STATUS_LABELS: Record<string, string> = {
  queued: "Queued",
  running: "Running",
  succeeded: "Done",
  needs_input: "Needs input",
  failed: "Failed",
  cancelled: "Cancelled",
};

/** One recorded step of a run, as `GET /ai/runs/{id}` returns it. */
export interface RunStep {
  ord: number;
  kind: string;
  name: string | null;
  status: string;
  started_at?: string | null;
  finished_at?: string | null;
  input?: Record<string, unknown>;
  output?: Record<string, unknown>;
}

const TOOL_LABELS: Record<string, string> = {
  read_page: "Read page",
  list_children: "Listed subpages of",
  search_vault: "Searched for",
  load_skill: "Loaded skill",
  schedule: "Scheduled follow-up",
  list_proposals: "Listed proposals",
  propose_edit: "Proposed an edit to",
  propose_append: "Proposed an addition to",
  propose_create: "Proposed a new page",
  propose_delete: "Proposed deleting",
  propose_move: "Proposed moving",
};

/** A one-line, human description of a step: "Proposed an addition to Projects · Add summary". */
export function stepSummary(step: RunStep): { title: string; detail: string; page: string | null } {
  const input = step.input ?? {};
  const output = step.output ?? {};
  const str = (v: unknown) => (typeof v === "string" && v ? v : null);
  if (step.kind === "tool") {
    const name = step.name ?? "tool";
    const page = str(output.page) ?? str(input.path) ?? null;
    const subject =
      name === "search_vault"
        ? str(input.query)
        : name === "load_skill"
          ? str(input.name)
          : name === "propose_create"
            ? str(input.title)
            : page;
    const detail = [str(output.error) ? `Failed: ${str(output.error)}` : null, str(output.summary)]
      .filter(Boolean)
      .join(" · ");
    return { title: `${TOOL_LABELS[name] ?? name}${subject ? ` ${subject}` : ""}`, detail, page };
  }
  if (step.kind === "retrieve") {
    const pages = typeof input.pages === "number" ? input.pages : null;
    const found = typeof output.candidates === "number" ? output.candidates : null;
    const parts = [
      pages !== null ? `${pages} page${pages === 1 ? "" : "s"} in scope` : null,
      found !== null ? `${found} passage${found === 1 ? "" : "s"} found` : null,
    ];
    return { title: "Searched the pages", detail: parts.filter(Boolean).join(" · "), page: null };
  }
  if (step.kind === "followup")
    return { title: "Reused earlier sources", detail: step.name ?? "", page: null };
  if (step.kind === "generate" || step.kind === "research") {
    const calls = typeof output.tool_calls === "number" ? output.tool_calls : null;
    return {
      title: "Model",
      detail: calls ? `${calls} tool call${calls === 1 ? "" : "s"}` : "",
      page: null,
    };
  }
  return { title: step.kind, detail: step.name ?? "", page: null };
}
