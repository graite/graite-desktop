import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { BlockNoteEditor } from "@blocknote/core";
import { schema, type GraiteEditor } from "../schema";
import { EditorSurface } from "../EditorSurface";
import type { PickedPage, SlashMenuDeps } from "../slash-menu";

// jsdom has no layout: give floating-ui/ProseMirror the rect APIs they call.
const rect = () => ({
  x: 0,
  y: 0,
  width: 0,
  height: 0,
  top: 0,
  left: 0,
  right: 0,
  bottom: 0,
  toJSON() {
    return this;
  },
});
Element.prototype.getBoundingClientRect = rect as never;
Element.prototype.getClientRects = (() => [] as unknown as DOMRectList) as never;
Range.prototype.getBoundingClientRect = rect as never;
Range.prototype.getClientRects = (() => [] as unknown as DOMRectList) as never;

/** Mounts exactly what the app mounts and drives the slash menu through the real plugins. */
function mount(deps?: Partial<SlashMenuDeps>, instructionsOnly = false) {
  const editor = BlockNoteEditor.create({ schema }) as GraiteEditor;
  const slashDeps: SlashMenuDeps = {
    createChildPage: vi.fn(async (): Promise<PickedPage> => ({
      path: "P/Untitled",
      title: "Untitled",
      icon: null,
      target: "Untitled",
    })),
    pickPage: vi.fn(async (): Promise<PickedPage | null> => ({
      path: "Projects/Atlas",
      title: "Atlas",
      icon: "🧭",
      target: "Projects/Atlas",
    })),
    onTreeChanged: vi.fn(),
    ...deps,
  };
  const utils = render(
    <EditorSurface
      editor={editor}
      instructionsOnly={instructionsOnly}
      slashDeps={slashDeps}
      onChange={() => {}}
    />,
  );
  const dom = editor.prosemirrorView!.dom as HTMLElement;
  return { editor, slashDeps, dom, ...utils };
}

async function typeSlashQuery(editor: GraiteEditor, dom: HTMLElement, query: string) {
  const view = editor.prosemirrorView!;
  editor.setTextCursorPosition(editor.document[0]!, "end");
  editor.focus();
  // Type like a user: ProseMirror routes typed text through handleTextInput (where the
  // suggestion plugin watches for the trigger) and inserts it itself when no plugin handles it.
  for (const ch of "/" + query) {
    act(() => {
      const { from, to } = view.state.selection;
      const handled = view.someProp("handleTextInput", (f) =>
        f(view, from, to, ch, () => view.state.tr),
      );
      if (!handled) view.dispatch(view.state.tr.insertText(ch, from, to));
    });
  }
  await waitFor(() => expect(dom.getAttribute("aria-expanded")).toBe("true"));
  // Let the (async) getItems resolve and the menu render.
  await waitFor(() => expect(document.querySelector(".bn-suggestion-menu-item")).not.toBeNull());
}

/**
 * Choose the first menu item by mouse. This runs BlockNote's `closeMenu(); clearQuery();
 * onItemClick()` path exactly like Enter does in a browser. (jsdom does not order
 * capture-phase listeners at the event target like browsers do, so a synthetic Enter
 * reaches ProseMirror before the menu's handler; the click path has no such issue.)
 */
function chooseFirstItem() {
  const item = document.querySelector(".bn-suggestion-menu-item") as HTMLElement;
  act(() => {
    fireEvent.click(item);
  });
}

afterEach(cleanup);

describe("slash menu (mounted)", () => {
  it("inserts a board view from the Views group", async () => {
    const { editor, dom } = mount();
    await typeSlashQuery(editor, dom, "board");
    chooseFirstItem();
    expect(editor.document[0]!.type).toBe("pageView");
    expect(editor.document[0]!.props).toMatchObject({ view: "kanban", group: "", show: "" });
  });

  it.each([2, 3, 4])("inserts %s editable columns", async (count) => {
    const { editor, dom } = mount();
    await typeSlashQuery(editor, dom, `${count} columns`);
    chooseFirstItem();
    expect(editor.document[0]!.type).toBe("columnLayout");
    expect(editor.document[0]!.children).toHaveLength(count);
    expect(
      editor.document[0]!.children.every(
        (column) => column.type === "pageColumn" && column.children[0]?.type === "paragraph",
      ),
    ).toBe(true);
  });

  it.each([
    ["audio", "audio"],
    ["record", "recording"],
    ["ocr", "pdf"],
  ])("/%s inserts a local media block in place", async (query, kind) => {
    const { editor, dom } = mount();
    await typeSlashQuery(editor, dom, query);
    chooseFirstItem();
    await waitFor(() => expect(editor.document[0]!.type).toBe("localMedia"));
    expect(editor.document[0]!.props).toMatchObject({ kind, file: "" });
  });
  it("/head + choose Heading replaces the query in place", async () => {
    const { editor, dom } = mount();
    await typeSlashQuery(editor, dom, "head");
    chooseFirstItem();
    await waitFor(() => expect(editor.document[0]!.type).toBe("heading"));
    const text = JSON.stringify(editor.document);
    expect(text).not.toContain("/head");
    expect(editor.document.filter((b) => b.type === "heading")).toHaveLength(1);
  });

  it("offers working page links from the instruction editor slash menu", async () => {
    const { editor, dom, slashDeps } = mount(undefined, true);
    await typeSlashQuery(editor, dom, "link to");
    chooseFirstItem();
    await waitFor(() => expect(editor.document[0]!.type).toBe("pageLink"));
    expect(slashDeps.pickPage).toHaveBeenCalledOnce();
    expect(editor.document[0]!.props).toMatchObject({ path: "Projects/Atlas" });
  });

  it("/link + choose inserts a page link with the picked page", async () => {
    const { editor, dom, slashDeps } = mount();
    await typeSlashQuery(editor, dom, "link to");
    chooseFirstItem();
    await waitFor(() => expect(slashDeps.pickPage).toHaveBeenCalled());
    await waitFor(() => {
      const link = editor.document.find((b) => b.type === "pageLink");
      expect(link?.props).toMatchObject({
        path: "Projects/Atlas",
        title: "Atlas",
        icon: "🧭",
        target: "Projects/Atlas",
      });
    });
    expect(JSON.stringify(editor.document)).not.toContain("Choose a page");
    expect(JSON.stringify(editor.document)).not.toContain("/link");
  });

  it("/page + choose creates a child page link", async () => {
    const { editor, dom, slashDeps } = mount();
    await typeSlashQuery(editor, dom, "page");
    chooseFirstItem();
    await waitFor(() => expect(slashDeps.createChildPage).toHaveBeenCalled());
    await waitFor(() => {
      const link = editor.document.find((b) => b.type === "pageLink");
      expect(link?.props).toMatchObject({
        path: "P/Untitled",
        title: "Untitled",
        target: "Untitled",
      });
    });
    expect(slashDeps.onTreeChanged).toHaveBeenCalled();
  });
});
