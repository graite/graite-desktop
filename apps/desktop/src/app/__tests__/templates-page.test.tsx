import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
const api = vi.hoisted(() => ({ list: vi.fn(), use: vi.fn() }));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("@/lib/templates", () => ({ templates: api }));
vi.mock("sonner", () => ({ toast }));
import { TemplatesPage } from "../TemplatesPage";

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
