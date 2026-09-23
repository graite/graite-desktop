import type { Proposal, ReviewActions } from "@/lib/review";
import { ProposalCard } from "@/review/ProposalCard";

/**
 * The changes an answer proposed, as one-line cards that open to their diff. Two or more are
 * grouped under a "N changes" header so a busy turn stays one block in the thread.
 */
export function ChatProposals({
  proposals,
  actions,
  onNavigate,
}: {
  proposals: Proposal[];
  actions: ReviewActions;
  onNavigate: (path: string) => void;
}) {
  if (!proposals.length) return null;
  const cards = proposals.map((p) => (
    <ProposalCard
      key={p.id}
      proposal={p}
      actions={actions}
      onNavigate={onNavigate}
      collapsible
      defaultOpen={false}
      quick
    />
  ));
  if (proposals.length < 2) return <div className="ai-proposals">{cards}</div>;
  return (
    <section className="ai-proposals ai-proposal-group" aria-label={`${proposals.length} changes`}>
      <header>{proposals.length} changes</header>
      {cards}
    </section>
  );
}
