import { describe, expect, it } from "vitest";
import { closeTab, cycleTab, dropTabs, parseTabs, renameTabs, showInTab } from "../tabs";

describe("page tabs", () => {
  it("plain navigation reuses the tab of the page it came from", () => {
    expect(showInTab(["A", "B"], "C", "A", false)).toEqual(["C", "B"]);
  });

  it("a new tab is added at the end", () => {
    expect(showInTab(["A", "B"], "C", "A", true)).toEqual(["A", "B", "C"]);
    expect(showInTab([], "C", null, false)).toEqual(["C"]);
  });

  it("a page that already has a tab keeps it", () => {
    const tabs = ["A", "B"];
    expect(showInTab(tabs, "B", "A", true)).toBe(tabs);
  });

  it("closing the active tab activates the right neighbour, else the left", () => {
    expect(closeTab(["A", "B", "C"], "B", "B")).toEqual({ tabs: ["A", "C"], active: "C" });
    expect(closeTab(["A", "B"], "B", "B")).toEqual({ tabs: ["A"], active: "A" });
    expect(closeTab(["A"], "A", "A")).toEqual({ tabs: [], active: null });
  });

  it("closing another tab leaves the active one alone", () => {
    expect(closeTab(["A", "B"], "A", "B")).toEqual({ tabs: ["B"], active: "B" });
  });

  it("follows renames and moves, subpages included", () => {
    expect(renameTabs(["P", "P/Child", "Pq", "Other"], "P", "Q/P")).toEqual([
      "Q/P",
      "Q/P/Child",
      "Pq",
      "Other",
    ]);
  });

  it("drops the tabs of a trashed page and its subpages", () => {
    expect(dropTabs(["P", "P/Child", "Pq"], "P")).toEqual(["Pq"]);
  });

  it("cycles through the tabs in both directions", () => {
    expect(cycleTab(["A", "B", "C"], "C", 1)).toBe("A");
    expect(cycleTab(["A", "B", "C"], "A", -1)).toBe("C");
    expect(cycleTab([], null, 1)).toBeNull();
  });

  it("reads stored tabs defensively", () => {
    expect(parseTabs('["A", 3, "B"]')).toEqual(["A", "B"]);
    expect(parseTabs("not json")).toEqual([]);
    expect(parseTabs(null)).toEqual([]);
  });
});
