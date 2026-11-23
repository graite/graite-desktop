import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const api = vi.hoisted(() => ({ status: vi.fn(), install: vi.fn(), login: vi.fn() }));
vi.mock("@/lib/claudeCode", () => ({ claudeCode: api }));

import { ClaudeCodeCard } from "@/models/ClaudeCodeCard";

const BASE = { models: ["sonnet", "opus", "haiku"], can_open_terminal: true, method: "", plan: "" };
const MISSING = { ...BASE, installed: false, signed_in: false, connected: false };
const SIGNED_OUT = { ...BASE, installed: true, signed_in: false, connected: false };
const CONNECTED = {
  ...BASE,
  installed: true,
  signed_in: true,
  connected: true,
  method: "claude.ai",
  plan: "max",
};

const show = (activeModel: string | null = null, onPick = vi.fn()) => {
  render(<ClaudeCodeCard activeModel={activeModel} disabled={false} onPick={onPick} />);
  return onPick;
};

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  Object.values(api).forEach((mock) => mock.mockReset());
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

it("offers to set Claude up when Claude Code is not installed", async () => {
  api.status.mockResolvedValue(MISSING);
  api.install.mockResolvedValue({ opened: true, command: "curl … | bash", url: "" });
  show();
  fireEvent.click(await screen.findByRole("button", { name: /Set up Claude/ }));
  expect(await screen.findByText(/Installing in the window that opened/)).toBeTruthy();
  expect(api.install).toHaveBeenCalledOnce();
});

it("opens Claude Code's own sign-in and switches to connected by itself", async () => {
  api.status.mockResolvedValue(SIGNED_OUT);
  api.login.mockResolvedValue({ opened: true, command: "claude auth login --claudeai", url: "" });
  show();
  fireEvent.click(await screen.findByRole("button", { name: "Sign in to Claude" }));
  expect(await screen.findByText(/Finish in your browser/)).toBeTruthy();
  // No field for a password, key or token: the sign-in is not Graite's.
  expect(document.querySelector("input")).toBeNull();
  api.status.mockResolvedValue(CONNECTED);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2600);
  });
  await waitFor(() => expect(screen.getByText("Connected")).toBeTruthy());
  expect(screen.getByText("Claude max plan")).toBeTruthy();
});

it("shows the command to copy when no terminal could be opened", async () => {
  api.status.mockResolvedValue(SIGNED_OUT);
  api.login.mockResolvedValue({ opened: false, command: "claude auth login --claudeai", url: "" });
  show();
  fireEvent.click(await screen.findByRole("button", { name: "Sign in to Claude" }));
  expect(await screen.findByText("claude auth login --claudeai")).toBeTruthy();
  expect(screen.getByRole("button", { name: /Copy command/ })).toBeTruthy();
});

it("picks a Claude model once connected", async () => {
  api.status.mockResolvedValue(CONNECTED);
  const onPick = show("sonnet");
  const opus = await screen.findByRole("radio", { name: "Opus" });
  expect(screen.getByRole("radio", { name: "Sonnet" }).getAttribute("aria-checked")).toBe("true");
  fireEvent.click(opus);
  expect(onPick).toHaveBeenCalledWith("opus");
});

it("says so when Claude Code is signed in without a subscription", async () => {
  api.status.mockResolvedValue({ ...CONNECTED, connected: false, method: "apiKey", plan: "" });
  show();
  expect(await screen.findByText("Claude Code is signed in")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Sign in with a subscription" })).toBeTruthy();
});
