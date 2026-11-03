import { fromBlocks } from "@graite/md-convert";
import { cleanView, type TableViewDef } from "./views";

/**
 * How an empty database block starts (D82): a new database here, or a linked view of one that
 * exists. The slash item that inserts the block notes which; a block without a note (undo, a
 * fence without a source) starts as "new". Kept apart from the setup component so the slash
 * menu does not load the table code. (A database page needs no setup: it is made at once.)
 */
export type SetupMode = "new" | "linked";

const pending = new Map<string, SetupMode>();

export function startSetup(blockId: string, mode: SetupMode) {
  pending.set(blockId, mode);
}

/** The mode noted for a block, once: the note is dropped when read. */
export function takeSetup(blockId: string): SetupMode | undefined {
  const mode = pending.get(blockId);
  pending.delete(blockId);
  return mode;
}

/** A page body holding one database block with these views (a new database page). */
export function databaseBody(views: TableViewDef[]): string {
  const props = {
    views: JSON.stringify(views.map(cleanView)),
    source: "",
    view: "",
    filter: "",
    sort: "",
    columns: "",
    height: 0,
    embed: false,
    tabs: "",
  };
  return fromBlocks([
    { id: "db", type: "tableView", props, content: undefined, children: [] },
  ] as unknown as Parameters<typeof fromBlocks>[0]);
}
