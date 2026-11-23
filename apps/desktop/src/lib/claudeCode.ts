import { request } from "./api";
import type { components } from "@graite/api-types";

export type ClaudeCodeInfo = components["schemas"]["ClaudeCodeInfo"];
export type ClaudeLaunch = components["schemas"]["Launch"];

/** The user's own Claude Code, signed in with their Claude subscription. Graite never sees
 * the sign-in: it asks whether Claude Code is installed and signed in, and can open Claude
 * Code's own install and sign-in commands in a terminal window. */
export const claudeCode = {
  status: () => request<ClaudeCodeInfo>("/api/v1/ai/claude-code/status"),
  install: () => request<ClaudeLaunch>("/api/v1/ai/claude-code/install", { method: "POST" }),
  login: () => request<ClaudeLaunch>("/api/v1/ai/claude-code/login", { method: "POST" }),
};
