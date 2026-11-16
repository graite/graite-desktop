import { expect, it, vi } from "vitest";
import { BlockNoteEditor } from "@blocknote/core";
import { TextSelection } from "prosemirror-state";
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
  editor.setTextCursorPosition(editor.document[0]!, "end");
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

function moveCursor(editor: GraiteEditor, by: number): void {
  editor.transact((tr) => tr.setSelection(TextSelection.create(tr.doc, tr.selection.from + by)));
}

function withText(text: string): GraiteEditor {
  const editor = BlockNoteEditor.create({ schema }) as GraiteEditor;
  const el = document.createElement("div");
  document.body.appendChild(el);
  editor.mount(el);
  editor.replaceBlocks(editor.document, [{ type: "paragraph", content: text }]);
  return editor;
}

it("converts Markdown copied from VS Code or a chat app instead of making a code block", () => {
  const md =
    "## Plan\n\n1. first\n2. second\n\n**Done** when [the docs](https://example.com) are updated.";
  const extras: Record<string, string>[] = [
    { "vscode-editor-data": JSON.stringify({ mode: "markdown" }) },
    { "text/html": `<meta charset="utf-8"><pre><code>${md}</code></pre>` },
  ];
  for (const extra of extras) {
    const editor = BlockNoteEditor.create({ schema }) as GraiteEditor;
    const { handled, defaultPasteHandler } = paste(editor, { "text/plain": md, ...extra });
    expect(handled).toBe(true);
    expect(defaultPasteHandler).not.toHaveBeenCalled();
    expect(editor.document.map((b) => b.type)).toEqual([
      "heading",
      "numberedListItem",
      "numberedListItem",
      "paragraph",
    ]);
    expect(editor.document[3]!.content).toMatchObject([
      { type: "text", text: "Done", styles: { bold: true } },
      { type: "text", text: " when " },
      { type: "link", href: "https://example.com" },
      { type: "text", text: " are updated." },
    ]);
  }
});

it("leaves source code copied from VS Code to become a code block", () => {
  const editor = BlockNoteEditor.create({ schema }) as GraiteEditor;
  const clip = {
    "text/plain": "# a comment\nprint('- x')",
    "vscode-editor-data": JSON.stringify({ mode: "python" }),
  };
  expect(paste(editor, clip).defaultPasteHandler).toHaveBeenCalled();
});

it("styles Markdown that is typical of model output: loose lists, aligned tables, indented text", () => {
  const editor = BlockNoteEditor.create({ schema }) as GraiteEditor;
  paste(editor, {
    "text/plain": [
      "    ### Summary",
      "",
      "    - **Rent** is due",
      "",
      "    - `Power` is paid",
      "",
      "    | Item | Cost |",
      "    | :--- | ---: |",
      "    | Rent | 1200 |",
      "",
      "    ```python title=example.py",
      "    print(1)",
      "    ```",
    ].join("\n"),
  });
  expect(editor.document.map((b) => b.type)).toEqual([
    "heading",
    "bulletListItem",
    "bulletListItem",
    "table",
    "codeBlock",
  ]);
});

it("puts a line with only inline Markdown in at the cursor", () => {
  const editor = withText("Before  after");
  editor.setTextCursorPosition(editor.document[0]!, "start");
  moveCursor(editor, 7);
  paste(editor, { "text/plain": "**bold** and [a link](https://example.com)" });
  expect(editor.document).toHaveLength(2); // the line, and the editor's trailing paragraph
  expect(editor.document[0]!.content).toMatchObject([
    { type: "text", text: "Before " },
    { type: "text", text: "bold", styles: { bold: true } },
    { type: "text", text: " and " },
    { type: "link" },
    { type: "text", text: " after" },
  ]);
});

it("splits the line when blocks are pasted in the middle of it", () => {
  const editor = withText("Before after");
  editor.setTextCursorPosition(editor.document[0]!, "start");
  moveCursor(editor, 7);
  paste(editor, { "text/plain": "# Title\n- item" });
  expect(editor.document.slice(0, 4).map((b) => b.type)).toEqual([
    "paragraph",
    "heading",
    "bulletListItem",
    "paragraph",
  ]);
  expect(editor.document[0]!.content).toMatchObject([{ text: "Before " }]);
  expect(editor.document[3]!.content).toMatchObject([{ text: "after" }]);
});

it("puts blocks above a line when pasted at its start", () => {
  const editor = withText("Existing");
  editor.setTextCursorPosition(editor.document[0]!, "start");
  paste(editor, { "text/plain": "# Title\n- item" });
  expect(editor.document.slice(0, 3).map((b) => b.type)).toEqual([
    "heading",
    "bulletListItem",
    "paragraph",
  ]);
});
