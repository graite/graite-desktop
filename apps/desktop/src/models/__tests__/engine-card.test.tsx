import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const enginesMock = vi.hoisted(() => ({
  list: vi.fn(),
  install: vi.fn(),
  cancel: vi.fn(),
  rollback: vi.fn(),
  remove: vi.fn(),
  newest: vi.fn(),
}));
const listeners = vi.hoisted(
  () => [] as ((e: { type: string; data: Record<string, unknown> }) => void)[],
);
vi.mock("@/lib/engines", async () => {
  const actual = await vi.importActual<typeof import("@/lib/engines")>("@/lib/engines");
  return { ...actual, engines: enginesMock };
});
vi.mock("@/lib/api", () => ({
  onDaemonEvent: (l: (typeof listeners)[number]) => {
    listeners.push(l);
    return () => {};
  },
}));

const toastMock = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn() }));
vi.mock("sonner", () => ({ toast: toastMock }));

import { EngineCard } from "../EngineCard";

const VOICE = {
  id: "crispasr",
  name: "Voice engine",
  purpose: "Gives your assistant its voice.",
  version: "v0.8.33",
  installed_version: null,
  installed_variant: null,
  previous_version: null,
  update_available: false,
  recommended: "windows-x64-vulkan",
  recommended_label: "Graphics card (Vulkan)",
  recommended_size: 36_700_000,
  reason: "Uses your graphics card (NVIDIA RTX 4070).",
  variants: [
    {
      id: "windows-x64-vulkan",
      os: "windows",
      arch: "x64",
      backend: "vulkan",
      label: "Graphics card (Vulkan)",
      archives: [{ url: "u", sha256: "s", size: 36_700_000 }],
    },
    {
      id: "windows-x64-cuda",
      os: "windows",
      arch: "x64",
      backend: "cuda",
      label: "NVIDIA (CUDA 13)",
      archives: [{ url: "u", sha256: "s", size: 509_000_000 }],
    },
  ],
  custom_path: "",
  path: "",
  status: "idle",
  progress: 0,
  error: null,
};

function card() {
  return render(<EngineCard engineId="crispasr" />);
}

beforeEach(() => {
  HTMLElement.prototype.scrollIntoView = vi.fn();
  vi.clearAllMocks();
  localStorage.clear(); // geek mode is remembered app-wide
  listeners.length = 0;
});
afterEach(cleanup);

it("explains the engine and GPU options and offers an install", async () => {
  enginesMock.list.mockResolvedValue([VOICE]);
  enginesMock.install.mockResolvedValue({ ...VOICE, status: "downloading", progress: 3 });
  card();
  const install = await screen.findByRole("button", { name: /Install · 37 MB/ });
  expect(screen.getByText("Gives your assistant its voice.")).toBeTruthy();
  expect(screen.getByText(/Graite downloads it, checks it and runs it for you/)).toBeTruthy();
  const advanced = screen.getByText("Build options").closest("details") as HTMLDetailsElement;
  expect(advanced.open).toBe(false);
  expect(advanced.contains(screen.getByLabelText("Build"))).toBe(true);
  // Graite runs the engine it installed; there is no "use my own build" path here.
  expect(screen.queryByLabelText(/executable/i)).toBeNull();
  // The card face stays one sentence: the Vulkan/CUDA explanation lives beside the Build picker.
  expect(advanced.contains(screen.getByText(/Vulkan uses an AMD, Intel or NVIDIA graphics/))).toBe(
    true,
  );

  fireEvent.click(install);
  await waitFor(() => expect(enginesMock.install).toHaveBeenCalledWith("crispasr"));
  expect(await screen.findByRole("status")).toBeTruthy();
  expect(screen.getByText(/Downloading 3%/)).toBeTruthy();

  enginesMock.list.mockResolvedValue([
    { ...VOICE, installed_version: "v0.8.33", installed_variant: "windows-x64-vulkan" },
  ]);
  listeners.forEach((l) =>
    l({ type: "engine_progress", data: { id: "crispasr", status: "idle", progress: 100 } }),
  );
  expect(await screen.findByText("Ready")).toBeTruthy();
});

