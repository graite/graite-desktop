import { ArrowDown, ArrowUp, ArrowUpDown, Check, X } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

export interface SortChoice {
  field: string;
  direction: "asc" | "desc";
}

/**
 * The toolbar's Sort button, for every layout (D82): pick a field and a direction, or clear.
 * Used by database blocks and subpage views alike; `label` names a field (e.g. "$title").
 */
export function SortButton({
  fields,
  value,
  onChange,
  label = (name) => name,
}: {
  fields: string[];
  value: SortChoice | null;
  onChange: (sort: SortChoice | null) => void;
  label?: (field: string) => string;
}) {
  const direction = value?.direction ?? "asc";
  return (
    <Popover>
      <PopoverTrigger
        className={`view-button ${value ? "view-button-active" : ""}`}
        aria-label="Sort"
        title="Sort"
      >
        {value ? (
          value.direction === "asc" ? (
            <ArrowUp size={13} />
          ) : (
            <ArrowDown size={13} />
          )
        ) : (
          <ArrowUpDown size={13} />
        )}
        {value ? label(value.field) : "Sort"}
      </PopoverTrigger>
      <PopoverContent align="end" className="view-menu view-sort-menu">
        <small>Sort by</small>
        <div className="view-sort-fields" role="listbox" aria-label="Sort by">
          {fields.map((field) => (
            <button
              key={field}
              type="button"
              role="option"
              aria-selected={value?.field === field}
              className="view-menu-item"
              onClick={() => onChange({ field, direction })}
            >
              {label(field)}
              {value?.field === field && <Check size={13} className="ml-auto" />}
            </button>
          ))}
        </div>
        <div className="view-sort-direction" role="radiogroup" aria-label="Direction">
          {(["asc", "desc"] as const).map((d) => (
            <button
              key={d}
              type="button"
              role="radio"
              aria-checked={direction === d}
              disabled={!value}
              className={`view-chip-choice ${value && direction === d ? "active" : ""}`}
              onClick={() => value && onChange({ field: value.field, direction: d })}
            >
              {d === "asc" ? <ArrowUp size={12} /> : <ArrowDown size={12} />}
              {d === "asc" ? "Ascending" : "Descending"}
            </button>
          ))}
        </div>
        {value && (
          <button type="button" className="view-menu-item" onClick={() => onChange(null)}>
            <X size={13} />
            Clear sort
          </button>
        )}
      </PopoverContent>
    </Popover>
  );
}
