import { useEffect, useRef } from "react";
import type { ChatMessage } from "@/lib/ai";
import type { Proposal } from "@/lib/review";

const APPLIED = new Set(["accepted", "auto_applied"]);

/** The message that tells the assistant how its proposals were decided, or null when the
 *  last answer is not waiting for a review (or the review is not finished). */
export function reviewOutcome(
  last: ChatMessage | undefined,
  byId: Map<string, Proposal>,
): { pending: boolean; message: string | null } {
  if (!last || last.role !== "assistant" || !last.awaiting)
    return { pending: false, message: null };
  const mine = (last.proposals ?? []).map((id) => byId.get(id));
  if (!mine.length || mine.some((p) => !p)) return { pending: false, message: null };
  const decided = mine as Proposal[];
  if (decided.some((p) => p.status === "pending")) return { pending: true, message: null };
  const accepted = decided.filter((p) => APPLIED.has(p.status)).length;
  // Nothing was accepted: there is nothing to continue with, and the user knows why.
  if (!accepted) return { pending: false, message: null };
  const refused = decided.length - accepted;
  const outcome =
    refused === 0
      ? "I accepted the changes."
      : `I accepted ${accepted} of the ${decided.length} changes; the rest were not applied.`;
  return { pending: false, message: `${outcome} Continue: ${last.awaiting}` };
}

/**
 * When the assistant said the rest of its work waits for a review (`awaiting` on its last
 * answer), send it the outcome as soon as the user has decided, so nobody has to type
 * "continue". Only a review that was seen waiting in this window continues by itself: an
 * old conversation opened later never starts working on its own.
 */
export function useContinueAfterReview(options: {
  messages: ChatMessage[];
  byId: Map<string, Proposal>;
  busy: boolean;
  send: (text: string) => void;
}) {
  const { messages, byId, busy, send } = options;
  const waitingOn = useRef<ChatMessage | null>(null);
  const sendRef = useRef(send);
  sendRef.current = send;
  useEffect(() => {
    const last = messages[messages.length - 1];
    const { pending, message } = reviewOutcome(last, byId);
    if (pending) {
      waitingOn.current = last ?? null;
      return;
    }
    if (!message || busy || !last) return;
    const seen = waitingOn.current;
    if (!seen || seen.run_id !== last.run_id) return;
    waitingOn.current = null;
    sendRef.current(message);
  }, [messages, byId, busy]);
}
