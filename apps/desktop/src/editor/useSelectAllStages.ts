import { useEffect } from "react";
import { getBlockInfoFromSelection } from "@blocknote/core";
import { TextSelection } from "prosemirror-state";
import type { GraiteEditor } from "./schema";

/**
 * Notion-style two-stage Ctrl+A / Cmd+A:
 *   1st press -> select the current block's text
 *   2nd press -> select all blocks of the page
 * Capture-phase listener on the PM DOM runs before ProseMirror's own selectAll.
 */
export function useSelectAllStages(editor: GraiteEditor) {
  useEffect(() => {
    const view = editor.prosemirrorView;
    if (!view) return;
    const dom = view.dom;

    const handler = (e: KeyboardEvent) => {
      const isSelectAll =
        (e.key === "a" || e.key === "A") && (e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey;
      if (!isSelectAll) return;
      // Fields inside the editor (a review card's textarea) keep the native select-all.
      if (e.target instanceof Element && e.target.closest("[data-review-slot], input, textarea"))
        return;
      e.preventDefault();
      e.stopPropagation();

      const doc = editor.document;
      if (doc.length === 0) return;
      const selectAllBlocks = () => editor.setSelection(doc[0]!.id, doc[doc.length - 1]!.id);

      const bn = editor.getSelection();
      if (bn && bn.blocks.length > 1) return selectAllBlocks();

      const state = view.state;
      let info;
      try {
        info = getBlockInfoFromSelection(state);
      } catch {
        return selectAllBlocks();
      }
      if (!info.isBlockContainer || !info.blockContent) return selectAllBlocks();

      const contentFrom = info.blockContent.beforePos + 1;
      const contentTo = info.blockContent.afterPos - 1;
      if (contentTo <= contentFrom) return selectAllBlocks();

      const sel = state.selection;
      const fullySelected =
        sel instanceof TextSelection && sel.from <= contentFrom && sel.to >= contentTo;
      if (fullySelected) return selectAllBlocks();

      view.dispatch(state.tr.setSelection(TextSelection.create(state.doc, contentFrom, contentTo)));
    };

    dom.addEventListener("keydown", handler, { capture: true });
    return () => dom.removeEventListener("keydown", handler, { capture: true });
  }, [editor]);
}
