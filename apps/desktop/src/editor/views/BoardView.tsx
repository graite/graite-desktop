import { useState, type DragEvent } from "react";
import { Plus, GripVertical, EyeOff } from "lucide-react";
import { toast } from "sonner";
import type { PageProperty } from "@/lib/workspace";
import { PropertyTag } from "@/pages/PropertySelect";
import type { BoardItem, BoardSource } from "./board";
import { NewPageInput } from "./NewPageInput";
import { orderedNames, moveName } from "./settings";
import { RowMenu } from "./RowMenu";

export const DRAG_TYPE = "application/graite-view-page";
type Drop = { card: string; position: "before" | "after" } | { column: string } | null;
/** A board's column order and hidden columns. */
export interface BoardLayout {
  order: string[];
  hidden: string[];
}

/** Cards in columns by a status or select field. Pages or table rows (see board.ts). */
export function BoardView<R extends BoardItem>({
  source,
  groupField,
  draft,
  onDraftDone,
  onOpen,
  board,
  onBoard,
}: {
  source: BoardSource<R>;
  /** The grouping field; its options are the columns, in this order unless `board` says. */
  groupField: PageProperty;
  draft: string | null;
  onDraftDone: () => void;
  onOpen: (row: R) => void;
  board: BoardLayout;
  onBoard: (next: BoardLayout) => void;
}) {
  const { rows } = source;
  const [drop, setDrop] = useState<Drop>(null);
  const [newIn, setNewIn] = useState<string | null>(null);
  const fail = (e: unknown) => toast.error((e as Error).message);

  const allColumns = orderedNames(
    [...groupField.options, ...rows.map((r) => source.group(r)), ""],
    board.order,
  );
  const columns = allColumns.filter((c) => !board.hidden.includes(c));
  const setBoard = onBoard;
  const cardsIn = (column: string) => rows.filter((r) => source.group(r) === column);
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

  const moveTo = (row: R, column: string, target?: R, position: "before" | "after" = "after") =>
    source.move(row, column, target && target.id !== row.id ? target : undefined, position);
  const onDropCard = (e: DragEvent, target: R, column: string) => {
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
            <NewPageInput
              onCreate={(title) => source.create(title)}
              onDone={onDraftDone}
              placeholder={source.placeholder}
            />
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
                    tabIndex={0}
                    onKeyDown={(e) => {
                      if (e.target !== e.currentTarget) return;
                      if (e.key === "Enter") onOpen(row);
                      if (e.key === "Delete" || e.key === "Backspace") {
                        e.preventDefault();
                        void source.remove(row);
                      }
                    }}
                  >
                    <div className="view-card-title">
                      <span className="view-page-icon">{source.icon(row)}</span>
                      <span title={row.title}>{row.title || "Untitled"}</span>
                    </div>
                    <RowMenu row={row} handle="dots" onDelete={(r) => void source.remove(r)} />
                    {source.chips(row)}
                  </article>
                );
              })}
              {(newIn === column ||
                (draft !== null && (columns.includes(draft) ? draft : columns[0]) === column)) && (
                <div className="view-card">
                  <NewPageInput
                    placeholder={source.placeholder}
                    onCreate={(title) => source.create(title, column || undefined)}
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
