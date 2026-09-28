import { ExternalLink, MoreHorizontal, Trash2 } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { PageDoc } from "@/lib/api";

/** The "…" menu on a card or row of a view: open or delete that page. */
export function RowMenu({
  row,
  onOpen,
  onDelete,
}: {
  row: PageDoc;
  onOpen: (row: PageDoc) => void;
  onDelete: (row: PageDoc) => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="view-row-menu"
          aria-label={`Actions for ${row.title || "Untitled"}`}
          draggable={false}
          onClick={(e) => e.stopPropagation()}
          onPointerDown={(e) => e.stopPropagation()}
        >
          <MoreHorizontal size={14} />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" onClick={(e) => e.stopPropagation()}>
        <DropdownMenuItem onClick={() => onOpen(row)}>
          <ExternalLink className="mr-2 size-4" /> Open
        </DropdownMenuItem>
        <DropdownMenuItem variant="destructive" onClick={() => onDelete(row)}>
          <Trash2 className="mr-2 size-4 text-destructive" /> Delete
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
