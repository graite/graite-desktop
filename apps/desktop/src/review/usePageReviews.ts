import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import {
  reviewSlot,
  setReviewAnchors,
  topLevelBlocks,
  type ReviewAnchor,
} from "@/editor/reviewDecorations";
import type { GraiteEditor } from "@/editor/schema";
import type { Proposal, ReviewActions } from "@/lib/review";
import { computeAnchors } from "./anchors";
import { useProposals } from "./useProposals";

/**
 * The open page's proposals, placed in the editor. Anchors are computed against the body on
 * disk, so they are only recomputed when the editor matches it (after a load or a save);
 * while the user types, the markers follow their blocks.
 */
export function usePageReviews({
  editor,
  path,
  diskBody,
  bodyVersion,
  isDirty,
  flush,
}: {
  editor: GraiteEditor;
  path: string;
  diskBody: RefObject<string>;
  /** Bumped whenever `diskBody` and the editor are known to agree. */
  bodyVersion: number;
  isDirty: () => boolean;
  flush: () => Promise<void>;
}) {
  const { proposals, actions: base, refresh } = useProposals({ page_path: path, limit: 50 });
  const open = useMemo(
    () =>
      proposals.filter(
        (p) => p.page_path === path && (p.status === "pending" || p.status === "conflict"),
      ),
    [proposals, path],
  );
  const [anchors, setAnchors] = useState<ReviewAnchor[]>([]);
  const [unanchored, setUnanchored] = useState<Proposal[]>([]);
  const anchorsRef = useRef(anchors);
  anchorsRef.current = anchors;
  useEffect(() => {
    let next: ReviewAnchor[];
    if (isDirty()) {
      // Blocks may have moved since the last save: keep what is placed, drop what was decided.
      const ids = new Set(open.map((p) => p.id));
      next = anchorsRef.current.filter((a) => ids.has(a.proposalId));
      setUnanchored((old) => old.filter((p) => ids.has(p.id)));
    } else {
      const placed = computeAnchors(diskBody.current, topLevelBlocks(editor), open);
      next = placed.anchors;
      setUnanchored(placed.unanchored);
    }
    setReviewAnchors(editor, next);
    setAnchors(next);
  }, [editor, open, bodyVersion, diskBody, isDirty]);
  useEffect(() => () => setReviewAnchors(editor, []), [editor]);

  // Applying a proposal writes the page: save the user's pending edits first, or the reload
  // that follows would collide with them.
  const flushRef = useRef(flush);
  flushRef.current = flush;
  const actions = useMemo<ReviewActions>(
    () => ({
      ...base,
      accept: async (id, newText) => {
        await flushRef.current();
        await base.accept(id, newText);
      },
    }),
    [base],
  );
  const jump = useCallback(() => {
    const first = anchorsRef.current[0];
    const target = first
      ? reviewSlot(editor, first.proposalId)
      : document.querySelector("[data-review-unanchored]");
    target?.scrollIntoView?.({ block: "center", behavior: "smooth" });
  }, [editor]);
  return {
    open,
    anchors,
    unanchored,
    actions,
    refresh,
    jump,
    flush: useCallback(() => flushRef.current(), []),
  };
}
