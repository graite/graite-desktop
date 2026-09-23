import { describe, expect, it } from "vitest";
import { BlockNoteEditor } from "@blocknote/core";
import { toBlocks } from "@graite/md-convert";
import { schema, type GraiteEditor, type GraitePartialBlock } from "../schema";
import { linksToTrash, loadBlocks, trackHistoryTransactions } from "../PageEditor";

function editorWith(md: string) {
  const editor = BlockNoteEditor.create({ schema }) as GraiteEditor;
  const el = document.createElement("div");
  document.body.appendChild(el);
  editor.mount(el);
  loadBlocks(editor, toBlocks(md) as GraitePartialBlock[]);
  return editor;
}

describe("undo after a page load", () => {
  it("does not revert the loaded document", () => {
    const editor = editorWith("# Title\n\n[[Child]]\n\nSome text\n");
    const before = JSON.stringify(editor.document);
    editor.undo();
    expect(JSON.stringify(editor.document)).toBe(before);
  });

  it("undoes only the user's typing", () => {
    const editor = editorWith("Hello\n");
    const loaded = JSON.stringify(editor.document);
    editor.setTextCursorPosition(editor.document[0]!, "end");
    editor.insertInlineContent(" world");
    expect(JSON.stringify(editor.document)).toContain("Hello world");
    editor.undo();
    expect(JSON.stringify(editor.document)).toBe(loaded);
    expect(JSON.stringify(editor.document)).toContain("Hello");
  });

  it("marks undo/redo transactions as history", () => {
    const editor = editorWith("Hello\n");
    const tracker = trackHistoryTransactions(editor);
    editor.setTextCursorPosition(editor.document[0]!, "end");
    editor.insertInlineContent("!");
    expect(tracker.lastWasHistory).toBe(false);
    editor.undo();
    expect(tracker.lastWasHistory).toBe(true);
    editor.redo();
    expect(tracker.lastWasHistory).toBe(true);
    tracker.dispose();
  });
});

describe("linksToTrash", () => {
  it("trashes exactly one intentionally removed link", () => {
    expect(linksToTrash(["A"], { lastWasHistory: false, documentEmpty: false })).toEqual(["A"]);
  });
  it("never trashes on undo, on an emptied document, or on bulk removal", () => {
    expect(linksToTrash(["A"], { lastWasHistory: true, documentEmpty: false })).toEqual([]);
    expect(linksToTrash(["A"], { lastWasHistory: false, documentEmpty: true })).toEqual([]);
    expect(linksToTrash(["A", "B"], { lastWasHistory: false, documentEmpty: false })).toEqual([]);
  });
});
