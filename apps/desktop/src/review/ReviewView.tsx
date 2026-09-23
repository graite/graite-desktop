import { useState } from "react";
import { Button } from "@/components/ui/button";
import { review } from "@/lib/review";
import { ProposalCard } from "./ProposalCard";
import { useProposals } from "./useProposals";
import "./review.css";

type Tab = "pending" | "auto_applied" | "decided";

/** The Studio's review queue: everything waiting, applied automatically, or decided. */
export function ReviewView({ onNavigate }: { onNavigate: (path: string) => void }) {
  const [tab, setTab] = useState<Tab>("pending");
  const { proposals, actions, error, refresh } = useProposals({ limit: 200 });
  const waiting = proposals.filter((p) => p.status === "pending" || p.status === "conflict");
  const shown =
    tab === "pending"
      ? waiting
      : tab === "auto_applied"
        ? proposals.filter((p) => p.status === "auto_applied")
        : proposals.filter((p) => !["pending", "conflict", "auto_applied"].includes(p.status));
  const pending = proposals.filter((p) => p.status === "pending");
  return (
    <section className="review-view" aria-label="Review">
      <header className="review-view-head">
        <h1>Review</h1>
        <div className="ai-modes" role="tablist" aria-label="Proposal status">
          {(
            [
              ["pending", `Pending (${waiting.length})`],
              ["auto_applied", "Applied automatically"],
              ["decided", "Decided"],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={tab === id}
              data-active={tab === id || undefined}
              onClick={() => setTab(id)}
            >
              {label}
            </button>
          ))}
        </div>
        {tab === "pending" && pending.length > 1 && (
          <Button
            size="sm"
            variant="outline"
            onClick={() => void review.acceptBatch(pending.map((p) => p.id)).then(() => refresh())}
          >
            Accept all pending
          </Button>
        )}
      </header>
      {error && (
        <p className="review-error" role="alert">
          {error}
        </p>
      )}
      {!shown.length && (
        <p className="review-empty">
          {tab === "pending"
            ? "Nothing waits for your review. Ask for a change in Act mode and it will show up here."
            : tab === "auto_applied"
              ? "No change has been applied automatically yet."
              : "No decisions yet."}
        </p>
      )}
      <div className="review-list">
        {shown.map((p) => (
          <ProposalCard
            key={p.id}
            proposal={p}
            actions={actions}
            onNavigate={onNavigate}
            collapsible
            defaultOpen={p.status === "conflict"}
          />
        ))}
      </div>
    </section>
  );
}
