import type { ReactNode } from "react";

/**
 * What a board or list shows (BoardView, ListView): pages of a page view, or rows of a table
 * view (D79). Each side adapts its own items; the board only arranges them.
 */
export interface BoardItem {
  id: string;
  title: string;
}

export interface BoardSource<R extends BoardItem> {
  rows: R[];
  /** The item's value of the grouping field ("" when it has none). */
  group: (row: R) => string;
  /** Put `row` in `column`, and before/after `target` when the source keeps its own order. */
  move: (row: R, column: string, target?: R, position?: "before" | "after") => Promise<unknown>;
  create: (title: string, column?: string) => Promise<unknown>;
  remove: (row: R) => unknown;
  icon: (row: R) => ReactNode;
  /** The fields a card or list row shows. */
  chips: (row: R) => ReactNode;
  /** The placeholder of the "New" input, e.g. "Page title". */
  placeholder?: string;
}
