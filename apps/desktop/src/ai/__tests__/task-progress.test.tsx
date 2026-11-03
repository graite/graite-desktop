import { afterEach, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { TaskProgress, lastLines, summarize } from "../TaskProgress";

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

it("shows every finished step on one line and lists them when clicked", () => {
  render(<TaskProgress steps={[...STEPS]} hideRunning />);
  const line = screen.getByRole("button", { name: /Read Todos/ });
  // The running search is left to the live line; thoughts are not on the summary.
  expect(line.textContent).toBe("✓Read Todos · Proposed an addition! 1 failed›");
  expect(line.getAttribute("aria-expanded")).toBe("false");
  expect(document.querySelectorAll(".ai-task-tool")).toHaveLength(0);
  fireEvent.click(line);
  const rows = [...document.querySelectorAll(".ai-task-steps > .ai-step")].map(
    (row) => row.querySelector("summary")?.textContent ?? row.textContent,
  );
  expect(rows).toEqual([
    "Thought",
    "✓ReadTodos",
    "Thought",
    "!Proposed an additionThe page changed.",
  ]);
  expect(
    screen.getByText("The page changed.").closest(".ai-step")?.getAttribute("data-status"),
  ).toBe("failed");
  const thought = screen.getAllByText("Thought")[1].closest("details") as HTMLDetailsElement;
  expect(thought.open).toBe(false);
  fireEvent.click(thought.querySelector("summary") as HTMLElement);
  expect(thought.textContent).toContain("Add the requested view.");
});

it("counts repeated tools and puts the live step at the end of the same line", () => {
  const steps = [
    { id: "a", round: 1, kind: "tool", name: "read_tables", status: "succeeded", text: "CRM" },
    { id: "b", round: 1, kind: "tool", name: "read_tables", status: "succeeded", text: "Deals" },
    { id: "c", round: 2, kind: "tool", name: "run_query_ro", status: "succeeded", text: "" },
  ] as const;
  expect(summarize([...steps])).toBe("Read tables 2× · Queried tables");
  render(<TaskProgress steps={[...steps]} hideRunning live="Reading rows · companies" />);
  expect(document.querySelectorAll(".ai-task-progress")).toHaveLength(1);
  expect(screen.getByRole("button").textContent).toContain(
    "Read tables 2× · Queried tables · Reading rows · companies",
  );
});

it("shows only the live line before any step finished", () => {
  render(<TaskProgress steps={[]} live="Searching your pages…" />);
  expect(screen.getByRole("status").textContent).toBe("Searching your pages…");
});

it("keeps the tail of a running thought on one line", () => {
  expect(lastLines("One.\n\nTwo   words\n  three  ")).toBe("Two words three");
});
