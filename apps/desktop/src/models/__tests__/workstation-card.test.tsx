import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

const computeMock = vi.hoisted(() => ({ status: vi.fn(), serve: vi.fn(), use: vi.fn() }));
vi.mock("@/lib/compute", () => ({ compute: computeMock }));

import { WorkstationCard } from "@/models/WorkstationCard";

const DESK = {
  id: "r2",
  name: "Desk",
  chat_model: "gemma-3-12b",
  chat_models: ["gemma-3-12b"],
  documents: true,
  speech: false,
  voice: true,
  uses: [] as string[],
};
const ALONE = {
  serving: false,
  chat_model: null,
  documents: false,
  speech: false,
  voice: false,
  devices: [],
};

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

function show(status: object | null, shared: boolean | null = true) {
  const props = {
    refresh: vi.fn(async () => {}),
    onStatus: vi.fn(),
    onUsed: vi.fn(),
    onOpenSync: vi.fn(),
  };
  render(<WorkstationCard status={status as never} shared={shared} {...props} />);
  return props;
}

it("offers a workstation for what it can do and moves a task to it", async () => {
  computeMock.use.mockResolvedValue({ provider: "device", model: "gemma-3-12b" });
  const { onUsed, refresh } = show({ ...ALONE, devices: [DESK] });
  const desk = within(screen.getByRole("group", { name: "Desk" }));
  expect(desk.getByText("gemma-3-12b")).toBeTruthy();
  // It has no speech model, so that is not offered. One chat model: nothing to pick.
  expect(desk.getAllByRole("switch").map((s) => s.getAttribute("aria-label"))).toEqual([
    "Chat on Desk",
    "Documents on Desk",
    "Voice on Desk",
  ]);
  expect(desk.queryByRole("combobox")).toBeNull();
  fireEvent.click(desk.getByRole("switch", { name: "Chat on Desk" }));
  await waitFor(() =>
    expect(computeMock.use).toHaveBeenCalledWith("r2", "chat", true, "gemma-3-12b"),
  );
  await waitFor(() =>
    expect(onUsed).toHaveBeenCalledWith({ provider: "device", model: "gemma-3-12b" }),
  );
  await waitFor(() => expect(refresh).toHaveBeenCalled());
});

it("shows what a workstation is used for, takes a task back, and says why that failed", async () => {
  computeMock.use.mockRejectedValue(new Error("Wait for the current answer to finish."));
  show({ ...ALONE, devices: [{ ...DESK, uses: ["documents"] }] });
  const documents = screen.getByRole("switch", { name: "Documents on Desk" });
  expect(documents.getAttribute("aria-checked")).toBe("true");
  expect(screen.getByRole("switch", { name: "Chat on Desk" }).getAttribute("aria-checked")).toBe(
    "false",
  );
  fireEvent.click(documents);
  await waitFor(() =>
    expect(computeMock.use).toHaveBeenCalledWith("r2", "documents", false, undefined),
  );
  expect((await screen.findByRole("alert")).textContent).toContain("Wait for");
});

it("keeps using a workstation and being one apart, and says what this computer lends", async () => {
  computeMock.serve.mockResolvedValue({ ...ALONE, serving: true });
  const { onStatus } = show({ ...ALONE, chat_model: "gemma-3-4b", speech: true });
  // Nothing found: the steps to take on the other computer.
  const using = within(screen.getByRole("region", { name: "Use a workstation" }));
  expect(using.getByText(/No workstation is switched on yet/)).toBeTruthy();
  expect(using.getAllByRole("listitem").length).toBe(3);
  const being = within(screen.getByRole("region", { name: "Be a workstation" }));
  expect(being.getByText(/use it for chat, speech, while Graite is open here/)).toBeTruthy();
  fireEvent.click(
    being.getByRole("switch", { name: "Let my other devices use the AI on this computer" }),
  );
  await waitFor(() => expect(computeMock.serve).toHaveBeenCalledWith(true));
  await waitFor(() => expect(onStatus).toHaveBeenCalledWith({ ...ALONE, serving: true }));
});

it("sends you to Sync devices first when this vault is not shared", () => {
  const { onOpenSync } = show(ALONE, false);
  expect(screen.getByText("First share this vault with that computer")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Open Sync devices" }));
  expect(onOpenSync).toHaveBeenCalled();
});

it("lets you pick which of the workstation's chat models to use", () => {
  show({
    ...ALONE,
    devices: [{ ...DESK, chat_models: ["gemma-3-12b", "big-one-27b"], uses: ["chat"] }],
  });
  const picker = screen.getByRole("combobox", { name: "Chat model on Desk" });
  expect(picker.textContent).toContain("gemma-3-12b");
});
