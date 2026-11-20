import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const host = vi.hoisted(() => ({
  getDaemonInfo: vi.fn(),
  vaults: vi.fn(),
  inspectVault: vi.fn(),
  pickFolder: vi.fn(),
  openVault: vi.fn(),
  forgetVault: vi.fn(),
  revealFolder: vi.fn(),
  onVaultChanged: vi.fn(() => () => {}),
  kind: "desktop",
}));
vi.mock("@/lib/platform", async () => {
  const actual = await vi.importActual<typeof import("@/lib/platform")>("@/lib/platform");
  return { ...actual, platform: host };
});
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
const syncMock = vi.hoisted(() => ({ enable: vi.fn(), status: vi.fn() }));
vi.mock("@/lib/sync", () => ({ sync: syncMock }));

import { NoVaultError } from "@/lib/platform";
import { scopedKey } from "@/lib/storage";
import { VaultGate } from "../VaultGate";
import { useVault } from "../vault-context";

const NOTES = { url: "http://127.0.0.1:1", token: "t", vault: "/home/me/Notes", dev: false };
const WORK = { url: "http://127.0.0.1:2", token: "t", vault: "/home/me/Work", dev: false };

function Probe() {
  const vault = useVault();
  return (
    <div>
      <span data-testid="vault">{vault?.info.vault}</span>
      <span data-testid="key">{scopedKey("graite.selectedPath")}</span>
      <button onClick={() => void vault?.switchTo("/home/me/Work", false)}>switch</button>
      <button onClick={() => void vault?.joinInFolder("s1", "/home/me/Work")}>join</button>
    </div>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  host.vaults.mockResolvedValue({ current: null, recent: ["/home/me/Notes"], dev: false });
  host.inspectVault.mockResolvedValue({
    path: "/home/me/Notes",
    exists: true,
    is_dir: true,
    has_graite: true,
    pages: 12,
    other_files: false,
  });
});
afterEach(cleanup);

it("shows the picker while no vault is chosen, then the workspace after opening one", async () => {
  host.getDaemonInfo.mockRejectedValue(new NoVaultError());
  host.openVault.mockResolvedValue(NOTES);
  render(<VaultGate>{() => <Probe />}</VaultGate>);
  await screen.findByRole("dialog", { name: "Choose a vault" });
  const recent = await screen.findByText("Notes");
  expect(screen.getByText("12 pages")).toBeTruthy();
  fireEvent.click(recent.closest("button") as HTMLButtonElement);
  await waitFor(() => expect(host.openVault).toHaveBeenCalledWith("/home/me/Notes", false));
  expect((await screen.findByTestId("vault")).textContent).toBe("/home/me/Notes");
  expect(screen.getByTestId("key").textContent).not.toBe("graite.selectedPath");
});

it("asks before creating a vault in an empty folder and reports a failed open", async () => {
  host.getDaemonInfo.mockRejectedValue(new NoVaultError());
  host.vaults.mockResolvedValue({ current: null, recent: [], dev: false });
  host.pickFolder.mockResolvedValue("/home/me/Fresh");
  host.inspectVault.mockResolvedValue({
    path: "/home/me/Fresh",
    exists: true,
    is_dir: true,
    has_graite: false,
    pages: 0,
    other_files: false,
  });
  host.openVault.mockRejectedValue(new Error("Could not create the folder: read-only"));
  render(<VaultGate>{() => <Probe />}</VaultGate>);
  fireEvent.click(await screen.findByRole("button", { name: /Open or create a folder/ }));
  await screen.findByRole("alertdialog", { name: "Create a vault here?" });
  fireEvent.click(screen.getByRole("button", { name: "Create vault here" }));
  await waitFor(() => expect(host.openVault).toHaveBeenCalledWith("/home/me/Fresh", true));
  expect((await screen.findByRole("alert")).textContent).toContain("read-only");
});

it("remounts the workspace for another vault and scopes storage to it", async () => {
  host.getDaemonInfo.mockResolvedValue(NOTES);
  host.openVault.mockResolvedValue(WORK);
  render(<VaultGate>{() => <Probe />}</VaultGate>);
  expect((await screen.findByTestId("vault")).textContent).toBe("/home/me/Notes");
  const before = screen.getByTestId("key").textContent;
  fireEvent.click(screen.getByText("switch"));
  await waitFor(() => expect(screen.getByTestId("vault").textContent).toBe("/home/me/Work"));
  expect(screen.getByTestId("key").textContent).not.toBe(before);
});

it("shows the startup error with a retry when the daemon fails for another reason", async () => {
  host.getDaemonInfo.mockRejectedValueOnce(new Error("sidecar missing")).mockResolvedValue(NOTES);
  render(<VaultGate>{() => <Probe />}</VaultGate>);
  expect((await screen.findByRole("alert")).textContent).toContain("sidecar missing");
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  expect((await screen.findByTestId("vault")).textContent).toBe("/home/me/Notes");
});

it("gets a shared vault in a new folder: opens the folder, joins there, shows Sync devices", async () => {
  host.getDaemonInfo.mockResolvedValue(NOTES);
  host.openVault.mockResolvedValue(WORK);
  const order: string[] = [];
  host.openVault.mockImplementation(async () => {
    order.push("open");
    return WORK;
  });
  syncMock.enable.mockImplementation(async () => {
    order.push("join");
    return {};
  });
  const opened = vi.fn();
  window.addEventListener("graite:open-settings", opened);
  render(<VaultGate>{() => <Probe />}</VaultGate>);
  fireEvent.click(await screen.findByText("join"));
  await waitFor(() => expect(screen.getByTestId("vault").textContent).toBe("/home/me/Work"));
  expect(host.openVault).toHaveBeenCalledWith("/home/me/Work", true);
  await waitFor(() => expect(syncMock.enable).toHaveBeenCalledWith("s1"));
  expect(order).toEqual(["open", "join"]);
  await waitFor(() => expect(opened).toHaveBeenCalled());
  window.removeEventListener("graite:open-settings", opened);
});

it("marks the vaults that sync with other devices in the picker", async () => {
  host.getDaemonInfo.mockRejectedValue(new NoVaultError());
  host.vaults.mockResolvedValue({
    current: null,
    recent: ["/home/me/Notes", "/home/me/Work"],
    dev: false,
  });
  host.inspectVault.mockImplementation(async (path: string) => ({
    path,
    exists: true,
    is_dir: true,
    has_graite: true,
    pages: 12,
    other_files: false,
    synced: path.endsWith("Work") ? "Work" : null,
  }));
  render(<VaultGate>{() => <Probe />}</VaultGate>);
  const work = (await screen.findByText("Work")).closest("button");
  await waitFor(() => expect(work?.textContent).toContain("Synced"));
  expect(screen.getByText("Notes").closest("button")?.textContent).not.toContain("Synced");
});
