import { afterEach, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { Proposal } from "@/lib/review";
import { RowsDiff } from "../RowsDiff";

afterEach(cleanup);

type Rows = NonNullable<Proposal["rows"]>;
const LONG = "A long note that goes on for a while. ".repeat(6).trim();

const ROWS: Rows = {
  table: "Projects/Atlas/_data/expenses.csv",
  applied: false,
  columns: {
    amount: { type: "currency", currency: "EUR", options: [], colors: {} },
    category: {
      type: "single_select",
      options: ["Travel", "Food"],
      colors: { Travel: "blue" },
    },
    note: { type: "text", options: [], colors: {} },
    description: { type: "text", options: [], colors: {} },
  },
  ops: [
    {
      op: "insert",
      label: "Taxi",
      values: { description: "Taxi", amount: 30, category: "Travel", note: "" },
    },
    {
      op: "update",
      id: "2",
      label: "Lunch",
      values: { amount: 14, note: LONG },
      base: { amount: 12, note: "short" },
    },
    { op: "delete", id: "1", label: "Train", values: {}, base: { description: "Train" } },
    { op: "delete", id: "7", values: {} },
    { op: "insert", label: "Coffee", values: { amount: 3 } },
  ],
};

it("lists each row by name with only what changes", () => {
  render(<RowsDiff rows={ROWS} showTable />);
  const list = screen.getByLabelText("Changes to expenses");
  expect(list.querySelector(".rows-change-table")?.textContent).toBe("expenses · Atlas");
  expect(list.querySelector(".rows-change-counts")?.textContent).toBe(
    "2 new · 1 edited · 2 deleted",
  );
  const entries = list.querySelectorAll(".rows-change");
  expect(entries).toHaveLength(4); // the fifth waits behind "Show all"
  const [taxi, lunch, train, unnamed] = entries;
  // A new row shows its filled fields: money formatted, a select as a pill, no empty note.
  expect(taxi?.querySelector(".rows-change-label")?.textContent).toBe("Taxi");
  expect(taxi?.textContent).toMatch(/€\s?30[.,]00|30[.,]00\s?€/);
  expect(taxi?.querySelector(".property-tag")?.textContent).toBe("Travel");
  expect(taxi?.textContent).not.toContain("note");
  // An edit shows old → new; long text is stacked and clamped, with its own "More".
  expect(lunch?.querySelector(".rows-change-was")?.textContent).toMatch(/12/);
  const stacked = lunch?.querySelector(".rows-change-stacked");
  expect(stacked?.querySelector("[data-was]")?.textContent).toContain("short");
  fireEvent.click(screen.getByRole("button", { name: "More" }));
  expect(screen.getByRole("button", { name: "Less" })).toBeTruthy();
  // A deleted row is its name only; one without a label falls back to its id.
  expect(train?.querySelector(".rows-change-fields")).toBeNull();
  expect(unnamed?.querySelector(".rows-change-label")?.textContent).toBe("Row 7");
  fireEvent.click(screen.getByRole("button", { name: "Show all 5 changes" }));
  expect(list.querySelectorAll(".rows-change")).toHaveLength(5);
});

it("works for proposals made before rows had names and column types", () => {
  const old: Rows = {
    table: "A/_data/t.csv",
    applied: false,
    ops: [{ op: "update", id: "9", values: { v: "b" }, base: { v: "a" } }],
  };
  render(<RowsDiff rows={old} />);
  expect(screen.getByText("Row 9")).toBeTruthy();
  expect(screen.getByText("a").className).toContain("rows-change-was");
});
