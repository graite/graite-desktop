import { expect, it } from "vitest";
import { viewsAfterField, type TableViewDef } from "./views";

const views: TableViewDef[] = [
  {
    name: "Table",
    source: "_data/Backlog.csv",
    columns: ["name", "notes"],
    sort: "notes desc",
    filter: 'notes = "x"',
  },
  { name: "Board", source: "_data/Backlog.csv", view: "board", group: "notes", show: ["notes"] },
  { name: "Other", source: "_data/other.csv", columns: ["notes"] },
];

it("renames a field in every view of its table and drops a filter that named it", () => {
  const [table, board, other] = viewsAfterField(views, "_data/Backlog.csv", "notes", "Details");
  expect(table).toMatchObject({ columns: ["name", "Details"], sort: "Details desc" });
  expect(table!.filter).toBeUndefined();
  expect(board).toMatchObject({ group: "Details", show: ["Details"] });
  expect(other).toEqual(views[2]);
});

it("takes a deleted field out of the lists, the sort and the board's group", () => {
  const [table, board] = viewsAfterField(views, "_data/Backlog.csv", "notes", null);
  expect(table!.columns).toEqual(["name"]);
  expect(table!.sort).toBeUndefined();
  expect(board!.group).toBeUndefined();
  expect(board!.show).toEqual([]);
});
