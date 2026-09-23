import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { BlockNoteEditor } from "@blocknote/core";
import { schema, type GraiteEditor } from "../schema";
import { EditorSurface } from "../EditorSurface";
import {
  editorExtensions,
  reviewSlot,
  setReviewAnchors,
  topLevelBlocks,
} from "../reviewDecorations";

afterEach(cleanup);

const slashDeps = {
  createChildPage: async () => {
    throw Error();
  },
  pickPage: async () => null,
  onTreeChanged: () => {},
};

it("marks changed blocks and hosts a card slot without touching the document", () => {
  const editor = BlockNoteEditor.create({
    schema,
    extensions: editorExtensions,
    initialContent: [
      { type: "paragraph", content: "Keep" },
      { type: "paragraph", content: "Change me" },
      { type: "paragraph", content: "After" },
    ],
  }) as GraiteEditor;
  const onChange = vi.fn();
  render(<EditorSurface editor={editor} onChange={onChange} slashDeps={slashDeps} />);
  const dom = editor.prosemirrorView.dom;
  const before = JSON.stringify(editor.document);
  const [, target] = topLevelBlocks(editor);

  setReviewAnchors(editor, [
    { proposalId: "p_1", afterBlockId: target!.id, changedBlockIds: [target!.id] },
  ]);
  const marked = dom.querySelectorAll("[data-review-changed]");
  expect(marked).toHaveLength(1);
  expect(marked[0]!.textContent).toBe("Change me");
  const slot = dom.querySelector("[data-proposal-id='p_1']");
  expect(slot).toBe(reviewSlot(editor, "p_1"));
  expect(slot!.getAttribute("contenteditable")).toBe("false");
  // The slot sits right after the changed block, before the next one.
  expect(marked[0]!.nextElementSibling).toBe(slot);
  expect(onChange).not.toHaveBeenCalled();
  expect(JSON.stringify(editor.document)).toBe(before);
  expect(editor.undo()).toBe(false);

  // A real edit keeps the same slot element (the card inside keeps its state) and the marker.
  editor.updateBlock(editor.document[0]!, { content: "Kept" });
  expect(onChange).toHaveBeenCalledTimes(1);
  expect(dom.querySelector("[data-proposal-id='p_1']")).toBe(slot);
  expect(dom.querySelectorAll("[data-review-changed]")).toHaveLength(1);

  setReviewAnchors(editor, []);
  expect(dom.querySelector("[data-proposal-id]")).toBeNull();
  expect(dom.querySelector("[data-review-changed]")).toBeNull();
  expect(onChange).toHaveBeenCalledTimes(1);
});
