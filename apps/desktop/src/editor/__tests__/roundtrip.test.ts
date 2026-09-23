import { describe, expect, it } from "vitest";
import { BlockNoteEditor } from "@blocknote/core";
import { canonical, fromBlocks, toBlocks } from "@graite/md-convert";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { schema } from "../schema";

/**
 * Round-trip through the REAL BlockNote editor (headless, jsdom), not just the converter:
 * markdown -> toBlocks -> editor.replaceBlocks -> editor.document -> fromBlocks === canonical.
 */
const projectsMd = readFileSync(
  resolve(__dirname, "../../../../../examples/vault/Projects/page.md"),
  "utf8",
).replace(/^---[\s\S]*?---\n/, "");

function roundTrip(md: string): string {
  const editor = BlockNoteEditor.create({ schema });
  editor.replaceBlocks(editor.document, toBlocks(md) as never);
  return fromBlocks(editor.document as never);
}

describe("editor round-trip", () => {
  it("survives the example Projects page", () => {
    expect(roundTrip(projectsMd)).toBe(canonical(projectsMd));
  });
  it("survives a page link and a wikilink", () => {
    const md = "Intro\n\n[[Child]]\n\nSee [[Other|alias]] here.\n";
    expect(roundTrip(md)).toBe(canonical(md));
  });
  it("survives a toggle with body, a table, a checklist and a path-style page link", () => {
    const md = [
      "> [!toggle]- Details",
      "> First paragraph",
      ">",
      "> - nested bullet",
      "",
      "| a | b |",
      "| - | - |",
      "| 1 | 2 |",
      "",
      "- [ ] open",
      "- [x] done",
      "",
      "[[Projects/Atlas/Roadmap]]",
      "",
    ].join("\n");
    expect(roundTrip(md)).toBe(canonical(md));
    const editor = BlockNoteEditor.create({ schema });
    editor.replaceBlocks(editor.document, toBlocks(md) as never);
    expect(editor.document[0]!.type).toBe("toggleListItem");
    expect(editor.document[0]!.children[0]!.type).toBe("paragraph");
  });

  it("keeps media, active tasks and Markdown results across reopen", () => {
    const md = readFileSync(
      resolve(__dirname, "../../../../../packages/md-convert/fixtures/blocks/media.md"),
      "utf8",
    );
    expect(roundTrip(md)).toBe(canonical(md));
  });

  it("preserves columns and every page view through the real editor", () => {
    const md = readFileSync(
      resolve(__dirname, "../../../../../packages/md-convert/fixtures/blocks/columns-and-views.md"),
      "utf8",
    );
    expect(roundTrip(md)).toBe(canonical(md));
  });

  it("serializes a typed slash query as plain text", () => {
    const editor = BlockNoteEditor.create({ schema });
    editor.replaceBlocks(editor.document, [{ type: "paragraph", content: "/page" }]);
    expect(fromBlocks(editor.document as never)).toBe("/page\n");
  });
});

it("retains repeated blank blocks at the start, middle and end through reopening", () => {
  const md = readFileSync(
    resolve(__dirname, "../../../../../packages/md-convert/fixtures/blocks/empty-paragraphs.md"),
    "utf8",
  );
  expect(roundTrip(md)).toBe(canonical(md));
  expect(roundTrip(roundTrip(md))).toBe(canonical(md));
  expect(toBlocks(md).filter((b) => b.type === "paragraph" && !b.content.length)).toHaveLength(4);
});

it("preserves view arrangement, filters and sorting through the real editor", () => {
  const md = readFileSync(
    resolve(__dirname, "../../../../../packages/md-convert/fixtures/blocks/view-settings.md"),
    "utf8",
  );
  expect(roundTrip(md)).toBe(canonical(md));
});
