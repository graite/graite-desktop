import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { Proposal } from "@/lib/review";
import { InlineProposalCard } from "../InlineProposalCard";
import { ProposalCard } from "../ProposalCard";
import { PatchView } from "../DiffView";

afterEach(cleanup);

const markdown =
  "## Launch plan\n\nA **bold** and *thoughtful* update.\n\n- First task\n- Second task\n\n1. Check\n2. Ship\n\n> A quote\n\n`code`\n\n| Owner | Status |\n| --- | --- |\n| Team | Ready |\n\n- [x] Prepared";
const proposal = {
  id: "p",
  kind: "append",
  status: "pending",
  page_path: "Plan",
  new_text: markdown,
  summary: "Add plan",
} as Proposal;
const actions = {
  accept: vi.fn(async () => {}),
  reject: vi.fn(async () => {}),
  revert: vi.fn(async () => {}),
  optIn: vi.fn(async () => {}),
};

it.each([ProposalCard, InlineProposalCard])(
  "renders Markdown in the %s preview and keeps edits formatted",
  (Card) => {
    const { container } = render(<Card proposal={proposal} actions={actions} />);
    expect(screen.getByRole("heading", { name: "Launch plan", level: 2 })).toBeTruthy();
    expect(container.querySelector("strong")?.textContent).toBe("bold");
    expect(container.querySelector("em")?.textContent).toBe("thoughtful");
    expect(container.querySelectorAll("li")).toHaveLength(5);
    expect(container.querySelector("blockquote")?.textContent).toContain("A quote");
    expect(container.querySelector("code")?.textContent).toBe("code");
    expect(screen.getByRole("table")).toBeTruthy();
    expect(screen.getByRole("checkbox").hasAttribute("disabled")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: /^Edit/ }));
    fireEvent.change(screen.getByLabelText("Proposed text"), {
      target: { value: "### Revised\n\n**Ready**" },
    });
    expect(screen.getByRole("heading", { name: "Revised", level: 3 })).toBeTruthy();
    expect(container.querySelector("strong")?.textContent).toBe("Ready");
  },
);

it.each([ProposalCard, InlineProposalCard])(
  "preserves Markdown structure on both sides of an edit in %s",
  (Card) => {
    const { container } = render(
      <Card
        actions={actions}
        proposal={{
          ...proposal,
          kind: "edit",
          old_text: "## **Old** plan\n\n- *Draft*",
          new_text: "### New plan\n\n1. **Ready**",
        }}
      />,
    );
    const before = container.querySelector('[data-kind="del"]')!;
    const after = container.querySelector('[data-kind="add"]')!;
    expect(before.querySelector("h2 strong")?.textContent).toBe("Old");
    expect(before.querySelector("ul li em")?.textContent).toBe("Draft");
    expect(after.querySelector("h3")?.textContent).toBe("New plan");
    expect(after.querySelector("ol li strong")?.textContent).toBe("Ready");
  },
);

it("formats patch-only deletions and keeps separated hunks distinct", () => {
  render(
    <PatchView
      patch={
        "--- a/Plan\n+++ b/Plan\n@@ -1,2 +0,0 @@\n-## Old heading\n-**Old content**\n@@ -10,1 +7,0 @@\n-*Another section*\n"
      }
    />,
  );
  expect(screen.getByRole("heading", { name: "Old heading" })).toBeTruthy();
  expect(screen.getAllByLabelText("Changes")).toHaveLength(2);
});

it("does not execute HTML or load remote images in generated Markdown", () => {
  const { container } = render(
    <InlineProposalCard
      actions={actions}
      proposal={{
        ...proposal,
        new_text:
          "<script>alert(1)</script>\n\n![External image](https://example.com/pixel.png)\n\n[Unsafe](javascript:alert(1))",
      }}
    />,
  );
  expect(container.querySelector("script, img, a")).toBeNull();
  expect(screen.getByText("External image")).toBeTruthy();
});
