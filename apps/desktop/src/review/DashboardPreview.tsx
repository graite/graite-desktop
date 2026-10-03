import { DashboardFrame } from "@/editor/dashboards/DashboardFrame";
import type { Proposal } from "@/lib/review";
import { TextDiff } from "./DiffView";

/** A dashboard proposal (D72): the proposed HTML running live, and its source as a diff. */
export default function DashboardPreview({
  proposal,
  maxHeight = 640,
}: {
  proposal: Proposal;
  /** The preview fits the dashboard, up to this height. */
  maxHeight?: number;
}) {
  const pending = proposal.status === "pending" || proposal.status === "conflict";
  return (
    <div className="review-dashboard">
      {pending ? (
        <DashboardFrame
          pagePath={proposal.page_path}
          proposalId={proposal.id}
          height={0}
          maxHeight={maxHeight}
          title={proposal.summary ?? "Dashboard preview"}
        />
      ) : proposal.dashboard ? (
        <DashboardFrame
          pagePath={proposal.page_path}
          src={proposal.dashboard.src}
          height={0}
          maxHeight={maxHeight}
          title={proposal.summary ?? "Dashboard"}
        />
      ) : null}
      <details className="review-dashboard-code">
        <summary>{proposal.dashboard?.created ? "HTML" : "Changes to the HTML"}</summary>
        <TextDiff
          highlightChanges
          oldText={proposal.old_text ?? ""}
          newText={proposal.new_text ?? ""}
        />
      </details>
    </div>
  );
}
