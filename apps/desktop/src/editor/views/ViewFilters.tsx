import { useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  Check,
  ChevronDown,
  Equal,
  EqualNot,
  MoreHorizontal,
  Plus,
  Search,
  SquareCheck,
  SquareDashed,
  Trash2,
  X,
} from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { PropertyIcon } from "@/pages/PageProperties";
import { PropertyTag } from "@/pages/PropertySelect";
import type { PageProperty } from "@/lib/workspace";
import type { ViewFilter } from "./settings";

const conditions = {
  contains: { label: "Contains", icon: Search },
  equals: { label: "Is", icon: Equal },
  not: { label: "Is not", icon: EqualNot },
  empty: { label: "Is empty", icon: SquareDashed },
  filled: { label: "Is not empty", icon: SquareCheck },
  gt: { label: "Greater / after", icon: ArrowUp },
  lt: { label: "Less / before", icon: ArrowDown },
};
const fieldName = (name: string) => (name === "$title" ? "Name" : name);

function FieldMenu({
  fields,
  selected,
  onPick,
}: {
  fields: PageProperty[];
  selected?: string;
  onPick: (name: string) => void;
}) {
  return (
    <>
      {["$title", ...fields.map((f) => f.name)].map((name) => (
        <button key={name} className="view-menu-item" onClick={() => onPick(name)}>
          <PropertyIcon type={fields.find((f) => f.name === name)?.type ?? "text"} />
          <span>{fieldName(name)}</span>
          {selected === name && <Check size={13} className="ml-auto" />}
        </button>
      ))}
    </>
  );
}

export function AddViewFilter({
  fields,
  onAdd,
}: {
  fields: PageProperty[];
  onAdd: (field: string) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger className="view-button" aria-label="Add filter">
        <Plus size={13} />
        Filter
      </PopoverTrigger>
      <PopoverContent className="view-menu" align="start">
        <small>Filter by property</small>
        <FieldMenu
          fields={fields}
          onPick={(field) => {
            setOpen(false);
            onAdd(field);
          }}
        />
      </PopoverContent>
    </Popover>
  );
}

function FilterEditor({
  filter,
  fields,
  onChange,
  onRemove,
  onDone,
}: {
  filter: ViewFilter;
  fields: PageProperty[];
  onChange: (next: ViewFilter) => void;
  onRemove: () => void;
  onDone: () => void;
}) {
  const [fieldOpen, setFieldOpen] = useState(false);
  const [conditionOpen, setConditionOpen] = useState(false);
  const field = fields.find((f) => f.name === filter.field);
  const choices =
    field &&
    ["status", "single_select", "multi_select"].includes(field.type) &&
    ["equals", "not"].includes(filter.op)
      ? field.options
      : [];
  return (
    <div className="view-filter-editor">
      <div className="view-filter-heading">
        <Popover open={fieldOpen} onOpenChange={setFieldOpen}>
          <PopoverTrigger className="view-button" aria-label="Filter property">
            <PropertyIcon type={field?.type ?? "text"} />
            <span>{fieldName(filter.field)}</span>
            <ChevronDown size={12} />
          </PopoverTrigger>
          <PopoverContent className="view-menu" align="start">
            <FieldMenu
              fields={fields}
              selected={filter.field}
              onPick={(name) => {
                onChange({ ...filter, field: name, value: "" });
                setFieldOpen(false);
              }}
            />
          </PopoverContent>
        </Popover>
        <Popover open={conditionOpen} onOpenChange={setConditionOpen}>
          <PopoverTrigger className="view-button" aria-label="Filter condition">
            {conditions[filter.op].label}
            <ChevronDown size={12} />
          </PopoverTrigger>
          <PopoverContent className="view-menu" align="start">
            {Object.entries(conditions).map(([op, { label, icon: Icon }]) => (
              <button
                key={op}
                className="view-menu-item"
                onClick={() => {
                  onChange({ ...filter, op: op as ViewFilter["op"] });
                  setConditionOpen(false);
                }}
              >
                <Icon size={14} />
                {label}
                {filter.op === op && <Check size={13} className="ml-auto" />}
              </button>
            ))}
          </PopoverContent>
        </Popover>
        <Popover>
          <PopoverTrigger className="view-button view-filter-more" aria-label="Filter actions">
            <MoreHorizontal size={15} />
          </PopoverTrigger>
          <PopoverContent className="view-menu" align="end">
            <button className="view-menu-item" onClick={onRemove}>
              <Trash2 size={14} />
              Remove filter
            </button>
          </PopoverContent>
        </Popover>
      </div>
      {!["empty", "filled"].includes(filter.op) && (
        <div className="view-filter-input">
          <input
            autoFocus
            aria-label="Filter value"
            placeholder="Enter a value…"
            value={filter.value}
            onChange={(e) => onChange({ ...filter, value: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === "Enter") onDone();
            }}
          />
          {filter.value && (
            <button
              aria-label="Clear filter value"
              onClick={() => onChange({ ...filter, value: "" })}
            >
              <X size={13} />
            </button>
          )}
        </div>
      )}
      {!!choices.length && (
        <div className="view-filter-options">
          {choices
            .filter((o) => o.toLowerCase().includes(filter.value.toLowerCase()))
            .map((option) => (
              <button
                className="view-menu-item"
                key={option}
                onClick={() => {
                  onChange({ ...filter, value: option });
                  onDone();
                }}
              >
                <PropertyTag field={field!} option={option} />
                {option === filter.value && <Check size={13} className="ml-auto" />}
              </button>
            ))}
        </div>
      )}
    </div>
  );
}

export function ViewFilterPills({
  fields,
  filters,
  openIndex,
  onOpen,
  onChange,
  onAdd,
}: {
  fields: PageProperty[];
  filters: ViewFilter[];
  openIndex: number | null;
  onOpen: (index: number | null) => void;
  onChange: (filters: ViewFilter[]) => void;
  onAdd: (field: string) => void;
}) {
  return (
    <div className="view-filter-pills" aria-label="Active filters">
      {filters.map((filter, index) => {
        const label = `${fieldName(filter.field)}: ${conditions[filter.op].label}${["empty", "filled"].includes(filter.op) ? "" : ` ${filter.value || "…"}`}`;
        return (
          <Popover
            key={index}
            open={openIndex === index}
            onOpenChange={(open) => onOpen(open ? index : null)}
          >
            <PopoverTrigger
              className="view-filter-pill"
              title={label}
              aria-label={`Edit filter: ${label}`}
            >
              <PropertyIcon type={fields.find((f) => f.name === filter.field)?.type ?? "text"} />
              <span>{label}</span>
              <ChevronDown size={12} />
            </PopoverTrigger>
            <PopoverContent align="start" className="view-filter-popover">
              <FilterEditor
                filter={filter}
                fields={fields}
                onChange={(next) => onChange(filters.map((f, i) => (i === index ? next : f)))}
                onRemove={() => {
                  onOpen(null);
                  onChange(filters.filter((_, i) => i !== index));
                }}
                onDone={() => onOpen(null)}
              />
            </PopoverContent>
          </Popover>
        );
      })}
      <AddViewFilter fields={fields} onAdd={onAdd} />
    </div>
  );
}
