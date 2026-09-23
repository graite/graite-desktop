import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { canonical } from "./index";

const fixturesDir = join(import.meta.dirname, "..", "fixtures");

describe("canonical", () => {
  it("is idempotent on every fixture", () => {
    for (const name of readdirSync(fixturesDir).filter((f) => f.endsWith(".md"))) {
      const md = readFileSync(join(fixturesDir, name), "utf8");
      const once = canonical(md);
      expect(canonical(once), name).toBe(once);
    }
  });

  it("keeps frontmatter, gfm tables and task lists", () => {
    const md = "---\ntitle: T\n---\n\n# H\n\n- [ ] a\n- [x] b\n\n| a | b |\n| - | - |\n| 1 | 2 |\n";
    const out = canonical(md);
    expect(out).toContain("---\ntitle: T\n---");
    expect(out).toContain("- [ ] a");
    expect(out).toContain("| a | b |");
  });
});
