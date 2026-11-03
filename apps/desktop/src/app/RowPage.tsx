import { ArrowLeft, Table2 } from "lucide-react";
import { RowView, type OpenRow } from "@/editor/tables/RowView";
import "@/editor/tables/tables.css";
import "@/editor/views/views.css";

/**
 * A table row as a full page (D80): its name, its fields like page properties, its own
 * document, and the rows it links to. Back returns to the page it was opened from; a linked
 * row opens here too.
 */
export function RowPage({
  row,
  onBack,
  onOpen,
  onNavigate,
}: {
  row: OpenRow;
  onBack: () => void;
  onOpen: (row: OpenRow) => void;
  onNavigate: (path: string) => void;
}) {
  const page = row.table.split("/_data/")[0] ?? "";
  return (
    <main className="h-full overflow-auto px-10 py-8">
      <div className="row-page mx-auto max-w-3xl">
        <RowView
          key={`${row.table}#${row.id}`}
          row={row}
          layout="page"
          onOpen={(table, id) => onOpen({ table, id })}
          onOpenPage={onNavigate}
          onDeleted={onBack}
          heading={(label, secondary, meta, actions) => (
            <header className="row-page-head">
              <div className="row-page-crumbs">
                <button type="button" className="view-button" onClick={onBack}>
                  <ArrowLeft size={13} /> Back
                </button>
                <button type="button" className="row-page-crumb" onClick={() => onNavigate(page)}>
                  {page.split("/").pop()}
                </button>
                <span>/</span>
                <span className="row-page-crumb">
                  <Table2 size={12} /> {meta?.name ?? ""}
                </span>
                <span className="row-links-grow" />
                {actions}
              </div>
              <h1 className="row-page-title">{label || "Untitled"}</h1>
              {secondary && <p className="row-page-secondary">{secondary}</p>}
            </header>
          )}
        />
      </div>
    </main>
  );
}
