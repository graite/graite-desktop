import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
const api = vi.hoisted(() => ({ list: vi.fn(), use: vi.fn(), instructions: vi.fn() }));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("@/lib/templates", () => ({ templates: api }));
vi.mock("sonner", () => ({ toast }));
import { TemplatesPage } from "../TemplatesPage";
vi.mock("@/editor/TextInstructionsEditor", () => ({
  TextInstructionsEditor: ({ value, label }: { value: string; label?: string }) => (
    <div aria-label={label}>{value}</div>
  ),
}));

const crm = {
  slug: "crm",
  name: "CRM",
  description: "Companies, contacts and deals.",
  icon: "🤝",
  category: "Business",
  tags: [],
  highlights: ["Weighted pipeline"],
  pages: ["CRM", "Sales playbook"],
  tables: [{ name: "deals", page: "CRM", columns: [{ name: "value", type: "currency" }] }],
  charts: 3,
  dashboards: ["pipeline"],
};
const books = { ...crm, slug: "bookkeeping", name: "Bookkeeping", category: "Finance" };

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

it("lists templates by category and makes one inside the open page", async () => {
  api.list.mockResolvedValue([crm, books]);
  api.use.mockResolvedValue({ path: "Work/My CRM", title: "My CRM" });
  const onCreated = vi.fn();
  render(<TemplatesPage currentPage={{ path: "Work", title: "Work" }} onCreated={onCreated} />);
  await screen.findByText("Bookkeeping");
  fireEvent.click(screen.getByRole("tab", { name: "Business" }));
  expect(screen.queryByText("Bookkeeping")).toBeNull();

  fireEvent.click(screen.getByText("CRM"));
  expect(await screen.findByText("Weighted pipeline")).toBeTruthy();
  fireEvent.change(screen.getByDisplayValue("CRM"), { target: { value: "My CRM" } });
  const [inside, sample] = screen.getAllByRole("switch");
  fireEvent.click(inside!);
  fireEvent.click(sample!);
  fireEvent.click(screen.getByRole("button", { name: "Use template" }));
  await waitFor(() => expect(onCreated).toHaveBeenCalledWith("Work/My CRM"));
  expect(api.use).toHaveBeenCalledWith("crm", {
    title: "My CRM",
    parentPath: "Work",
    sampleData: false,
  });
});

it("shows AI instructions as their own gallery, with search and a text-only dialog", async () => {
  api.list.mockResolvedValue([crm]);
  api.instructions.mockResolvedValue([
    {
      slug: "meeting-notes",
      name: "Meeting notes",
      description: "One subpage per meeting.",
      category: "Productivity",
      icon: "🤝",
      text: "Keep meeting notes.",
    },
    {
      slug: "deal-reviews",
      name: "Deal reviews",
      description: "Keeps every open deal honest.",
      category: "Sales",
      icon: "📈",
      text: "Review my deals.",
    },
  ]);
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  render(<TemplatesPage currentPage={null} onCreated={vi.fn()} />);
  await screen.findByText("CRM");
  fireEvent.click(screen.getByRole("tab", { name: "AI instructions" }));
  // Its own title and explanation, and no page templates in between.
  expect(screen.getByRole("heading", { level: 1, name: "AI instructions" })).toBeTruthy();
  expect(screen.queryByText("CRM")).toBeNull();
  await screen.findByText("Meeting notes");
  fireEvent.change(screen.getByLabelText("Search instructions"), { target: { value: "deal" } });
  expect(screen.queryByText("Meeting notes")).toBeNull();
  fireEvent.click(screen.getByText("Deal reviews"));
  // The dialog holds the text and two buttons, nothing to search or filter.
  const dialog = screen.getByRole("dialog");
  expect(dialog.textContent).toContain("Review my deals.");
  expect(dialog.querySelector("input")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Copy" }));
  await waitFor(() => expect(writeText).toHaveBeenCalledWith("Review my deals."));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
});
