import { describe, expect, it } from "vitest";
import { BlockNoteEditor } from "@blocknote/core";
import { schema } from "../schema";
import { editorExtensions } from "../reviewDecorations";

function mounted() {
  const editor = BlockNoteEditor.create({ schema, extensions: editorExtensions });
  const el = document.createElement("div");
  document.body.appendChild(el);
  editor.mount(el);
  return editor;
}

function backspace(editor: ReturnType<typeof mounted>): void {
  const view = editor.prosemirrorView!;
  const event = new KeyboardEvent("keydown", {
    key: "Backspace",
    code: "Backspace",
    bubbles: true,
  });
  view.someProp("handleKeyDown", (f) => f(view, event));
}

/**
 * One press turns an empty heading into a paragraph. What looked like two steps was the
 * old type's styling lingering for a render (see the data-prev-type rules in editor.css).
 */
describe("Backspace in a heading", () => {
  it("marks the changed block with its previous type for one render only", async () => {
    const editor = mounted();
    editor.replaceBlocks(editor.document, [
      { type: "paragraph", content: "Before" },
      { type: "bulletListItem" },
    ]);
    await new Promise((r) => setTimeout(r, 10));
    editor.setTextCursorPosition(editor.document[1]!, "start");
    backspace(editor);
    expect(editor.document[1]!.type).toBe("paragraph");
    await new Promise((r) => setTimeout(r, 10));
    expect(editor.domElement!.querySelector("[data-prev-type]")).toBeNull();
  });

  for (const level of [1, 2, 3] as const) {
    it(`turns an empty level ${level} heading into a paragraph in one press`, () => {
      const editor = mounted();
      editor.replaceBlocks(editor.document, [
        { type: "paragraph", content: "Before" },
        { type: "heading", props: { level } },
      ]);
      editor.setTextCursorPosition(editor.document[1]!, "start");
      backspace(editor);
      expect(editor.document[1]!.type).toBe("paragraph");
      expect(editor.document).toHaveLength(2);
    });
  }

  it("only removes a character from a heading that has text", () => {
    const editor = mounted();
    editor.replaceBlocks(editor.document, [
      { type: "heading", props: { level: 2 }, content: "Title" },
    ]);
    editor.setTextCursorPosition(editor.document[0]!, "end");
    backspace(editor);
    expect(editor.document[0]!.type).toBe("heading");
  });

  it("at the start of a heading with text, keeps the text and makes it a paragraph", () => {
    const editor = mounted();
    editor.replaceBlocks(editor.document, [
      { type: "heading", props: { level: 2 }, content: "Title" },
    ]);
    editor.setTextCursorPosition(editor.document[0]!, "start");
    backspace(editor);
    expect(editor.document[0]!.type).toBe("paragraph");
    expect(editor.document[0]!.content).toMatchObject([{ text: "Title" }]);
  });
});
