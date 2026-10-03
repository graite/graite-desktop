import { lazy, Suspense } from "react";
import { createReactBlockSpec } from "@blocknote/react";
import type { GraiteEditor } from "../schema";

// ECharts loads with the first chart block, not with the app.
const ChartBody = lazy(() => import("../charts/ChartBody").then((m) => ({ default: m.ChartBody })));

/**
 * A chart over the page's CSV tables (D72), stored as a `graite:chart` fence. The props are the
 * fence's keys (see md-convert's ChartBlock); the daemon compiles them to read-only SQL.
 */
export const Chart = createReactBlockSpec(
  {
    type: "chart",
    propSchema: {
      title: { default: "" },
      source: { default: "" },
      sql: { default: "" },
      type: { default: "" },
      x: { default: "" },
      y: { default: "" },
      series: { default: "" },
      filter: { default: "" },
      sort: { default: "" },
      limit: { default: 0 },
      stacked: { default: "" },
      height: { default: 0 },
      palette: { default: "" },
    },
    content: "none",
  },
  {
    // Like table blocks: ProseMirror leaves the chart's clicks and keys alone.
    meta: { selectable: false },
    render: ({ block, editor }) => (
      <Suspense fallback={<div className="table-empty">Loading chart…</div>}>
        <ChartBody id={block.id} props={block.props} editor={editor as unknown as GraiteEditor} />
      </Suspense>
    ),
  },
);
