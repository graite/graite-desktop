import type { BoardItem, BoardSource } from "./board";
import { NewPageInput } from "./NewPageInput";
import { RowMenu } from "./RowMenu";

/** Items one per line with their fields. Pages or table rows (see board.ts). */
export function ListView<R extends BoardItem>({
  source,
  draft,
  onDraftDone,
  onOpen,
}: {
  source: BoardSource<R>;
  draft: boolean;
  onDraftDone: () => void;
  onOpen: (row: R) => void;
}) {
  return (
    <div className="view-list">
      {source.rows.map((row) => (
        <div className="view-list-row" key={row.id}>
          <div className="view-list-lead">
            <RowMenu row={row} handle="grip" onDelete={(r) => void source.remove(r)} />
            <button className="view-page" onClick={() => onOpen(row)}>
              <span className="view-page-icon">{source.icon(row)}</span>
              <span title={row.title}>{row.title || "Untitled"}</span>
            </button>
          </div>
          {source.chips(row)}
        </div>
      ))}
      {draft && (
        <div className="view-list-row">
          <NewPageInput
            onCreate={(title) => source.create(title)}
            onDone={onDraftDone}
            placeholder={source.placeholder}
          />
        </div>
      )}
    </div>
  );
}
