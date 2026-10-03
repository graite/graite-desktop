import { request } from "./api";
import { platform } from "./platform";
import type { components } from "@graite/api-types";

/** HTML dashboards in a page's `_dashboards/` (D72). */
export type Dashboard = components["schemas"]["Dashboard"];
export type DashboardInfo = components["schemas"]["DashboardInfo"];

const json = (body: unknown): RequestInit => ({ body: JSON.stringify(body) });
const q = (params: Record<string, string>) => new URLSearchParams(params).toString();

export const dashboards = {
  read: (pagePath: string, src: string) =>
    request<Dashboard>(`/api/v1/dashboards?${q({ page_path: pagePath, src })}`),
  list: (pagePath: string) =>
    request<DashboardInfo[]>(`/api/v1/dashboards/list?${q({ page_path: pagePath })}`),
  write: (pagePath: string, src: string, html: string, create = false) =>
    request<Dashboard>("/api/v1/dashboards", {
      method: "PUT",
      ...json({ page_path: pagePath, src, html, create }),
    }),
  /** The full URL of a frame showing a dashboard file or a pending proposal's HTML. */
  async frameUrl(pagePath: string, target: { src?: string; proposalId?: string }) {
    const { url } = await request<{ url: string }>("/api/v1/dashboards/ticket", {
      method: "POST",
      ...json({
        page_path: pagePath,
        src: target.src ?? null,
        proposal_id: target.proposalId ?? null,
      }),
    });
    const daemon = (await platform.getDaemonInfo()).url;
    return `${daemon}${url}`;
  },
};
