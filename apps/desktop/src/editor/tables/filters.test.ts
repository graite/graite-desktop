import { expect, it } from "vitest";
import { filterToRules, rulesToFilter } from "./filters";

const numeric = (f: string) => f === "amount";

it("writes rules as the readable filter language", () => {
  expect(
    rulesToFilter(
      [
        { field: "category", op: "equals", value: "Travel" },
        { field: "amount", op: "gt", value: "100" },
        { field: "Project name", op: "contains", value: 'say "hi"' },
        { field: "due", op: "empty", value: "" },
        { field: "note", op: "equals", value: "" },
      ],
      numeric,
    ),
  ).toBe(
    'category = "Travel" and amount > 100 and `Project name` contains "say \\"hi\\"" and due is empty',
  );
});

it("reads simple filters back into the same rules", () => {
  const text =
    'category = "Travel" and amount > 100 and `Project name` contains x and done is not empty';
  const rules = filterToRules(text)!;
  expect(rules).toEqual([
    { field: "category", op: "equals", value: "Travel" },
    { field: "amount", op: "gt", value: "100" },
    { field: "Project name", op: "contains", value: "x" },
    { field: "done", op: "filled", value: "" },
  ]);
  expect(filterToRules(rulesToFilter(rules, numeric))).toEqual(rules);
  expect(filterToRules("status != 'In progress'")).toEqual([
    { field: "status", op: "not", value: "In progress" },
  ]);
  expect(filterToRules('name = "a and b"')).toEqual([
    { field: "name", op: "equals", value: "a and b" },
  ]);
});

it("leaves anything richer to the custom filter", () => {
  for (const text of [
    "a = 1 or b = 2",
    "not (a = 1)",
    "status in [a, b]",
    "amount >= 3",
    "a = 1 and",
    'a = "open',
  ])
    expect(filterToRules(text)).toBeNull();
  expect(filterToRules("")).toEqual([]);
});
