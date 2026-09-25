import { request } from "./api";
import type { components } from "@graite/api-types";

export type CloudStatus = components["schemas"]["CloudStatus"];
export type CloudModel = components["schemas"]["CloudModel"];
export type CloudLogin = components["schemas"]["LoginOut"];

/** Graite Cloud, the optional hosted account. The daemon runs the browser sign-in and keeps
 * the tokens in the OS keychain; the UI only ever sees the status. */
export const cloud = {
  status: () => request<CloudStatus>("/api/v1/cloud/status"),
  login: (signup = false) =>
    request<CloudLogin>("/api/v1/cloud/login", {
      method: "POST",
      body: JSON.stringify({ signup }),
    }),
  logout: () => request<{ signed_in: boolean }>("/api/v1/cloud/logout", { method: "POST" }),
  models: () =>
    request<components["schemas"]["CloudModels"]>("/api/v1/cloud/models").then((r) => r.models),
  openAccount: () => request<CloudLogin>("/api/v1/cloud/open-account", { method: "POST" }),
};
