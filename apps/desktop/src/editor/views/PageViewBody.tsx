import { useContext, useMemo, useState } from "react";
import { Plus } from "lucide-react";
import { useDismissableLayerSurface } from "@radix-ui/react-dismissable-layer";
import { toast } from "sonner";
import type { PageDoc } from "@/lib/api";
import { MediaContext } from "../media/context";
import type { GraiteEditor } from "../schema";
import { BoardView } from "./BoardView";
import { groupCandidates, sameName, visibleFields, withShown } from "./collection";
import { ListView } from "./ListView";
import { NewPageInput } from "./NewPageInput";
import { TableView } from "./TableView";
import { defaultStatusField, ViewToolbar, type ViewProps } from "./ViewToolbar";
import { useCollection } from "./useCollection";
import { readSettings, projectRows, type ViewSettings } from "./settings";
import "./views.css";

export function PageViewBody({
  id,
  props,
  editor,
}: {
  id: string;
  props: ViewProps;
  editor: GraiteEditor;
}) {
  const { navigate } = useContext(MediaContext);
  const dismissSurface = useDismissableLayerSurface();
  const settings = useMemo(() => readSettings(props.settings), [props.settings]);
  const defaults = useMemo(
    () =>
      settings.fields?.length
        ? settings.fields
        : props.view === "kanban" && (!props.group || props.group === "Status")
          ? [defaultStatusField([])]
          : [],
    [settings.fields, props.view, props.group],
  );
  const collection = useCollection(defaults);
  const { rows, fields, loading, error, addFieldToAll } = collection;
  const [query, setQuery] = useState("");
  const shownCollection = {
    ...collection,
    rows: projectRows(rows, query, settings, props.view === "table"),
  };
  const [draft, setDraft] = useState(false);
  const groupField = groupCandidates(fields).find((f) => sameName(f.name, props.group || "Status"));
  // The board groups by the field, so its cards never repeat it; the table and list still show it.
  const visible = visibleFields(fields, props.show, props.view).filter(
    (f) => props.view !== "kanban" || f !== groupField,
  );
  const onProps = (next: Partial<ViewProps>) =>
    editor.updateBlock(id, { type: "pageView", props: next });
  const onSettings = (next: ViewSettings) => onProps({ settings: JSON.stringify(next) });
  const open = (row: PageDoc) => navigate?.(row.path);
  const done = () => setDraft(false);
  const addStatus = async () => {
    const field = defaultStatusField(fields);
    try {
      await addFieldToAll(field);
      onProps({ group: field.name });
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  let body;
  if (error)
    body = (
      <div className="view-empty" role="alert">
        {error}
      </div>
    );
  else if (loading) body = <div className="view-empty">Loading…</div>;
  else if (!rows.length && !(props.view === "kanban" && groupField))
    body = (
      <div className="view-empty">
        No pages yet.
        {draft ? (
          <NewPageInput onCreate={(title) => collection.createPage(title)} onDone={done} />
        ) : (
          <button className="view-button" onClick={() => setDraft(true)}>
            <Plus size={13} />
            New page
          </button>
        )}
      </div>
    );
  else if (rows.length > 0 && !shownCollection.rows.length && !draft)
    body = <div className="view-empty">No pages match your search or filters.</div>;
  else if (props.view === "kanban" && !groupField)
    body = (
      <div className="view-empty">
        {props.group ? (
          <>
            The property “{props.group}” is not a status or select property on these pages any more.
            Pick another one under “Group by”.
          </>
        ) : (
          <>Choose a status or select property under “Group by” to arrange pages into columns.</>
        )}
        {!groupCandidates(fields).length && (
          <button className="view-button" onClick={() => void addStatus()}>
            <Plus size={13} />
            Add a Status property to every page
          </button>
        )}
      </div>
    );
  else if (props.view === "kanban" && groupField)
    body = (
      <BoardView
        collection={shownCollection}
        settings={settings}
        onSettings={onSettings}
        groupField={groupField}
        visible={visible}
        draft={draft ? (groupField.options[0] ?? "") : null}
        onDraftDone={done}
        onOpen={open}
      />
    );
  else if (props.view === "list")
    body = (
      <ListView
        collection={shownCollection}
        visible={visible}
        draft={draft}
        onDraftDone={done}
        onOpen={open}
      />
    );
  else
    body = (
      <TableView
        collection={shownCollection}
        sort={settings.sort}
        onSort={(sort) => onSettings({ ...settings, sort })}
        onOrder={(names) => onProps({ show: withShown(props.show, "table", names) })}
        visible={visible}
        draft={draft}
        onDraftDone={done}
        onOpen={open}
      />
    );

  // BlockNote's native table handles inspect every HTML cell, including our collection
  // table, then assume its block has editable table content. Keep those mouse events
  // inside this non-editable view; clicks, pointer controls and dragging still work.
  // Radix reads a stopped mousedown/mouseup as an intercepted click and would keep
  // popovers open, so the view is registered as a surface that still dismisses them.
  const containMouse = (event: React.MouseEvent) => event.stopPropagation();
  return (
    <div
      ref={dismissSurface}
      className="page-view"
      data-view={props.view}
      contentEditable={false}
      onMouseMoveCapture={containMouse}
      onMouseDownCapture={containMouse}
      onMouseUpCapture={containMouse}
    >
      <ViewToolbar
        props={props}
        groupField={groupField}
        collection={collection}
        onProps={onProps}
        onNew={() => setDraft(true)}
        matchedCount={shownCollection.rows.length}
        query={query}
        onQuery={setQuery}
        settings={settings}
        onSettings={onSettings}
      />
      {body}
    </div>
  );
}
