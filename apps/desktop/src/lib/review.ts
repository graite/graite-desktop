import { request } from "./api";
import type { components } from "@graite/api-types";

export type Proposal = components["schemas"]["Proposal"];

const enc = encodeURIComponent;
const json = (body: unknown) => ({ body: JSON.stringify(body) });

/** The review queue: proposals a model made, and the user's decisions on them. */
export const review = {
  list: (
    params: {
      status?: string;
      conversation_id?: string;
      page_path?: string;
      run_id?: string;
      limit?: number;
    } = {},
  ) => {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(params))
      if (value !== undefined) query.set(key, String(value));
    const suffix = query.toString();
    return request<Proposal[]>(`/api/v1/ai/proposals${suffix ? `?${suffix}` : ""}`);
  },
  get: (id: string) => request<Proposal>(`/api/v1/ai/proposals/${enc(id)}`),
  // Applying a proposal changes a page outside the editor: `own: false` lets the resulting
  // file_changed event reload the open page instead of being dropped as our own save.
  accept: (id: string, newText?: string) =>
    request<Proposal>(`/api/v1/ai/proposals/${enc(id)}/accept`, {
      method: "POST",
      own: false,
      ...json(newText === undefined ? {} : { new_text: newText }),
    }),
  reject: (id: string, reason: string) =>
    request<Proposal>(`/api/v1/ai/proposals/${enc(id)}/reject`, {
      method: "POST",
      ...json({ reason }),
    }),
  revert: (id: string) =>
    request<Proposal>(`/api/v1/ai/proposals/${enc(id)}/revert`, { method: "POST", own: false }),
  acceptBatch: (ids: string[]) =>
    request<{ applied: string[]; stopped_at: string | null }>("/api/v1/ai/proposals/accept-batch", {
      method: "POST",
      own: false,
      ...json({ ids }),
    }),
  rejectBatch: (ids: string[], reason = "") =>
    request<{ rejected: string[] }>("/api/v1/ai/proposals/reject-batch", {
      method: "POST",
      ...json({ ids, reason }),
    }),
  optIn: (source: string) =>
    request<{ opted_in: string[] }>("/api/v1/ai/proposals/opt-in", {
      method: "POST",
      ...json({ source }),
    }),
};

export const KIND_LABELS: Record<string, string> = {
  edit: "Edit",
  append: "Append",
  create: "New page",
  delete: "Delete",
  move: "Move",
  properties: "Properties",
};

export const STATUS_LABELS: Record<string, string> = {
  pending: "Awaiting review",
  accepted: "Accepted",
  rejected: "Rejected",
  conflict: "Conflict",
  auto_applied: "Applied automatically",
  reverted: "Reverted",
  superseded: "Superseded",
  refused: "Refused",
};

/** Actions a proposal card can take; wired once per surface. */
export interface ReviewActions {
  accept: (id: string, newText?: string) => Promise<void>;
  reject: (id: string, reason: string) => Promise<void>;
  revert: (id: string) => Promise<void>;
  optIn: (source: string) => Promise<void>;
}
