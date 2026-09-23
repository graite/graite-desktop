import { expect, it } from "vitest";
import { toBlocks } from "@graite/md-convert";
import type { Proposal } from "@/lib/review";
import { computeAnchors } from "../anchors";

const BODY =
  "# Plan\n\nThe meeting is on Tuesday.\n\n* first\n* second\n  * nested\n\nLast words.\n";

function proposal(id: string, patch: Partial<Proposal>): Proposal {
  return {
    id,
    kind: "edit",
    page_path: "Plan",
    status: "pending",
    created_at: id,
    summary: id,
    ...patch,
  } as Proposal;
}

/** The editor's blocks for a body: the converter's blocks plus BlockNote's trailing paragraph. */
function docOf(body: string) {
  return [
    ...toBlocks(body).map((b, i) => ({ id: `b${i}`, type: b.type })),
    { id: "tail", type: "paragraph" },
  ];
}

it("anchors edits under the blocks they touch and appends at the end", () => {
  const doc = docOf(BODY);
  expect(doc.map((b) => b.type)).toEqual([
    "heading",
    "paragraph",
    "bulletListItem",
    "bulletListItem",
    "paragraph",
    "paragraph",
  ]);
  const { anchors, unanchored } = computeAnchors(BODY, doc, [
    proposal("p3", { kind: "append", new_text: "More" }),
    proposal("p1", { old_text: "on Tuesday", new_text: "on Wednesday" }),
    proposal("p2", { old_text: "Tuesday.\n\n* first", new_text: "Friday.\n\n* first" }),
    proposal("p4", { old_text: "nested", new_text: "deeper" }),
  ]);
  expect(unanchored).toEqual([]);
  expect(anchors).toEqual([
    { proposalId: "p1", afterBlockId: "b1", changedBlockIds: ["b1"] },
    { proposalId: "p2", afterBlockId: "b2", changedBlockIds: ["b1", "b2"] },
    { proposalId: "p3", afterBlockId: "b4", changedBlockIds: [] },
    { proposalId: "p4", afterBlockId: "b3", changedBlockIds: ["b3"] }, // nested items anchor to their top-level item
  ]);
});

it("leaves page-level, missing and ambiguous changes unanchored", () => {
  const body = "Same line.\n\nSame line.\n";
  const rows = [
    proposal("p1", { old_text: "Same line.", new_text: "x" }),
    proposal("p2", { old_text: "Gone", new_text: "x", status: "conflict" }),
    proposal("p3", { kind: "create", new_text: "New page" }),
    proposal("p4", { kind: "delete" }),
    proposal("p5", { kind: "move", new_path: "Archive/Plan" }),
  ];
  const result = computeAnchors(body, docOf(body), rows);
  expect(result.anchors).toEqual([]);
  expect(result.unanchored.map((p) => p.id)).toEqual(["p1", "p2", "p3", "p4", "p5"]);
});

it("anchors nothing when the editor and the file are out of step", () => {
  const rows = [
    proposal("p1", { old_text: "Tuesday", new_text: "Friday" }),
    proposal("p2", { kind: "append", new_text: "x" }),
  ];
  const shuffled = docOf(BODY).reverse();
  expect(computeAnchors(BODY, shuffled, rows).unanchored).toHaveLength(2);
  expect(computeAnchors(BODY, docOf(BODY).slice(0, 2), rows).unanchored).toHaveLength(2);
});

it("appends to an empty page under its only block", () => {
  const { anchors } = computeAnchors(
    "",
    [{ id: "only", type: "paragraph" }],
    [proposal("p1", { kind: "append", new_text: "x" })],
  );
  expect(anchors).toEqual([{ proposalId: "p1", afterBlockId: "only", changedBlockIds: [] }]);
});
