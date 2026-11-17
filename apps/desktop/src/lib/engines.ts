import { request } from "./api";
import type { components } from "@graite/api-types";

export type EngineState = components["schemas"]["EngineState"];
export type EngineVariant = components["schemas"]["Variant"];
export type NewestBuild = components["schemas"]["NewestBuild"];

const enc = encodeURIComponent;

/** Engines Graite installs and keeps up to date itself (chat engine, voice engine). */
export const engines = {
  list: () => request<EngineState[]>("/api/v1/engines"),
  /** Without a variant: the build Graite recommends for this computer. With `newest`, the
   * newest upstream build found by `newest()` (geek mode) instead of the tested one. */
  install: (id: string, variant?: string, options: { newest?: boolean } = {}) =>
    request<EngineState>(`/api/v1/engines/${enc(id)}/install`, {
      method: "POST",
      body: JSON.stringify({ variant: variant ?? null, newest: !!options.newest }),
    }),
  /** Geek mode: ask GitHub for the newest build Graite can install. Null when there is none. */
  newest: (id: string) =>
    request<NewestBuild | null>(`/api/v1/engines/${enc(id)}/newest`, { method: "POST" }),
  cancel: (id: string) =>
    request<EngineState>(`/api/v1/engines/${enc(id)}/cancel`, { method: "POST" }),
  rollback: (id: string) =>
    request<EngineState>(`/api/v1/engines/${enc(id)}/rollback`, { method: "POST" }),
  remove: (id: string) => request<EngineState>(`/api/v1/engines/${enc(id)}`, { method: "DELETE" }),
};

export function variantSize(variant: EngineVariant): number {
  return (variant.archives ?? []).reduce((total, archive) => total + archive.size, 0);
}

/** "2.4 GB" / "8 MB": model and engine sizes, so a 2 MB model does not read "0.00 GB". */
export function megabytes(bytes: number): string {
  return bytes >= 1e9
    ? `${(bytes / 1e9).toFixed(1)} GB`
    : `${Math.max(1, Math.round(bytes / 1e6))} MB`;
}
