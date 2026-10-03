import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { RelationPicker } from "./relations";

const rows = vi.hoisted(() => vi.fn());
vi.mock("@/lib/tables", () => ({ tables: { rows } }));

afterEach(cleanup);

it("searches the target table and picks rows by id, showing the detail field", async () => {
  rows.mockResolvedValue({
    visible: ["id", "name", "city"],
    label_column: "name",
    secondary_column: "city",
    rows: [
      { id: "c1", cells: ["c1", "Acme", "Utrecht"] },
      { id: "c2", cells: ["c2", "Acme", "Delft"] },
    ],
  });
  const onChange = vi.fn();
  render(
    <RelationPicker
      target="Clients/_data/companies.csv"
      selected={[{ id: "c1", label: "Acme" }]}
      single={false}
      onChange={onChange}
    />,
  );
  // Two rows named alike: the detail field tells them apart.
  expect(await screen.findByText("Delft")).toBeTruthy();
  fireEvent.click(screen.getByText("Delft"));
  expect(onChange).toHaveBeenLastCalledWith(
    [
      { id: "c1", label: "Acme" },
      { id: "c2", label: "Acme", secondary: "Delft" },
    ],
    false,
  );
  fireEvent.click(screen.getByRole("button", { name: "Remove Acme" }));
  expect(onChange).toHaveBeenLastCalledWith([], false);
});

it("replaces the link and closes when the relation holds one row", async () => {
  rows.mockResolvedValue({
    visible: ["id", "name"],
    label_column: "name",
    secondary_column: null,
    rows: [{ id: "c2", cells: ["c2", "Beta"] }],
  });
  const onChange = vi.fn();
  render(
    <RelationPicker
      target="Clients/_data/companies.csv"
      selected={[{ id: "c1", label: "Acme" }]}
      single
      onChange={onChange}
    />,
  );
  fireEvent.click(await screen.findByText("Beta"));
  expect(onChange).toHaveBeenCalledWith([{ id: "c2", label: "Beta" }], true);
});
