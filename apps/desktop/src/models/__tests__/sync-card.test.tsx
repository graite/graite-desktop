import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

const syncMock = vi.hoisted(() => ({
  status: vi.fn(),
  setup: vi.fn(),
  passphrase: vi.fn(),
  unlock: vi.fn(),
  enable: vi.fn(),
  disable: vi.fn(),
  reset: vi.fn(),
}));
vi.mock("@/lib/sync", () => ({ sync: syncMock }));
vi.mock("@/lib/api", () => ({
  api: { health: vi.fn().mockResolvedValue({ vault: "/home/sam/Notes" }) },
}));

import { SyncCard } from "@/models/SyncCard";

const BASE = {
  signed_in: true,
  set_up: true,
  unlocked: true,
  space_id: null,
  connected: false,
  waiting: 0,
  error: null,
  spaces: [],
};
const SPACE = {
  id: "s1",
  name: "Notes",
  devices: [
    { id: "r1", name: "Laptop", this_device: true, connected: true, in_sync: true },
    { id: "r2", name: "Desk", this_device: false, connected: false, in_sync: false },
    { id: "r3", name: "Phone", this_device: false, connected: false, in_sync: null },
  ],
};

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

it("asks to sign in first, and leads to Graite Cloud", async () => {
  syncMock.status.mockResolvedValue({ ...BASE, signed_in: false, set_up: null });
  const onOpenCloud = vi.fn();
  render(<SyncCard onOpenCloud={onOpenCloud} />);
  expect(await screen.findByText("Sign in first")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Open Graite Cloud" }));
  expect(onOpenCloud).toHaveBeenCalled();
});

it("shares the vault in one click on the first computer and shows the six words", async () => {
  syncMock.status.mockResolvedValue({ ...BASE, set_up: false, unlocked: false });
  syncMock.setup.mockResolvedValue(BASE);
  syncMock.enable.mockResolvedValue({ ...BASE, space_id: "s1", spaces: [SPACE] });
  syncMock.passphrase.mockResolvedValue("one two three four five six");
  render(<SyncCard />);
  expect(
    await screen.findByRole("heading", { name: "Share this vault with your other devices" }),
  ).toBeTruthy();
  expect(screen.getByRole("list", { name: "How it works" }).textContent).toContain(
    "You get six secret words.",
  );
  expect(screen.queryByRole("button", { name: "Get new words" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Share this vault" }));
  // Each word in its own numbered block.
  const blocks = within(await screen.findByRole("list", { name: "Six secret words" }));
  expect(blocks.getAllByRole("listitem").map((li) => li.textContent)).toEqual([
    "1one",
    "2two",
    "3three",
    "4four",
    "5five",
    "6six",
  ]);
  // Each word can be copied on its own, and all six at once.
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.assign(navigator, { clipboard: { writeText } });
  fireEvent.click(blocks.getByRole("button", { name: "Copy word 3" }));
  expect(writeText).toHaveBeenLastCalledWith("three");
  fireEvent.click(screen.getByRole("button", { name: "Copy all six" }));
  expect(writeText).toHaveBeenLastCalledWith("one two three four five six");
  expect(await screen.findByRole("button", { name: "Copied" })).toBeTruthy();
  expect(syncMock.setup).toHaveBeenCalled();
  expect(syncMock.enable).toHaveBeenCalledWith();
  expect(screen.getByRole("heading", { name: /“Notes” is shared/ })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Hide secret words" }));
  expect(screen.queryByRole("list", { name: "Six secret words" })).toBeNull();
});

it("connects another computer with six blocks, pasted or typed, and says why it failed", async () => {
  syncMock.status.mockResolvedValue({ ...BASE, unlocked: false });
  syncMock.unlock.mockRejectedValueOnce(new Error("That passphrase does not open sync."));
  render(<SyncCard />);
  const first = await screen.findByLabelText("Word 1");
  const connect = screen.getByRole("button", { name: "Connect" }) as HTMLButtonElement;
  fireEvent.change(first, { target: { value: "Wrong" } });
  expect(connect.disabled).toBe(true);
  // Pasting all six fills every block.
  fireEvent.paste(first, {
    clipboardData: { getData: () => "Wrong horse-battery staple  fifth sixth" },
  });
  expect((screen.getByLabelText("Word 3") as HTMLInputElement).value).toBe("battery");
  expect((screen.getByLabelText("Word 6") as HTMLInputElement).value).toBe("sixth");
  expect(connect.disabled).toBe(false);
  fireEvent.click(connect);
  expect((await screen.findByRole("alert")).textContent).toContain("does not open sync");
  expect(syncMock.unlock).toHaveBeenLastCalledWith("wrong horse battery staple fifth sixth");
  // Not connected yet: there is nothing to stop, only new words to get.
  expect(screen.getByText("Don’t have the words?")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Stop sharing here" })).toBeNull();
});

it("says what happens to the pages before a vault is fetched into this folder", async () => {
  syncMock.status.mockResolvedValue({ ...BASE, spaces: [SPACE] });
  syncMock.enable.mockResolvedValue({ ...BASE, space_id: "s1", spaces: [SPACE] });
  render(<SyncCard />);
  expect(await screen.findByText(/Pages already in this folder stay/)).toBeTruthy();
  expect(await screen.findByText(/copied into the folder “Notes”/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Get this vault here" }));
  await waitFor(() => expect(syncMock.enable).toHaveBeenCalledWith("s1"));
});

it("lists the devices, and says in plain words what stopping does", async () => {
  syncMock.status.mockResolvedValue({ ...BASE, space_id: "s1", connected: true, spaces: [SPACE] });
  syncMock.disable.mockResolvedValue(BASE);
  render(<SyncCard />);
  expect(await screen.findByText("Laptop (this computer)")).toBeTruthy();
  expect(screen.getByText("up to date")).toBeTruthy();
  expect(screen.getByText("behind · offline")).toBeTruthy();
  expect(screen.getByText("not synced yet")).toBeTruthy();
  expect(screen.getByText(/Your pages stay on this computer/)).toBeTruthy();
  expect(screen.getByText("Lost your six words, or a device?")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Stop sharing here" }));
  await waitFor(() => expect(syncMock.disable).toHaveBeenCalled());
});

it("says so when this computer has no words to show", async () => {
  syncMock.status.mockResolvedValue({ ...BASE, space_id: "s1", connected: true, spaces: [SPACE] });
  syncMock.passphrase.mockResolvedValue(null);
  render(<SyncCard />);
  fireEvent.click(await screen.findByRole("button", { name: "Show secret words" }));
  expect(await screen.findByText(/does not have the words saved/)).toBeTruthy();
});

it("gets new words only after a second click", async () => {
  syncMock.status.mockResolvedValue({ ...BASE, unlocked: false });
  syncMock.reset.mockResolvedValue({ ...BASE, set_up: false, unlocked: false });
  render(<SyncCard />);
  fireEvent.click(await screen.findByRole("button", { name: "Get new words" }));
  expect(syncMock.reset).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Yes, new words for all my devices" }));
  expect(await screen.findByRole("button", { name: "Share this vault" })).toBeTruthy();
  expect(syncMock.reset).toHaveBeenCalled();
});
