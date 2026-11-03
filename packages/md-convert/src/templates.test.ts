import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { canonical, fromBlocks, hasRawBlocks, toBlocks } from "./index";

/** The daemon's built-in templates (D77): their pages must open in the editor as real blocks
 *  and save back byte for byte, or the first edit of a fresh template rewrites its layout. */
const builtin = join(
  import.meta.dirname,
  "..",
  "..",
  "..",
  "apps",
  "daemon",
  "graite",
  "templates",
  "builtin",
);

function pages(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...pages(path));
    else if (name === "page.md") out.push(path);
  }
  return out;
}

const body = (text: string) => text.replace(/^---\n[\s\S]*?\n---\n\n?/, "");

describe("built-in template pages", () => {
  const files = pages(builtin);
  it("finds the templates", () => expect(files.length).toBeGreaterThan(10));
  for (const file of files) {
    const name = file.slice(builtin.length + 1);
    it(`round-trips ${name}`, () => {
      const md = body(readFileSync(file, "utf8"));
      const blocks = toBlocks(md);
      const raw = blocks.filter((b) => b.type === "rawMarkdown");
      expect(raw.map((b) => JSON.stringify(b.props))).toEqual([]);
      expect(hasRawBlocks(blocks)).toBe(false);
      expect(fromBlocks(blocks)).toBe(canonical(md));
      expect(canonical(md)).toBe(md);
    });
  }
});
