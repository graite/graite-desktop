import { lazy, Suspense } from "react";
import { createReactBlockSpec } from "@blocknote/react";
import type { GraiteEditor } from "../schema";

// The grid (glide-data-grid) loads with the first table block, not with the app.
const TableViewBody = lazy(() =>
  import("../tables/TableViewBody").then((m) => ({ default: m.TableViewBody })),
);

/**
 * A view over a CSV table in a page's `_data/` (D68), stored as a `graite:table` fence or an
 * `![[name.csv]]` embed. The view state (filter, sort, columns) lives here, not in the data,
 * so two blocks can show the same table differently. See md-convert for the on-disk form.
 */
export const TableView = createReactBlockSpec(
  {
    type: "tableView",
    propSchema: {
      source: { default: "" },
      view: { default: "" },
      filter: { default: "" },
      sort: { default: "" },
      columns: { default: "" },
      height: { default: 0 },
      embed: { default: false },
      tabs: { default: "" },
    },
    content: "none",
  },
  {
    // ProseMirror ignores every event inside a non-selectable block (BlockNote sets the node
    // view's stopEvent), so the grid gets clicks, keys and paste without anyone stopping them.
    meta: { selectable: false },
    render: ({ block, editor }) => (
      <Suspense fallback={<div className="table-empty">Loading table…</div>}>
        <TableViewBody
          id={block.id}
          props={block.props}
          editor={editor as unknown as GraiteEditor}
        />
      </Suspense>
    ),
  },
);
