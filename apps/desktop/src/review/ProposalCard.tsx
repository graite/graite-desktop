import { useState } from "react";
import { Check, ChevronRight, FileText, Pencil, RotateCcw, ShieldCheck, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { KIND_LABELS, STATUS_LABELS, type Proposal, type ReviewActions } from "@/lib/review";
import { ReviewContent } from "./ReviewContent";
import { PropertyDiff } from "./PropertyDiff";
import { PatchView, TextDiff } from "./DiffView";
import { useProposalDecision } from "./useProposalDecision";
import "./review.css";

/**
 * One proposed change with its diff and the decision buttons. With `collapsible` the card is
 * a toggle: a one-line row that opens to the full card (the Review page's list).
 */
export function ProposalCard({
  proposal,
  actions,
  onNavigate,
  collapsible = false,
  defaultOpen = true,
  quick = false,
}: {
  proposal: Proposal;
  actions: ReviewActions;
  onNavigate?: (path: string) => void;
  collapsible?: boolean;
  defaultOpen?: boolean;
  /** Keep Accept and Reject on the collapsed row (chat), so deciding needs no expanding. */
  quick?: boolean;
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
    open,
    applied,
  } = useProposalDecision(proposal);
  const [expanded, setExpanded] = useState(defaultOpen);
  const shown = !collapsible || expanded;
  const path =
    proposal.new_path && proposal.kind !== "move" ? proposal.new_path : proposal.page_path;
  const needsOptIn = proposal.policy === "auto_apply_needs_opt_in" && proposal.status === "pending";
  return (
    <article
      className="review-card"
      data-status={proposal.status}
      data-collapsed={!shown || undefined}
      aria-label={`Proposal: ${proposal.summary ?? proposal.kind}`}
    >
      {collapsible ? (
        <div className="review-row">
          <button
            type="button"
            className="review-toggle"
            aria-expanded={expanded}
            onClick={() => setExpanded((on) => !on)}
          >
            <ChevronRight
              size={14}
              className={`shrink-0 transition-transform ${expanded ? "rotate-90" : ""}`}
            />
            <span className="review-kind">{KIND_LABELS[proposal.kind] ?? proposal.kind}</span>
            <span className="review-summary">{proposal.summary}</span>
            {!expanded && <span className="review-path">{proposal.page_path}</span>}
            <span className="review-status">
              {STATUS_LABELS[proposal.status] ?? proposal.status}
            </span>
          </button>
          {quick && !shown && open && (
            <span className="review-quick">
              <button
                type="button"
                title="Accept"
                aria-label="Accept"
                disabled={busy}
                onClick={() => void run(() => actions.accept(proposal.id))}
              >
                <Check size={13} />
              </button>
              <button
                type="button"
                title="Reject"
                aria-label="Reject"
                disabled={busy}
                onClick={() => {
                  // A rejection asks for a reason, which needs the full card.
                  setExpanded(true);
                  setRejecting(true);
                }}
              >
                <X size={13} />
              </button>
            </span>
          )}
        </div>
      ) : (
        <header>
          <span className="review-kind">{KIND_LABELS[proposal.kind] ?? proposal.kind}</span>
          <span className="review-summary">{proposal.summary}</span>
          <span className="review-status">{STATUS_LABELS[proposal.status] ?? proposal.status}</span>
        </header>
      )}
      {!shown && error && (
        <p className="review-error" role="alert">
          {error}
        </p>
      )}
      {shown && (
        <>
          <p className="review-target">
            <FileText size={12} />
            {proposal.kind === "move" ? (
              <>
                {proposal.page_path} → {proposal.new_path || "vault root"}
              </>
            ) : proposal.kind === "create" ? (
              <>
                {proposal.page_title} under {proposal.page_path || "the vault root"}
              </>
            ) : (
              proposal.page_path
            )}
            {/* Proposed from outside Graite, by an MCP client such as Claude or ChatGPT. */}
            {proposal.conversation_id?.startsWith("mcp:") && (
              <span className="review-origin">via MCP · {proposal.conversation_id.slice(4)}</span>
            )}
            {onNavigate && path && (applied || proposal.kind !== "create") && (
              <button type="button" className="ai-source" onClick={() => onNavigate(path)}>
                Open
              </button>
            )}
          </p>
          {proposal.status === "conflict" && (
            <p className="review-note" role="alert">
              Rebase failed: {proposal.reason || "the page changed since this was proposed"}. Edit
              the proposal to match the current page, or reject it.
            </p>
          )}
          {proposal.status === "rejected" && proposal.reason && (
            <p className="review-note">Rejected: {proposal.reason}</p>
          )}
          {applied && proposal.reason === "rebased" && (
            <p className="review-note">Applied on top of a newer version of the page.</p>
          )}
          {editing ? (
            <>
              <textarea
                aria-label="Proposed text"
                className="review-editor"
                value={draft}
                rows={Math.min(18, Math.max(4, draft.split("\n").length + 1))}
                onChange={(e) => setDraft(e.target.value)}
              />
              <ReviewContent editing>
                <TextDiff
                  highlightChanges
                  oldText={proposal.kind === "edit" ? (proposal.old_text ?? "") : ""}
                  newText={draft}
                />
              </ReviewContent>
            </>
          ) : proposal.kind === "properties" ? null : proposal.new_text != null &&
            proposal.kind !== "move" &&
            proposal.kind !== "delete" ? (
            <ReviewContent>
              <TextDiff
                highlightChanges
                oldText={proposal.kind === "edit" ? (proposal.old_text ?? "") : ""}
                newText={proposal.new_text}
              />
            </ReviewContent>
          ) : proposal.patch ? (
            <ReviewContent>
              <PatchView patch={proposal.patch} />
            </ReviewContent>
          ) : null}
          {proposal.properties?.length ? (
            <ReviewContent>
              <PropertyDiff before={proposal.base_properties ?? null} after={proposal.properties} />
            </ReviewContent>
          ) : null}
          {needsOptIn && (
            <p className="review-note review-optin">
              <ShieldCheck size={13} /> This folder is set to apply {proposal.kind} changes without
              review, but that has not been confirmed yet.{" "}
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
            {open && !rejecting && (
              <>
                <Button
                  size="sm"
                  disabled={busy}
                  onClick={() =>
                    void run(() => actions.accept(proposal.id, editing ? draft : undefined))
                  }
                >
                  <Check size={13} /> {editing ? "Accept edited" : "Accept"}
                </Button>
                {proposal.kind !== "delete" &&
                  proposal.kind !== "move" &&
                  proposal.kind !== "properties" && (
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={busy}
                      onClick={() => setEditing((on) => !on)}
                    >
                      <Pencil size={13} /> {editing ? "Stop editing" : "Edit"}
                    </Button>
                  )}
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy}
                  onClick={() => setRejecting(true)}
                >
                  <X size={13} /> Reject
                </Button>
              </>
            )}
            {open && rejecting && (
              <form
                className="review-reject"
                onSubmit={(e) => {
                  e.preventDefault();
                  void run(() => actions.reject(proposal.id, reason)).then(() =>
                    setRejecting(false),
                  );
                }}
              >
                <input
                  aria-label="Reason for rejecting"
                  placeholder="Why? (the model reads this next turn)"
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  autoFocus
                />
                <Button size="sm" type="submit" disabled={busy}>
                  Reject
                </Button>
                <Button size="sm" type="button" variant="ghost" onClick={() => setRejecting(false)}>
                  Cancel
                </Button>
              </form>
            )}
            {applied && (
              <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() => void run(() => actions.revert(proposal.id))}
              >
                <RotateCcw size={13} /> Revert
              </Button>
            )}
          </footer>
        </>
      )}
    </article>
  );
}

export function policySource(proposal: Proposal): string {
  // Older proposals do not carry the setting's source; guess the folder or the page itself.
  return proposal.page_path.includes("/")
    ? proposal.page_path.split("/").slice(0, -1).join("/")
    : proposal.page_path;
}
