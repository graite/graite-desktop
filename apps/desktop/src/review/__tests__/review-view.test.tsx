import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const reviewMock = vi.hoisted(() => ({
  list: vi.fn(),
  get: vi.fn(),
  accept: vi.fn(),
  reject: vi.fn(),
  revert: vi.fn(),
  acceptBatch: vi.fn(),
  optIn: vi.fn(),
}));
vi.mock("@/lib/review", async () => {
  const actual = await vi.importActual<typeof import("@/lib/review")>("@/lib/review");
  return { ...actual, review: reviewMock };
});
vi.mock("@/lib/api", () => ({ onDaemonEvent: vi.fn(() => () => {}) }));

import { ReviewView } from "../ReviewView";

const base = {
  run_id: null,
  conversation_id: "c",
  page_id: null,
  page_title: null,
  base_hash: null,
  old_text: null,
  new_path: null,
  patch: "",
  policy: "propose",
  decided_by: null,
  reason: null,
  decided_at: null,
  applied_hash: null,
  snapshot: null,
  trash_id: null,
  edited: false,
};
const ROWS = [
  {
    ...base,
    id: "p_1",
    page_path: "A",
    kind: "append",
    new_text: "x",
    summary: "First",
    status: "pending",
    created_at: "2",
  },
  {
    ...base,
    id: "p_2",
    page_path: "B",
    kind: "edit",
    new_text: "y",
    summary: "Second",
    status: "pending",
    created_at: "1",
  },
  {
    ...base,
    id: "p_3",
    page_path: "C",
    kind: "append",
    new_text: "z",
    summary: "Auto",
    status: "auto_applied",
    created_at: "3",
  },
  {
    ...base,
    id: "p_4",
    page_path: "D",
    kind: "append",
    new_text: "w",
    summary: "Old",
    status: "rejected",
    created_at: "0",
  },
];

beforeEach(() => {
  vi.clearAllMocks();
  reviewMock.list.mockResolvedValue(ROWS);
  reviewMock.acceptBatch.mockResolvedValue({ applied: ["p_2", "p_1"], stopped_at: null });
});
afterEach(cleanup);

it("groups proposals by state and can accept everything pending", async () => {
  render(<ReviewView onNavigate={vi.fn()} />);
  await screen.findByText("First");
  expect(screen.getByRole("tab", { name: "Pending (2)" }).getAttribute("aria-selected")).toBe(
    "true",
  );
  expect(screen.queryByText("Auto")).toBeNull();
  fireEvent.click(screen.getByRole("tab", { name: "Applied automatically" }));
  expect(screen.queryByRole("button", { name: /Revert/ })).toBeNull();
  fireEvent.click(screen.getByText("Auto"));
  expect(screen.getByRole("button", { name: /Revert/ })).toBeTruthy();
  fireEvent.click(screen.getByRole("tab", { name: "Decided" }));
  expect(screen.getByText("Old")).toBeTruthy();
  fireEvent.click(screen.getByRole("tab", { name: "Pending (2)" }));
  fireEvent.click(screen.getByRole("button", { name: "Accept all pending" }));
  await waitFor(() => expect(reviewMock.acceptBatch).toHaveBeenCalledWith(["p_1", "p_2"]));
});

it("lists proposals as toggles that start small and open on click", async () => {
  render(<ReviewView onNavigate={vi.fn()} />);
  const row = (await screen.findByText("Second")).closest("button")!;
  expect(row.getAttribute("aria-expanded")).toBe("false");
  expect(row.textContent).toContain("B");
  expect(screen.queryByRole("button", { name: /Accept$/ })).toBeNull();
  fireEvent.click(row);
  expect(row.getAttribute("aria-expanded")).toBe("true");
  expect(screen.getByRole("button", { name: /Accept$/ })).toBeTruthy();
  fireEvent.click(row);
  expect(screen.queryByRole("button", { name: /Accept$/ })).toBeNull();
});
