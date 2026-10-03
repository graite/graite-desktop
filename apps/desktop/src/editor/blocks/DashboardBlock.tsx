import { lazy, Suspense } from "react";
import { createReactBlockSpec } from "@blocknote/react";
import type { GraiteEditor } from "../schema";

const DashboardBody = lazy(() =>
  import("../dashboards/DashboardBody").then((m) => ({ default: m.DashboardBody })),
);

/**
 * An HTML dashboard from the page's `_dashboards/` (D72), stored as a `graite:dashboard`
 * fence (`src`, `height`). The file runs in a sandboxed frame; see DashboardFrame.
 */
export const Dashboard = createReactBlockSpec(
  {
    type: "dashboard",
    propSchema: { src: { default: "" }, height: { default: 0 } },
    content: "none",
  },
  {
    meta: { selectable: false },
    render: ({ block, editor }) => (
      <Suspense fallback={<div className="table-empty">Loading dashboard…</div>}>
        <DashboardBody
          id={block.id}
          props={block.props}
          editor={editor as unknown as GraiteEditor}
        />
      </Suspense>
    ),
  },
);
