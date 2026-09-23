import { useState } from "react";
import { Check, MoreHorizontal, Plus, Trash2 } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import type { PageProperty } from "@/lib/workspace";

export const tagColors = [
  "default",
  "gray",
  "brown",
  "orange",
  "yellow",
  "green",
  "blue",
  "purple",
  "pink",
  "red",
];
export function optionColor(field: PageProperty, option: string) {
  if (field.colors?.[option]) return field.colors[option];
  if (/^(done|complete|completed)$/i.test(option)) return "green";
  if (/progress|doing/i.test(option)) return "yellow";
  if (/hold|blocked/i.test(option)) return "red";
  return ["blue", "purple", "green", "orange", "pink"][
    Math.max(0, field.options.indexOf(option)) % 5
  ];
}
export function PropertyTag({ field, option }: { field: PageProperty; option: string }) {
  return (
    <span className="property-tag" data-color={optionColor(field, option)}>
      {field.type === "status" && <span className="property-status-dot" />}
      {option}
    </span>
  );
}

function OptionSettings({
  field,
  option,
  save,
}: {
  field: PageProperty;
  option: string;
  save: (field: PageProperty) => void;
}) {
  const [name, setName] = useState(option);
  const rename = () => {
    const next = name.trim();
    if (!next || next === option || field.options.includes(next)) return;
    const colors = { ...field.colors };
    delete colors[option];
    colors[next] = optionColor(field, option);
    save({
      ...field,
      options: field.options.map((o) => (o === option ? next : o)),
      colors,
      value: Array.isArray(field.value)
        ? field.value.map((o) => (o === option ? next : o))
        : field.value === option
          ? next
          : field.value,
    });
  };
  return (
    <div className="property-option-settings">
      <input
        aria-label="Option name"
        value={name}
        maxLength={100}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") rename();
        }}
      />
      {name.trim() !== option && (
        <button disabled={!name.trim() || field.options.includes(name.trim())} onClick={rename}>
          <Check size={14} /> Save name
        </button>
      )}
      <button
        onClick={() =>
          save({
            ...field,
            options: field.options.filter((o) => o !== option),
            value: Array.isArray(field.value)
              ? field.value.filter((o) => o !== option)
              : field.value === option
                ? null
                : field.value,
          })
        }
      >
        <Trash2 size={14} /> Delete option
      </button>
      <small>Colors</small>
      {tagColors.map((color) => (
        <button
          key={color}
          onClick={() => save({ ...field, colors: { ...field.colors, [option]: color } })}
        >
          <span className="property-color-swatch property-tag" data-color={color} />
          {color[0].toUpperCase() + color.slice(1)}
          {optionColor(field, option) === color && <Check size={13} className="ml-auto" />}
        </button>
      ))}
    </div>
  );
}

export function PropertySelect({
  field,
  disabled,
  onChange,
  onFieldChange,
}: {
  field: PageProperty;
  disabled: boolean;
  onChange: (value: PageProperty["value"]) => void;
  onFieldChange?: (field: PageProperty) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const selected = Array.isArray(field.value)
    ? field.value
    : typeof field.value === "string" && field.value
      ? [field.value]
      : [];
  const choose = (option: string) => {
    onChange(
      field.type === "multi_select"
        ? selected.includes(option)
          ? selected.filter((o) => o !== option)
          : [...selected, option]
        : selected.includes(option)
          ? null
          : option,
    );
    if (field.type !== "multi_select") setOpen(false);
  };
  return (
    <Popover
      open={open}
      onOpenChange={(v) => {
        setOpen(v);
        setQuery("");
      }}
    >
      <PopoverTrigger
        className="property-select-trigger"
        aria-label={field.name}
        disabled={disabled}
      >
        {selected.length ? (
          selected.map((o) => <PropertyTag key={o} field={field} option={o} />)
        ) : (
          <span className="property-empty">Empty</span>
        )}
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="property-select-menu"
        onClick={(e) => e.stopPropagation()}
      >
        <input
          aria-label="Find or create an option"
          placeholder="Select an option or create one…"
          value={query}
          maxLength={100}
          onChange={(e) => setQuery(e.target.value)}
        />
        <div className="property-options-list">
          {field.options
            .filter((o) => o.toLowerCase().includes(query.toLowerCase()))
            .map((option) => (
              <div className="property-choice" key={option}>
                <button disabled={disabled} onClick={() => choose(option)}>
                  <PropertyTag field={field} option={option} />
                  {selected.includes(option) && <Check size={14} className="ml-auto" />}
                </button>
                {onFieldChange && (
                  <Popover>
                    <PopoverTrigger aria-label={`Edit ${option}`} disabled={disabled}>
                      <MoreHorizontal size={15} />
                    </PopoverTrigger>
                    <PopoverContent side="right" align="start" className="property-option-editor">
                      <OptionSettings field={field} option={option} save={onFieldChange} />
                    </PopoverContent>
                  </Popover>
                )}
              </div>
            ))}
        </div>
        {onFieldChange && query.trim() && !field.options.includes(query.trim()) && (
          <button
            className="property-create-option"
            disabled={disabled}
            onClick={() => {
              const option = query.trim();
              onFieldChange({
                ...field,
                options: [...field.options, option],
                value: field.type === "multi_select" ? [...selected, option] : option,
              });
              setQuery("");
              if (field.type !== "multi_select") setOpen(false);
            }}
          >
            <Plus size={14} /> Create “{query.trim()}”
          </button>
        )}
        {!field.options.length && !query && (
          <small className="property-empty">Type to create your first option.</small>
        )}
      </PopoverContent>
    </Popover>
  );
}
