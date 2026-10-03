import { request } from "./api";
import type { components } from "@graite/api-types";

/** Charts and read-only queries over a page's CSV tables (D72). */
export type ChartData = components["schemas"]["ChartData"];
export type QueryResult = components["schemas"]["QueryResult"];

/** A `graite:chart` fence as the daemon reads it: only the keys that are set. */
export type ChartSpec = Record<string, string | number | boolean | string[]>;

const json = (body: unknown): RequestInit => ({ body: JSON.stringify(body) });

export const charts = {
  data: (pagePath: string, spec: ChartSpec, signal?: AbortSignal) =>
    request<ChartData>("/api/v1/charts/data", {
      method: "POST",
      signal,
      own: false,
      ...json({ page_path: pagePath, spec }),
    }),
  /** A chart spec from words, made by the page's model and checked against the data (D73).
   *  With `current`, a change to that chart ("as a line", "only Done"). */
  ai: (pagePath: string, prompt: string, current?: ChartSpec, signal?: AbortSignal) =>
    request<{ spec: ChartSpec; message: string }>("/api/v1/charts/ai", {
      method: "POST",
      signal,
      own: false,
      ...json({ page_path: pagePath, prompt, current: current ?? null }),
    }),
  /** One read-only SELECT over the tables `pagePath` may read. */
  query: (pagePath: string, sql: string) =>
    request<QueryResult>("/api/v1/tables/query", {
      method: "POST",
      own: false,
      ...json({ page_path: pagePath, sql }),
    }),
};
