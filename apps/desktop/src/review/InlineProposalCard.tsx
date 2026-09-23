import { Check, Pencil, ShieldCheck, FileCheck2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { KIND_LABELS, type Proposal, type ReviewActions } from "@/lib/review";
import { ReviewContent } from "./ReviewContent";
import { TextDiff } from "./DiffView";
import { policySource } from "./ProposalCard";
import { useProposalDecision } from "./useProposalDecision";
import "./review.css";

function pageLevelNote(proposal: Proposal): string {
  if (proposal.kind === "create")
    return `New page “${proposal.page_title ?? "Untitled"}” under this page`;
  if (proposal.kind === "delete") return "Move this page to the trash";
  if (proposal.kind === "move") return `Move this page to ${proposal.new_path || "the vault root"}`;
  return "";
}

/** An open proposal as a compact suggestion, shown in the page where the change would land. */
export function InlineProposalCard({
  proposal,
  actions,
}: {
  proposal: Proposal;
  actions: ReviewActions;
}) {
  const {
    editing,
    setEditing,
    draft,
    setDraft,
    rejecting,
    setRejecting,
    reason,
    setReason,
    busy,
    error,
    run,
  } = useProposalDecision(proposal);
  const editable = proposal.kind !== "delete" && proposal.kind !== "move";
  const oldText = proposal.kind === "edit" ? (proposal.old_text ?? "") : "";
  const note = pageLevelNote(proposal);
  // Icons carry an explicit size class: BlockNote resets every other svg inside the editor.
  const needsOptIn = proposal.policy === "auto_apply_needs_opt_in" && proposal.status === "pending";
  return (
    <article
      className="review-inline"
      data-status={proposal.status}
      aria-label={`Proposal: ${proposal.summary ?? proposal.kind}`}
    >
      <header>
        <FileCheck2 className="size-3.5" />
        <span className="review-kind">{KIND_LABELS[proposal.kind] ?? proposal.kind}</span>
        <span className="review-summary">{proposal.summary}</span>
      </header>
      {proposal.status === "conflict" && (
        <p className="review-note" role="alert">
          {proposal.reason || "The page changed since this was proposed"}. Edit the proposal to
          match the page, or reject it.
        </p>
      )}
      {note && <p className="review-note">{note}</p>}
      {editing && (
        <textarea
          aria-label="Proposed text"
          className="review-editor"
          value={draft}
          rows={Math.min(14, Math.max(3, draft.split("\n").length + 1))}
          onChange={(e) => setDraft(e.target.value)}
        />
      )}
      {editable && (
        <ReviewContent editing={editing} pagePreview>
          <TextDiff
            highlightChanges
            oldText={oldText}
            newText={editing ? draft : (proposal.new_text ?? "")}
          />
        </ReviewContent>
      )}
      {needsOptIn && (
        <p className="review-note review-optin">
          <ShieldCheck className="size-3.5" /> This folder applies {proposal.kind} changes without
          review once you confirm.{" "}
          <button
            type="button"
            className="ai-source"
            disabled={busy}
            onClick={() =>
              void run(() => actions.optIn(proposal.opt_in_source ?? policySource(proposal)))
            }
          >
            Allow from now on
          </button>
        </p>
      )}
      {error && (
        <p className="review-error" role="alert">
          {error}
        </p>
      )}
      <footer>
        {rejecting ? (
          <form
            className="review-reject"
            onSubmit={(e) => {
              e.preventDefault();
              void run(() => actions.reject(proposal.id, reason)).then(() => setRejecting(false));
            }}
          >
            <input
              aria-label="Reason for rejecting"
              placeholder="Why? (the model reads this next turn)"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              autoFocus
            />
            <Button size="xs" type="submit" disabled={busy}>
              Reject
            </Button>
            <Button size="xs" type="button" variant="ghost" onClick={() => setRejecting(false)}>
              Cancel
            </Button>
          </form>
        ) : (
          <>
            <Button
              size="xs"
              disabled={busy}
              onClick={() =>
                void run(() => actions.accept(proposal.id, editing ? draft : undefined))
              }
            >
              <Check className="size-3" /> {editing ? "Accept edited" : "Accept"}
            </Button>
            {editable && (
              <Button
                size="icon-xs"
                variant="ghost"
                disabled={busy}
                aria-label={editing ? "Stop editing" : "Edit proposal"}
                title={editing ? "Stop editing" : "Edit before accepting"}
                onClick={() => setEditing((on) => !on)}
              >
                <Pencil className="size-3" />
              </Button>
            )}
            <Button
              size="icon-xs"
              variant="ghost"
              disabled={busy}
              aria-label="Reject proposal"
              title="Reject"
              onClick={() => setRejecting(true)}
            >
              <X className="size-3" />
            </Button>
          </>
        )}
      </footer>
    </article>
  );
}
