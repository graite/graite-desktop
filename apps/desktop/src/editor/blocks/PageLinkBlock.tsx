import { createReactBlockSpec } from "@blocknote/react";
import { PageIcon } from "@/components/PageIcon";

/**
 * A link to a child page. Serializes to `[[Title]]` alone on a line (docs/design/editor-roundtrip.md).
 * `path` is the vault-relative folder of the linked page; empty while it is being created/chosen.
 * Navigation is handled by a container-level click handler via data-page-link / data-page-path.
 */
export const PageLink = createReactBlockSpec(
  {
    type: "pageLink",
    propSchema: {
      path: { default: "" },
      title: { default: "Untitled" },
      icon: { default: "" },
      /** Exact wikilink text written to markdown: child title, or full vault path for other pages. */
      target: { default: "" },
      /** "1" while the linked page has no body text; kept in sync from the tree, never serialized. */
      empty: { default: "" },
    },
    content: "none",
  },
  {
    render: ({ block }) => {
      const icon = block.props.icon;
      const title = block.props.title || "Untitled";
      const pending = block.props.path === "";
      return (
        <div
          className={`flex w-full cursor-pointer items-center gap-2 rounded-md px-1.5 py-0.5 transition-colors hover:bg-accent ${
            pending ? "opacity-60" : ""
          }`}
          data-media-drop-page={block.props.path || undefined}
          data-page-link
          data-page-path={block.props.path}
        >
          <span className="flex shrink-0 items-center">
            <PageIcon
              icon={icon}
              hasContent={block.props.empty !== "1"}
              className="size-4"
              emojiClassName="text-base leading-none"
            />
          </span>
          <span className="text-sm font-medium underline decoration-gray-300 decoration-[0.5px] underline-offset-2">
            {title}
          </span>
        </div>
      );
    },
  },
);
