import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { DaemonEvent } from "@graite/api-types";

const cloudMock = vi.hoisted(() => ({
  status: vi.fn(),
  login: vi.fn(),
  logout: vi.fn(),
  models: vi.fn(),
  openAccount: vi.fn(),
}));
const listeners = vi.hoisted(() => new Set<(event: DaemonEvent) => void>());
vi.mock("@/lib/cloud", () => ({ cloud: cloudMock }));
vi.mock("@/lib/api", () => ({
  onDaemonEvent: (listener: (event: DaemonEvent) => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
}));
vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));

import { GraiteCloudCard } from "@/models/GraiteCloudCard";

const SIGNED_OUT = { signed_in: false, cloud_url: "https://api.getgraite.com" };
const SIGNED_IN = {
  signed_in: true,
  cloud_url: "https://api.getgraite.com",
  email: "ada@example.com",
  plan: "Free",
  plan_id: "free",
  email_verified: false,
  verify_by: "2026-09-27T12:00:00Z",
  today: {
    limit: 100000,
    used: 38000,
    remaining: 62000,
    percent_used: 38,
    resets_at: "2026-09-25T00:00:00Z",
  },
};
const MODELS = [
  { id: "graite/fast", name: "Fast", context_length: 128000, available: true, min_plan: null },
  { id: "graite/smart", name: "Smart", context_length: 200000, available: false, min_plan: "plus" },
];

beforeEach(() => {
  vi.clearAllMocks();
  listeners.clear();
  cloudMock.models.mockResolvedValue(MODELS);
  cloudMock.login.mockResolvedValue({ url: "https://api.getgraite.com/auth/x", opened: true });
});
afterEach(cleanup);

it("explains Graite Cloud and starts the browser sign-in", async () => {
  cloudMock.status.mockResolvedValue(SIGNED_OUT);
  render(<GraiteCloudCard activeModel={null} disabled={false} onPick={() => {}} />);
  expect(screen.getByText(/runs the models for you/)).toBeTruthy();
  const zdr = screen.getByRole("region", { name: "Zero data retention" });
  expect(zdr.textContent).toMatch(
    /never stored and never used to train models\. We only count tokens/,
  );
  fireEvent.click(await screen.findByRole("button", { name: "Create an account" }));
  expect(await screen.findByText(/Finish in your browser/)).toBeTruthy();
  expect(cloudMock.login).toHaveBeenCalledWith(true);
});

it("updates by itself when the browser sign-in finishes", async () => {
  cloudMock.status.mockResolvedValue(SIGNED_OUT);
  render(<GraiteCloudCard activeModel={null} disabled={false} onPick={() => {}} />);
  fireEvent.click(await screen.findByRole("button", { name: "Sign in with Graite" }));
  await screen.findByText(/Finish in your browser/);
  cloudMock.status.mockResolvedValue(SIGNED_IN);
  act(() => {
    for (const listener of listeners) listener({ type: "cloud_status", data: { signed_in: true } });
  });
  expect(await screen.findByText("ada@example.com")).toBeTruthy();
  expect(screen.queryByText(/Finish in your browser/)).toBeNull();
});

it("uses the model Graite Cloud offers, without a list to choose from", async () => {
  cloudMock.status.mockResolvedValue(SIGNED_IN);
  const onPick = vi.fn();
  render(<GraiteCloudCard activeModel={null} disabled={false} onPick={onPick} />);
  expect(await screen.findByText("ada@example.com")).toBeTruthy();
  await waitFor(() => expect(onPick).toHaveBeenCalledWith(MODELS[0]));
  expect(screen.queryByRole("button", { name: /Fast|Smart/ })).toBeNull();
  expect(screen.getByText(/Ready to chat with Graite Cloud/)).toBeTruthy();
  expect(screen.getByText(/Confirm your email by/)).toBeTruthy();
});

it("shows free accounts no meter, only that today's credits are used up", async () => {
  cloudMock.status.mockResolvedValue(SIGNED_IN);
  const { unmount } = render(
    <GraiteCloudCard activeModel="graite/fast" disabled={false} onPick={() => {}} />,
  );
  expect(await screen.findByText("Free plan")).toBeTruthy();
  expect(screen.queryByRole("progressbar")).toBeNull();
  expect(screen.queryByText(/38%/)).toBeNull();
  expect(screen.queryByText(/used today’s free credits/)).toBeNull();
  unmount();

  cloudMock.status.mockResolvedValue({
    ...SIGNED_IN,
    today: { ...SIGNED_IN.today, used: 100000, remaining: 0, percent_used: 100 },
  });
  render(<GraiteCloudCard activeModel="graite/fast" disabled={false} onPick={() => {}} />);
  expect(await screen.findByText(/You’ve used today’s free credits/)).toBeTruthy();
  expect(screen.queryByRole("progressbar")).toBeNull();
});

it("shows paid plans how much of today is used", async () => {
  cloudMock.status.mockResolvedValue({ ...SIGNED_IN, plan: "Plus", plan_id: "plus" });
  render(<GraiteCloudCard activeModel="graite/fast" disabled={false} onPick={() => {}} />);
  expect((await screen.findByRole("progressbar")).getAttribute("aria-valuenow")).toBe("38");
  expect(screen.getByText(/38% of today’s credits used/)).toBeTruthy();
});

it("says so when Graite Cloud offers no model", async () => {
  cloudMock.status.mockResolvedValue(SIGNED_IN);
  cloudMock.models.mockResolvedValue([]);
  const onPick = vi.fn();
  render(<GraiteCloudCard activeModel={null} disabled={false} onPick={onPick} />);
  expect(await screen.findByText(/isn’t available right now/)).toBeTruthy();
  expect(onPick).not.toHaveBeenCalled();
});

it("signs out", async () => {
  cloudMock.status.mockResolvedValue(SIGNED_IN);
  cloudMock.logout.mockResolvedValue({ signed_in: false });
  render(<GraiteCloudCard activeModel={null} disabled={false} onPick={() => {}} />);
  fireEvent.click(await screen.findByRole("button", { name: /Sign out/ }));
  cloudMock.status.mockResolvedValue(SIGNED_OUT);
  await waitFor(() => expect(screen.getByRole("button", { name: "Sign in with Graite" })));
  expect(cloudMock.logout).toHaveBeenCalled();
});
