import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { PageDoc } from "@/lib/api";

const reviewMock = vi.hoisted(() => ({
  list: vi.fn(),
  get: vi.fn(),
  accept: vi.fn(),
  reject: vi.fn(),
  revert: vi.fn(),
  acceptBatch: vi.fn(),
  rejectBatch: vi.fn(),
  optIn: vi.fn(),
}));
const put = vi.hoisted(() => vi.fn());
vi.mock("@/lib/review", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/review")>()),
  review: reviewMock,
}));
vi.mock("@/lib/api", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/api")>();
  return { ...real, onDaemonEvent: () => () => {}, pages: { ...real.pages, put } };
});
vi.mock("sonner", () => ({ toast: { success: vi.fn(), warning: vi.fn(), error: vi.fn() } }));

import { PageEditor } from "@/editor/PageEditor";

// jsdom has no layout; floating UI and ProseMirror need these to exist.
const rect = {
  x: 0,
  y: 0,
  top: 0,
  left: 0,
  bottom: 0,
  right: 0,
  width: 0,
  height: 0,
  toJSON: () => ({}),
} as DOMRect;
Element.prototype.getBoundingClientRect = () => rect;
Range.prototype.getBoundingClientRect = () => rect;
Range.prototype.getClientRects = () =>
  ({
    length: 0,
    item: () => null,
    [Symbol.iterator]: [][Symbol.iterator],
  }) as unknown as DOMRectList;

const BODY = "Intro stays.\n\nThe meeting is on Tuesday.\n\nOutro stays.\n";
const PAGE: PageDoc = {
  id: "pg1",
  path: "Plan",
  title: "Plan",
  icon: null,
  frontmatter: {},
  body: BODY,
  hash: "h1",
};
const base = {
  run_id: null,
  conversation_id: "c",
  page_id: "pg1",
  page_path: "Plan",
  page_title: null,
  base_hash: null,
  old_text: null,
  new_text: null,
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
  status: "pending",
};
const ROWS = [
  {
    ...base,
    id: "p_1",
    kind: "edit",
    summary: "Fix the day",
    old_text: "on Tuesday",
    new_text: "on Wednesday",
    created_at: "1",
  },
  {
    ...base,
    id: "p_2",
    kind: "append",
    summary: "Add agenda",
    new_text: "Agenda: budget.",
    created_at: "2",
  },
  {
    ...base,
    id: "p_3",
    kind: "create",
    summary: "Minutes page",
    page_title: "Minutes",
    new_text: "# Minutes",
    created_at: "3",
  },
  {
    ...base,
    id: "p_4",
    kind: "edit",
    summary: "Stale edit",
    old_text: "no longer here",
    new_text: "x",
    status: "conflict",
    reason: "the text to replace is no longer unique",
    created_at: "4",
  },
  {
    ...base,
    id: "p_5",
    kind: "append",
    summary: "Already in",
    new_text: "Done.",
    status: "accepted",
    created_at: "0",
  },
];

function mount() {
  return render(
    <PageEditor
      page={PAGE}
      tree={[]}
      refreshNonce={0}
      onNavigate={vi.fn()}
      onTitleChange={vi.fn()}
      onIconChange={vi.fn()}
      onRenamed={vi.fn()}
      onTreeChanged={vi.fn()}
      onSaved={vi.fn()}
    />,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  // The daemon's list reflects decisions, so a refresh after one does not bring it back.
  const rows = ROWS.map((row) => ({ ...row }));
  reviewMock.list.mockImplementation(async () => rows.map((row) => ({ ...row })));
  reviewMock.acceptBatch.mockResolvedValue({ applied: ["p_1", "p_2", "p_3"], stopped_at: null });
  reviewMock.rejectBatch.mockResolvedValue({ rejected: ["p_1", "p_2", "p_3", "p_4"] });
  reviewMock.accept.mockImplementation(async (id: string) =>
    Object.assign(
      rows.find((r) => r.id === id)!,
      { status: "accepted" },
    ),
  );
});
afterEach(cleanup);

it("shows each proposal where it applies and never saves the page for it", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  try {
    mount();
    const edit = await screen.findByLabelText("Proposal: Fix the day");
    const editorDom = document.querySelector(".bn-editor")!;
    expect(editorDom.contains(edit)).toBe(true);

    // The edit sits directly under the paragraph it changes, which is marked.
    const changed = editorDom.querySelectorAll("[data-review-changed]");
    expect(changed).toHaveLength(1);
    expect(changed[0]!.textContent).toBe("The meeting is on Tuesday.");
    expect(changed[0]!.nextElementSibling!.contains(edit)).toBe(true);
    expect(edit.querySelector('[data-kind="del"]')!.textContent).toBe("on Tuesday");
    expect(edit.querySelector('[data-kind="add"]')!.textContent).toBe("on Wednesday");

    // The append sits after the last paragraph with content.
    const append = screen.getByLabelText("Proposal: Add agenda");
    const outro = [...editorDom.querySelectorAll(".bn-block-outer")].find(
      (el) => el.textContent === "Outro stays.",
    )!;
    expect(outro.nextElementSibling!.contains(append)).toBe(true);

    // A new page and an edit whose text is gone have no place in the text: above the editor.
    const loose = document.querySelector("[data-review-unanchored]")!;
    expect(editorDom.contains(loose)).toBe(false);
    expect(
      within(loose as HTMLElement).getByLabelText("Proposal: Minutes page").textContent,
    ).toContain("New page “Minutes”");
    expect(
      within(loose as HTMLElement).getByLabelText("Proposal: Stale edit").textContent,
    ).toContain("no longer unique");
    expect(screen.queryByLabelText("Proposal: Already in")).toBeNull();

    const bar = screen.getByLabelText("Open reviews on this page");
    expect(bar.textContent).toContain("4 open reviews · 1 in conflict");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(put).not.toHaveBeenCalled();
  } finally {
    vi.useRealTimers();
  }
});

it("accepts one, accepts all pending, and discards all after confirming", async () => {
  mount();
  const edit = await screen.findByLabelText("Proposal: Fix the day");
  fireEvent.click(within(edit).getByRole("button", { name: /Accept/ }));
  await waitFor(() => expect(reviewMock.accept).toHaveBeenCalledWith("p_1", undefined));
  await waitFor(() => expect(screen.queryByLabelText("Proposal: Fix the day")).toBeNull());
  expect(document.querySelector("[data-review-changed]")).toBeNull();

  const bar = screen.getByLabelText("Open reviews on this page");
  expect(bar.textContent).toContain("3 open reviews");
  expect(within(bar).queryByRole("button", { name: /Accept all/ })).toBeNull();
  fireEvent.keyDown(within(bar).getByRole("button", { name: "Review actions" }), { key: "Enter" });
  fireEvent.click(await screen.findByRole("menuitem", { name: "Accept all" }));
  await waitFor(() => expect(reviewMock.acceptBatch).toHaveBeenCalledWith(["p_2", "p_3"]));

  fireEvent.keyDown(within(bar).getByRole("button", { name: "Review actions" }), { key: "Enter" });
  fireEvent.click(await screen.findByRole("menuitem", { name: "Discard all" }));
  expect(reviewMock.rejectBatch).not.toHaveBeenCalled();
  fireEvent.click(
    within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Discard all" }),
  );
  await waitFor(() => expect(reviewMock.rejectBatch).toHaveBeenCalledWith(["p_2", "p_3", "p_4"]));
  expect(put).not.toHaveBeenCalled();
});
