import { createReactInlineContentSpec } from "@blocknote/react";

/** Inline `[[Target|Alias]]`. Click handling lives in PageEditor via data-wikilink. */
export const Wikilink = createReactInlineContentSpec(
  {
    type: "wikilink",
    propSchema: {
      target: { default: "" },
      alias: { default: "" },
    },
    content: "none",
  },
  {
    render: ({ inlineContent }) => (
      <span
        className="cursor-pointer rounded-sm bg-accent/60 px-1 text-[0.95em] underline decoration-gray-300 decoration-[0.5px] underline-offset-2 hover:bg-accent"
        data-wikilink
        data-wikilink-target={inlineContent.props.target}
      >
        {inlineContent.props.alias || inlineContent.props.target}
      </span>
    ),
  },
);
