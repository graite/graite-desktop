import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const request = vi.hoisted(() => vi.fn());
const host = vi.hoisted(() => ({ platform: { getDaemonInfo: vi.fn() } }));
vi.mock("@/lib/api", () => ({ request }));
vi.mock("@/lib/platform", () => host);
vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));

import { McpCard } from "../McpCard";

const INFO = {
  http_url: "http://127.0.0.1:41234/mcp",
  http_stable: false,
  stdio_command: "/opt/Graite/daemon/graite-daemon",
  stdio_args: ["mcp"],
  tools: ["propose_create", "read_page", "search_vault"],
};
const writeText = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  writeText.mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  host.platform.getDaemonInfo.mockResolvedValue({
    url: "http://127.0.0.1:41234",
    token: "launch-token",
    vault: "/v",
    dev: false,
  });
});
afterEach(cleanup);

it("hands out the restart-proof command and never the per-launch token", async () => {
  request.mockResolvedValue(INFO);
  const { container } = render(<McpCard />);
  expect(
    await screen.findByText("claude mcp add graite -- /opt/Graite/daemon/graite-daemon mcp"),
  ).toBeTruthy();
  expect(request).toHaveBeenCalledWith("/api/v1/mcp/info");
  expect(screen.getByText("propose")).toBeTruthy();
  expect(screen.getByText(/local-only stay hidden/)).toBeTruthy();
  // The desktop app gets a new port and token on every launch: a pasted URL would go stale.
  expect(screen.queryByText("Direct HTTP")).toBeNull();
  expect(container.textContent).not.toContain("launch-token");

  fireEvent.click(screen.getByRole("button", { name: "Copy Claude Desktop · Cursor setup" }));
  await waitFor(() => expect(writeText).toHaveBeenCalled());
  expect(JSON.parse(writeText.mock.calls[0][0] as string)).toEqual({
    mcpServers: { graite: { command: "/opt/Graite/daemon/graite-daemon", args: ["mcp"] } },
  });
});

it("offers direct HTTP for a daemon with a fixed address, and quotes what needs quoting", async () => {
  request.mockResolvedValue({
    ...INFO,
    http_stable: true,
    stdio_command: "uv",
    stdio_args: ["run", "--project", "/home/me/My Code/daemon", "graite-daemon", "mcp"],
  });
  render(<McpCard />);
  expect(
    await screen.findByText(
      "claude mcp add graite -- uv run --project '/home/me/My Code/daemon' graite-daemon mcp",
    ),
  ).toBeTruthy();
  expect(
    await screen.findByText(
      "claude mcp add --transport http graite http://127.0.0.1:41234/mcp --header 'Authorization: Bearer launch-token'",
    ),
  ).toBeTruthy();
});

it("hands an AppImage user a command that survives restarts", async () => {
  request.mockResolvedValue({
    ...INFO,
    stdio_command: "/home/me/Apps/Graite_0.1.0_amd64.AppImage",
  });
  render(<McpCard />);
  expect(
    await screen.findByText(
      "claude mcp add graite -- /home/me/Apps/Graite_0.1.0_amd64.AppImage mcp",
    ),
  ).toBeTruthy();
  expect(screen.getByText(/keeps working across restarts/)).toBeTruthy();
  expect(screen.queryByText(/new location every time/)).toBeNull();
});

it("warns when only the AppImage mount is known, and hides itself on old daemons", async () => {
  request.mockResolvedValue({
    ...INFO,
    stdio_command: "/tmp/.mount_GraitXyz/daemon/graite-daemon",
  });
  render(<McpCard />);
  expect(await screen.findByText(/new location every time/)).toBeTruthy();
  cleanup();
  request.mockRejectedValue(new Error("404"));
  const { container } = render(<McpCard />);
  await waitFor(() => expect(request).toHaveBeenCalledTimes(2));
  expect(container.textContent).toBe("");
});
