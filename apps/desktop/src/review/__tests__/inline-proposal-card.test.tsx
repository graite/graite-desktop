import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { Proposal } from "@/lib/review";
import { InlineProposalCard } from "../InlineProposalCard";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const PROPOSAL = {
  id: "p_1",
  kind: "edit",
  page_path: "Plan",
  status: "pending",
  summary: "Fix the day",
  policy: "propose",
  old_text: "The meeting is on Tuesday.",
  new_text: "The meeting is on Wednesday.",
  created_at: "1",
} as Proposal;
const actions = () => ({
  accept: vi.fn(async () => {}),
  reject: vi.fn(async () => {}),
  revert: vi.fn(async () => {}),
  optIn: vi.fn(async () => {}),
});

it("shows before and after text and accepts an edited proposal", async () => {
  const act = actions();
  render(<InlineProposalCard proposal={PROPOSAL} actions={act} />);
  const changes = screen.getByLabelText("Changes");
  expect(changes.querySelector('[data-kind="del"]')?.textContent).toBe(PROPOSAL.old_text);
  expect(changes.querySelector('[data-kind="add"]')?.textContent).toBe(PROPOSAL.new_text);
  expect(changes.textContent).toContain("Removed");
  expect(changes.textContent).toContain("Added");

  fireEvent.click(screen.getByRole("button", { name: "Edit proposal" }));
  fireEvent.change(screen.getByLabelText("Proposed text"), {
    target: { value: "The meeting is on Friday." },
  });
  expect(screen.getByLabelText("Changes").querySelector('[data-kind="add"]')!.textContent).toBe(
    "The meeting is on Friday.",
  );
  fireEvent.click(screen.getByRole("button", { name: /Accept edited/ }));
  await waitFor(() => expect(act.accept).toHaveBeenCalledWith("p_1", "The meeting is on Friday."));
});

it("rejects with a reason and explains a conflict or a page-level change", async () => {
  const act = actions();
  const { rerender } = render(<InlineProposalCard proposal={PROPOSAL} actions={act} />);
  fireEvent.click(screen.getByRole("button", { name: "Reject proposal" }));
  fireEvent.change(screen.getByLabelText("Reason for rejecting"), {
    target: { value: "Keep Tuesday" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Reject" }));
  await waitFor(() => expect(act.reject).toHaveBeenCalledWith("p_1", "Keep Tuesday"));

  rerender(
    <InlineProposalCard
      proposal={{
        ...PROPOSAL,
        status: "conflict",
        reason: "the text to replace is no longer unique",
      }}
      actions={act}
    />,
  );
  expect(screen.getByRole("alert").textContent).toContain("no longer unique");
  rerender(
    <InlineProposalCard
      proposal={{
        ...PROPOSAL,
        kind: "move",
        old_text: null,
        new_text: null,
        new_path: "Archive/Plan",
      }}
      actions={act}
    />,
  );
  expect(screen.getByText("Move this page to Archive/Plan")).toBeTruthy();
  expect(screen.queryByLabelText("Changes")).toBeNull();
  expect(screen.queryByRole("button", { name: "Edit proposal" })).toBeNull();
});

it("expands and collapses long previews without changing what is accepted", async () => {
  vi.spyOn(Element.prototype, "scrollHeight", "get").mockReturnValue(450);
  const act = actions();
  const text = "A detailed proposed paragraph.\n".repeat(24);
  const { container } = render(
    <InlineProposalCard proposal={{ ...PROPOSAL, new_text: text }} actions={act} />,
  );
  const more = screen.getByRole("button", { name: "Read more" });
  expect(more.getAttribute("aria-expanded")).toBe("false");
  expect(container.querySelector("[data-truncated]")).toBeTruthy();
  fireEvent.click(more);
  expect(screen.getByRole("button", { name: "Read less" }).getAttribute("aria-expanded")).toBe(
    "true",
  );
  expect(container.querySelector("[data-truncated]")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Read less" }));
  expect(container.querySelector("[data-truncated]")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Accept" }));
  await waitFor(() => expect(act.accept).toHaveBeenCalledWith("p_1", undefined));
  const proposed = screen.getByLabelText("Changes").querySelector('[data-kind="add"]')!.textContent;
  expect(proposed).toBe(text.trimEnd());
});

it("shows the complete diff while editing and leaves short previews uncollapsed", () => {
  const height = vi.spyOn(Element.prototype, "scrollHeight", "get").mockReturnValue(80);
  const { rerender, container } = render(
    <InlineProposalCard proposal={PROPOSAL} actions={actions()} />,
  );
  expect(screen.queryByRole("button", { name: "Read more" })).toBeNull();
  height.mockReturnValue(280);
  rerender(<InlineProposalCard proposal={{ ...PROPOSAL }} actions={actions()} />);
  expect(screen.queryByRole("button", { name: "Read more" })).toBeNull();
  height.mockReturnValue(400);
  rerender(
    <InlineProposalCard
      proposal={{ ...PROPOSAL, new_text: "Long paragraph. ".repeat(100) }}
      actions={actions()}
    />,
  );
  expect(screen.getByRole("button", { name: "Read more" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Edit proposal" }));
  expect(container.querySelector("[data-truncated]")).toBeNull();
  expect(screen.queryByRole("button", { name: "Read more" })).toBeNull();
});
