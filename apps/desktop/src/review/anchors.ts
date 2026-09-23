import { toBlocksWithSpans } from "@graite/md-convert";
import type { ReviewAnchor } from "@/editor/reviewDecorations";
import type { Proposal } from "@/lib/review";

export interface PageAnchors {
  anchors: ReviewAnchor[];
  /** Proposals with no place in the text: new pages, deletes, moves, or text that is gone. */
  unanchored: Proposal[];
}

/**
 * Place each open proposal in the editor. `body` is the markdown on disk (what the daemon
 * matches `old_text` against) and `doc` the editor's top-level blocks loaded from it; the
 * converter's source spans tie the two together. An edit anchors under the last block its
 * `old_text` touches, an append under the last block with content.
 */
export function computeAnchors(
  body: string,
  doc: { id: string; type: string }[],
  proposals: Proposal[],
): PageAnchors {
  const ordered = [...proposals].sort((a, b) => a.created_at.localeCompare(b.created_at));
  const { blocks, spans } = toBlocksWithSpans(body);
  // The editor may hold more blocks than the file (BlockNote keeps a trailing empty
  // paragraph), never fewer; anything else means the two are out of step.
  const aligned =
    doc.length >= blocks.length && blocks.every((block, i) => doc[i]!.type === block.type);
  if (!aligned || !doc.length) return { anchors: [], unanchored: ordered };

  const anchors: ReviewAnchor[] = [];
  const unanchored: Proposal[] = [];
  for (const proposal of ordered) {
    if (proposal.kind === "append") {
      const last = doc[Math.max(blocks.length, 1) - 1]!;
      anchors.push({ proposalId: proposal.id, afterBlockId: last.id, changedBlockIds: [] });
      continue;
    }
    const old = proposal.old_text ?? "";
    const at = proposal.kind === "edit" && old ? body.indexOf(old) : -1;
    // Like the daemon, only a single occurrence identifies the place.
    if (at === -1 || body.indexOf(old, at + 1) !== -1) {
      unanchored.push(proposal);
      continue;
    }
    const end = at + old.length;
    const touched = spans.flatMap((span, i) => (span.start < end && span.end > at ? [i] : []));
    if (!touched.length) {
      unanchored.push(proposal);
      continue;
    }
    anchors.push({
      proposalId: proposal.id,
      afterBlockId: doc[touched[touched.length - 1]!]!.id,
      changedBlockIds: touched.map((i) => doc[i]!.id),
    });
  }
  return { anchors, unanchored };
}
