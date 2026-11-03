import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ApiError } from "@/lib/api";
import { RowDocument } from "./RowDocument";

/** A row's document (D80): saved a moment after typing, against the hash it loaded. */
const api = vi.hoisted(() => ({ rowDoc: vi.fn(), writeRowDoc: vi.fn() }));
const toast = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn() }));
vi.mock("@/lib/tables", () => ({ tables: api }));
vi.mock("sonner", () => ({ toast }));
vi.mock("@/lib/api", async (orig) => ({
  ...(await orig<typeof import("@/lib/api")>()),
  pages: { tree: async () => [] },
}));
vi.mock("../MarkdownEditor", () => ({
  MarkdownEditor: ({ value, onChange }: { value: string; onChange: (v: string) => void }) => (
    <textarea aria-label="doc" defaultValue={value} onChange={(e) => onChange(e.target.value)} />
  ),
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.useRealTimers();
});

it("saves after typing stops, with the loaded hash, and reloads on a conflict", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  api.rowDoc.mockResolvedValueOnce({ body: "Old\n", hash: "h1", exists: true });
  api.writeRowDoc.mockResolvedValueOnce({ body: "New\n", hash: "h2", exists: true });
  render(<RowDocument table="CRM/_data/deals.csv" id="d1" title="Pilot" />);
  const box = await screen.findByLabelText("doc");
  fireEvent.change(box, { target: { value: "New" } });
  expect(api.writeRowDoc).not.toHaveBeenCalled();
  await act(async () => {
    vi.advanceTimersByTime(700);
  });
  expect(api.writeRowDoc).toHaveBeenCalledWith("CRM/_data/deals.csv", "d1", "New", "h1", "Pilot");

  // The next save names the new hash; a change elsewhere is a conflict and reloads.
  api.writeRowDoc.mockRejectedValueOnce(new ApiError(409, "conflict"));
  api.rowDoc.mockResolvedValueOnce({ body: "Theirs\n", hash: "h3", exists: true });
  fireEvent.change(box, { target: { value: "Mine" } });
  await act(async () => {
    vi.advanceTimersByTime(700);
  });
  expect(api.writeRowDoc).toHaveBeenLastCalledWith(
    "CRM/_data/deals.csv",
    "d1",
    "Mine",
    "h2",
    "Pilot",
  );
  await vi.waitFor(() => expect(toast.error).toHaveBeenCalled());
  expect(((await screen.findByLabelText("doc")) as HTMLTextAreaElement).value).toBe("Theirs\n");
});
