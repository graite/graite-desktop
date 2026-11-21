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

const TEST_OK = { ok: true, via: "server", tools: 3, pages: 12, ms: 40, error: null };

it("has one switch for everything, and says who used Graite last", async () => {
  answer({
    "/api/v1/mcp/info": {
      ...INFO,
      enabled: true,
      last_used: { client: "claude-code", at: new Date(Date.now() - 120_000).toISOString() },
    },
  });
  render(<ConnectorsCard />);
  const master = await screen.findByRole("switch", { name: "Let AI apps use Graite" });
  expect(master.getAttribute("aria-checked")).toBe("true");
  expect(screen.getByText(/last used by claude-code, 2 minutes ago/)).toBeTruthy();
  // Both kinds of app are there without opening anything.
  expect(screen.getByRole("region", { name: "Apps in the browser" })).toBeTruthy();
  expect(screen.getByRole("region", { name: "Apps on this computer" })).toBeTruthy();
});

it("switches everything off in one click and hides what no longer applies", async () => {
  answer({ "/api/v1/mcp/info": { ...INFO, enabled: true, last_used: null } });
  render(<ConnectorsCard />);
  const master = await screen.findByRole("switch", { name: "Let AI apps use Graite" });
  expect(screen.getByText(/no app has used it yet/)).toBeTruthy();
  request.mockImplementation((path: string, init?: RequestInit) =>
    Promise.resolve(
      path === "/api/v1/mcp/enabled" && init?.method === "PUT"
        ? { ...INFO, enabled: false, last_used: null }
        : path === "/api/v1/cloud/status"
          ? SIGNED_IN
          : INFO,
    ),
  );
  fireEvent.click(master);
  await waitFor(() => expect(master.getAttribute("aria-checked")).toBe("false"));
  expect(request).toHaveBeenCalledWith(
    "/api/v1/mcp/enabled",
    expect.objectContaining({ method: "PUT", body: JSON.stringify({ enabled: false }) }),
  );
  expect(screen.getByText(/No app can read or change anything/)).toBeTruthy();
  expect(screen.queryByRole("region", { name: "Apps on this computer" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Test" })).toBeNull();
});

it("tests the connection for real and says what it found", async () => {
  answer({ "/api/v1/mcp/test?via=server": TEST_OK });
  render(<ConnectorsCard />);
  fireEvent.click(await screen.findByRole("button", { name: "Test" }));
  expect(
    await screen.findByText("Works. An app can use 3 tools and read your 12 pages (40 ms)."),
  ).toBeTruthy();
});

it("shows why a test failed", async () => {
  answer({
    "/api/v1/mcp/test?via=server": { ...TEST_OK, ok: false, error: "Graite gave no answer." },
  });
  render(<ConnectorsCard />);
  fireEvent.click(await screen.findByRole("button", { name: "Test" }));
  expect((await screen.findByRole("alert")).textContent).toContain("Graite gave no answer.");
});

it("asks to sign in before remote access, then offers the switch and the address", async () => {
  answer({ "/api/v1/cloud/status": { signed_in: false, cloud_url: "https://api.getgraite.com" } });
  const first = render(<ConnectorsCard />);
  const browser = within(await screen.findByRole("region", { name: "Apps in the browser" }));
  expect(browser.getByRole("button", { name: "Sign in" })).toBeTruthy();
  expect(browser.queryByRole("switch")).toBeNull();
  first.unmount();

  answer({
    "/api/v1/mcp/remote": { ...INFO.remote, enabled: true, connected: true },
  });
  render(<ConnectorsCard />);
  const remote = await screen.findByRole("switch", { name: "Remote access" });
  expect(screen.queryByText("Connector URL")).toBeNull();
  fireEvent.click(remote);
  await waitFor(() => expect(remote.getAttribute("aria-checked")).toBe("true"));
  expect(await screen.findByText("Connector URL")).toBeTruthy();
  expect(screen.getByText(/Connected · signed in as a@b.c/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Copy Connector URL setup" }));
  await waitFor(() => expect(writeText).toHaveBeenCalledWith("https://api.getgraite.com/mcp"));
});

it("adds Graite to an app in one click, then offers to test that app", async () => {
  answer({
    "/api/v1/mcp/clients/claude-code": client("claude-code", "Claude Code", { installed: true }),
    "/api/v1/mcp/test?via=bridge": { ...TEST_OK, via: "bridge", pages: 0, ms: 310 },
  });
  render(<ConnectorsCard />);
  const row = within(await screen.findByRole("listitem", { name: "Claude Code" }));
  expect(row.getByText("Not added yet")).toBeTruthy();
  fireEvent.click(row.getByRole("button", { name: "Add to Claude Code" }));
  expect(await row.findByText("Added")).toBeTruthy();
  fireEvent.click(row.getByRole("button", { name: "Test Claude Code" }));
  expect(
    await row.findByText("Works. The app can start Graite and sees 3 tools (310 ms)."),
  ).toBeTruthy();
  // The by-hand command stays one click away.
  expect(row.getByText("Set it up by hand")).toBeTruthy();
  expect(row.getByText(/claude mcp add/)).toBeTruthy();
});

it("shows one app at a time, picked from three", async () => {
  render(<ConnectorsCard />);
  const local = within(await screen.findByRole("region", { name: "Apps on this computer" }));
  expect(local.getAllByRole("radio").map((r) => r.textContent)).toEqual([
    "Claude Code",
    "Codex",
    "Cursor",
  ]);
  expect(local.getAllByRole("listitem").length).toBe(1);
  fireEvent.click(local.getByRole("radio", { name: "Cursor" }));
  expect(local.getByRole("listitem", { name: "Cursor" })).toBeTruthy();
  expect(local.queryByRole("listitem", { name: "Claude Code" })).toBeNull();
  expect(local.getByText(/mcp\.json/)).toBeTruthy();
});

it("explains the browser connection in three steps", async () => {
  render(<ConnectorsCard />);
  const browser = within(await screen.findByRole("region", { name: "Apps in the browser" }));
  expect(
    browser.getByRole("heading", { name: "Your pages inside Claude and ChatGPT" }),
  ).toBeTruthy();
  expect(
    within(browser.getByRole("list", { name: "How to connect" }))
      .getAllByRole("listitem")
      .map((step) => step.textContent),
  ).toEqual([
    "Sign in to Graite Cloud",
    "Switch on remote access",
    "Paste the address into Claude or ChatGPT",
  ]);
});

it("offers Update when an app points at a Graite that has moved", async () => {
  answer({
    "/api/v1/mcp/info": {
      ...INFO,
      clients: [client("cursor", "Cursor", { installed: true, outdated: true })],
    },
  });
  render(<ConnectorsCard />);
  const row = within(await screen.findByRole("listitem", { name: "Cursor" }));
  expect(row.getByText(/pointing at an older Graite/)).toBeTruthy();
  expect(row.getByRole("button", { name: "Update" })).toBeTruthy();
  expect(row.queryByRole("button", { name: "Test Cursor" })).toBeNull();
});

it("says so when the settings cannot be loaded, and can try again", async () => {
  request.mockRejectedValueOnce(new Error("Graite did not answer."));
  render(<ConnectorsCard />);
  expect((await screen.findByRole("alert")).textContent).toContain("Graite did not answer.");
  answer();
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  expect(await screen.findByRole("switch", { name: "Let AI apps use Graite" })).toBeTruthy();
});
