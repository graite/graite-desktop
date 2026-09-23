import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ProposalCard } from "../ProposalCard";
import type { Proposal, ReviewActions } from "@/lib/review";

afterEach(cleanup);

const PROPOSAL: Proposal = {
  id: "p_1",
  run_id: "r",
  conversation_id: "c",
  page_path: "Notes",
  page_id: "n",
  page_title: "Notes",
  kind: "edit",
  base_hash: "h",
  old_text: "Old line.",
  new_text: "New line.",
  new_path: null,
  patch: "--- a/Notes\n+++ b/Notes\n@@ -1,3 +1,3 @@\n # Notes\n \n-Old line.\n+New line.\n",
  summary: "Update the line",
  status: "pending",
  policy: "propose",
  decided_by: null,
  reason: null,
  created_at: "2026-09-16T10:00:00Z",
  decided_at: null,
  applied_hash: null,
  snapshot: null,
  trash_id: null,
  edited: false,
};

function actions(): ReviewActions {
  return {
    accept: vi.fn(async () => {}),
    reject: vi.fn(async () => {}),
    revert: vi.fn(async () => {}),
    optIn: vi.fn(async () => {}),
  };
}

it("shows the diff and accepts, edits or rejects a pending proposal", async () => {
  const acts = actions();
  const onNavigate = vi.fn();
  render(<ProposalCard proposal={PROPOSAL} actions={acts} onNavigate={onNavigate} />);
  const diff = screen.getByLabelText("Changes");
  expect(diff.querySelector('[data-kind="del"]')?.textContent).toBe("Old line.");
  expect(diff.querySelector('[data-kind="add"]')?.textContent).toBe("New line.");
  expect(diff.textContent).not.toContain("+++");
  fireEvent.click(screen.getByRole("button", { name: "Open" }));
  expect(onNavigate).toHaveBeenCalledWith("Notes");
  fireEvent.click(screen.getByRole("button", { name: /Edit/ }));
  fireEvent.change(screen.getByLabelText("Proposed text"), { target: { value: "Newer line." } });
  fireEvent.click(screen.getByRole("button", { name: /Accept edited/ }));
  await waitFor(() => expect(acts.accept).toHaveBeenCalledWith("p_1", "Newer line."));
  fireEvent.click(screen.getByRole("button", { name: /Reject/ }));
  fireEvent.change(screen.getByLabelText("Reason for rejecting"), {
    target: { value: "Too short" },
  });
  fireEvent.submit(
    screen.getByLabelText("Reason for rejecting").closest("form") as HTMLFormElement,
  );
  await waitFor(() => expect(acts.reject).toHaveBeenCalledWith("p_1", "Too short"));
});

it("explains a conflict and lets an applied proposal be reverted", async () => {
  const acts = actions();
  const { rerender } = render(
    <ProposalCard
      proposal={{
        ...PROPOSAL,
        status: "conflict",
        reason: "the text to replace is no longer unique",
      }}
      actions={acts}
    />,
  );
  expect(screen.getByRole("alert").textContent).toContain(
    "Rebase failed: the text to replace is no longer unique",
  );
  expect(screen.getByRole("button", { name: /Accept/ })).toBeTruthy();
  rerender(
    <ProposalCard
      proposal={{ ...PROPOSAL, status: "accepted", reason: "rebased" }}
      actions={acts}
    />,
  );
  expect(screen.getByText("Applied on top of a newer version of the page.")).toBeTruthy();
  expect(screen.queryByRole("button", { name: /Accept/ })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: /Revert/ }));
  await waitFor(() => expect(acts.revert).toHaveBeenCalledWith("p_1"));
});

it("offers the one-time auto-apply confirmation", async () => {
  const acts = actions();
  render(
    <ProposalCard
      proposal={{ ...PROPOSAL, page_path: "Journal/Today", policy: "auto_apply_needs_opt_in" }}
      actions={acts}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Allow from now on" }));
  await waitFor(() => expect(acts.optIn).toHaveBeenCalledWith("Journal"));
});

it("says when a change was proposed from outside Graite over MCP", () => {
  const { rerender } = render(
    <ProposalCard
      proposal={{ ...PROPOSAL, run_id: null, conversation_id: "mcp:claude-code" }}
      actions={actions()}
    />,
  );
  expect(screen.getByText("via MCP · claude-code")).toBeTruthy();
  rerender(<ProposalCard proposal={PROPOSAL} actions={actions()} />);
  expect(screen.queryByText(/via MCP/)).toBeNull();
});

const STATUS = {
  id: "status",
  name: "Status",
  type: "status" as const,
  options: ["Open", "Done"],
  colors: { Open: "blue" as const, Done: "green" as const },
};

it("shows what a properties proposal would change, since it has no text to diff", () => {
  const proposal: Proposal = {
    ...PROPOSAL,
    id: "p_2",
    kind: "properties",
    old_text: null,
    new_text: null,
    patch: null,
    summary: "Move it to Done",
    base_properties: [
      { ...STATUS, value: "Open" },
      { id: "due", name: "Due", type: "date", options: [], colors: {}, value: "2026-10-02" },
    ],
    properties: [{ ...STATUS, value: "Done" }],
  };
  render(<ProposalCard proposal={proposal} actions={actions()} />);
  const row = document.querySelector('.property-diff-row[data-state="changed"]')!;
  expect(row.querySelector("dt")?.textContent).toBe("Status");
  expect(row.querySelector(".property-diff-was")?.textContent).toBe("Open");
  expect(row.querySelector("dd")?.textContent).toContain("Done");
  // Fields the proposal never mentions are untouched, so they must not be shown as removed.
  expect(document.body.textContent).not.toContain("Due");
  // There is no text to edit, so the button that offers to must not be there.
  expect(screen.queryByText("Edit")).toBeNull();
});

it("shows a new card's fields under its body, where the body says nothing about them", () => {
  const proposal: Proposal = {
    ...PROPOSAL,
    id: "p_3",
    kind: "create",
    page_title: "Finish the app",
    old_text: null,
    new_text: "",
    new_path: "Todos/Board/Finish the app",
    summary: "First card",
    properties: [{ ...STATUS, value: "Open" }],
  };
  render(<ProposalCard proposal={proposal} actions={actions()} />);
  const row = document.querySelector('.property-diff-row[data-state="added"]')!;
  expect(row.textContent).toContain("Status");
  expect(row.textContent).toContain("Open");
});

it("decides from the collapsed row in quick mode; rejecting opens the card for a reason", async () => {
  const acts = actions();
  render(<ProposalCard proposal={PROPOSAL} actions={acts} collapsible defaultOpen={false} quick />);
  expect(screen.queryByLabelText("Changes")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Accept" }));
  await waitFor(() => expect(acts.accept).toHaveBeenCalledWith("p_1"));
  fireEvent.click(screen.getByRole("button", { name: "Reject" }));
  expect(screen.getByLabelText("Reason for rejecting")).toBeTruthy();
});
