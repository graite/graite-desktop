import { useEffect, useState } from "react";
import { Check, ChevronDown, Plus, SlidersHorizontal, Columns3 } from "lucide-react";
import { toast } from "sonner";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import type { PageProperty } from "@/lib/workspace";
import { PropertyForm, PropertyIcon } from "@/pages/PageProperties";
import {
  groupCandidates,
  sameName,
  viewKinds,
  viewLabels,
  visibleFields,
  withShown,
  type ViewKind,
} from "./collection";
import { ArrangeItems } from "./ArrangeItems";
import { groupValue } from "./collection";
import { orderedNames, type ViewSettings } from "./settings";
import { AddViewFilter, ViewFilterPills } from "./ViewFilters";
import { ViewSearch } from "./ViewSearch";
import type { Collection } from "./useCollection";

export type ViewProps = { view: ViewKind; group: string; show: string; settings?: string };

/** A Status property definition whose name does not collide with the existing fields. */
export function defaultStatusField(fields: PageProperty[]): PageProperty {
  let name = "Status";
  let suffix = 2;
  while (fields.some((f) => sameName(f.name, name))) name = `Status ${suffix++}`;
  return {
    id: "",
    name,
    type: "status",
    options: ["Backlog", "To do", "In progress", "Done"],
    colors: { Backlog: "gray", "To do": "gray", "In progress": "yellow", Done: "green" },
    value: null,
  };
}

