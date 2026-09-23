import { expect, it, vi } from "vitest";
import { BlockNoteEditor } from "@blocknote/core";
import { looksLikeMarkdownBlocks, markdownPasteHandler } from "../paste";
import { schema, type GraiteEditor } from "../schema";

it("recognises Markdown blocks in plain text", () => {
  expect(looksLikeMarkdownBlocks("# Shopping")).toBe(true);
  expect(looksLikeMarkdownBlocks("- milk")).toBe(true);
  expect(looksLikeMarkdownBlocks("Intro\r\n1. first\r\n2. second")).toBe(true);
  expect(looksLikeMarkdownBlocks("> quoted")).toBe(true);
  expect(looksLikeMarkdownBlocks("Just a sentence with a - dash and #hashtag.")).toBe(false);
  expect(looksLikeMarkdownBlocks("*emphasis* at the start")).toBe(false);
});

function paste(editor: GraiteEditor, clip: Record<string, string>) {
  const event = {
    clipboardData: { types: Object.keys(clip), getData: (t: string) => clip[t] ?? "" },
  } as unknown as ClipboardEvent;
  const defaultPasteHandler = vi.fn(() => true);
  const handled = markdownPasteHandler()({ event, editor, defaultPasteHandler } as never);
  return { handled, defaultPasteHandler };
}

it("turns a pasted heading and list into blocks in place of an empty line", () => {
  const editor = BlockNoteEditor.create({
    schema,
    initialContent: [{ type: "paragraph" }],
  }) as GraiteEditor;
  const { handled, defaultPasteHandler } = paste(editor, {
    "text/plain": "# Shopping\r\n- milk\r\n- eggs",
    "text/html": "<meta charset=utf-8><span>plain</span>",
  });
  expect(handled).toBe(true);
  expect(defaultPasteHandler).not.toHaveBeenCalled();
  expect(editor.document.map((b) => b.type)).toEqual([
    "heading",
    "bulletListItem",
    "bulletListItem",
  ]);
});

it("inserts a single list item after a line with text", () => {
  const editor = BlockNoteEditor.create({
    schema,
    initialContent: [{ type: "paragraph", content: "Notes" }],
  }) as GraiteEditor;
  paste(editor, { "text/plain": "- only item" });
  expect(editor.document.map((b) => b.type)).toEqual(["paragraph", "bulletListItem"]);
});

it("leaves ordinary text and rich HTML to BlockNote", () => {
  const editor = BlockNoteEditor.create({ schema }) as GraiteEditor;
  expect(paste(editor, { "text/plain": "hello world" }).defaultPasteHandler).toHaveBeenCalled();
  expect(
    paste(editor, { "text/plain": "- a", "text/html": "<ul><li>a</li></ul>" }).defaultPasteHandler,
  ).toHaveBeenCalled();
  expect(
    paste(editor, { "text/plain": "- a", "blocknote/html": "<p>a</p>" }).defaultPasteHandler,
  ).toHaveBeenCalled();
});
