import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { BlockNoteEditor } from "@blocknote/core";
import { SideMenuExtension } from "@blocknote/core/extensions";
import { schema, type GraiteEditor, type GraitePartialBlock } from "../schema";
import { EditorSurface } from "../EditorSurface";
import { MediaContext } from "../media/context";

afterEach(async () => {
  // Let the click guard a finished drag leaves for one task expire.
  await new Promise((resolve) => setTimeout(resolve, 0));
  cleanup();
  vi.restoreAllMocks();
  delete (document as { elementFromPoint?: unknown }).elementFromPoint;
});

function setup(content: GraitePartialBlock[]) {
  const editor = BlockNoteEditor.create({ schema, initialContent: content }) as GraiteEditor;
  const moveMedia = vi.fn(async () => {});
  const movePage = vi.fn(async () => {});
  render(
    <MediaContext.Provider
      value={{ pageId: "source", onTreeChanged: () => {}, moveMedia, movePage }}
    >
      <EditorSurface
        editor={editor}
        onChange={() => {}}
        slashDeps={{ createChildPage: vi.fn(), pickPage: vi.fn(), onTreeChanged: vi.fn() }}
      />
      <div className="bn-side-menu">
        <button draggable="true" data-testid="handle" />
      </div>
      <div data-media-drop-page="Destination" data-testid="destination">
        Destination
      </div>
    </MediaContext.Provider>,
  );
  return { editor, moveMedia, movePage };
}

/** Press the handle of `block`, move over `over`, release. jsdom has no layout: stub hit tests. */
function dragHandle(editor: GraiteEditor, block: string, over: Element) {
  const menu = editor.getExtension(SideMenuExtension)!;
  act(() =>
    menu.store.setState({
      show: false,
      referencePos: new DOMRect(),
      block: editor.getBlock(block)!,
    }),
  );
  document.elementFromPoint = vi.fn(() => over);
  const handle = document.querySelector('[data-testid="handle"]')!;
  fireEvent.pointerDown(handle, { button: 0, clientX: 0, clientY: 0 });
  expect((handle as HTMLButtonElement).draggable).toBe(false);
  fireEvent.pointerMove(window, { clientX: 30, clientY: 30, buttons: 1 });
  expect(document.querySelector(".block-drag-ghost")).not.toBeNull();
  fireEvent.pointerUp(window, { clientX: 30, clientY: 30 });
  expect(document.querySelector(".block-drag-ghost")).toBeNull();
  expect((handle as HTMLButtonElement).draggable).toBe(true);
}

it("drops a grabbed media block onto a page without deleting it before the save succeeds", () => {
  const { editor, moveMedia } = setup([
    { type: "localMedia", props: { file: "voice.wav", kind: "audio" } },
  ]);
  const target = document.querySelector('[data-testid="destination"]')!;
  dragHandle(editor, editor.document[0]!.id, target);
  expect(moveMedia).toHaveBeenCalledWith(editor.document[0]!.id, "Destination");
  expect(target.hasAttribute("data-media-drop-active")).toBe(false);
  expect(editor.document[0]!.props).toMatchObject({ file: "voice.wav" });
});

it("a short press on the handle is a click, not a drag", () => {
  const { editor, moveMedia } = setup([
    { type: "localMedia", props: { file: "voice.wav", kind: "audio" } },
  ]);
  const menu = editor.getExtension(SideMenuExtension)!;
  act(() =>
    menu.store.setState({ show: false, referencePos: new DOMRect(), block: editor.document[0]! }),
  );
  const handle = document.querySelector('[data-testid="handle"]')!;
  const clicked = vi.fn();
  handle.addEventListener("click", clicked);
  fireEvent.pointerDown(handle, { button: 0, clientX: 0, clientY: 0 });
  fireEvent.pointerMove(window, { clientX: 2, clientY: 1, buttons: 1 });
  fireEvent.pointerUp(window, { clientX: 2, clientY: 1 });
  fireEvent.click(handle);
  expect(document.querySelector(".block-drag-ghost")).toBeNull();
  expect(clicked).toHaveBeenCalled();
  expect(moveMedia).not.toHaveBeenCalled();
});

it("moves a block before or after the block under the pointer as one undo step", () => {
  const { editor } = setup([
    { type: "paragraph", content: "First" },
    { type: "paragraph", content: "Second" },
    { type: "paragraph", content: "Third" },
  ]);
  const [first, , third] = editor.document;
  const outer = document.querySelector(`.bn-block-outer[data-id="${third!.id}"]`)!;
  // Below the middle of "Third": the block lands after it.
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 100, 20));
  dragHandle(editor, first!.id, outer.querySelector(".bn-block-content")!);
  const texts = () =>
    editor.document.flatMap((b) => (b.content as { text: string }[]).map((c) => c.text));
  expect(texts()).toEqual(["Second", "Third", "First"]);
  editor.undo();
  expect(texts()).toEqual(["First", "Second", "Third"]);
});

it("a click whose release never arrives does not turn later mouse moves into a drag", () => {
  const { editor, moveMedia } = setup([
    { type: "localMedia", props: { file: "voice.wav", kind: "audio" } },
  ]);
  const menu = editor.getExtension(SideMenuExtension)!;
  act(() =>
    menu.store.setState({ show: false, referencePos: new DOMRect(), block: editor.document[0]! }),
  );
  document.elementFromPoint = vi.fn(() => document.querySelector('[data-testid="destination"]'));
  const handle = document.querySelector('[data-testid="handle"]')!;
  fireEvent.pointerDown(handle, { button: 0, clientX: 0, clientY: 0 });
  // The menu took the pointerup; the mouse now moves with no button held.
  fireEvent.pointerMove(window, { clientX: 60, clientY: 60, buttons: 0 });
  expect(document.querySelector(".block-drag-ghost")).toBeNull();
  expect((handle as HTMLButtonElement).draggable).toBe(true);
  fireEvent.pointerMove(window, { clientX: 90, clientY: 90, buttons: 0 });
  fireEvent.pointerUp(window, { clientX: 90, clientY: 90 });
  expect(document.querySelector(".block-drag-ghost")).toBeNull();
  expect(moveMedia).not.toHaveBeenCalled();
});
