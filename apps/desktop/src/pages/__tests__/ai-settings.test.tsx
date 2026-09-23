import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
const api = vi.hoisted(() => ({
  get: vi.fn(),
  put: vi.fn(),
  getInstructions: vi.fn(),
  putInstructions: vi.fn(),
}));
vi.mock("@/lib/api", () => ({
  pages: { aiSettings: api, instructions: { get: api.getInstructions, put: api.putInstructions } },
  ConflictError: class extends Error {},
}));
vi.mock("@/editor/TextInstructionsEditor", () => ({
  TextInstructionsEditor: ({
    value,
    onChange,
    label = "Instructions",
    readOnly,
  }: {
    value: string;
    onChange?: (value: string) => void;
    label?: string;
    readOnly?: boolean;
  }) =>
    readOnly ? (
      <div aria-label={label}>{value}</div>
    ) : (
      <textarea aria-label={label} value={value} onChange={(e) => onChange?.(e.target.value)} />
    ),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn() } }));
import { AiSettingsDialog } from "../AiSettingsDialog";
const inherited = {
  values: { autonomy: "propose", cloud: "allowed" },
  sources: { autonomy: "Projects", cloud: "default" },
  instructions: [
    { source: "AGENTS.md", text: "Use clear language." },
    { source: "Projects", text: "Include the owner." },
  ],
};
const settings = { own: {}, inherited, effective: inherited, page: { hash: "h1" } };
beforeEach(() => {
  vi.clearAllMocks();
  api.get.mockResolvedValue(settings);
  api.put.mockResolvedValue(settings);
});
afterEach(cleanup);
it("shows simple page permissions, inherited instructions and no model picker", async () => {
  render(<AiSettingsDialog path="Projects/Atlas" title="Atlas" open onOpenChange={vi.fn()} />);
  await screen.findByLabelText("Instructions");
  expect((screen.getByLabelText("This page + children") as HTMLInputElement).checked).toBe(true);
  expect((screen.getByLabelText("Ask before applying") as HTMLInputElement).checked).toBe(true);
  expect(screen.getByText("Use clear language.")).toBeTruthy();
  expect(screen.getByText("Include the owner.")).toBeTruthy();
  expect(screen.queryByRole("combobox")).toBeNull();
});
it("saves this-page access and explicit auto-apply permission", async () => {
  render(<AiSettingsDialog path="Projects/Atlas" title="Atlas" open onOpenChange={vi.fn()} />);
  fireEvent.change(await screen.findByLabelText("Instructions"), {
    target: { value: "New contacts need an email." },
  });
  fireEvent.click(screen.getByLabelText("This page"));
  fireEvent.click(screen.getByLabelText("Apply changes automatically"));
  fireEvent.click(screen.getByLabelText("Local models only"));
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() =>
    expect(api.put).toHaveBeenCalledWith(
      "Projects/Atlas",
      {
        instructions: "New contacts need an email.",
        ai_scope: "page",
        autonomy: "auto-apply",
        cloud: "local-only",
        model: null,
        auto_apply_kinds: ["append", "create", "edit", "properties"],
      },
      "h1",
    ),
  );
});
it("does not let descendants lift inherited restrictions", async () => {
  const locked = {
    ...inherited,
    values: { autonomy: "none", cloud: "local-only" },
    sources: { autonomy: "Projects", cloud: "Projects" },
  };
  api.get.mockResolvedValue({ ...settings, inherited: locked, effective: locked });
  render(<AiSettingsDialog path="Projects/Atlas" title="Atlas" open onOpenChange={vi.fn()} />);
  await screen.findByLabelText("Instructions");
  expect((screen.getByLabelText("Allowed") as HTMLInputElement).disabled).toBe(true);
  expect((screen.getByLabelText("Apply changes automatically") as HTMLInputElement).disabled).toBe(
    true,
  );
});
it("edits workspace instructions at the source while preserving the page draft", async () => {
  api.getInstructions.mockResolvedValue({
    source: "AGENTS.md",
    text: "Use clear language.",
    hash: "root1",
  });
  api.putInstructions.mockResolvedValue({});
  render(<AiSettingsDialog path="Projects/Atlas" title="Atlas" open onOpenChange={vi.fn()} />);
  fireEvent.change(await screen.findByLabelText("Instructions"), { target: { value: "Draft" } });
  fireEvent.click(screen.getByText("Workspace instructions"));
  fireEvent.click(screen.getByRole("button", { name: "Open shared instruction settings" }));
  const shared = await screen.findByLabelText("Shared instructions");
  await waitFor(() => expect((shared as HTMLTextAreaElement).value).toBe("Use clear language."));
  fireEvent.change(shared, { target: { value: "Write clearly." } });
  fireEvent.click(screen.getByRole("button", { name: "Save instructions" }));
  await waitFor(() =>
    expect(api.putInstructions).toHaveBeenCalledWith("AGENTS.md", "Write clearly.", "root1"),
  );
  await waitFor(() => expect(screen.queryByLabelText("Shared instructions")).toBeNull());
  expect(
    (within(screen.getByRole("dialog")).getByLabelText("Instructions") as HTMLTextAreaElement)
      .value,
  ).toBe("Draft");
});

it("opens inherited page settings at the source and saves the current draft first", async () => {
  const navigate = vi.fn().mockResolvedValue(undefined);
  const close = vi.fn();
  render(
    <AiSettingsDialog
      path="Projects/Atlas"
      title="Atlas"
      open
      onOpenChange={close}
      onNavigateSettings={navigate}
    />,
  );
  fireEvent.change(await screen.findByLabelText("Instructions"), {
    target: { value: "Keep this draft." },
  });
  fireEvent.click(screen.getByText("Projects"));
  expect(screen.queryByRole("button", { name: "Edit instructions from Projects" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Open page settings" }));
  await waitFor(() => expect(navigate).toHaveBeenCalledWith("Projects"));
  expect(api.put).toHaveBeenCalledWith(
    "Projects/Atlas",
    expect.objectContaining({ instructions: "Keep this draft." }),
    "h1",
  );
  expect(api.put.mock.invocationCallOrder[0]).toBeLessThan(navigate.mock.invocationCallOrder[0]);
  expect(close).toHaveBeenCalledWith(false);
});
it("keeps the draft open when saving before source navigation fails", async () => {
  api.put.mockRejectedValue(new Error("Save failed"));
  const navigate = vi.fn();
  render(
    <AiSettingsDialog
      path="Projects/Atlas"
      title="Atlas"
      open
      onOpenChange={vi.fn()}
      onNavigateSettings={navigate}
    />,
  );
  fireEvent.change(await screen.findByLabelText("Instructions"), { target: { value: "Unsaved" } });
  fireEvent.click(screen.getByText("Projects"));
  fireEvent.click(screen.getByRole("button", { name: "Open page settings" }));
  expect(await screen.findByRole("alert")).toHaveProperty("textContent", "Save failed");
  expect(navigate).not.toHaveBeenCalled();
});
