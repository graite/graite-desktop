import { useEffect, useState } from "react";
import { ArrowLeft, Maximize2, Table2, X } from "lucide-react";
import { Dialog as DialogPrimitive } from "radix-ui";
import { Dialog, DialogDescription, DialogPortal, DialogTitle } from "@/components/ui/dialog";
import { PopoverContainer } from "@/components/ui/popover";
import { RowView, type OpenRow } from "./RowView";

export type { OpenRow } from "./RowView";

/**
 * One row of a table as a side panel: every field, editable; linked rows open in the same
 * panel (Back returns); "Open as page" shows the row full width (D80).
 */
export function RowPanel({
  row,
  onClose,
  onOpenTable,
  onOpenPage,
  onOpenFull,
}: {
  row: OpenRow | null;
  onClose: () => void;
  /** Show this table in the block; offered when the table is one of the block's tabs. */
  onOpenTable?: (table: string) => boolean;
  /** Go to a linked page (page fields, D76). */
  onOpenPage?: (path: string) => void;
  /** Open the row as a full page. */
  onOpenFull?: (row: OpenRow) => void;
}) {
  const [stack, setStack] = useState<OpenRow[]>([]);
  const [sheet, setSheet] = useState<HTMLElement | null>(null);
  const current = stack[stack.length - 1] ?? null;
  useEffect(() => setStack(row ? [row] : []), [row]);

  return (
    <Dialog open={!!row} onOpenChange={(open) => !open && onClose()}>
      {/* A plain sheet on the radix primitives: no centered layout or zoom animation to
          undo, so it looks the same in every webview (WebKitGTK included). */}
      <DialogPortal>
        <DialogPrimitive.Overlay className="table-row-overlay" />
        <DialogPrimitive.Content className="table-row-panel" ref={setSheet}>
          <PopoverContainer.Provider value={sheet}>
            {current && (
              <RowView
                key={`${current.table}#${current.id}`}
                row={current}
                layout="panel"
                onOpen={(table, id) => setStack((s) => [...s, { table, id }])}
                onOpenPage={(path) => {
                  onClose();
                  onOpenPage?.(path);
                }}
                onDeleted={() => (stack.length > 1 ? setStack((s) => s.slice(0, -1)) : onClose())}
                heading={(label, secondary, page, actions) => (
                  <>
                    <div className="table-row-panel-head">
                      {stack.length > 1 && (
                        <button
                          type="button"
                          className="view-button"
                          aria-label="Back"
                          onClick={() => setStack((s) => s.slice(0, -1))}
                        >
                          <ArrowLeft size={13} />
                        </button>
                      )}
                      <span className="table-row-panel-table">
                        <Table2 size={13} />
                        {page?.name ?? ""}
                      </span>
                      {onOpenTable && page && (
                        <button
                          type="button"
                          className="view-button"
                          onClick={() => {
                            if (onOpenTable(current.table)) onClose();
                          }}
                        >
                          Open table
                        </button>
                      )}
                      {onOpenFull && (
                        <button
                          type="button"
                          className="view-button"
                          title="Open as page"
                          onClick={() => {
                            onClose();
                            onOpenFull(current);
                          }}
                        >
                          <Maximize2 size={13} /> Open as page
                        </button>
                      )}
                      {actions}
                      <DialogPrimitive.Close className="table-row-close" aria-label="Close">
                        <X size={15} />
                      </DialogPrimitive.Close>
                    </div>
                    <DialogTitle className="table-row-panel-title">
                      {label || "Untitled"}
                    </DialogTitle>
                    <DialogDescription className="table-row-panel-secondary">
                      {secondary}
                    </DialogDescription>
                  </>
                )}
              />
            )}
          </PopoverContainer.Provider>
        </DialogPrimitive.Content>
      </DialogPortal>
    </Dialog>
  );
}
