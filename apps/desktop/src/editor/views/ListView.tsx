import type { PageDoc } from "@/lib/api";
import type { PageProperty } from "@/lib/workspace";
import { NewPageInput } from "./NewPageInput";
import { PropertyChip } from "./PropertyChip";
import { PageTitle } from "./TableView";
import type { Collection } from "./useCollection";

export function ListView({
  collection,
  visible,
  draft,
  onDraftDone,
  onOpen,
}: {
  collection: Collection;
  visible: PageProperty[];
  draft: boolean;
  onDraftDone: () => void;
  onOpen: (row: PageDoc) => void;
}) {
  return (
    <div className="view-list">
      {collection.rows.map((row) => (
        <div className="view-list-row" key={row.id}>
          <PageTitle row={row} onOpen={onOpen} />
          <div className="view-chips">
            {visible.map((f) => (
              <div className="view-card-property" key={f.id}>
                <PropertyChip page={row} field={f} />
              </div>
            ))}
          </div>
        </div>
      ))}
      {draft && (
        <div className="view-list-row">
          <NewPageInput onCreate={(title) => collection.createPage(title)} onDone={onDraftDone} />
        </div>
      )}
    </div>
  );
}
