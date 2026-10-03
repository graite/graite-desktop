import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { RelationSetup } from "./RelationSetup";

const list = vi.hoisted(() => vi.fn());
vi.mock("@/lib/tables", () => ({ tables: { list } }));

afterEach(cleanup);

const table = (name: string, columns: string[]) => ({
  path: `Clients/_data/${name}.csv`,
  page_path: "Clients",
  name,
  row_count: 2,
  columns: columns.map((c) => ({ name: c, type: "text" })),
});

it("picks a table, then the options, and checks the back-link name", async () => {
  list.mockResolvedValue([table("companies", ["id", "name"]), table("projects", ["id"])]);
  const onSubmit = vi.fn();
  render(
    <RelationSetup
      table={{ path: "Clients/_data/projects.csv", name: "projects" }}
      submit="Create field"
      onSubmit={onSubmit}
      onCancel={() => {}}
    />,
  );
  fireEvent.click(await screen.findByRole("option", { name: /companies/ }));
  fireEvent.click(screen.getByRole("switch", { name: "Link to several rows" }));
  expect(screen.getByText(/links to one row in companies/)).toBeTruthy();
  fireEvent.change(screen.getByLabelText("Field name on companies"), {
    target: { value: "name" },
  });
  expect(screen.getByText(/already has a field named/)).toBeTruthy();
  expect((screen.getByRole("button", { name: "Create field" }) as HTMLButtonElement).disabled).toBe(
    true,
  );
  fireEvent.change(screen.getByLabelText("Field name on companies"), {
    target: { value: "projects" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Create field" }));
  expect(onSubmit).toHaveBeenCalledWith({
    target: "Clients/_data/companies.csv",
    cardinality: "one",
    reverse: "projects",
  });
});
