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
vi.mock("@/lib/tables", () => ({
  describeWarning: (w: string) => w,
  isRelationLinks: () => false,
  sourceFor: (page: string, t: { path: string; page_path: string; name: string }) =>
    t.page_path === page ? `_data/${t.name}.csv` : t.path,
  tables: api,
}));
vi.mock("./TableGrid", () => ({
  emptySelection: () => ({ columns: { toArray: () => [] }, rows: { toArray: () => [] } }),
  TableGrid: () => <div data-testid="grid" />,
}));
vi.mock("@/review/useProposals", () => ({ useProposals: () => ({ proposals: [] }) }));

afterEach(cleanup);

it("shows the folder's tables as tabs and keeps each tab's view when switching", async () => {
  api.list.mockResolvedValue([table("companies"), table("projects")]);
  api.rows.mockResolvedValue({
    ...table("companies"),
    visible: ["id", "name"],
    total: 1,
    offset: 0,
    rows: [{ id: "a", cells: ["a", "Acme"] }],
  });
  const updateBlock = vi.fn();
  render(
    <MediaContext.Provider value={{ pageId: "p", pagePath: "Clients", onTreeChanged: () => {} }}>
      <TableViewBody
        id="b"
        props={{
          source: "_data/companies.csv",
          view: "",
          filter: 'name = "Acme"',
          sort: "name desc",
          columns: "",
          height: 0,
          embed: false,
          tabs: JSON.stringify({ "_data/projects.csv": { sort: ["-title"], columns: ["title"] } }),
        }}
        editor={{ updateBlock } as unknown as GraiteEditor}
      />
    </MediaContext.Provider>,
  );
  fireEvent.click(await screen.findByRole("tab", { name: "projects" }));
  expect(updateBlock).toHaveBeenCalledWith("b", {
    type: "tableView",
    props: {
      source: "_data/projects.csv",
      filter: "",
      sort: '["-title"]',
      columns: '["title"]',
      tabs: JSON.stringify({
        "_data/companies.csv": { filter: 'name = "Acme"', sort: "name desc" },
      }),
      embed: false,
    },
  });
});

it("keeps a new back-link field visible on a tab with a saved field list", async () => {
  api.list.mockResolvedValue([table("companies"), table("projects")]);
  api.rows.mockResolvedValue({
    ...table("projects"),
    visible: ["id", "name"],
    total: 1,
    offset: 0,
    rows: [{ id: "p", cells: ["p", "Site"] }],
  });
  api.resolve.mockResolvedValue({ path: "Clients/_data/projects.csv" });
  (api as Record<string, unknown>).addRelation = vi.fn(async () => table("projects"));
  const updateBlock = vi.fn();
  render(
    <MediaContext.Provider value={{ pageId: "p", pagePath: "Clients", onTreeChanged: () => {} }}>
      <TableViewBody
        id="b"
        props={{
          source: "_data/projects.csv",
          view: "",
          filter: "",
          sort: "",
          columns: "",
          height: 0,
          embed: false,
          tabs: JSON.stringify({ "_data/companies.csv": { columns: ["name"] } }),
        }}
        editor={{ updateBlock } as unknown as GraiteEditor}
      />
    </MediaContext.Provider>,
  );
  fireEvent.click(await screen.findByRole("button", { name: "Shown fields" }));
  fireEvent.click(screen.getByText("New field"));
  fireEvent.change(screen.getByLabelText("New field name"), { target: { value: "client" } });
  fireEvent.click(screen.getByRole("option", { name: "Relation" }));
  fireEvent.click(screen.getByRole("button", { name: "Next" }));
  fireEvent.click(await screen.findByRole("option", { name: /companies/ }));
  fireEvent.click(screen.getByRole("button", { name: "Create field" }));
  await vi.waitFor(() =>
    expect(updateBlock).toHaveBeenCalledWith("b", {
      type: "tableView",
      props: {
        tabs: JSON.stringify({ "_data/companies.csv": { columns: ["name", "projects"] } }),
      },
    }),
  );
});