export function ViewToolbar({
  props,
  groupField,
  collection,
  onProps,
  onNew,
  matchedCount,
  query,
  onQuery,
  settings,
  onSettings,
}: {
  props: ViewProps;
  groupField?: PageProperty;
  collection: Collection;
  onProps: (next: Partial<ViewProps>) => void;
  onNew: () => void;
  matchedCount: number;
  query: string;
  onQuery: (value: string) => void;
  settings: ViewSettings;
  onSettings: (next: ViewSettings) => void;
}) {
  const { view, group, show } = props;
  const { fields, rows, addFieldToAll } = collection;
  const [editingFilter, setEditingFilter] = useState<number | null>(null);
  const [adding, setAdding] = useState(false);
  const [propsOpen, setPropsOpen] = useState(false);
  // The block re-renders a microtask after `updateBlock`; keep the last written value so the
  // checkboxes reflect a click immediately instead of snapping back for one frame.
  const [draftShow, setDraftShow] = useState<string | null>(null);
  useEffect(() => setDraftShow(null), [show, view]);
  const effectiveShow = draftShow ?? show;
  const candidates = groupCandidates(fields);
  const listed = view === "kanban" ? fields.filter((f) => f !== groupField) : fields;
  const visibleNames = visibleFields(listed, effectiveShow, view).map((f) => f.name);
  const isShown = (field: PageProperty) => visibleNames.some((n) => sameName(n, field.name));

  const write = (names: string[]) => {
    const next = withShown(effectiveShow, view, names);
    setDraftShow(next);
    onProps({ show: next });
  };
  const names = orderedNames(
    listed.map((f) => f.name),
    visibleNames,
  );
  const toggle = (field: PageProperty) =>
    write(
      isShown(field)
        ? visibleNames.filter((n) => !sameName(n, field.name))
        : names.filter((n) => visibleNames.includes(n) || n === field.name),
    );
  const board = settings.boards?.[groupField?.name ?? group] ?? { order: [], hidden: [] };
  const columns = groupField
    ? orderedNames(
        [...groupField.options, ...rows.map((row) => groupValue(row, groupField)), ""],
        board.order,
      )
    : [];
  const setBoard = (next: typeof board) =>
    onSettings({ ...settings, boards: { ...settings.boards, [groupField?.name ?? group]: next } });
  const filters = settings.filters ?? [];
  const addFilter = (field: string) => {
    const type = fields.find((f) => f.name === field)?.type;
    onSettings({
      ...settings,
      filters: [
        ...filters,
        {
          field,
          op:
            type &&
            ["status", "single_select", "multi_select", "checkbox", "number", "date"].includes(type)
              ? "equals"
              : "contains",
          value: "",
        },
      ],
    });
    setEditingFilter(filters.length);
  };
  const addStatus = async () => {
    const field = defaultStatusField(fields);
    try {
      await addFieldToAll(field);
      onProps({ group: field.name });
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  return (
    <div className="view-toolbar" contentEditable={false}>
      <div className="view-tabs" role="tablist" aria-label="View type">
        {viewKinds.map((kind) => (
          <button
            key={kind}
            role="tab"
            aria-selected={view === kind}
            onClick={() => onProps({ view: kind })}
          >
            {viewLabels[kind]}
          </button>
        ))}
      </div>
      <span className="view-count">
        {matchedCount === rows.length ? rows.length : `${matchedCount} of ${rows.length}`}{" "}
        {rows.length === 1 ? "page" : "pages"}
      </span>
      <div className="view-actions">
        <ViewSearch query={query} onQuery={onQuery} />
        {!filters.length && <AddViewFilter fields={fields} onAdd={addFilter} />}
        {view === "kanban" && groupField && (
          <Popover>
            <PopoverTrigger className="view-button">
              <Columns3 size={13} />
              Columns
            </PopoverTrigger>
            <PopoverContent align="end" className="view-menu">
              <small>Drag to reorder columns. Uncheck to hide.</small>
              <ArrangeItems
                names={columns}
                label={(n) => n || `No ${groupField.name}`}
                shown={(n) => !board.hidden.includes(n)}
                onToggle={(n) =>
                  setBoard({
                    ...board,
                    hidden: board.hidden.includes(n)
                      ? board.hidden.filter((v) => v !== n)
                      : [...board.hidden, n],
                  })
                }
                onOrder={(order) => setBoard({ ...board, order })}
              />
            </PopoverContent>
          </Popover>
        )}
        {view === "kanban" && (
          <Popover>
            <PopoverTrigger
              className="view-button"
              aria-label="Group by property"
              data-missing={!!group && !groupField ? "" : undefined}
            >
              Group by: {groupField?.name ?? (group ? `${group} (missing)` : "none")}
              <ChevronDown size={13} />
            </PopoverTrigger>
            <PopoverContent align="end" className="view-menu">
              {candidates.map((f) => (
                <button
                  key={f.name}
                  className="view-menu-item"
                  onClick={() => onProps({ group: f.name })}
                >
                  <PropertyIcon type={f.type} />
                  {f.name}
                  {f === groupField && <Check size={13} className="ml-auto" />}
                </button>
              ))}
              {!candidates.length && (
                <small>No status or select property on these pages yet.</small>
              )}
              <button className="view-menu-item view-menu-add" onClick={() => void addStatus()}>
                <Plus size={13} />
                Add a Status property to every page
              </button>
            </PopoverContent>
          </Popover>
        )}
        <Popover
          open={propsOpen}
          onOpenChange={(o) => {
            setPropsOpen(o);
            setAdding(false);
          }}
        >
          <PopoverTrigger className="view-button" aria-label="Shown properties">
            <SlidersHorizontal size={13} />
            Properties
          </PopoverTrigger>
          <PopoverContent align="end" className="view-menu">
            {adding ? (
              <PropertyForm
                onSave={async (field) => {
                  await addFieldToAll(field);
                  write([...visibleNames, field.name]);
                  setAdding(false);
                }}
              />
            ) : (
              <>
                <small>
                  {view === "table"
                    ? `Columns in this ${viewLabels[view].toLowerCase()}`
                    : `Shown on each ${viewLabels[view].toLowerCase()} card`}{" "}
                  · only this view
                </small>
                <ArrangeItems
                  names={names}
                  label={(name) => (
                    <>
                      <PropertyIcon type={listed.find((f) => f.name === name)!.type} />
                      {name}
                    </>
                  )}
                  shown={(name) => visibleNames.includes(name)}
                  onToggle={(name) => toggle(listed.find((f) => f.name === name)!)}
                  onOrder={(order) => write(order.filter((n) => visibleNames.includes(n)))}
                />
                {!listed.length && <small>No properties yet.</small>}
                <button className="view-menu-item view-menu-add" onClick={() => setAdding(true)}>
                  <Plus size={13} />
                  New property for every page
                </button>
              </>
            )}
          </PopoverContent>
        </Popover>
        <button className="view-button view-button-primary" onClick={onNew}>
          <Plus size={13} />
          New
        </button>
      </div>
      {!!filters.length && (
        <ViewFilterPills
          fields={fields}
          filters={filters}
          openIndex={editingFilter}
          onOpen={setEditingFilter}
          onChange={(next) => onSettings({ ...settings, filters: next })}
          onAdd={addFilter}
        />
      )}
    </div>
  );
}
