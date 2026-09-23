import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { canonical, fromBlocks, toBlocks, toBlocksWithSpans } from "./index";

const fixturesDir = join(import.meta.dirname, "..", "fixtures");
const blocksDir = join(fixturesDir, "blocks");

function read(dir: string, name: string): string {
  return readFileSync(join(dir, name), "utf8");
}

describe("toBlocks / fromBlocks", () => {
  for (const name of readdirSync(blocksDir).filter((f) => f.endsWith(".md"))) {
    it(`round-trips ${name}`, () => {
      const md = read(blocksDir, name);
      const blocks = toBlocks(md);
      expect(fromBlocks(blocks)).toBe(canonical(md));
      // A second pass through the editor shape must be stable too.
      expect(fromBlocks(toBlocks(fromBlocks(blocks)))).toBe(canonical(md));
    });
  }

  it("matches the snapshot for fixtures/basic.md", () => {
    expect(toBlocks(read(fixturesDir, "basic.md"))).toMatchSnapshot();
  });

  it("maps every construct to the intended block type", () => {
    const types = (md: string) => toBlocks(md).map((b) => b.type);
    expect(types(read(blocksDir, "headings.md"))).toEqual([
      "heading",
      "heading",
      "heading",
      "heading",
      "heading",
      "heading",
      "paragraph",
    ]);
    expect(types(read(blocksDir, "lists.md"))).toEqual([
      "bulletListItem",
      "bulletListItem",
      "bulletListItem",
      "paragraph",
      "numberedListItem",
      "numberedListItem",
      "numberedListItem",
      "paragraph",
      "numberedListItem",
      "numberedListItem",
      "paragraph",
      "checkListItem",
      "checkListItem",
      "bulletListItem",
    ]);
    expect(types(read(blocksDir, "page-link.md"))).toEqual([
      "paragraph",
      "pageLink",
      "pageLink",
      "paragraph",
    ]);
    expect(types(read(blocksDir, "raw.md"))).toEqual([
      "rawMarkdown",
      "rawMarkdown",
      "rawMarkdown",
      "rawMarkdown",
      "rawMarkdown",
      "rawMarkdown",
      "rawMarkdown",
    ]);
    expect(types(read(blocksDir, "image.md"))).toEqual(["image", "image", "rawMarkdown"]);
    expect(types(read(blocksDir, "divider.md"))).toEqual(["paragraph", "divider", "paragraph"]);
  });

  it("keeps heading levels 1-6 and nests list children", () => {
    const [h6] = toBlocks("###### six");
    expect(h6).toMatchObject({ type: "heading", props: { level: 6 } });
    const [item] = toBlocks("- a\n  - b\n    - c");
    expect(item).toMatchObject({
      type: "bulletListItem",
      content: [{ type: "text", text: "a" }],
      children: [{ type: "bulletListItem", children: [{ type: "bulletListItem" }] }],
    });
  });

  it("serializes wikilinks with and without alias", () => {
    expect(canonical("[[A]] and [[A|b]] and [[A|A]]\n")).toBe("[[A]] and [[A|b]] and [[A]]\n");
    expect(fromBlocks(toBlocks("[[A|b]] x"))).toBe("[[A|b]] x\n");
  });

  it("produces the documented shapes for page links, wikilinks and tables", () => {
    const [link] = toBlocks("[[Child]]");
    expect(link).toEqual({
      type: "pageLink",
      props: { path: "", title: "Child", icon: "", target: "Child" },
      children: [],
    });
    const [para] = toBlocks("see [[Target|Alias]] and [[Plain]]");
    expect(para).toMatchObject({
      type: "paragraph",
      content: [
        { type: "text", text: "see " },
        { type: "wikilink", props: { target: "Target", alias: "Alias" } },
        { type: "text", text: " and " },
        { type: "wikilink", props: { target: "Plain", alias: "" } },
      ],
    });
    const [table] = toBlocks("| a | b |\n| - | - |\n| 1 | 2 |");
    expect(table).toMatchObject({
      type: "table",
      content: {
        type: "tableContent",
        rows: [
          { cells: [[{ text: "a" }], [{ text: "b" }]] },
          { cells: [[{ text: "1" }], [{ text: "2" }]] },
        ],
      },
    });
    const [code] = toBlocks("```ts\nlet x = 1;\n```");
    expect(code).toEqual({
      type: "codeBlock",
      props: { language: "ts" },
      content: [{ type: "text", text: "let x = 1;", styles: {} }],
      children: [],
    });
    const [numbered] = toBlocks("5. five");
    expect(numbered).toMatchObject({ type: "numberedListItem", props: { start: 5 } });
  });

  it("serializes editor-made content: title from pageLink, empty paragraphs preserved", () => {
    const md = fromBlocks([
      {
        type: "heading",
        props: { level: 1 },
        content: [{ type: "text", text: "Title", styles: {} }],
        children: [],
      },
      { type: "paragraph", props: {}, content: [], children: [] },
      {
        type: "pageLink",
        props: { path: "Projects/Atlas", title: "Atlas", icon: "🗺️", target: "" },
        children: [],
      },
      {
        type: "checkListItem",
        props: { checked: true },
        content: [{ type: "text", text: "done", styles: { bold: true } }],
        children: [],
      },
      { type: "paragraph", props: {}, content: [], children: [] },
    ]);
    expect(md).toBe(
      "# Title\n\n<!-- graite:empty -->\n\n[[Atlas]]\n\n- [x] **done**\n\n<!-- graite:empty -->\n",
    );
  });
});

