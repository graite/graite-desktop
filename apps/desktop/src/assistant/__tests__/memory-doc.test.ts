import { expect, it } from "vitest";
import {
  addItem,
  editItem,
  entryText,
  lastEntries,
  parseMemory,
  removeItem,
  serializeMemory,
  PROFILE_SECTIONS,
} from "../memoryDoc";

const SEEDED = PROFILE_SECTIONS.map((s) => `## ${s}`).join("\n\n") + "\n";

it("reads sections of bullets and writes them back unchanged", () => {
  const body =
    "## About\n\n- Name: Sam.\n- Lives in Lisbon.\n\n## Preferences\n\n- Tea over coffee.\n\n## People\n";
  const sections = parseMemory(body);
  expect(sections.map((s) => [s.title, s.entries.map(entryText)])).toEqual([
    [null, []],
    ["About", ["Name: Sam.", "Lives in Lisbon."]],
    ["Preferences", ["Tea over coffee."]],
    ["People", []],
  ]);
  expect(serializeMemory(sections)).toBe(body);
  expect(serializeMemory(parseMemory(SEEDED))).toBe(SEEDED);
});

it("pulls a spread-out list with empty-paragraph markers back into one tight list", () => {
  const playbook = "- First lesson.\n\n\n<!-- graite:empty -->\n\n- Second lesson.\n";
  const sections = parseMemory(playbook);
  expect(sections[0]!.entries.map(entryText)).toEqual(["First lesson.", "Second lesson."]);
  expect(serializeMemory(sections)).toBe("- First lesson.\n- Second lesson.\n");
});

it("keeps what is not a plain bullet verbatim: paragraphs, nested items, code", () => {
  const body =
    "Intro line\nsecond line.\n\n- Parent\n  - Child\n- [x] Done\n\n```\na\n\n\nb\n```\n\n## Other\n\nFree text.\n";
  const sections = parseMemory(body);
  expect(sections[0]!.entries.map((e) => e.kind)).toEqual(["block", "item", "item", "block"]);
  expect(serializeMemory(sections)).toBe(body);
  // Editing a fact leaves its nested items and every other block alone.
  const edited = serializeMemory(editItem(sections, 0, 1, "Parent, renamed"));
  expect(edited).toBe(body.replace("- Parent\n", "- Parent, renamed\n"));
});

it("edits, deletes and adds facts", () => {
  let sections = parseMemory(SEEDED);
  sections = addItem(sections, "People", "Anna is my  sister.\n");
  sections = addItem(sections, "People", "Tom is a colleague.");
  sections = addItem(sections, "About", "Name: Sam.");
  expect(serializeMemory(sections)).toBe(
    SEEDED.replace("## About\n", "## About\n\n- Name: Sam.\n").replace(
      "## People\n",
      "## People\n\n- Anna is my sister.\n- Tom is a colleague.\n",
    ),
  );
  const people = sections.findIndex((s) => s.title === "People");
  sections = editItem(sections, people, 0, "Anna is my older sister.");
  sections = removeItem(sections, people, 1);
  expect(sections[people]!.entries.map(entryText)).toEqual(["Anna is my older sister."]);
  // An emptied edit deletes; blank additions are ignored; the input was never mutated.
  expect(editItem(sections, people, 0, "  ")[people]!.entries).toEqual([]);
  expect(addItem(sections, "People", "   ")).toBe(sections);
  expect(sections[people]!.entries).toHaveLength(1);
});

it("creates a missing Profile section in its place, and adds to a flat list", () => {
  const flat = parseMemory("- Name: Sam.\n- The user goes by Sam.\n");
  expect(serializeMemory(addItem(flat, null, "Likes tea."))).toBe(
    "- Name: Sam.\n- The user goes by Sam.\n- Likes tea.\n",
  );
  const partial = parseMemory("## About\n\n- Sam.\n\n## Other\n\n- Misc.\n");
  expect(serializeMemory(addItem(partial, "Routines", "Runs on Sundays."))).toBe(
    "## About\n\n- Sam.\n\n## Routines\n\n- Runs on Sundays.\n\n## Other\n\n- Misc.\n",
  );
  expect(serializeMemory(addItem(parseMemory(""), "Custom", "x"))).toBe("## Custom\n\n- x\n");
});

it("gives the newest Journal entries", () => {
  const journal = parseMemory(
    "- 2026-09-01: a\n- 2026-09-02: b\n\n2026-09-03: c\n- 2026-09-04: d\n",
  );
  expect(lastEntries(journal, 2).map(entryText)).toEqual(["2026-09-03: c", "2026-09-04: d"]);
});
