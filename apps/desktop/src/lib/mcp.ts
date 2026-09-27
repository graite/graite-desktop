import { request } from "./api";
import type { components } from "@graite/api-types";

export type McpInfo = components["schemas"]["McpInfo"];
export type RemoteInfo = components["schemas"]["RemoteInfo"];
export type ClientStatus = components["schemas"]["ClientStatus"];
export type ClientId = "claude-code" | "codex" | "cursor";

/** The entry name in local apps. The remote connector is `graite`, so the two never clash. */
export const LOCAL_NAME = "graite-local";

export const mcp = {
  info: () => request<McpInfo>("/api/v1/mcp/info"),
  /** Remote access through Graite Cloud, for hosted clients such as claude.ai and ChatGPT. */
  setRemote: (enabled: boolean) =>
    request<RemoteInfo>("/api/v1/mcp/remote", {
      method: "PUT",
      body: JSON.stringify({ enabled }),
    }),
  /** Graite adds itself to Claude Code, Codex or Cursor on this computer. */
  addClient: (id: ClientId) =>
    request<ClientStatus>(`/api/v1/mcp/clients/${id}`, { method: "POST" }),
};

/** A shell word, quoted only when it has to be. */
const word = (value: string) =>
  /^[\w@%+=:,./-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;

/** `mcpServers` entry for Cursor (~/.cursor/mcp.json). */
export function jsonConfig(info: McpInfo): string {
  return JSON.stringify(
    { mcpServers: { [LOCAL_NAME]: { command: info.stdio_command, args: info.stdio_args } } },
    null,
    2,
  );
}

/** One line for Claude Code. It launches the bridge, which finds the running app by itself. */
export function claudeCodeCommand(info: McpInfo): string {
  return [
    "claude",
    "mcp",
    "add",
    "-s",
    "user",
    LOCAL_NAME,
    "--",
    info.stdio_command,
    ...info.stdio_args,
  ]
    .map(word)
    .join(" ");
}

/** One line for Codex; it writes ~/.codex/config.toml itself. */
export function codexCommand(info: McpInfo): string {
  return ["codex", "mcp", "add", LOCAL_NAME, "--", info.stdio_command, ...info.stdio_args]
    .map(word)
    .join(" ");
}

/** Direct HTTP. Only worth showing when the daemon keeps its port and token between launches. */
export function httpCommand(info: McpInfo, token: string): string {
  return [
    "claude",
    "mcp",
    "add",
    "--transport",
    "http",
    LOCAL_NAME,
    info.http_url,
    "--header",
    `Authorization: Bearer ${token}`,
  ]
    .map(word)
    .join(" ");
}
