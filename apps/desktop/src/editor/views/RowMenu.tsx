import { GripVertical, MoreHorizontal, Trash2 } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

/**
 * The menu of a card or row in a view (clicking the item itself opens it: a page or a row). Tables and
 * lists show it as a 6-dot handle like the editor's blocks; board cards as "…".
 */
export function RowMenu<R extends { title: string }>({
  row,
  handle,
  onDelete,
}: {
  row: R;
  handle: "grip" | "dots";
  onDelete: (row: R) => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className={handle === "grip" ? "view-row-menu view-row-grip" : "view-row-menu"}
          aria-label={`Actions for ${row.title || "Untitled"}`}
          draggable={false}
          onClick={(e) => e.stopPropagation()}
          onPointerDown={(e) => e.stopPropagation()}
        >
          {handle === "grip" ? <GripVertical size={14} /> : <MoreHorizontal size={14} />}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align={handle === "grip" ? "start" : "end"}
        side={handle === "grip" ? "left" : "bottom"}
        onClick={(e) => e.stopPropagation()}
      >
        <DropdownMenuItem variant="destructive" onClick={() => onDelete(row)}>
          <Trash2 className="mr-2 size-4 text-destructive" /> Delete
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
