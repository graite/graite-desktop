/**
 * Text dragged out of the editor onto a page (a sidebar row or a page link in the text) is
 * moved into that page. The sidebar is not part of the editor, so the editor that started the
 * drag registers here what to do, and whichever page the text is dropped on calls it.
 */
import type { GraiteBlock } from "./schema";

/** Marks a drag as "text from a Graite page"; the payload itself stays in the editor. */
export const TEXT_DRAG = "application/graite-text";

type Take = (targetPath: string) => void;

let active: Take | null = null;

export function beginTextDrag(take: Take): void {
  active = take;
}

export function endTextDrag(): void {
  active = null;
}

/** Move the dragged text to `targetPath`. False when no text drag is in progress. */
export function dropTextOnPage(targetPath: string): boolean {
  const take = active;
  active = null;
  if (!take) return false;
  take(targetPath);
  return true;
}

// Blocks that are text and nothing else. Media, tables of a database, views and page links
// point at files or pages that belong to the page they are on, so they are not moved as text.
const TEXT_TYPES = new Set([
  "paragraph",
  "heading",
  "bulletListItem",
  "numberedListItem",
  "checkListItem",
  "toggleListItem",
  "quote",
  "codeBlock",
  "table",
  "divider",
  "rawMarkdown",
  "callout",
]);

export function isMovableText(blocks: GraiteBlock[]): boolean {
  return (
    blocks.length > 0 &&
    blocks.every(
      (b) =>
        TEXT_TYPES.has(b.type) &&
        (!b.children?.length || isMovableText(b.children as GraiteBlock[])),
    )
  );
}
