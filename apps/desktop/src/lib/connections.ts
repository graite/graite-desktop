import { request } from "./api";
import type { components } from "@graite/api-types";

export type Connection = components["schemas"]["Connection"];
export type SavedModel = components["schemas"]["SavedModel"];
export type DiscoveredModel = components["schemas"]["DiscoveredModel"];
export type ConnectionKind = Connection["kind"];

const enc = encodeURIComponent;
const json = (body: unknown) => ({ body: JSON.stringify(body) });

/** App-wide model connections and saved models (shared by every vault). */
export const connections = {
  list: () =>
    request<{ connections: Connection[]; models: SavedModel[] }>("/api/v1/ai/connections"),
  add: (body: { name: string; kind: ConnectionKind; base_url?: string; api_key?: string }) =>
    request<Connection>("/api/v1/ai/connections", { method: "POST", ...json(body) }),
  update: (
    id: string,
    body: { name?: string; base_url?: string; api_key?: string; clear_key?: boolean },
  ) => request<Connection>(`/api/v1/ai/connections/${enc(id)}`, { method: "PATCH", ...json(body) }),
  remove: (id: string) =>
    request<{ ok: boolean; removed_models: string[] }>(`/api/v1/ai/connections/${enc(id)}`, {
      method: "DELETE",
    }),
  discover: (id: string) =>
    request<{ models: DiscoveredModel[] }>(`/api/v1/ai/connections/${enc(id)}/discover`, {
      method: "POST",
    }),
  saveModel: (
    id: string,
    body: { model: string; label?: string; context_length?: number | null },
  ) =>
    request<SavedModel>(`/api/v1/ai/connections/${enc(id)}/models`, {
      method: "POST",
      ...json(body),
    }),
  removeModel: (modelId: string) =>
    request<{ ok: boolean }>(`/api/v1/ai/models/${enc(modelId)}`, { method: "DELETE" }),
};

/** "200k" style context length for a picker row. */
export function contextLabel(length: number | null | undefined): string {
  if (!length) return "";
  return length >= 1000 ? `${Math.round(length / 1000)}k` : String(length);
}

export const KIND_LABELS: Record<ConnectionKind | "local", string> = {
  local: "On device",
  compatible: "Model server",
  anthropic: "Claude",
};

/** The host of a server address, for privacy copy and labels: "openrouter.ai". */
export function hostOf(url: string | null | undefined): string {
  try {
    return url ? new URL(url).hostname : "";
  } catch {
    return "";
  }
}

export const OPENROUTER_URL = "https://openrouter.ai/api/v1";
