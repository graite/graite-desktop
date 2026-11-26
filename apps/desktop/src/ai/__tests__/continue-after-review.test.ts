import { expect, it } from "vitest";
import type { ChatMessage } from "@/lib/ai";
import type { Proposal } from "@/lib/review";
import { reviewOutcome } from "../useContinueAfterReview";

const answer = (extra: Partial<ChatMessage>): ChatMessage =>
  ({ role: "assistant", content: "Proposed.", interrupted: false, ...extra }) as ChatMessage;
const proposals = (...statuses: string[]) =>
  new Map(statuses.map((status, n) => [`p${n}`, { id: `p${n}`, status } as Proposal]));

it("waits while a proposal of the answer is still open", () => {
  const last = answer({ awaiting: "add the rows", proposals: ["p0", "p1"] });
  expect(reviewOutcome(last, proposals("accepted", "pending"))).toEqual({
    pending: true,
    message: null,
  });
});

it("continues with the outcome once everything is decided", () => {
  const last = answer({ awaiting: "add the rows", proposals: ["p0", "p1"] });
  expect(reviewOutcome(last, proposals("accepted", "auto_applied")).message).toBe(
    "I accepted the changes. Continue: add the rows",
  );
  expect(reviewOutcome(last, proposals("accepted", "rejected")).message).toMatch(
    /^I accepted 1 of the 2 changes/,
  );
});

it("does not continue when nothing was accepted or nothing was awaited", () => {
  const last = answer({ awaiting: "add the rows", proposals: ["p0"] });
  expect(reviewOutcome(last, proposals("rejected")).message).toBeNull();
  expect(reviewOutcome(answer({ proposals: ["p0"] }), proposals("accepted")).message).toBeNull();
  expect(reviewOutcome(undefined, proposals()).message).toBeNull();
});
