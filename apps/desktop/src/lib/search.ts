import { request } from "./api";
import type { components } from "@graite/api-types";

/** Find (Cmd+K and "Find" in chat): answered from the index, never by a chat model. */
export type SearchHit = components["schemas"]["SearchHit"];
export type SearchResult = components["schemas"]["SearchResult"];

export const search = {
  /** Pages matching `query`, best first. `root` limits it to a page and its subpages. */
  find: (query: string, options: { k?: number; root?: string | null } = {}) => {
    const params = new URLSearchParams({ q: query, k: String(options.k ?? 10) });
    if (options.root) params.set("root", options.root);
    return request<SearchResult>(`/api/v1/search?${params}`);
  },
  /** Load the search model in the background, so the searches that follow can use meaning. */
  warm: () => request<{ semantic: boolean }>("/api/v1/search/warm", { method: "POST" }),
};

/** The words of a query that are worth highlighting in a result. */
export function queryTerms(query: string): string[] {
  return [...new Set(query.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])].filter(
    (word) => word.length > 1,
  );
}

/** `text` cut into pieces, marking the ones that start with a query word. */
export function highlight(text: string, terms: string[]): { text: string; hit: boolean }[] {
  if (!terms.length || !text) return [{ text, hit: false }];
  const escaped = terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const pattern = new RegExp(`(?<![\\p{L}\\p{N}])(${escaped.join("|")})[\\p{L}\\p{N}]*`, "giu");
  const out: { text: string; hit: boolean }[] = [];
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    if (match.index > last) out.push({ text: text.slice(last, match.index), hit: false });
    out.push({ text: match[0], hit: true });
    last = match.index + match[0].length;
  }
  if (last < text.length) out.push({ text: text.slice(last), hit: false });
  return out;
}