describe("callouts and toggles", () => {
  it("keeps Obsidian callouts byte-for-byte through canonical", () => {
    const md = "> [!note] Hi\n> body\n";
    expect(canonical(md)).toBe(md);
    expect(canonical("> [!warning]+\n>\n> - a\n> - b\n")).toBe("> [!warning]+\n>\n> - a\n> - b\n");
  });

  it("maps [!toggle] callouts to toggleListItem and back", () => {
    const [toggle] = toBlocks("> [!toggle]- T\n> body\n");
    expect(toggle).toEqual({
      type: "toggleListItem",
      props: {},
      content: [{ type: "text", text: "T", styles: {} }],
      children: [
        {
          type: "paragraph",
          props: {},
          content: [{ type: "text", text: "body", styles: {} }],
          children: [],
        },
      ],
    });
    expect(fromBlocks([toggle!])).toBe("> [!toggle]- T\n> body\n");
    const [empty] = toBlocks("> [!toggle]- Empty\n");
    expect(empty).toMatchObject({ type: "toggleListItem", children: [] });
    expect(fromBlocks([empty!])).toBe("> [!toggle]- Empty\n");
    expect(fromBlocks([{ type: "toggleListItem", props: {}, content: [], children: [] }])).toBe(
      "> [!toggle]-\n",
    );
  });

  it("serializes pageLink target, then title, then path", () => {
    const base = { type: "pageLink" as const, children: [] };
    expect(
      fromBlocks([{ ...base, props: { path: "A/B", title: "B", icon: "", target: "A/B" } }]),
    ).toBe("[[A/B]]\n");
    expect(
      fromBlocks([{ ...base, props: { path: "A/B", title: "B", icon: "", target: "" } }]),
    ).toBe("[[B]]\n");
    expect(fromBlocks([{ ...base, props: { path: "A/B", title: "", icon: "", target: "" } }])).toBe(
      "[[A/B]]\n",
    );
  });

  it("marks table header rows", () => {
    const [table] = toBlocks("| a |\n| - |\n| 1 |\n");
    expect(table).toMatchObject({ type: "table", content: { headerRows: 1 } });
  });
});

describe("graite:view fences", () => {
  it("accepts the legacy field key as group and rejects removed view kinds", () => {
    const [legacy] = toBlocks(
      "```graite:view\nview: kanban\nfield: Status\nshow:\n  - Priority\n```\n",
    );
    expect(legacy).toMatchObject({
      type: "pageView",
      props: { view: "kanban", group: "Status", show: JSON.stringify({ kanban: ["Priority"] }) },
    });
    expect(fromBlocks([legacy!])).toBe(
      "```graite:view\nview: kanban\ngroup: Status\nshow:\n  kanban:\n    - Priority\n```\n",
    );
    const [timeline] = toBlocks("```graite:view\nview: timeline\nfield: Date\n```\n");
    expect(timeline?.type).toBe("rawMarkdown");
    const [empty] = toBlocks("```graite:view\nview: list\nshow: []\n```\n");
    expect(empty).toMatchObject({ props: { show: JSON.stringify({ list: [] }) } });
    expect(toBlocks("```graite:view\nview: list\nshow:\n  gallery: []\n```\n")[0]?.type).toBe(
      "rawMarkdown",
    );
  });

  // The daemon refuses a fence it knows the editor would drop, so an agent gets told off
  // instead of filing a page that quietly renders as grey text. Its copy of these rules lives
  // in apps/daemon/graite/vault/blocks.py and apps/daemon/tests/test_blocks.py reads this same
  // file: if either side moves alone, one of the two suites fails.
  const cases = JSON.parse(read(fixturesDir, "view-cases.json")) as {
    valid: string[];
    invalid: string[];
  };

  it.each(cases.valid)("renders a view for %j", (body) => {
    expect(toBlocks("```graite:view\n" + body + "```\n")[0]?.type).toBe("pageView");
  });

  it.each(cases.invalid)("falls back to plain text for %j", (body) => {
    expect(toBlocks("```graite:view\n" + body + "```\n")[0]?.type).toBe("rawMarkdown");
  });
});

describe("toBlocksWithSpans", () => {
  for (const name of readdirSync(blocksDir).filter((f) => f.endsWith(".md"))) {
    it(`locates every block of ${name} in its source`, () => {
      const md = read(blocksDir, name);
      const { blocks, spans } = toBlocksWithSpans(md);
      expect(blocks).toEqual(toBlocks(md));
      expect(spans).toHaveLength(blocks.length);
      let cursor = 0;
      for (const span of spans) {
        expect(span.start).toBeGreaterThanOrEqual(cursor);
        expect(span.end).toBeGreaterThan(span.start);
        cursor = span.end;
      }
    });
  }

  it("spans list items with their nested items, toggles, and loose lists as one block", () => {
    const md = "Intro\n\n- one\n  - nested\n- two\n\n> [!toggle]- Title\n> body\n\n1. a\n\n2. b\n";
    const { blocks, spans } = toBlocksWithSpans(md);
    expect(blocks.map((b) => b.type)).toEqual([
      "paragraph",
      "bulletListItem",
      "bulletListItem",
      "toggleListItem",
      "rawMarkdown",
    ]);
    const text = spans.map((s) => md.slice(s.start, s.end));
    expect(text).toEqual([
      "Intro",
      "- one\n  - nested",
      "- two",
      "> [!toggle]- Title\n> body",
      "1. a\n\n2. b",
    ]);
  });
});

describe("empty-paragraph markers", () => {
  it("turns a marker nested under a list item into an empty paragraph, not a raw block", () => {
    const blocks = toBlocks(read(blocksDir, "list-empty-child.md"));
    expect(blocks.map((b) => [b.type, (b.children ?? []).map((c) => c.type)])).toEqual([
      ["bulletListItem", ["paragraph"]],
      ["bulletListItem", ["bulletListItem", "paragraph"]],
      ["paragraph", []],
    ]);
  });
});
