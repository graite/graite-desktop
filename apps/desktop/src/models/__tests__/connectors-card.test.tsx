import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

const request = vi.hoisted(() => vi.fn());
const host = vi.hoisted(() => ({ platform: { getDaemonInfo: vi.fn() } }));
vi.mock("@/lib/api", () => ({ request, onDaemonEvent: () => () => {} }));
vi.mock("@/lib/platform", () => host);
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

import { ConnectorsCard } from "../ConnectorsCard";

const client = (id: string, name: string, extra: Record<string, unknown> = {}) => ({
  id,
  name,
  found: true,
  installed: false,
  outdated: false,
  where: `~/.${id}`,
  can_install: true,
  note: null,
  ...extra,
});
const INFO = {
  http_url: "http://127.0.0.1:41234/mcp",
  http_stable: false,
  stdio_command: "/opt/Graite/daemon/graite-daemon",
  stdio_args: ["mcp"],
  tools: ["propose_create", "read_page", "search_vault"],
  remote: { enabled: false, connected: false, url: "https://api.getgraite.com/mcp", error: null },
  clients: [
    client("claude-code", "Claude Code"),
    client("codex", "Codex"),
    client("cursor", "Cursor"),
  ],
};
const SIGNED_IN = { signed_in: true, cloud_url: "https://api.getgraite.com", email: "a@b.c" };
const writeText = vi.fn();

function answer(overrides: Record<string, unknown> = {}) {
  request.mockImplementation((path: string) => {
    if (path in overrides) return Promise.resolve(overrides[path]);
    if (path === "/api/v1/cloud/status") return Promise.resolve(SIGNED_IN);
    return Promise.resolve(INFO);
  });
}

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

it("puts the browser connector first, as three steps and what it can do", async () => {
  answer();
  const { container } = render(<ConnectorsCard />);
  const browser = await screen.findByRole("region", { name: "Connect in the browser" });
  const local = screen.getByRole("region", { name: "Apps on this computer" });
  expect(browser.compareDocumentPosition(local) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  const steps = within(browser)
    .getAllByRole("listitem")
    .map((li) => li.querySelector("strong")?.textContent);
  expect(steps.slice(0, 3)).toEqual([
    "Sign in to Graite Cloud",
    "Turn on remote access",
    "Add Graite as a connector in your AI app",
  ]);
  expect(await within(browser).findByText(/Signed in as a@b.c/)).toBeTruthy();
  expect(within(browser).getByText("https://api.getgraite.com/mcp")).toBeTruthy();
  expect(within(browser).getByText(/create pages, boards, cards and properties/)).toBeTruthy();
  expect(within(browser).getByText(/local-only stay hidden/)).toBeTruthy();
  expect(container.textContent).not.toContain("launch-token");
});

it("asks to sign in first, and keeps remote access off until then", async () => {
  answer({ "/api/v1/cloud/status": { signed_in: false, cloud_url: "x" } });
  render(<ConnectorsCard />);
  expect(await screen.findByRole("button", { name: "Sign in" })).toBeTruthy();
  const toggle = screen.getByRole("switch", { name: "Remote access" }) as HTMLButtonElement;
  expect(toggle.disabled).toBe(true);
});

it("switches remote access on", async () => {
  answer({ "/api/v1/mcp/remote": { ...INFO.remote, enabled: true, connected: true } });
  render(<ConnectorsCard />);
  await screen.findByText(/Signed in as/);
  const toggle = screen.getByRole("switch", { name: "Remote access" });
  expect(toggle.getAttribute("aria-checked")).toBe("false");
  fireEvent.click(toggle);
  expect(await screen.findByText(/Connected through Graite Cloud/)).toBeTruthy();
  expect(request).toHaveBeenCalledWith("/api/v1/mcp/remote", {
    method: "PUT",
    body: JSON.stringify({ enabled: true }),
  });
});

it("opens the local apps on a switch, and adds Graite to one in a click", async () => {
  answer({
    "/api/v1/mcp/clients/cursor": client("cursor", "Cursor", { installed: true }),
  });
  render(<ConnectorsCard />);
  const local = await screen.findByRole("switch", { name: /Also connect apps on this computer/ });
  expect(local.getAttribute("aria-checked")).toBe("false");
  expect(screen.queryByRole("listitem", { name: "Cursor" })).toBeNull();
  fireEvent.click(local);
  const cursor = screen.getByRole("listitem", { name: "Cursor" });
  expect(screen.getByRole("listitem", { name: "Claude Code" })).toBeTruthy();
  expect(screen.getByRole("listitem", { name: "Codex" })).toBeTruthy();
  fireEvent.click(within(cursor).getByRole("button", { name: "Add to Cursor" }));
  await waitFor(() =>
    expect(request).toHaveBeenCalledWith("/api/v1/mcp/clients/cursor", { method: "POST" }),
  );
  expect(await within(cursor).findByText("Added", { selector: "span" })).toBeTruthy();
});

it("starts open when an app is already set up, with commands to copy by hand", async () => {
  answer({
    "/api/v1/mcp/info": {
      ...INFO,
      stdio_command: "uv",
      stdio_args: ["run", "--project", "/home/me/My Code/daemon", "graite-daemon", "mcp"],
      clients: [
        client("claude-code", "Claude Code", { installed: true }),
        client("codex", "Codex", { found: false }),
        client("cursor", "Cursor", { can_install: false, note: "bad json" }),
      ],
    },
  });
  render(<ConnectorsCard />);
  const local = await screen.findByRole("switch", { name: /Also connect apps on this computer/ });
  expect(local.getAttribute("aria-checked")).toBe("true");
  expect(screen.getByText(/Not found on this computer/)).toBeTruthy();
  expect(screen.getByText("bad json")).toBeTruthy();
  expect(
    screen.getByText(
      "claude mcp add -s user graite-local -- uv run --project '/home/me/My Code/daemon' graite-daemon mcp",
    ),
  ).toBeTruthy();
  expect(
    screen.getByText(
      "codex mcp add graite-local -- uv run --project '/home/me/My Code/daemon' graite-daemon mcp",
    ),
  ).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Copy Cursor setup" }));
  await waitFor(() => expect(writeText).toHaveBeenCalled());
  expect(JSON.parse(writeText.mock.calls[0][0] as string)).toEqual({
    mcpServers: {
      "graite-local": {
        command: "uv",
        args: ["run", "--project", "/home/me/My Code/daemon", "graite-daemon", "mcp"],
      },
    },
  });
});

it("hides itself on an old daemon", async () => {
  request.mockRejectedValue(new Error("404"));
  const { container } = render(<ConnectorsCard />);
  await waitFor(() => expect(request).toHaveBeenCalled());
  expect(container.textContent).toBe("");
});
