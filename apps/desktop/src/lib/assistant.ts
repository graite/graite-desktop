import { request } from "./api";
import type { components } from "@graite/api-types";

export type AssistantInfo = components["schemas"]["AssistantInfo"];
export type AssistantSections = components["schemas"]["Sections"];
/** Sections have daemon defaults; a draft may leave some out. */
type Body = components["schemas"]["AssistantBody"];
export type AssistantBody = Omit<
  Body,
  "sections" | "mode" | "description" | "rename_memory" | "user_name"
> & {
  /** What the assistant calls the user ("Hi Sam."); empty = "Hi there." */
  user_name?: string;
  sections?: Partial<AssistantSections>;
  mode?: string;
  description?: string;
  rename_memory?: boolean;
};
export type ConversationRef = components["schemas"]["ConversationRef"];
export type MemoryItem = components["schemas"]["MemoryItem"];
export type MemoryList = components["schemas"]["MemoryList"];
export type NewMemory = components["schemas"]["MemoryBody"];

const json = (body: unknown) => ({ body: JSON.stringify(body) });

/** The personal assistant: one named agent per vault, with memory pages and a voice. */
export const assistant = {
  get: () => request<AssistantInfo>("/api/v1/assistant"),
  save: (body: AssistantBody) =>
    request<AssistantInfo>("/api/v1/assistant", { method: "PUT", ...json(body) }),
  optInMemory: () =>
    request<{ opted_in: boolean }>("/api/v1/assistant/memory/opt-in", { method: "POST" }),
  /** Every memory page, with its kind, pin and when it was last recalled. */
  memories: () => request<MemoryList>("/api/v1/assistant/memory"),
  addMemory: (body: NewMemory) =>
    request<MemoryItem>("/api/v1/assistant/memory", { method: "POST", ...json(body) }),
  /** Turn the old Profile and Playbook lists into one memory page per line. */
  upgradeMemory: () =>
    request<{ created: number; memories?: string | null }>("/api/v1/assistant/memory/upgrade", {
      method: "POST",
    }),
  /** Merge, generalise and forget memories now, instead of waiting for Sunday. */
  tidyMemory: () =>
    request<{ job_id: string }>("/api/v1/assistant/memory/tidy", { method: "POST" }),
  /** The session to talk in: the recent one, or a new one (always new with `fresh`). */
  conversation: (fresh = false) =>
    request<ConversationRef>(`/api/v1/assistant/conversations${fresh ? "?fresh=true" : ""}`, {
      method: "POST",
    }),
  conversations: () => request<ConversationRef[]>("/api/v1/assistant/conversations"),
  /** One background pass now, whatever the schedule says. */
  runLoop: () => request<{ job_id: string }>("/api/v1/assistant/loop/run", { method: "POST" }),
  dismissQuestion: (runId: string) =>
    request<{ ok: boolean }>(`/api/v1/assistant/questions/${encodeURIComponent(runId)}/dismiss`, {
      method: "POST",
    }),
};

export const SECTION_FIELDS: { key: keyof AssistantSections; label: string; hint: string }[] = [
  { key: "personality", label: "Personality", hint: "How it talks and behaves." },
  {
    key: "context",
    label: "Context",
    hint: "Who you are and what it should know about your life and work.",
  },
  { key: "guidelines", label: "Guidelines", hint: "What it should always or never do." },
  {
    key: "goals",
    label: "Goals",
    hint: "What it helps you achieve. It keeps working on these in the background.",
  },
];

/** What a save sends: the editable part of the assistant's state. */
export function bodyOf(info: AssistantInfo): AssistantBody {
  return {
    name: info.name,
    user_name: info.user_name ?? "",
    description: info.description,
    sections: info.sections,
    scope: info.scope,
    mode: info.mode,
    model: info.model,
    skills: info.skills,
    tools: info.tools,
    schedule: info.schedule,
    triggers: info.triggers,
    voice: info.voice,
    rename_memory: true,
  };
}
