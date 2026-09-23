import { describe, expect, it } from "vitest";
import { BlockNoteEditor } from "@blocknote/core";
import { schema } from "../schema";

/** Reproduces "Enter at the end of a checklist item turns the next block into a bullet". */
describe("checklist Enter", () => {
  it("creates another checkListItem", () => {
    const editor = BlockNoteEditor.create({ schema });
    const el = document.createElement("div");
    document.body.appendChild(el);
    editor.mount(el);
    editor.replaceBlocks(editor.document, [
      { type: "checkListItem", props: { checked: false }, content: "Task" },
    ]);
    const first = editor.document[0]!;
    editor.setTextCursorPosition(first, "end");
    editor.focus();
    // Press Enter through the real keymap
    const view = editor.prosemirrorView!;
    const handled = view.someProp("handleKeyDown", (f) =>
      f(view, new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true })),
    );
    expect(handled).toBe(true);
    // BlockNote keeps a trailing empty paragraph at the end of the document.
    const types = editor.document.map((b) => b.type).slice(0, 2);
    expect(types).toEqual(["checkListItem", "checkListItem"]);
  });
});
