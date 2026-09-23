import { createExtension } from "@blocknote/core";
import { Plugin, PluginKey, type EditorState } from "prosemirror-state";
import { Decoration, DecorationSet } from "prosemirror-view";
import type { GraiteEditor } from "./schema";

/** Where one open proposal shows in the editor: under a block, marking the blocks it changes. */
export interface ReviewAnchor {
  proposalId: string;
  afterBlockId: string;
  changedBlockIds: string[];
}

type ProseMirrorNode = EditorState["doc"];

const KEY = new PluginKey<DecorationSet>("graite-review");

/**
 * Review markers as ProseMirror decorations: a slot under the anchor block for the proposal's
 * card and an attribute on the blocks it would change. Decorations are view-only, so the
 * document, undo history and saved markdown never see them (opening a page with proposals
 * must not rewrite it). They are rebuilt by block id, which survives edits, drags and undo.
 */
export const ReviewDecorations = createExtension(({ editor }) => {
  let anchors: ReviewAnchor[] = [];
  // One element per proposal for its whole life: ProseMirror re-inserts the same node when it
  // redraws, so the React portal inside keeps its state (a half-typed edit or reject reason).
  const slots = new Map<string, HTMLElement>();
  const slot = (proposalId: string): HTMLElement => {
    let el = slots.get(proposalId);
    if (!el) {
      el = document.createElement("div");
      el.className = "review-inline-slot";
      el.setAttribute("contenteditable", "false");
      el.dataset.reviewSlot = "";
      el.dataset.proposalId = proposalId;
      slots.set(proposalId, el);
    }
    return el;
  };
  const build = (doc: ProseMirrorNode): DecorationSet => {
    const group = doc.firstChild;
    if (!anchors.length || !group) return DecorationSet.empty;
    const changed = new Set(anchors.flatMap((a) => a.changedBlockIds));
    const decorations: Decoration[] = [];
    group.forEach((node, offset) => {
      const id = node.attrs.id as string | undefined;
      if (!id) return;
      const from = 1 + offset;
      const to = from + node.nodeSize;
      if (changed.has(id))
        decorations.push(Decoration.node(from, to, { "data-review-changed": "" }));
      for (const anchor of anchors) {
        if (anchor.afterBlockId !== id) continue;
        decorations.push(
          Decoration.widget(to, () => slot(anchor.proposalId), {
            key: `review:${anchor.proposalId}`,
            side: 1,
            stopEvent: () => true,
            ignoreSelection: true,
          }),
        );
      }
    });
    return DecorationSet.create(doc, decorations);
  };
  return {
    key: "reviewDecorations",
    prosemirrorPlugins: [
      new Plugin({
        key: KEY,
        state: {
          init: (_, state) => build(state.doc),
          apply: (tr, old) => (tr.docChanged || tr.getMeta(KEY) ? build(tr.doc) : old),
        },
        props: { decorations: (state) => KEY.getState(state) },
      }),
    ],
    setAnchors(next: ReviewAnchor[]) {
      if (JSON.stringify(next) === JSON.stringify(anchors)) return;
      anchors = next;
      const live = new Set(next.map((a) => a.proposalId));
      for (const id of [...slots.keys()]) if (!live.has(id)) slots.delete(id);
      // Meta only: no document change, so BlockNote's onChange (and a save) never fires.
      editor.transact((tr) => tr.setMeta(KEY, {}).setMeta("addToHistory", false));
    },
    slot,
  } as const;
});

export const editorExtensions = [ReviewDecorations()];

export function setReviewAnchors(editor: GraiteEditor, anchors: ReviewAnchor[]): void {
  editor.getExtension(ReviewDecorations)?.setAnchors(anchors);
}

/** The element a proposal's card is rendered into (a React portal target). */
export function reviewSlot(editor: GraiteEditor, proposalId: string): HTMLElement | null {
  return editor.getExtension(ReviewDecorations)?.slot(proposalId) ?? null;
}

export function topLevelBlocks(editor: GraiteEditor): { id: string; type: string }[] {
  return editor.document.map((block) => ({ id: block.id, type: block.type }));
}
