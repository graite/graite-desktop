import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fromBlocks, merge3, minimalSave, toBlocks } from "./index";
import type { Block } from "./types";

const fixtures = join(import.meta.dirname, "..", "fixtures");
const vault = join(import.meta.dirname, "..", "..", "..", "examples", "vault");

function markdownFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
    .map((entry) => join(entry.parentPath, entry.name));
}

/** A page body as the daemon hands it to the editor: no frontmatter, one trailing newline. */
function body(file: string): string {
  const text = readFileSync(file, "utf8").replace(/^---\n[\s\S]*?\n---\n/, "");
  return text.replace(/^\n+|\n+$/g, "") + "\n";
}

const paragraph = (text: string): Block =>
  ({
    type: "paragraph",
    props: {},
    content: text ? [{ type: "text", text, styles: {} }] : [],
    children: [],
  }) as Block;

describe("merge3", () => {
  it("keeps the disk text where the editor changed nothing", () => {
    expect(merge3("- a\n- b\n", "- a\n- b\n\nnew\n", "* a\n* b\n")).toBe("* a\n* b\n\nnew\n");
  });
  it("keeps the disk's spelling of the lines next to an edited one", () => {
    expect(merge3("- a\n- b\n", "- a\n- c\n", "* a\n* b\n")).toBe("* a\n* c\n");
  });
  it("applies a deletion", () => {
    expect(merge3("one\n\ntwo\n\nthree\n", "one\n\nthree\n", "one\n\ntwo\n\nthree\n")).toBe(
      "one\n\nthree\n",
    );
  });
});

describe("minimalSave", () => {
  const files = [
    ...markdownFiles(join(fixtures, "roundtrip")),
    ...markdownFiles(join(fixtures, "blocks")),
    ...markdownFiles(vault),
  ];

  for (const file of files) {
    const name = file.split(/fixtures\/|examples\//)[1];
    const disk = body(file);
    const blocks = toBlocks(disk);
    const baseline = fromBlocks(blocks);

    it(`writes nothing new for an unedited ${name}`, () => {
      expect(minimalSave(disk, baseline, baseline)).toBe(disk);
    });

    it(`adds only the typed paragraph to ${name}`, () => {
      // The editor keeps an empty paragraph at the end; Enter there and typing fills it.
      const next = fromBlocks([...blocks, paragraph("A new last line")]);
      const saved = minimalSave(disk, baseline, next);
      expect(fromBlocks(toBlocks(saved))).toBe(next);
      // Everything that was on disk is still there, byte for byte, with the line after it.
      const kept = disk.replace(/(\n+<!-- graite:empty -->)*\n+$/, "");
      expect(saved.startsWith(kept)).toBe(true);
      expect(saved.endsWith("A new last line\n")).toBe(true);
    });

    it(`changes only the first lines when a paragraph is put first in ${name}`, () => {
      const next = fromBlocks([paragraph("A new first line"), ...blocks]);
      const saved = minimalSave(disk, baseline, next);
      expect(fromBlocks(toBlocks(saved))).toBe(next);
      // Only the first block may be respelled (a setext heading has no line-for-line match).
      const rest = disk
        .replace(/(\n+<!-- graite:empty -->)+\n*$/, "\n")
        .split("\n")
        .slice(3);
      expect(saved.endsWith(rest.join("\n"))).toBe(true);
    });
  }

  it("does not write the editor's trailing empty paragraph", () => {
    const blocks = toBlocks("Text\n");
    expect(fromBlocks([...blocks, paragraph("")])).toBe("Text\n");
    expect(fromBlocks([...blocks, paragraph(""), paragraph("")])).toBe("Text\n");
  });

  it("gives a new list item the marker the file already uses", () => {
    const disk = "* a\n* b\n";
    const baseline = fromBlocks(toBlocks(disk));
    expect(minimalSave(disk, baseline, "- a\n- b\n- c\n")).toBe("* a\n* b\n* c\n");
  });

  it("keeps a soft line break that the editor did not touch", () => {
    const disk = "one line\nwrapped by hand\n\nsecond\n";
    const blocks = toBlocks(disk);
    const saved = minimalSave(disk, fromBlocks(blocks), fromBlocks([...blocks, paragraph("x")]));
    expect(saved).toBe("one line\nwrapped by hand\n\nsecond\n\nx\n");
  });
});
