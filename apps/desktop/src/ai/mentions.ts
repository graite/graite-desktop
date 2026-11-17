import { pages as pagesApi, type TreeNode } from "@/lib/api";
import { allPages, type FlatPage } from "@/editor/tree-utils";

/**
 * `@page` in a chat message pins that page: its text is given to the model first, whatever
 * the search finds. The message keeps the readable form (`@Offline mode`); the paths are
 * worked out from it when it is sent.
 */

let known: FlatPage[] = [];
let loadedAt = 0;

/** The pages that can be mentioned, refreshed when the list is older than half a minute. */
export async function loadMentionPages(force = false): Promise<FlatPage[]> {
  if (!force && known.length && Date.now() - loadedAt < 30_000) return known;
  try {
    known = allPages((await pagesApi.tree()) as TreeNode[]);
    loadedAt = Date.now();
  } catch {
    // Keep what was known: a failed refresh must not empty the list.
  }
  return known;
}

export function knownMentionPages(): FlatPage[] {
  return known;
}

/** For tests. */
export function setMentionPages(list: FlatPage[]): void {
  known = list;
  loadedAt = Date.now();
}

/** The `@…` being typed at the cursor: where it starts and the text after the `@`. */
export function mentionAt(text: string, cursor: number): { start: number; query: string } | null {
  const before = text.slice(0, cursor);
  const at = before.lastIndexOf("@");
  if (at < 0 || (at > 0 && !/\s/.test(before[at - 1]!))) return null;
  const query = before.slice(at + 1);
  // A mention is a few words on one line; anything longer is just text with an @ in it.
  if (query.includes("\n") || query.length > 40) return null;
  return { start: at, query };
}

/** Pages whose title contains the typed text, titles that start with it first. */
export function mentionMatches(query: string, pages: FlatPage[], limit = 8): FlatPage[] {
  const q = query.trim().toLowerCase();
  const scored = pages
    .map((page) => ({ page, at: page.title.toLowerCase().indexOf(q) }))
    .filter((entry) => entry.at >= 0)
    .sort(
      (a, b) =>
        Number(a.at > 0) - Number(b.at > 0) ||
        a.page.title.length - b.page.title.length ||
        a.page.path.localeCompare(b.page.path),
    );
  return scored.slice(0, limit).map((entry) => entry.page);
}

/** The paths of the pages mentioned in `text`: after each `@`, the longest title that fits. */
export function mentionedPaths(text: string, pages: FlatPage[] = known): string[] {
  const byLength = [...pages].sort((a, b) => b.title.length - a.title.length);
  const lower = text.toLowerCase();
  const found: string[] = [];
  for (let at = lower.indexOf("@"); at >= 0; at = lower.indexOf("@", at + 1)) {
    if (at > 0 && !/\s/.test(lower[at - 1]!)) continue;
    const rest = lower.slice(at + 1);
    const page = byLength.find((p) => {
      const title = p.title.toLowerCase();
      // The title, then the end of the text or something that is not part of a word.
      return title && rest.startsWith(title) && !/[\p{L}\p{N}]/u.test(rest[title.length] ?? "");
    });
    if (page && !found.includes(page.path)) found.push(page.path);
  }
  return found.slice(0, 8);
}
