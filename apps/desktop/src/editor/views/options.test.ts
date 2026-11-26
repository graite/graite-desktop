import { expect, it } from "vitest";
import type { PageProperty } from "@/lib/workspace";
import { optionChanges, withOptionChanges } from "./options";

const status = (options: string[], value: PageProperty["value"] = null): PageProperty => ({
  id: "s",
  name: "Status",
  type: "status",
  options,
  colors: { Backlog: "gray" },
  value,
});

it("tells a removed option from a renamed one", () => {
  expect(optionChanges(status(["Backlog", "Todo"]), status(["Todo"]))).toEqual([
    { from: "Backlog", to: null },
  ]);
  expect(optionChanges(status(["Backlog", "Todo"]), status(["Later", "Todo"]))).toEqual([
    { from: "Backlog", to: "Later" },
  ]);
  expect(optionChanges(status(["Todo"]), status(["Todo", "Done"]))).toEqual([]);
});

it("removes the option on another page of the view and clears a value that used it", () => {
  const next = withOptionChanges([status(["Backlog", "Todo"], "Backlog")], "status", [
    { from: "Backlog", to: null },
  ]);
  expect(next?.[0]).toMatchObject({ options: ["Todo"], value: null, colors: {} });
});

it("renames the option and the values that used it", () => {
  const next = withOptionChanges([status(["Backlog", "Todo"], "Backlog")], "Status", [
    { from: "Backlog", to: "Later" },
  ]);
  expect(next?.[0]).toMatchObject({
    options: ["Later", "Todo"],
    value: "Later",
    colors: { Later: "gray" },
  });
});

it("leaves a page alone that never had the option", () => {
  const untouched = { ...status(["Todo"], "Todo"), colors: {} };
  expect(withOptionChanges([untouched], "Status", [{ from: "Backlog", to: null }])).toBeNull();
});
