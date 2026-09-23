import { afterEach, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { TaskProgress, lastLines } from "../TaskProgress";

afterEach(cleanup);
const STEPS = [
  {
    id: "t1",
    round: 1,
    kind: "thinking",
    name: "Thinking",
    status: "succeeded",
    text: "Inspect the page.",
  },
  { id: "read", round: 1, kind: "tool", name: "read_page", status: "succeeded", text: "Todos" },
  {
    id: "t2",
    round: 2,
    kind: "thinking",
    name: "Thinking",
    status: "succeeded",
    text: "Add the requested view.",
  },
  {
    id: "edit",
    round: 2,
    kind: "tool",
    name: "propose_append",
    status: "failed",
    text: "The page changed.",
  },
  { id: "search", round: 2, kind: "tool", name: "search_vault", status: "running", text: "views" },
] as const;

it("lists finished steps as one-liners and opens a thought to its full text", () => {
  render(<TaskProgress steps={[...STEPS]} hideRunning />);
  const rows = [...document.querySelectorAll(".ai-step")].map(
    (row) => row.querySelector("summary")?.textContent ?? row.textContent,
  );
  // The running search is left to the live line.
  expect(rows).toEqual([
    "Thought",
    "✓ReadTodos",
    "Thought",
    "!Proposed an additionThe page changed.",
  ]);
  expect(screen.getByText("Todos").closest(".ai-step")?.textContent).toContain("Read");
  expect(
    screen.getByText("The page changed.").closest(".ai-step")?.getAttribute("data-status"),
  ).toBe("failed");
  const thought = screen.getAllByText("Thought")[1].closest("details") as HTMLDetailsElement;
  expect(thought.open).toBe(false);
  fireEvent.click(thought.querySelector("summary") as HTMLElement);
  expect(thought.textContent).toContain("Add the requested view.");
});

it("keeps the tail of a running thought on one line", () => {
  expect(lastLines("One.\n\nTwo   words\n  three  ")).toBe("Two words three");
});
