import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { BlockNoteEditor } from "@blocknote/core";
import { SideMenuExtension } from "@blocknote/core/extensions";
import { schema, type GraiteEditor } from "../schema";
import { EditorSurface } from "../EditorSurface";
import { MediaContext } from "../media/context";

afterEach(cleanup);
it("drops a grabbed media block onto a page without deleting it before the save succeeds", () => {
  const editor = BlockNoteEditor.create({
    schema,
    initialContent: [{ type: "localMedia", props: { file: "voice.wav", kind: "audio" } }],
  }) as GraiteEditor;
  const move = vi.fn(async () => {});
  render(
    <MediaContext.Provider value={{ pageId: "source", onTreeChanged: () => {}, moveMedia: move }}>
      <EditorSurface
        editor={editor}
        onChange={() => {}}
        slashDeps={{ createChildPage: vi.fn(), pickPage: vi.fn(), onTreeChanged: vi.fn() }}
      />
      <div data-media-drop-page="Destination" data-testid="destination">
        Destination
      </div>
    </MediaContext.Provider>,
  );
  const menu = editor.getExtension(SideMenuExtension)!;
  act(() =>
    menu.store.setState({ show: false, referencePos: new DOMRect(), block: editor.document[0]! }),
  );
  fireEvent.dragStart(document.body, {
    dataTransfer: { types: ["blocknote/html"], getData: () => "" },
  });
  const target = document.querySelector('[data-testid="destination"]')!;
  fireEvent.dragOver(target);
  expect(target.hasAttribute("data-media-drop-active")).toBe(true);
  fireEvent.drop(target);
  expect(move).toHaveBeenCalledWith(editor.document[0]!.id, "Destination");
  expect(target.hasAttribute("data-media-drop-active")).toBe(false);
  expect(editor.document[0]!.props).toMatchObject({ file: "voice.wav" });
});
