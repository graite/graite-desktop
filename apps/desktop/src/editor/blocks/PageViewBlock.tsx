import { createReactBlockSpec } from "@blocknote/react";
import type { GraiteEditor } from "../schema";
import { PageViewBody } from "../views/PageViewBody";

/**
 * A live view over the page's direct child pages, stored as a `graite:view` fence.
 * `group` is the board's grouping property name; `show` is "" (view default) or a JSON list
 * of the property names shown on cards/rows/columns (see md-convert for the on-disk form).
 */
export const PageView = createReactBlockSpec(
  {
    type: "pageView",
    propSchema: {
      view: { default: "table", values: ["table", "kanban", "list"] as const },
      group: { default: "" },
      show: { default: "" },
      settings: { default: "" },
    },
    content: "none",
  },
  {
    render: ({ block, editor }) => (
      <PageViewBody id={block.id} props={block.props} editor={editor as unknown as GraiteEditor} />
    ),
  },
);
