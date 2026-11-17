import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, createEvent, fireEvent, render, waitFor } from "@testing-library/react";
import { BlockNoteEditor } from "@blocknote/core";
import { schema, type GraiteEditor, type GraitePartialBlock } from "../schema";
import { EditorSurface } from "../EditorSurface";
import { MediaContext } from "../media/context";
import { beginTextDrag, TEXT_DRAG } from "../textDrag";

const mocks = vi.hoisted(() => ({
  upload: vi.fn(),
  error: vi.fn(),
}));
vi.mock("@/lib/media", async (original) => ({
  ...(await original<typeof import("@/lib/media")>()),
  media: {
    upload: mocks.upload,
    blob: vi.fn(async () => new Blob()),
    info: vi.fn(async () => ({})),
    job: vi.fn(),
  },
}));
vi.mock("sonner", () => ({ toast: { error: mocks.error, success: vi.fn() } }));

beforeEach(() => {
  mocks.upload.mockImplementation(async (_page: string, _blob: Blob, name: string) => ({
    file: `stored-${name}`,
    name,
    kind: name.endsWith(".pdf") ? "pdf" : "image",
  }));
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function setup(content: GraitePartialBlock[], context: Record<string, unknown> = {}) {
  const editor = BlockNoteEditor.create({ schema, initialContent: content }) as GraiteEditor;
  render(
    <MediaContext.Provider
      value={{ pageId: "page-1", pagePath: "Notes", onTreeChanged: () => {}, ...context }}
    >
      <EditorSurface
        editor={editor}
        onChange={() => {}}
        slashDeps={{ createChildPage: vi.fn(), pickPage: vi.fn(), onTreeChanged: vi.fn() }}
      />
    </MediaContext.Provider>,
  );
  const root = editor.prosemirrorView.dom;
  // jsdom has no layout: give each top-level block 20px of height, in order.
  const blocks = [
    ...root.querySelectorAll<HTMLElement>(":scope > .bn-block-group > .bn-block-outer"),
  ];
  blocks.forEach((el, i) => {
    el.getBoundingClientRect = () => new DOMRect(0, i * 20, 300, 20);
  });
  return { editor, root };
}

const file = (name: string, type = "image/png") => new File(["data"], name, { type });

function dropFiles(root: HTMLElement, files: File[], clientY: number) {
  const dataTransfer = { types: ["Files"], files, dropEffect: "none" };
  for (const make of [createEvent.dragOver, createEvent.drop]) {
    const event = make(root, { dataTransfer });
    // jsdom's drag events do not carry the pointer position.
    Object.defineProperty(event, "clientY", { value: clientY });
    fireEvent(root, event);
  }
}

it("uploads a dropped image and puts it between the two blocks it was dropped between", async () => {
  const { editor, root } = setup([
    { type: "paragraph", content: "First" },
    { type: "paragraph", content: "Second" },
  ]);
  dropFiles(root, [file("photo.png")], 22); // upper half of the second block
  await waitFor(() => expect(editor.document.map((b) => b.type)).toContain("localMedia"));
  expect(mocks.upload).toHaveBeenCalledWith("page-1", expect.any(File), "photo.png");
  expect(editor.document.slice(0, 3).map((b) => b.type)).toEqual([
    "paragraph",
    "localMedia",
    "paragraph",
  ]);
  expect(editor.document[1]!.props).toMatchObject({
    file: "stored-photo.png",
    name: "photo.png",
    kind: "image",
  });
  expect(document.querySelector(".block-drop-line")).toBeNull();
});

it("inserts several files in order and skips kinds the vault does not store", async () => {
  const { editor, root } = setup([{ type: "paragraph", content: "Only" }]);
  dropFiles(
    root,
    [file("a.png"), file("anim.gif", "image/gif"), file("b.pdf", "application/pdf")],
    15,
  );
  await waitFor(() =>
    expect(editor.document.filter((b) => b.type === "localMedia")).toHaveLength(2),
  );
  expect(editor.document.slice(0, 3).map((b) => (b.props as { name?: string }).name)).toEqual([
    undefined,
    "a.png",
    "b.pdf",
  ]);
  expect(mocks.upload).toHaveBeenCalledTimes(2);
  expect(mocks.error).toHaveBeenCalledWith(expect.stringContaining("1 of 3 files were skipped"));
});

it("leaves the text alone when the upload fails", async () => {
  mocks.upload.mockRejectedValueOnce(new Error("Files can be up to 200 MB."));
  const { editor, root } = setup([{ type: "paragraph", content: "Only" }]);
  dropFiles(root, [file("huge.png")], 5);
  await waitFor(() => expect(mocks.error).toHaveBeenCalled());
  expect(editor.document.map((b) => b.type)).not.toContain("localMedia");
});

it("adds a pasted screenshot under the line with the cursor", async () => {
  const { editor, root } = setup([
    { type: "paragraph", content: "First" },
    { type: "paragraph", content: "Second" },
  ]);
  editor.setTextCursorPosition(editor.document[0]!, "end");
  fireEvent.paste(root, {
    clipboardData: { types: ["Files"], files: [file("image.png")], getData: () => "" },
  });
  await waitFor(() => expect(editor.document[1]!.type).toBe("localMedia"));
  expect((editor.document[1]!.props as { name: string }).name).toMatch(/^Pasted image .*\.png$/);
});

it("moves dragged text to the page link or sidebar row it is dropped on", async () => {
  const moveSelection = vi.fn<(path: string) => Promise<void>>(async () => {});
  const { root } = setup(
    [
      { type: "paragraph", content: "Move me" },
      { type: "pageLink", props: { path: "Notes/Child", title: "Child", target: "Child" } },
    ],
    { moveSelection },
  );
  await waitFor(() => expect(root.querySelector("[data-media-drop-page]")).not.toBeNull());
  const link = root.querySelector<HTMLElement>("[data-media-drop-page]")!;
  expect(link.dataset.mediaDropPage).toBe("Notes/Child");
  // Sidebar rows carry the same attribute; one for another page and one for this page.
  const row = document.createElement("div");
  row.dataset.mediaDropPage = "Archive";
  const own = document.createElement("div");
  own.dataset.mediaDropPage = "Notes";
  document.body.append(row, own);
  const dataTransfer = { types: [TEXT_DRAG, "text/plain"], getData: () => "", dropEffect: "none" };

  for (const [target, path] of [
    [link, "Notes/Child"],
    [row, "Archive"],
  ] as const) {
    beginTextDrag((to) => void moveSelection(to));
    fireEvent.dragOver(target, { dataTransfer });
    expect(target.hasAttribute("data-media-drop-active")).toBe(true);
    fireEvent.drop(target, { dataTransfer });
    expect(moveSelection).toHaveBeenLastCalledWith(path);
    expect(target.hasAttribute("data-media-drop-active")).toBe(false);
  }

  moveSelection.mockClear();
  beginTextDrag((to) => void moveSelection(to));
  fireEvent.dragOver(own, { dataTransfer });
  expect(own.hasAttribute("data-media-drop-active")).toBe(false);
  fireEvent.drop(own, { dataTransfer });
  expect(moveSelection).not.toHaveBeenCalled();
  row.remove();
  own.remove();
});
