import { useCallback, useEffect, useMemo, useState } from "react";
import { onDaemonEvent } from "@/lib/api";
import { review, type Proposal, type ReviewActions } from "@/lib/review";

export interface ProposalFilter {
  conversation_id?: string;
  page_path?: string;
  status?: string;
  limit?: number;
}

/** Proposals matching a filter, kept fresh from daemon events, plus the decision actions. */
export function useProposals(filter: ProposalFilter | null) {
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [error, setError] = useState("");
  const key = JSON.stringify(filter);
  const refresh = useCallback(async () => {
    const current = JSON.parse(key) as ProposalFilter | null;
    if (!current) {
      setProposals([]);
      return;
    }
    try {
      setProposals(await review.list(current));
      setError("");
    } catch (e) {
      setError((e as Error).message);
    }
  }, [key]);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  useEffect(
    () =>
      onDaemonEvent((event) => {
        if (event.type === "proposal" || event.type === "proposal_decided") void refresh();
      }),
    [refresh],
  );
  const merge = useCallback((updated: Proposal) => {
    setProposals((old) => {
      const index = old.findIndex((p) => p.id === updated.id);
      if (index === -1) return [updated, ...old];
      const next = [...old];
      next[index] = updated;
      return next;
    });
  }, []);
  const actions = useMemo<ReviewActions>(
    () => ({
      accept: async (id, newText) => {
        try {
          merge(await review.accept(id, newText));
        } catch (e) {
          // A 409 means the proposal became a conflict; show its new state.
          merge(await review.get(id));
          throw e;
        }
      },
      reject: async (id, reason) => merge(await review.reject(id, reason)),
      revert: async (id) => merge(await review.revert(id)),
      optIn: async (source) => {
        await review.optIn(source);
      },
    }),
    [merge],
  );
  const byId = useMemo(() => new Map(proposals.map((p) => [p.id, p])), [proposals]);
  return { proposals, byId, actions, refresh, merge, error };
}
