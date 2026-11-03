import { request, type PageDoc } from "./api";
import type { components } from "@graite/api-types";

/** A built-in template (D77): a page tree with tables, charts and dashboards. */
export type Template = components["schemas"]["TemplateModel"];

export const templates = {
  list: () => request<Template[]>("/api/v1/templates"),
  /** Make the template's pages; returns the new top page. */
  use: (slug: string, opts: { parentPath?: string | null; title?: string; sampleData: boolean }) =>
    request<PageDoc>(`/api/v1/templates/${encodeURIComponent(slug)}/use`, {
      method: "POST",
      body: JSON.stringify({
        parent_path: opts.parentPath ?? null,
        title: opts.title?.trim() || null,
        sample_data: opts.sampleData,
      }),
    }),
};
