import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import type { PageDoc } from "@/lib/api";

const api = vi.hoisted(() => ({ put: vi.fn() }));
vi.mock("@/lib/review", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/review")>()),
  review: { list: vi.fn().mockResolvedValue([]) },
}));
vi.mock("@/lib/api", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/api")>();
  return { ...real, onDaemonEvent: () => () => {}, pages: { ...real.pages, put: api.put } };
});
vi.mock("sonner", () => ({ toast: { success: vi.fn(), warning: vi.fn(), error: vi.fn() } }));

import { ConflictError } from "@/lib/api";
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

const PAGE: PageDoc = {
  id: "pg1",
  path: "notes",
  title: "Notes",
  icon: null,
  frontmatter: {},
  body: "Hello\n",
  hash: "h0",
};

type TiptapDom = HTMLElement & {
  editor: { commands: { insertContentAt: (at: number, text: string) => void } };
};

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.clearAllMocks();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

it("waits for a slow save before the next one, so it never conflicts with itself", async () => {
  // Like the daemon: a write with an old base hash is refused.
  let disk = "h0";
  let n = 0;
  const finish: (() => void)[] = [];
  api.put.mockImplementation(
    (_path: string, _markdown: string, base: string | null) =>
      new Promise((resolve, reject) => {
        finish.push(() => {
          if (base !== disk) return reject(new ConflictError(disk, ""));
          disk = `h${++n}`;
          resolve({ ...PAGE, hash: disk });
        });
      }),
  );
  const onSaved = vi.fn();
  render(
    <PageEditor
      page={PAGE}
      tree={[]}
      refreshNonce={0}
      onNavigate={vi.fn()}
      onTitleChange={vi.fn()}
      onIconChange={vi.fn()}
      onRenamed={vi.fn()}
      onTreeChanged={vi.fn()}
      onSaved={onSaved}
    />,
  );
  const dom = (await waitFor(() => {
    const el = document.querySelector(".ProseMirror") as TiptapDom | null;
    expect(el?.editor).toBeTruthy();
    return el!;
  })) as TiptapDom;

  // Type, wait past the debounce (the save starts but the daemon is slow), type again.
  act(() => dom.editor.commands.insertContentAt(1, "/"));
  await act(() => vi.advanceTimersByTimeAsync(1000));
  expect(api.put).toHaveBeenCalledTimes(1);
  act(() => dom.editor.commands.insertContentAt(2, "dat"));
  await act(() => vi.advanceTimersByTimeAsync(1000));
  // The second save waits for the first instead of sending the same base hash.
  expect(api.put).toHaveBeenCalledTimes(1);

  await act(async () => finish.shift()!());
  await waitFor(() => expect(api.put).toHaveBeenCalledTimes(2));
  expect(api.put.mock.calls[1]![2]).toBe("h1");
  await act(async () => finish.shift()!());
  await waitFor(() => expect(onSaved).toHaveBeenCalledWith("h2"));
  expect(screen.queryByText(/changed on disk/)).toBeNull();
});
