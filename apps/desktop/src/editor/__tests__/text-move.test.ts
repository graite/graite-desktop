import { describe, expect, it } from "vitest";
import { BlockNoteEditor } from "@blocknote/core";
import { TextSelection } from "prosemirror-state";
import { toBlocks } from "@graite/md-convert";
import { schema, type GraiteEditor, type GraitePartialBlock } from "../schema";
import { loadBlocks } from "../PageEditor";
import { selectedLines, textMove, type TextDrag } from "../textMove";

function editorWith(md: string) {
  const editor = BlockNoteEditor.create({ schema }) as GraiteEditor;
  const el = document.createElement("div");
  document.body.appendChild(el);
  editor.mount(el);
  loadBlocks(editor, toBlocks(md) as GraitePartialBlock[]);
  return editor;
}

/** Document position of `text`'s first character (or just after it, with `after`). */
function at(editor: GraiteEditor, text: string, after = false): number {
  let found = -1;
  editor.prosemirrorState.doc.descendants((node, pos) => {
    if (found >= 0 || !node.isText) return found < 0;
    const i = node.text!.indexOf(text);
    if (i >= 0) found = pos + i + (after ? text.length : 0);
    return false;
  });
  if (found < 0) throw new Error(`no ${text}`);
  return found;
}

function select(editor: GraiteEditor, from: number, to: number) {
  const view = editor.prosemirrorView;
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, from, to)));
}

function dragOf(editor: GraiteEditor): TextDrag {
  const { selection, doc } = editor.prosemirrorState;
  return { doc, from: selection.from, to: selection.to, slice: selection.content() };
}

const texts = (editor: GraiteEditor) =>
  editor.document
    .map((b) => (b.content as { text: string }[]).map((c) => c.text).join(""))
    .filter(Boolean);

describe("moving dragged text", () => {
  it("moves a word once, out of where it was", () => {
    const editor = editorWith("alpha line\n\nbeta line\n\ndelta line\n");
    select(editor, at(editor, "beta "), at(editor, "beta ", true));
    const tr = textMove(editor.prosemirrorState, dragOf(editor), at(editor, "line", false), false);
    // dropped before "line" of "alpha line"
    editor.prosemirrorView.dispatch(tr!);
    expect(texts(editor)).toEqual(["alpha beta line", "line", "delta line"]);
  });

  it("copies with the copy modifier and does nothing dropped onto itself", () => {
    const editor = editorWith("alpha line\n\nbeta line\n");
    select(editor, at(editor, "beta"), at(editor, "beta", true));
    const drag = dragOf(editor);
    expect(textMove(editor.prosemirrorState, drag, at(editor, "beta") + 2, false)).toBeNull();
    editor.prosemirrorView.dispatch(
      textMove(editor.prosemirrorState, drag, at(editor, "alpha"), true)!,
    );
    expect(texts(editor)).toEqual(["betaalpha line", "beta line"]);
  });

  it("does nothing when the page changed during the drag", () => {
    const editor = editorWith("alpha line\n\nbeta line\n");
    select(editor, at(editor, "beta"), at(editor, "beta", true));
    const drag = dragOf(editor);
    editor.insertInlineContent("x");
    expect(textMove(editor.prosemirrorState, drag, at(editor, "alpha"), false)).toBeNull();
  });
});

describe("whole lines", () => {
  it("are the selected blocks from the start of one line to the end of another", () => {
    const editor = editorWith("alpha line\n\nbeta line\n\ngamma line\n\ndelta line\n");
    select(editor, at(editor, "beta"), at(editor, "gamma line", true));
    expect(selectedLines(editor)?.map((b) => b.id)).toEqual(
      editor.document.slice(1, 3).map((b) => b.id),
    );
  });

  it("are not part of a line or a single line", () => {
    const editor = editorWith("alpha line\n\nbeta line\n\ngamma line\n");
    select(editor, at(editor, "line"), at(editor, "gamma line", true));
    expect(selectedLines(editor)).toBeNull();
    select(editor, at(editor, "beta"), at(editor, "gamma"));
    expect(selectedLines(editor)).toBeNull();
    select(editor, at(editor, "beta"), at(editor, "beta line", true));
    expect(selectedLines(editor)).toBeNull();
  });
});
