import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const updates = vi.hoisted(() => ({
  status: vi.fn(),
  check: vi.fn(),
  install: vi.fn(),
}));
vi.mock("@/lib/platform", () => ({ platform: { kind: "desktop", updates } }));

import { resetUpdatesForTest } from "@/lib/updates";
import { UpdateCard } from "../UpdateCard";

beforeEach(() => {
  resetUpdatesForTest();
  updates.status.mockResolvedValue({ version: "0.4.0", supported: true });
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

it("shows nothing where the install is updated some other way", async () => {
  updates.status.mockResolvedValue({ version: "0.4.0", supported: false });
  const { container } = render(<UpdateCard />);
  await waitFor(() => expect(updates.status).toHaveBeenCalled());
  expect(container.textContent).toBe("");
});

it("checks on request and says when there is nothing newer", async () => {
  updates.check.mockResolvedValue(null);
  render(<UpdateCard />);
  fireEvent.click(await screen.findByRole("button", { name: "Check for updates" }));
  expect(await screen.findByText("You have the newest version.")).toBeTruthy();
  expect(screen.getByText(/Version 0\.4\.0\./)).toBeTruthy();
});

it("offers a found update and installs it only when asked", async () => {
  updates.check.mockResolvedValue({ version: "0.5.0", notes: null });
  updates.install.mockImplementation(async (onProgress: (f: number | null) => void) => {
    onProgress(0.5);
    await new Promise(() => {}); // the app restarts; this never resolves
  });
  render(<UpdateCard />);
  fireEvent.click(await screen.findByRole("button", { name: "Check for updates" }));
  const install = await screen.findByRole("button", { name: "Install and restart" });
  expect(updates.install).not.toHaveBeenCalled();
  fireEvent.click(install);
  expect(await screen.findByText("Installing version 0.5.0… 50%")).toBeTruthy();
});

it("reports a failed check and lets the user try again", async () => {
  updates.check.mockRejectedValue(new Error("offline"));
  render(<UpdateCard />);
  fireEvent.click(await screen.findByRole("button", { name: "Check for updates" }));
  expect(await screen.findByText("Could not check for updates: offline")).toBeTruthy();
  expect(
    (screen.getByRole("button", { name: "Check for updates" }) as HTMLButtonElement).disabled,
  ).toBe(false);
});
