import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
const api = vi.hoisted(() => ({ list: vi.fn(), restore: vi.fn(), purge: vi.fn(), empty: vi.fn() }));
const events = vi.hoisted(() => ({
  listener: null as null | ((e: { type: string; data: unknown }) => void),
}));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("@/lib/api", () => ({
  trash: api,
  request: vi.fn(),
  onDaemonEvent: (l: typeof events.listener) => {
    events.listener = l;
    return () => {
      events.listener = null;
    };
  },
}));
vi.mock("sonner", () => ({ toast }));
import { TrashPage } from "../TrashPage";

const page = (id: string, title: string, path: string) => ({
  trash_id: id,
  title,
  path,
  trashed_at: "2026-09-15T12:00:00Z",
  kind: "page",
  file: null,
  page_id: null,
  size: 2048,
});
const file = {
  trash_id: "f1",
  title: "scan.pdf",
  path: "Projects",
  trashed_at: "2026-09-15T12:00:00Z",
  kind: "attachment",
  file: "0123456789abcdef0123456789abcdef-scan.pdf",
  page_id: "p1",
  size: 1024,
};

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

it("shows deleted pages in the main screen, searches and restores a page", async () => {
  api.list.mockResolvedValue([
    page("one", "Draft", "Projects/Draft"),
    page("two", "Notes", "Notes"),
  ]);
  api.restore.mockResolvedValue({ path: "Projects/Draft" });
  const restored = vi.fn();
  render(<TrashPage version={1} onRestored={restored} />);
  await screen.findByText("Draft");
  fireEvent.change(screen.getByLabelText("Search trash"), { target: { value: "draft" } });
  expect(screen.queryByText("Notes")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Restore" }));
  await waitFor(() => expect(restored).toHaveBeenCalledWith("Projects/Draft"));
  expect(api.restore).toHaveBeenCalledWith("one");
});

it("restores a file into its page without leaving the trash", async () => {
  api.list.mockResolvedValue([file]);
  api.restore.mockResolvedValue({ path: "Projects", title: "Projects" });
  const restored = vi.fn();
  render(<TrashPage version={1} onRestored={restored} onNavigate={vi.fn()} />);
  await screen.findByText("scan.pdf");
  expect(screen.getByText("File from Projects")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Restore" }));
  await waitFor(() => expect(toast.success).toHaveBeenCalled());
  expect(toast.success.mock.calls[0][0]).toBe("Restored “scan.pdf” to Projects");
  expect(restored).not.toHaveBeenCalled();
  expect(screen.queryByText("scan.pdf")).toBeNull();
});

it("empties the trash only after confirming, and deletes one entry for good", async () => {
  api.list.mockResolvedValue([page("one", "Draft", "Projects/Draft"), file]);
  api.purge.mockResolvedValue({ entries: 1, bytes: 1024 });
  api.empty.mockResolvedValue({ entries: 1, bytes: 2048 });
  render(<TrashPage version={1} onRestored={vi.fn()} />);
  await screen.findByText("Draft");

  fireEvent.click(screen.getByRole("button", { name: "Delete scan.pdf permanently" }));
  fireEvent.click(await screen.findByRole("button", { name: "Delete permanently" }));
  await waitFor(() => expect(api.purge).toHaveBeenCalledWith("f1"));
  await waitFor(() => expect(screen.queryByText("scan.pdf")).toBeNull());

  fireEvent.click(screen.getByRole("button", { name: /Empty trash/ }));
  expect(api.empty).not.toHaveBeenCalled();
  expect(await screen.findByText(/cannot be undone/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Delete permanently" }));
  await waitFor(() => expect(api.empty).toHaveBeenCalled());
  expect(await screen.findByText("Trash is empty.")).toBeTruthy();
});

it("reloads when a file is trashed elsewhere", async () => {
  api.list.mockResolvedValueOnce([]).mockResolvedValue([file]);
  render(<TrashPage version={1} onRestored={vi.fn()} />);
  await screen.findByText("Trash is empty.");
  events.listener?.({ type: "trash_changed", data: {} });
  expect(await screen.findByText("scan.pdf")).toBeTruthy();
});