it("offers an update, a specific build, a roll back and removal under Advanced", async () => {
  const installed = {
    ...VOICE,
    installed_version: "v0.8.30",
    installed_variant: "windows-x64-vulkan",
    previous_version: "v0.8.29",
    update_available: true,
  };
  enginesMock.list.mockResolvedValue([installed]);
  enginesMock.install.mockResolvedValue(installed);
  enginesMock.rollback.mockResolvedValue(installed);
  card();
  expect(await screen.findByRole("button", { name: "Update" })).toBeTruthy();
  fireEvent.keyDown(screen.getByRole("combobox", { name: "Build" }), { key: "ArrowDown" });
  fireEvent.click(await screen.findByRole("option", { name: /NVIDIA \(CUDA 13\)/ }));
  fireEvent.click(screen.getByRole("button", { name: "Install this build" }));
  await waitFor(() =>
    expect(enginesMock.install).toHaveBeenCalledWith("crispasr", "windows-x64-cuda"),
  );
  fireEvent.click(screen.getByRole("button", { name: "Roll back to v0.8.29" }));
  await waitFor(() => expect(enginesMock.rollback).toHaveBeenCalledWith("crispasr"));
});

it("says so and offers a retry when the engine cannot be read, instead of vanishing", async () => {
  enginesMock.list.mockRejectedValue(new Error("The daemon is not answering."));
  card();
  expect((await screen.findByRole("alert")).textContent).toContain("The daemon is not answering.");
  enginesMock.list.mockResolvedValue([VOICE]);
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  expect(await screen.findByRole("button", { name: /Install · 37 MB/ })).toBeTruthy();
});

it("offers the newest upstream build only in geek mode, and installs it on request", async () => {
  const installed = {
    ...VOICE,
    installed_version: "v0.8.33",
    installed_variant: "windows-x64-vulkan",
  };
  enginesMock.list.mockResolvedValue([installed]);
  const { unmount } = card();
  await screen.findByText("Ready");
  expect(screen.queryByText("Newest build")).toBeNull();
  unmount();

  localStorage.setItem("graite.techMode", "1");
  enginesMock.newest.mockResolvedValue({
    version: "v0.8.60",
    published_at: "2026-11-17T10:00:00Z",
    prerelease: true,
    url: "https://github.com/x/y/releases/tag/v0.8.60",
    newer: true,
    tested: false,
  });
  enginesMock.install.mockResolvedValue({ ...installed, status: "downloading", progress: 1 });
  card();
  expect(await screen.findByText("Newest build")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Check" }));
  expect(await screen.findByText(/not yet tested with Graite/)).toBeTruthy();
  expect(screen.getByRole("link", { name: "Release notes" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: /Install v0\.8\.60/ }));
  await waitFor(() =>
    expect(enginesMock.install).toHaveBeenCalledWith("crispasr", "windows-x64-vulkan", {
      newest: true,
    }),
  );
});

it("says a failed install once as a popup and keeps the reason on the card", async () => {
  enginesMock.list.mockResolvedValue([VOICE]);
  card();
  await screen.findByRole("button", { name: /Install · 37 MB/ });
  const reason = "The engine could not start on this computer.";
  enginesMock.list.mockResolvedValue([{ ...VOICE, status: "error", error: reason }]);
  listeners.forEach((l) =>
    l({ type: "engine_progress", data: { id: "crispasr", status: "error", error: reason } }),
  );
  await waitFor(() =>
    expect(toastMock.error).toHaveBeenCalledWith(reason, { id: "engine-failed-crispasr" }),
  );
  const line = await screen.findByRole("alert");
  expect(line.textContent).toBe(reason);
  expect(line.className).toBe("ai-failure");
});
