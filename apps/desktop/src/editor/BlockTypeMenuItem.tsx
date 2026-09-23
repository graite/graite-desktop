import { useBlockNoteEditor, useComponentsContext } from "@blocknote/react";
import { SideMenuExtension } from "@blocknote/core/extensions";
import { useStore } from "@tanstack/react-store";

type BlockTypeOption = { name: string; type: string; props?: Record<string, unknown> };

const blockTypes: BlockTypeOption[] = [
  { name: "Text", type: "paragraph" },
  { name: "Heading 1", type: "heading", props: { level: 1 } },
  { name: "Heading 2", type: "heading", props: { level: 2 } },
  { name: "Heading 3", type: "heading", props: { level: 3 } },
  { name: "Bullet List", type: "bulletListItem" },
  { name: "Numbered List", type: "numberedListItem" },
  { name: "Check List", type: "checkListItem" },
  { name: "Toggle", type: "toggleListItem" },
  { name: "Quote", type: "quote" },
  { name: "Code", type: "codeBlock" },
];

const NOT_CONVERTIBLE = new Set(["pageLink", "table", "image", "divider", "rawMarkdown"]);

/** "Turn into" submenu for the drag-handle menu. */
export function BlockTypeMenuItem() {
  const editor = useBlockNoteEditor();
  const Components = useComponentsContext();
  const ext = editor.getExtension(SideMenuExtension);
  const block = useStore(ext!.store, (state) => state?.block);

  if (!block || !Components) return null;
  if (NOT_CONVERTIBLE.has(block.type)) return null;

  return (
    <Components.Generic.Menu.Root position="right" sub>
      <Components.Generic.Menu.Trigger sub>
        <Components.Generic.Menu.Item className="bn-menu-item" subTrigger>
          Turn into
        </Components.Generic.Menu.Item>
      </Components.Generic.Menu.Trigger>
      <Components.Generic.Menu.Dropdown sub className="bn-menu-dropdown">
        {blockTypes.map((bt) => {
          const props = block.props as Record<string, unknown>;
          const isActive =
            block.type === bt.type &&
            (!bt.props || Object.entries(bt.props).every(([k, v]) => props[k] === v));
          return (
            <Components.Generic.Menu.Item
              key={bt.name}
              className="bn-menu-item"
              checked={isActive}
              onClick={() => {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                editor.updateBlock(block, { type: bt.type as any, props: bt.props as any });
              }}
            >
              {bt.name}
            </Components.Generic.Menu.Item>
          );
        })}
      </Components.Generic.Menu.Dropdown>
    </Components.Generic.Menu.Root>
  );
}
