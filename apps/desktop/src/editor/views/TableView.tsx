import { Plus, ArrowUp, ArrowDown, ArrowUpDown } from "lucide-react";
import { toast } from "sonner";
import type { PageDoc } from "@/lib/api";
import type { PageProperty } from "@/lib/workspace";
import { PropertyIcon, PropertyValue } from "@/pages/PageProperties";
import { hasBodyContent, PageIcon } from "@/components/PageIcon";
import { emptyValue, findField } from "./collection";
import { NewPageInput } from "./NewPageInput";
import { moveName, type ViewSettings } from "./settings";
import type { Collection } from "./useCollection";

export function PageTitle({ row, onOpen }: { row: PageDoc; onOpen: (row: PageDoc) => void }) {
  return (
    <button className="view-page" onClick={() => onOpen(row)}>
      <span className="view-page-icon">
        <PageIcon icon={row.icon} hasContent={hasBodyContent(row.body)} />
      </span>
      <span title={row.title}>{row.title || "Untitled"}</span>
    </button>
  );
}

export function TableView({
  collection,
  visible,
  draft,
  onDraftDone,
  onOpen,
  sort,
  onSort,
  onOrder,
}: {
  collection: Collection;
  visible: PageProperty[];
  draft: boolean;
  onDraftDone: () => void;
  onOpen: (row: PageDoc) => void;
  sort?: ViewSettings["sort"];
  onSort: (sort: ViewSettings["sort"]) => void;
  onOrder: (names: string[]) => void;
}) {
  const { rows, setValue, setField, createPage } = collection;
  const fail = (e: unknown) => toast.error((e as Error).message);
  const header = (field: string, label: React.ReactNode) => (
    <button
      className="view-sort-header"
      onClick={() =>
        onSort(
          sort?.field === field
            ? sort.direction === "asc"
              ? { field, direction: "desc" }
              : undefined
            : { field, direction: "asc" },
        )
      }
    >
      {label}
      {sort?.field === field ? (
        sort.direction === "asc" ? (
          <ArrowUp size={12} />
        ) : (
          <ArrowDown size={12} />
        )
      ) : (
        <ArrowUpDown size={12} />
      )}
    </button>
  );
  return (
    <div className="view-table-wrap">
      <table className="view-table">
        <thead>
          <tr>
            <th
              aria-sort={
                sort?.field === "$title"
                  ? sort.direction === "asc"
                    ? "ascending"
                    : "descending"
                  : "none"
              }
            >
              {header("$title", "Name")}
            </th>
            {visible.map((f) => (
              <th
                key={f.id}
                draggable
                aria-sort={
                  sort?.field === f.name
                    ? sort.direction === "asc"
                      ? "ascending"
                      : "descending"
                    : "none"
                }
                onDragStart={(e) => {
                  e.dataTransfer.setData("application/graite-table-column", f.name);
                  e.stopPropagation();
                }}
                onDragOver={(e) => {
                  if (e.dataTransfer.types.includes("application/graite-table-column"))
                    e.preventDefault();
                }}
                onDrop={(e) => {
                  if (!e.dataTransfer.types.includes("application/graite-table-column")) return;
                  e.preventDefault();
                  e.stopPropagation();
                  onOrder(
                    moveName(
                      visible.map((p) => p.name),
                      e.dataTransfer.getData("application/graite-table-column"),
                      f.name,
                    ),
                  );
                }}
              >
                {header(
                  f.name,
                  <>
                    <PropertyIcon type={f.type} />
                    {f.name}
                  </>,
                )}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id}>
              <td>
                <PageTitle row={row} onOpen={onOpen} />
              </td>
              {visible.map((f) => {
                const own = findField(row, f.name);
                return (
                  <td key={f.id}>
                    {own ? (
                      <PropertyValue
                        page={row}
                        field={{
                          ...own,
                          options: f.options,
                          colors: { ...f.colors, ...own.colors },
                        }}
                        onChange={(value) => void setValue(row, f, value).catch(fail)}
                        onFieldChange={(next) => void setField(row, next).catch(fail)}
                      />
                    ) : (
                      <button
                        className="view-add-cell"
                        aria-label={`Add ${f.name}`}
                        onClick={() => void setValue(row, f, emptyValue(f)).catch(fail)}
                      >
                        <Plus size={12} />
                      </button>
                    )}
                  </td>
                );
              })}
            </tr>
          ))}
          {draft && (
            <tr>
              <td colSpan={visible.length + 1}>
                <NewPageInput onCreate={(title) => createPage(title)} onDone={onDraftDone} />
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
