import { useState, type DragEvent } from "react";
import { Plus, GripVertical, EyeOff } from "lucide-react";
import { toast } from "sonner";
import type { PageDoc } from "@/lib/api";
import type { PageProperty } from "@/lib/workspace";
import { PropertyTag } from "@/pages/PropertySelect";
import { hasBodyContent, PageIcon } from "@/components/PageIcon";
import { groupValue } from "./collection";
import { NewPageInput } from "./NewPageInput";
import { PropertyChip } from "./PropertyChip";
import { orderedNames, moveName, type ViewSettings } from "./settings";
import type { Collection } from "./useCollection";

export const DRAG_TYPE = "application/graite-view-page";
type Drop = { card: string; position: "before" | "after" } | { column: string } | null;

export function BoardView({
  collection,
  groupField,
  visible,
  draft,
  onDraftDone,
  onOpen,
  settings,
  onSettings,
}: {
  collection: Collection;
  groupField: PageProperty;
  visible: PageProperty[];
  draft: string | null;
  onDraftDone: () => void;
  onOpen: (row: PageDoc) => void;
  settings: ViewSettings;
  onSettings: (next: ViewSettings) => void;
}) {
  const { rows, setValue, reorder, createPage } = collection;
  const [drop, setDrop] = useState<Drop>(null);
  const [newIn, setNewIn] = useState<string | null>(null);
  const fail = (e: unknown) => toast.error((e as Error).message);

  const board = settings.boards?.[groupField.name] ?? { order: [], hidden: [] };
  const allColumns = orderedNames(
    [...groupField.options, ...rows.map((r) => groupValue(r, groupField)), ""],
    board.order,
  );
  const columns = allColumns.filter((c) => !board.hidden.includes(c));
  const setBoard = (next: typeof board) =>
    onSettings({ ...settings, boards: { ...settings.boards, [groupField.name]: next } });
  const cardsIn = (column: string) => rows.filter((r) => groupValue(r, groupField) === column);
  const dragged = (e: DragEvent) => rows.find((r) => r.id === e.dataTransfer.getData(DRAG_TYPE));
  const accept = (e: DragEvent) => {
    if (e.dataTransfer.types.includes(DRAG_TYPE)) {
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = "move";
      return true;
    }
    return false;
  };

  const moveTo = async (
    row: PageDoc,
    column: string,
    target?: PageDoc,
    position: "before" | "after" = "after",
  ) => {
    if (groupValue(row, groupField) !== column) await setValue(row, groupField, column || null);
    if (target && target.id !== row.id) await reorder(row, target, position);
  };
  const onDropCard = (e: DragEvent, target: PageDoc, column: string) => {
    if (!accept(e)) return;
    const row = dragged(e);
    setDrop(null);
    const position =
      e.clientY <
      e.currentTarget.getBoundingClientRect().top +
        e.currentTarget.getBoundingClientRect().height / 2
        ? "before"
        : "after";
    if (row) void moveTo(row, column, target, position).catch(fail);
  };
  const onDropColumn = (e: DragEvent, column: string) => {
    if (!accept(e)) return;
    const row = dragged(e);
    setDrop(null);
    if (!row) return;
    const others = cardsIn(column).filter((r) => r.id !== row.id);
    const last = others[others.length - 1];
    void moveTo(row, column, last, "after").catch(fail);
  };

  return (
    <div className="view-board">
      {!columns.length && (
        <div className="view-empty">
          All columns are hidden. Show them in the Columns menu.
          {draft !== null && (
            <NewPageInput onCreate={(title) => createPage(title)} onDone={onDraftDone} />
          )}
        </div>
      )}
      {columns.map((column) => {
        const cards = cardsIn(column);
        const active = drop && "column" in drop && drop.column === column;
        return (
          <section
            key={column || "\u0000"}
            className="view-column"
            data-drop={active ? "" : undefined}
            onDragOver={(e) => {
              if (accept(e)) setDrop({ column });
            }}
            onDragLeave={(e) => {
              if (!e.currentTarget.contains(e.relatedTarget as Node)) setDrop(null);
            }}
            onDrop={(e) => onDropColumn(e, column)}
          >
            <header
              className="view-column-header"
              title="Drag to reorder column"
              draggable
              onDragStart={(e) => {
                e.stopPropagation();
                e.dataTransfer.setData("application/graite-board-column", JSON.stringify(column));
                e.dataTransfer.effectAllowed = "move";
              }}
              onDragOver={(e) => {
                if (e.dataTransfer.types.includes("application/graite-board-column")) {
                  e.preventDefault();
                  e.stopPropagation();
                }
              }}
              onDrop={(e) => {
                if (!e.dataTransfer.types.includes("application/graite-board-column")) return;
                e.preventDefault();
                e.stopPropagation();
                try {
                  const source = JSON.parse(
                    e.dataTransfer.getData("application/graite-board-column"),
                  );
                  setBoard({ ...board, order: moveName(allColumns, source, column) });
                } catch {
                  /* Ignore unrelated drops. */
                }
              }}
            >
              <GripVertical size={13} className="view-grip" />
              {column ? (
                <PropertyTag field={groupField} option={column} />
              ) : (
                <span className="view-chip view-chip-text">No {groupField.name}</span>
              )}
              <span className="view-column-count">{cards.length}</span>
              <button
                className="view-hide-column"
                aria-label={`Hide ${column || "ungrouped"} column`}
                onClick={() => setBoard({ ...board, hidden: [...board.hidden, column] })}
              >
                <EyeOff size={13} />
              </button>
            </header>
            <div className="view-column-cards">
              {cards.map((row) => {
                const mark =
                  drop && "card" in drop && drop.card === row.id ? drop.position : undefined;
                return (
                  <article
                    key={row.id}
                    className="view-card"
                    draggable
                    data-drop={mark}
                    onDragStart={(e) => {
                      e.dataTransfer.setData(DRAG_TYPE, row.id);
                      e.dataTransfer.effectAllowed = "move";
                      e.stopPropagation();
                    }}
                    onDragEnd={() => setDrop(null)}
                    onDragOver={(e) => {
                      if (!accept(e)) return;
                      const box = e.currentTarget.getBoundingClientRect();
                      setDrop({
                        card: row.id,
                        position: e.clientY < box.top + box.height / 2 ? "before" : "after",
                      });
                    }}
                    onDrop={(e) => onDropCard(e, row, column)}
                    onClick={() => onOpen(row)}
                  >
                    <div className="view-card-title">
                      <span className="view-page-icon">
                        <PageIcon icon={row.icon} hasContent={hasBodyContent(row.body)} />
                      </span>
                      <span title={row.title}>{row.title || "Untitled"}</span>
                    </div>
                    {!!visible.length && (
                      <div className="view-chips">
                        {visible.map((f) => (
                          <div className="view-card-property" key={f.id}>
                            <PropertyChip page={row} field={f} />
                          </div>
                        ))}
                      </div>
                    )}
                  </article>
                );
              })}
              {(newIn === column ||
                (draft !== null && (columns.includes(draft) ? draft : columns[0]) === column)) && (
                <div className="view-card">
                  <NewPageInput
                    onCreate={(title) =>
                      createPage(title, column ? { field: groupField, value: column } : undefined)
                    }
                    onDone={() => {
                      setNewIn(null);
                      onDraftDone();
                    }}
                  />
                </div>
              )}
            </div>
            <button className="view-column-new" onClick={() => setNewIn(column)}>
              <Plus size={13} />
              New
            </button>
          </section>
        );
      })}
    </div>
  );
}
