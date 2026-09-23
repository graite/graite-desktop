import { request } from "./api";
import type { components } from "@graite/api-types";

export type McpInfo = components["schemas"]["McpInfo"];

export const mcp = {
  info: () => request<McpInfo>("/api/v1/mcp/info"),
};

/** A shell word, quoted only when it has to be. */
const word = (value: string) =>
  /^[\w@%+=:,./-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;

/** `mcpServers` entry for Claude Desktop (claude_desktop_config.json) and Cursor (~/.cursor/mcp.json). */
export function jsonConfig(info: McpInfo): string {
  return JSON.stringify(
    { mcpServers: { graite: { command: info.stdio_command, args: info.stdio_args } } },
    null,
    2,
  );
}

/** One line for Claude Code. It launches the bridge, which finds the running app by itself. */
export function claudeCodeCommand(info: McpInfo): string {
  return ["claude", "mcp", "add", "graite", "--", info.stdio_command, ...info.stdio_args]
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
    "graite",
    info.http_url,
    "--header",
    `Authorization: Bearer ${token}`,
  ]
    .map(word)
    .join(" ");
}
