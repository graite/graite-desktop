import { useState } from "react";
import type { Proposal } from "@/lib/review";

/** The edit / reject / busy state behind a proposal's decision buttons, shared by every card. */
export function useProposalDecision(proposal: Proposal) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(proposal.new_text ?? "");
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try {
      await work();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return {
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
    open: proposal.status === "pending" || proposal.status === "conflict",
    applied: proposal.status === "accepted" || proposal.status === "auto_applied",
  };
}
