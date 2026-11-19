import type { Node, Slice } from "prosemirror-model";
import {
  NodeSelection,
  TextSelection,
  type EditorState,
  type Transaction,
} from "prosemirror-state";
import { dropPoint } from "prosemirror-transform";
import type { EditorView } from "prosemirror-view";
import type { GraiteBlock, GraiteEditor } from "./schema";

/**
 * Selected text dragged with the mouse inside a page is moved here, in one transaction, instead
 * of by ProseMirror's own drop handling. BlockNote re-sends a drop that lands just beside the
 * text as a second, synthetic drop, and WebKitGTK (the Linux webview) ends the drag in an order
 * that leaves ProseMirror without its record of it: the text was inserted again and a stray
 * range removed instead of the dragged one.
 */
export interface TextDrag {
  doc: Node;
  from: number;
  to: number;
  slice: Slice;
  node?: NodeSelection;
  /** Set when the selection is whole lines: they move as lines, like with the handle. */
  lines?: GraiteBlock[];
}

/**
 * The blocks a selection covers when it runs from the start of one line to the end of another
 * line under the same parent; null for any other selection (part of a line, or one line).
 */
export function selectedLines(editor: GraiteEditor): GraiteBlock[] | null {
  const { $from, $to, empty } = editor.prosemirrorState.selection;
  if (empty || !$from.parent.isTextblock || !$to.parent.isTextblock) return null;
  if ($from.parentOffset !== 0 || $to.parentOffset !== $to.parent.content.size) return null;
  const blocks = editor.getSelection()?.blocks as GraiteBlock[] | undefined;
  if (!blocks || blocks.length < 2) return null;
  const parent = editor.getParentBlock(blocks[0]!.id)?.id;
  return blocks.every((b) => editor.getParentBlock(b.id)?.id === parent) ? blocks : null;
}

/** What is being dragged, read right after ProseMirror starts a drag of the selection. */
export function textDragOf(view: EditorView): TextDrag | null {
  // ProseMirror keeps a dragged node on `dragging` without declaring it.
  const dragging = view.dragging as { slice: Slice; node?: NodeSelection } | null;
  if (!dragging) return null;
  const { from, to } = dragging.node ?? view.state.selection;
  if (from === to) return null;
  return { doc: view.state.doc, from, to, slice: dragging.slice, node: dragging.node };
}

/**
 * The transaction that puts `drag` at document position `at`: moved, or copied when `copy`.
 * Null when there is nothing to do (dropped onto itself, or the page changed meanwhile).
 */
export function textMove(
  state: EditorState,
  drag: TextDrag,
  at: number,
  copy: boolean,
): Transaction | null {
  if (state.doc !== drag.doc) return null;
  if (!copy && at >= drag.from && at <= drag.to) return null;
  const { slice } = drag;
  const insertAt = dropPoint(state.doc, at, slice) ?? at;
  const tr = state.tr;
  if (!copy) {
    if (drag.node) drag.node.replace(tr);
    // Whole lines leave no empty line behind: deleteRange takes the blocks it covers.
    else tr.deleteRange(drag.from, drag.to);
  }
  const pos = tr.mapping.map(insertAt);
  const isNode = slice.openStart === 0 && slice.openEnd === 0 && slice.content.childCount === 1;
  const before = tr.doc;
  if (isNode) tr.replaceRangeWith(pos, pos, slice.content.firstChild!);
  else tr.replaceRange(pos, pos, slice);
  if (tr.doc.eq(before)) return null;
  const $pos = tr.doc.resolve(pos);
  const first = slice.content.firstChild;
  if (isNode && first && NodeSelection.isSelectable(first) && $pos.nodeAfter?.sameMarkup(first)) {
    tr.setSelection(new NodeSelection($pos));
  } else {
    let end = tr.mapping.map(insertAt);
    tr.mapping.maps[tr.mapping.maps.length - 1]!.forEach((_a, _b, _c, newTo) => (end = newTo));
    tr.setSelection(TextSelection.between($pos, tr.doc.resolve(end)));
  }
  return tr.setMeta("uiEvent", "drop");
}

/** The document position under a drop, with a drop beside the text taken to its nearest edge. */
export function dropPosition(view: EditorView, x: number, y: number): number | null {
  const box = (view.dom.firstElementChild ?? view.dom).getBoundingClientRect();
  const left = Math.min(Math.max(x, box.left + 1), box.right - 1);
  const top = Math.min(Math.max(y, box.top + 1), box.bottom - 1);
  return view.posAtCoords({ left, top })?.pos ?? null;
}
