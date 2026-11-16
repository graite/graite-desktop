import { describe, expect, it } from "vitest";
import { formatIcon, lucideComponentName, parseIcon } from "./pageIcon";

describe("page icon values", () => {
  it("reads an emoji as itself", () => {
    expect(parseIcon("🏦")).toEqual({ kind: "emoji", value: "🏦" });
    expect(parseIcon(null)).toBeNull();
    expect(parseIcon("")).toBeNull();
  });

  it("reads an icon with and without a colour", () => {
    expect(parseIcon("lucide:file-text")).toEqual({
      kind: "lucide",
      name: "file-text",
      color: "default",
    });
    expect(parseIcon("lucide:star:blue")).toEqual({ kind: "lucide", name: "star", color: "blue" });
  });

  it("falls back to the default colour for one it does not know", () => {
    expect(parseIcon("lucide:star:neon")).toEqual({
      kind: "lucide",
      name: "star",
      color: "default",
    });
  });

  it("rejects a malformed icon name", () => {
    expect(parseIcon("lucide:")).toBeNull();
    expect(parseIcon("lucide:Not A Name")).toBeNull();
  });

  it("writes what it reads", () => {
    expect(formatIcon("star")).toBe("lucide:star");
    expect(formatIcon("star", "red")).toBe("lucide:star:red");
    expect(parseIcon(formatIcon("grid-2x2", "green"))).toEqual({
      kind: "lucide",
      name: "grid-2x2",
      color: "green",
    });
  });

  it("maps a name to its component", () => {
    expect(lucideComponentName("file-text")).toBe("FileText");
    expect(lucideComponentName("grid-2x2")).toBe("Grid2x2");
    expect(lucideComponentName("a-arrow-down")).toBe("AArrowDown");
  });
});
