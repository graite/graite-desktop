import { createReactBlockSpec } from "@blocknote/react";

/**
 * Escape hatch for markdown the editor cannot model (HTML, footnotes, callouts for now).
 * The source survives byte-for-byte. Read-only display in this milestone.
 */
export const RawMarkdown = createReactBlockSpec(
  { type: "rawMarkdown", propSchema: { source: { default: "" } }, content: "none" },
  {
    render: ({ block }) => (
      <div className="w-full">
        <div className="mb-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
          raw markdown
        </div>
        <pre>{block.props.source}</pre>
      </div>
    ),
  },
);
