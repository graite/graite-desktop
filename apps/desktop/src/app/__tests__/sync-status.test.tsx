import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

const status = vi.hoisted(() => vi.fn());
vi.mock("@/lib/sync", () => ({ sync: { status } }));

import { SyncStatus, syncLine } from "../SyncStatus";

const BASE = {
  signed_in: true,
  set_up: true,
  unlocked: true,
  space_id: "s1",
  connected: true,
  waiting: 0,
  error: null,
  spaces: [],
};

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

it("says what sync is doing, and nothing for a vault that does not sync", () => {
  expect(syncLine(null)).toBeNull();
  expect(syncLine({ ...BASE, space_id: null })).toBeNull();
  expect(syncLine(BASE)?.text).toBe("Synced");
  expect(syncLine({ ...BASE, waiting: 1 })?.text).toBe("Syncing 1 change…");
  expect(syncLine({ ...BASE, waiting: 3 })?.text).toBe("Syncing 3 changes…");
  expect(syncLine({ ...BASE, connected: false })?.text).toBe("Sync offline");
  expect(syncLine({ ...BASE, error: "Keychain locked" })?.text).toBe("Sync needs attention");
});

it("shows the line in the sidebar and leads to Sync devices", async () => {
  status.mockResolvedValue({ ...BASE, waiting: 2 });
  const opened = vi.fn((event: Event) => (event as CustomEvent).detail);
  window.addEventListener("graite:open-settings", opened);
  render(<SyncStatus />);
  fireEvent.click(await screen.findByRole("button", { name: "Syncing 2 changes…" }));
  expect(opened).toHaveReturnedWith("sync");
  window.removeEventListener("graite:open-settings", opened);
});

it("stays out of the way when the vault does not sync", async () => {
  status.mockResolvedValue({ ...BASE, space_id: null });
  const { container } = render(<SyncStatus />);
  await vi.waitFor(() => expect(status).toHaveBeenCalled());
  expect(container.textContent).toBe("");
});
