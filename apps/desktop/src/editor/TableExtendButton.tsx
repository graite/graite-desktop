import { Plus } from "lucide-react";
import { ExtendButton, type ExtendButtonProps } from "@blocknote/react";

/**
 * BlockNote's add-row / add-column control for Markdown tables, with the look of the database
 * tables: a small "+" beside the last column and "+ New" under the last row. Clicking adds
 * one; dragging still adds or removes several (BlockNote's behavior, unchanged).
 */
export function TableExtendButton(props: ExtendButtonProps) {
  return (
    <ExtendButton {...props}>
      <Plus size={13} />
      {props.orientation === "addOrRemoveRows" && <span>New</span>}
    </ExtendButton>
  );
}
