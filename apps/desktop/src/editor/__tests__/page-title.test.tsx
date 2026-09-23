import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import type { PageDoc } from "@/lib/api";

const api = vi.hoisted(() => ({ patch: vi.fn(), put: vi.fn() }));
vi.mock("@/lib/review", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/review")>()),
  review: { list: vi.fn().mockResolvedValue([]) },
}));
vi.mock("@/lib/api", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...real,
    onDaemonEvent: () => () => {},
    pages: { ...real.pages, patch: api.patch, put: api.put },
  };
});
vi.mock("sonner", () => ({ toast: { success: vi.fn(), warning: vi.fn(), error: vi.fn() } }));

import { PageEditor } from "@/editor/PageEditor";

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

const NEW_PAGE: PageDoc = {
  id: "pg1",
  path: "untitled",
  title: "Untitled",
  icon: null,
  frontmatter: {},
  body: "",
  hash: "h1",
};
const onRenamed = vi.fn();

// Like the workspace, reflect typed titles into the page right away.
function Host() {
  const [page, setPage] = useState(NEW_PAGE);
  return (
    <PageEditor
      page={page}
      tree={[]}
      refreshNonce={0}
      onNavigate={vi.fn()}
      onTitleChange={(title) => setPage((p) => ({ ...p, title }))}
      onIconChange={vi.fn()}
      onRenamed={onRenamed}
      onTreeChanged={vi.fn()}
      onSaved={vi.fn()}
    />
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  api.patch.mockImplementation(async (_path: string, { title }: { title: string }) => ({
    ...NEW_PAGE,
    title,
    path: title.toLowerCase(),
    hash: "h2",
  }));
});
afterEach(cleanup);

it("renames a new page when Enter is pressed straight after typing", async () => {
  render(<Host />);
  const input = screen.getByLabelText("Page title") as HTMLInputElement;
  // A new page starts empty with the cursor in its title.
  expect(input.value).toBe("");
  expect(document.activeElement).toBe(input);

  fireEvent.change(input, { target: { value: "Groceries" } });
  fireEvent.keyDown(input, { key: "Enter" });

  await waitFor(() => expect(api.patch).toHaveBeenCalledWith("untitled", { title: "Groceries" }));
  expect(api.patch).toHaveBeenCalledTimes(1);
  await waitFor(() => expect(onRenamed).toHaveBeenCalledWith("untitled", "groceries"));
});

it("sends the second rename to the folder the first one moved to", async () => {
  render(<Host />);
  const input = screen.getByLabelText("Page title");
  fireEvent.change(input, { target: { value: "One" } });
  fireEvent.blur(input);
  fireEvent.focus(input);
  fireEvent.change(input, { target: { value: "Two" } });
  fireEvent.blur(input);

  await waitFor(() => expect(api.patch).toHaveBeenCalledTimes(2));
  expect(api.patch.mock.calls[1]).toEqual(["one", { title: "Two" }]);
});
