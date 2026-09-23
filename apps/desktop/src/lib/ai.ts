import { request } from "./api";
import { platform } from "./platform";
import type { components } from "@graite/api-types";

export type AIConfig = components["schemas"]["AIConfig"];
export type AIStatus = components["schemas"]["AIStatus"];
export type Conversation = Omit<
  components["schemas"]["Conversation"],
  "messages" | "context" | "kind"
> & {
  messages: ChatMessage[];
  context?: ContextEntry[];
  /** "assistant" for the personal assistant's sessions; the daemon defaults it to "chat". */
  kind?: string;
};
/** These have daemon defaults; optimistic client messages may omit them. */
export type ChatMessage = Omit<
  components["schemas"]["Message"],
  "context" | "interrupted" | "spoken" | "cut_short"
> & {
  context?: boolean;
  interrupted?: boolean;
  /** Voice conversation: the turn was spoken; `cut_short` when the user interrupted it. */
  spoken?: boolean;
  cut_short?: boolean;
};
export type ActivityStep = components["schemas"]["ActivityStep"];
export type Attachment = components["schemas"]["ChatAttachment"];

/** A conversation's page selection. The daemon always sends every field. */
export interface Scope {
  kind: "page" | "folder" | "vault";
  roots: string[];
  excluded: string[];
}

export function toScope(raw: components["schemas"]["ScopeModel"] | undefined | null): Scope {
  return { kind: raw?.kind ?? "vault", roots: raw?.roots ?? [], excluded: raw?.excluded ?? [] };
}
export type IndexStatus = components["schemas"]["IndexStatus"];
export type JobInfo = components["schemas"]["JobInfo"];
export type ChatMode = "ask" | "draft" | "act";

/** One numbered, citable source shown next to an answer. */
export interface Source {
  n: number;
  kind: "page" | "attachment" | "selection";
  page_path: string | null;
  page_id: string | null;
  title: string;
  heading_path: string[];
  snippet: string;
  hash: string | null;
  chunk_ids: number[];
  start_line: number | null;
  end_line: number | null;
}

/** A source in the conversation's context set: numbered once, kept across turns. */
export interface ContextEntry extends Source {
  added_turn: number;
  last_cited_turn: number;
  stale: boolean;
}

export interface Limits {
  items: string[];
  excluded_local_only: string[];
  pending_chunks: number;
}

export type AIEvent =
  | { type: "run"; run_id: string }
  | {
      type: "meta";
      run_id?: string;
      scope?: Scope;
      pages?: number;
      excluded_local_only?: string[];
      instructions?: string[];
    }
  | { type: "round_start"; round: number }
  | { type: "round_end"; round: number; thinking: string }
  | { type: "activity"; step: ActivityStep }
  | { type: "status"; text: string }
  | { type: "token"; text: string }
  | { type: "thinking"; text: string }
  | { type: "reset" }
  | { type: "tool_start"; name: string; arguments: string }
  | { type: "tool_end"; name: string; result: unknown }
  | { type: "sources"; sources: Source[]; new?: number[] }
  | { type: "limits"; items: string[]; excluded_local_only: string[]; pending_chunks: number }
  | { type: "clarify"; question: string }
  | { type: "proposal"; proposal: import("./review").Proposal }
  | {
      type: "answer";
      text: string;
      cited: number[];
      sources: Source[];
      new_sources?: Source[];
      thinking?: string;
      proposals?: string[];
      limits: string[];
      run_id: string;
    }
  | { type: "cancelled" }
  | { type: "error"; text: string }
  | { type: "done" };

export interface SendBody {
  message: string;
  page_path?: string;
  mode?: ChatMode;
  attachments?: string[];
  selection?: { page_path: string; text: string };
  replace_from?: number;
}

const enc = encodeURIComponent;

