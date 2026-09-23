import { expect, it } from "vitest";
import type { PageDoc } from "@/lib/api";
import { projectRows, moveName } from "./settings";
import { visibleFields } from "./collection";
import type { PageProperty } from "@/lib/workspace";
const row = (title: string, value: number | null): PageDoc => ({
  id: title,
  title,
  path: title,
  icon: null,
  hash: "",
  body: "",
  frontmatter: { properties: [{ id: "n", name: "Estimate", type: "number", value, options: [] }] },
});
const rows = [row("Ten", 10), row("Two", 2), row("Empty", null)];
it("sorts numeric properties numerically, with empty values last in both directions", () => {
  expect(
    projectRows(rows, "", { sort: { field: "Estimate", direction: "asc" } }, true).map(
      (r) => r.title,
    ),
  ).toEqual(["Two", "Ten", "Empty"]);
  expect(
    projectRows(rows, "", { sort: { field: "Estimate", direction: "desc" } }, true).map(
      (r) => r.title,
    ),
  ).toEqual(["Ten", "Two", "Empty"]);
  expect(rows.map((r) => r.title)).toEqual(["Ten", "Two", "Empty"]);
});
it("combines case-insensitive search with property filters and handles empty values", () => {
  expect(
    projectRows(rows, "T", { filters: [{ field: "Estimate", op: "gt", value: "5" }] }, false).map(
      (r) => r.title,
    ),
  ).toEqual(["Ten"]);
  expect(
    projectRows(rows, "", { filters: [{ field: "Estimate", op: "empty", value: "" }] }, false).map(
      (r) => r.title,
    ),
  ).toEqual(["Empty"]);
});
it("keeps explicit property order and can move columns both directions", () => {
  const fields = [
    { id: "a", name: "A" },
    { id: "b", name: "B" },
  ] as PageProperty[];
  expect(visibleFields(fields, '{"table":["B","A"]}', "table").map((f) => f.name)).toEqual([
    "B",
    "A",
  ]);
  expect(moveName(["a", "b", "c"], "a", "c")).toEqual(["b", "c", "a"]);
  expect(moveName(["a", "b", "c"], "c", "a")).toEqual(["c", "a", "b"]);
});
