import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MediaContext } from "../media/context";
import type { GraiteEditor } from "../schema";
import { TableViewBody } from "./TableViewBody";

const table = (name: string) => ({
  path: `Clients/_data/${name}.csv`,
  page_path: "Clients",
  name,
  hash: "h",
  row_count: 1,
  primary_key: "id",
  display: null,
  columns: [
    { name: "id", type: "text", invalid: 0, wrap: false },
    { name: "name", type: "text", invalid: 0, wrap: false },
  ],
  warnings: [],
});
const api = vi.hoisted(() => ({
  resolve: vi.fn(async () => ({ path: "Clients/_data/companies.csv" })),
  list: vi.fn(),
  rows: vi.fn(),
}));
vi.mock("@/lib/tables", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tables")>()),
  describeWarning: (w: string) => w,
  tables: api,
}));
vi.mock("./TableGrid", () => ({
  emptySelection: () => ({ columns: { toArray: () => [] }, rows: { toArray: () => [] } }),
  TableGrid: () => <div data-testid="grid" />,
}));
vi.mock("@/review/useProposals", () => ({ useProposals: () => ({ proposals: [] }) }));

afterEach(cleanup);

const OLDER = {
  views: "",
  source: "_data/companies.csv",
  view: "",
  filter: 'name = "Acme"',
  sort: "name desc",
  columns: "",
  height: 0,
  embed: false,
  tabs: JSON.stringify({ "_data/projects.csv": { sort: ["-title"], columns: ["title"] } }),
};

function show(props: typeof OLDER, updateBlock = vi.fn()) {
  render(
    <MediaContext.Provider value={{ pageId: "p", pagePath: "Clients", onTreeChanged: () => {} }}>
      <TableViewBody id="b" props={props} editor={{ updateBlock } as unknown as GraiteEditor} />
    </MediaContext.Provider>,
  );
  return updateBlock;
}

it("shows an older block as one view of its table, and writes views on the first change", async () => {
  api.list.mockResolvedValue([table("companies"), table("projects")]);
  api.rows.mockResolvedValue({
    ...table("companies"),
    visible: ["id", "name"],
    total: 1,
    offset: 0,
    rows: [{ id: "a", cells: ["a", "Acme"] }],
  });
  const updateBlock = show(OLDER);
  // One database per block (D82): no tabs for the folder's other tables.
  expect(await screen.findByRole("tab", { name: /Table/ })).toBeTruthy();
  expect(screen.queryByRole("tab", { name: /projects/ })).toBeNull();
  expect(updateBlock).not.toHaveBeenCalled();

  fireEvent.click(screen.getByRole("button", { name: "Sort" }));
  fireEvent.click(screen.getByRole("radio", { name: /Ascending/ }));
  expect(updateBlock).toHaveBeenCalledWith("b", {
    type: "tableView",
    props: {
      views: JSON.stringify([
        { name: "Table", source: "_data/companies.csv", filter: 'name = "Acme"', sort: "name asc" },
      ]),
      source: "",
      view: "",
      filter: "",
      sort: "",
      columns: "",
      tabs: "",
      embed: false,
    },
  });
});

it("links to another database from the Fields menu, named after it", async () => {
  api.list.mockResolvedValue([table("companies"), table("projects")]);
  api.rows.mockResolvedValue({
    ...table("projects"),
    visible: ["id", "name"],
    total: 1,
    offset: 0,
    rows: [{ id: "p", cells: ["p", "Site"] }],
  });
  api.resolve.mockResolvedValue({ path: "Clients/_data/projects.csv" });
  const addRelation = vi.fn(async () => table("projects"));
  (api as Record<string, unknown>).addRelation = addRelation;
  show({ ...OLDER, source: "_data/projects.csv", filter: "", sort: "", tabs: "" });
  fireEvent.click(await screen.findByRole("button", { name: "Shown fields" }));
  fireEvent.click(screen.getByText("Link to another database"));
  // This page's databases come first.
  expect(await screen.findByText("On this page")).toBeTruthy();
  fireEvent.click(await screen.findByRole("option", { name: /companies/ }));
  fireEvent.click(screen.getByRole("button", { name: "Create field" }));
  await vi.waitFor(() =>
    expect(addRelation).toHaveBeenCalledWith(
      "Clients/_data/projects.csv",
      "companies",
      "Clients/_data/companies.csv",
      "many",
      "projects",
    ),
  );
});