export const ai = {
  status: () => request<AIStatus>("/api/v1/ai/status"),
  save: (config: AIConfig, api_key?: string, clear_key = false) =>
    request<AIConfig>("/api/v1/ai/config", {
      method: "PUT",
      body: JSON.stringify({ ...config, api_key: api_key || undefined, clear_key }),
    }),
  discover: (config: AIConfig, api_key?: string) =>
    request<{ models: string[] }>("/api/v1/ai/discover", {
      method: "POST",
      body: JSON.stringify({ ...config, api_key: api_key || undefined }),
    }),
  check: () =>
    request<{ message: string; seconds: number }>("/api/v1/ai/check", { method: "POST" }),
  unload: () => request("/api/v1/ai/unload", { method: "POST" }),
  /** Conversations bound to a page (page and folder scopes). */
  conversations: (path: string) =>
    request<Conversation[]>(`/api/v1/ai/conversations?page_path=${enc(path)}`),
  /** Conversations of the Graite AI page (vault scope). */
  allConversations: () => request<Conversation[]>("/api/v1/ai/conversations?scope=all"),
  vaultConversations: () => request<Conversation[]>("/api/v1/ai/conversations?scope=vault"),
  conversation: (id: string) => request<Conversation>(`/api/v1/ai/conversations/${enc(id)}`),
  /** Back-compat: a folder conversation for a page. */
  create: (path: string) =>
    request<Conversation>("/api/v1/ai/conversations", {
      method: "POST",
      body: JSON.stringify({ page_path: path }),
    }),
  createConversation: (body: { page_path?: string; scope?: Scope; mode?: ChatMode }) =>
    request<Conversation>("/api/v1/ai/conversations", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  updateConversation: (id: string, patch: { title?: string; scope?: Scope; mode?: ChatMode }) =>
    request<Conversation>(`/api/v1/ai/conversations/${enc(id)}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    }),
  deleteConversation: (id: string) =>
    request<{ ok: boolean }>(`/api/v1/ai/conversations/${enc(id)}`, { method: "DELETE" }),
  cancel: (id: string) =>
    request<{ cancelled: boolean }>(`/api/v1/ai/conversations/${enc(id)}/cancel`, {
      method: "POST",
    }),
  attachments: (id: string) =>
    request<Attachment[]>(`/api/v1/ai/conversations/${enc(id)}/attachments`),
  attachment: (id: string, attachmentId: string) =>
    request<Attachment>(`/api/v1/ai/conversations/${enc(id)}/attachments/${enc(attachmentId)}`),
  deleteAttachment: (id: string, attachmentId: string) =>
    request<{ ok: boolean }>(
      `/api/v1/ai/conversations/${enc(id)}/attachments/${enc(attachmentId)}`,
      {
        method: "DELETE",
      },
    ),
  uploadAttachment: async (id: string, file: File | Blob, name: string) => {
    const { url, token } = await platform.getDaemonInfo();
    const response = await fetch(
      `${url}/api/v1/ai/conversations/${enc(id)}/attachments?name=${enc(name)}`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/octet-stream" },
        body: file,
      },
    );
    if (!response.ok) {
      const error = (await response.json().catch(() => ({}))) as { detail?: string };
      throw new Error(error.detail || `Upload failed (${response.status})`);
    }
    return (await response.json()) as Attachment;
  },
  indexStatus: () => request<IndexStatus>("/api/v1/ai/index/status"),
  rebuildIndex: () => request<{ job_id: string }>("/api/v1/ai/index/rebuild", { method: "POST" }),
  cancelJob: (id: string) => request<JobInfo>(`/api/v1/ai/jobs/${enc(id)}`, { method: "DELETE" }),
  jobs: (params: { status?: string; kind?: string } = {}) =>
    request<JobInfo[]>(`/api/v1/ai/jobs?${new URLSearchParams(params as Record<string, string>)}`),
};

/** SSE parser preserves split UTF-8 and split frames across network chunks. */
export async function readEvents(response: Response, onEvent: (event: AIEvent) => void) {
  if (!response.ok) {
    const error = (await response.json().catch(() => ({}))) as { detail?: string };
    throw new Error(error.detail || `Request failed (${response.status})`);
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Streaming is unavailable.");
  const decoder = new TextDecoder();
  let buffer = "";
  let done = false;
  try {
    while (true) {
      const next = await reader.read();
      buffer = (buffer + decoder.decode(next.value, { stream: !next.done })).replace(/\r\n/g, "\n");
      let end: number;
      while ((end = buffer.indexOf("\n\n")) !== -1) {
        const frame = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const data = frame
          .split("\n")
          .filter((l) => l.startsWith("data:"))
          .map((l) => l.slice(5).trimStart())
          .join("\n");
        if (!data) continue;
        const event = JSON.parse(data) as AIEvent;
        if (event.type === "error") throw new Error(event.text);
        if (event.type === "done") done = true;
        if (event.type === "cancelled") {
          done = true;
          onEvent(event);
          break;
        }
        onEvent(event);
      }
      if (next.done) break;
    }
    if (!done) throw new Error("The connection ended before the answer finished.");
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export async function sendMessage(
  id: string,
  body: SendBody,
  signal: AbortSignal,
  onEvent: (event: AIEvent) => void,
) {
  const { url, token } = await platform.getDaemonInfo();
  const response = await fetch(`${url}/api/v1/ai/conversations/${enc(id)}/messages`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  await readEvents(response, onEvent);
}
