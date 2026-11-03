import { useRef, useState } from "react";
import { Check, Info, RefreshCw, Tag } from "lucide-react";
import { toast } from "sonner";
import { tables } from "@/lib/tables";
import {
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from "@/components/ui/dropdown-menu";
import { TypeIcon } from "./columns";
import type { TableMeta } from "./useTableRows";

/** One field in the Name or Detail submenu, checked when it is the current choice. */
function FieldChoice({
  label,
  type,
  chosen,
  onSelect,
}: {
  label: string;
  type?: string;
  chosen: boolean;
  onSelect: () => void;
}) {
  return (
    <DropdownMenuItem onSelect={onSelect}>
      {type ? <TypeIcon type={type} size={14} /> : <span className="table-menu-icon-gap" />}
      {label}
      {chosen && <Check className="ml-auto" />}
    </DropdownMenuItem>
  );
}

function NameInput({
  initial,
  placeholder,
  onDone,
}: {
  initial: string;
  placeholder: string;
  onDone: (name: string | null) => void;
}) {
  const [name, setName] = useState(initial);
  const done = useRef(false);
  const finish = (value: string | null) => {
    if (done.current) return;
    done.current = true;
    onDone(value);
  };
  return (
    <input
      className="table-tab-input"
      autoFocus
      value={name}
      placeholder={placeholder}
      aria-label={placeholder}
      maxLength={120}
      size={Math.max(8, name.length + 1)}
      onFocus={(e) => e.currentTarget.select()}
      onChange={(e) => setName(e.target.value)}
      onBlur={() => finish(name.trim() && name.trim() !== initial ? name.trim() : null)}
      onKeyDown={(e) => {
        if (e.key === "Enter") finish(name.trim() && name.trim() !== initial ? name.trim() : null);
        else if (e.key === "Escape") finish(null);
        else return;
        e.preventDefault();
      }}
    />
  );
}

/** A table's own settings in a tab menu: the fields that name its rows in links, and a
 *  refresh of the labels other tables store. Shared by table tabs and view tabs. */
export function TableNamingItems({ meta, onChanged }: { meta: TableMeta; onChanged: () => void }) {
  // Fields that can name a row: not the id, and not links to other rows.
  const fields = meta.columns.filter((c) => c.name !== meta.primary_key && c.type !== "relation");
  const setDisplay = (key: "display" | "display_secondary", value: string) => {
    // Links elsewhere store the label: rewrite them when the naming field changes.
    tables
      .schema(meta.path, { [key]: value || null })
      .then(() => (key === "display" ? tables.refreshLabels(meta.path) : undefined))
      .then(onChanged)
      .catch((e: Error) => toast.error(e.message));
  };
  return (
    <>
      <DropdownMenuLabel className="table-menu-label">Shown in links as</DropdownMenuLabel>
      <DropdownMenuSub>
        <DropdownMenuSubTrigger>
          <Tag /> Name
          <span className="table-menu-current">{meta.display ?? meta.label_column ?? "—"}</span>
        </DropdownMenuSubTrigger>
        <DropdownMenuSubContent className="table-tab-fields">
          <FieldChoice
            label={
              meta.label_column && !meta.display ? `Automatic (${meta.label_column})` : "Automatic"
            }
            chosen={!meta.display}
            onSelect={() => setDisplay("display", "")}
          />
          <DropdownMenuSeparator />
          {fields.map((c) => (
            <FieldChoice
              key={c.name}
              label={c.name}
              type={c.type}
              chosen={meta.display === c.name}
              onSelect={() => setDisplay("display", c.name)}
            />
          ))}
        </DropdownMenuSubContent>
      </DropdownMenuSub>
      <DropdownMenuSub>
        <DropdownMenuSubTrigger>
          <Info /> Detail
          <span className="table-menu-current">{meta.display_secondary ?? "None"}</span>
        </DropdownMenuSubTrigger>
        <DropdownMenuSubContent className="table-tab-fields">
          <p className="table-menu-hint">
            Shown next to the name, to tell rows with the same name apart.
          </p>
          <FieldChoice
            label="None"
            chosen={!meta.display_secondary}
            onSelect={() => setDisplay("display_secondary", "")}
          />
          <DropdownMenuSeparator />
          {fields.map((c) => (
            <FieldChoice
              key={c.name}
              label={c.name}
              type={c.type}
              chosen={meta.display_secondary === c.name}
              onSelect={() => setDisplay("display_secondary", c.name)}
            />
          ))}
        </DropdownMenuSubContent>
      </DropdownMenuSub>
      <DropdownMenuSeparator />
      <DropdownMenuItem
        onSelect={() =>
          void tables
            .refreshLabels(meta.path)
            .then(() => toast.success("Link labels updated."))
            .catch((e: Error) => toast.error(e.message))
        }
      >
        <RefreshCw />
        <span className="table-menu-two-line">
          Refresh link labels
          <small>Update the names stored in other tables</small>
        </span>
      </DropdownMenuItem>
    </>
  );
}

/** A tab name being typed: Enter or leaving the field keeps it, Escape cancels. */
export { NameInput };
