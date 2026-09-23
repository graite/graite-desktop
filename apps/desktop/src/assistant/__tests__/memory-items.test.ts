import { expect, it } from "vitest";
import type { MemoryItem } from "@/lib/assistant";
import type { PageProperty } from "@/lib/workspace";
import { groupMemories, matches, recalledLabel, withMemoryFields } from "../memoryItems";

const item = (title: string, extra: Partial<MemoryItem> = {}): MemoryItem => ({
  path: `Ada/Memories/${title}`,
  title,
  body: "",
  kind: null,
  pinned: false,
  last_recalled: null,
  ...extra,
});

it("groups by kind in a fixed order, pinned first, and filters on every word", () => {
  const items = [
    item("Likes tea", { kind: "Preference" }),
    item("Goes by Sam", { kind: "About", pinned: true }),
    item("Answer once", { kind: "Lesson", body: "Duplicated messages\nget one answer." }),
    item("Anna is my sister", { kind: "Person", pinned: false }),
    item("Loose note"),
    item("Prefers mornings", { kind: "Preference", pinned: true }),
  ];
  const groups = groupMemories(items);
  expect(groups.map((g) => g.kind)).toEqual(["About", "Preference", "Person", "Lesson", "No kind"]);
  expect(groups[1]!.items.map((i) => i.title)).toEqual(["Prefers mornings", "Likes tea"]);
  expect(
    groupMemories(items, "duplicated ANSWER").flatMap((g) => g.items.map((i) => i.title)),
  ).toEqual(["Answer once"]);
  expect(matches(items[0]!, "tea preference")).toBe(true);
  expect(groupMemories(items, "coffee")).toEqual([]);
});

it("sets Kind and Pinned on a page, adding the fields when missing", () => {
  const none: PageProperty[] = [];
  const added = withMemoryFields(none, { kind: "Person", pinned: true });
  expect(added.map((p) => [p.name, p.type, p.value])).toEqual([
    ["Kind", "single_select", "Person"],
    ["Pinned", "checkbox", true],
  ]);
  expect(added[0]!.options).toContain("Lesson");
  const changed = withMemoryFields(added, { pinned: false });
  expect(changed.find((p) => p.name === "Pinned")!.value).toBe(false);
  expect(changed.find((p) => p.name === "Kind")!.value).toBe("Person");
  expect(added.find((p) => p.name === "Pinned")!.value).toBe(true); // not mutated
});

it("says when a memory last came up", () => {
  const now = new Date("2026-09-23T12:00:00Z");
  expect(recalledLabel(null, now)).toBe("Not recalled yet");
  expect(recalledLabel("2026-09-23", now)).toBe("Recalled today");
  expect(recalledLabel("2026-09-22", now)).toBe("Recalled yesterday");
  expect(recalledLabel("2026-09-13", now)).toBe("Recalled 10 days ago");
});
