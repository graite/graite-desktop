import { createPortal } from "react-dom";
import { reviewSlot, type ReviewAnchor } from "@/editor/reviewDecorations";
import type { GraiteEditor } from "@/editor/schema";
import type { Proposal, ReviewActions } from "@/lib/review";
import { InlineProposalCard } from "./InlineProposalCard";

/** Renders each anchored proposal into its slot inside the editor (see reviewDecorations). */
export function InlineProposals({
  editor,
  anchors,
  proposals,
  actions,
}: {
  editor: GraiteEditor;
  anchors: ReviewAnchor[];
  proposals: Proposal[];
  actions: ReviewActions;
}) {
  return (
    <>
      {anchors.map((anchor) => {
        const proposal = proposals.find((p) => p.id === anchor.proposalId);
        const slot = proposal && reviewSlot(editor, anchor.proposalId);
        return slot
          ? createPortal(
              <InlineProposalCard proposal={proposal} actions={actions} />,
              slot,
              anchor.proposalId,
            )
          : null;
      })}
    </>
  );
}
