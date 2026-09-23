import { useEffect, useState } from "react";
import {
  Plus,
  Paperclip,
  AlignLeft,
  Hash,
  CircleChevronDown,
  List,
  Calendar,
  SquareCheck,
  AtSign,
  Link,
  CircleDashed,
  Clock,
  Check,
} from "lucide-react";
import { toast } from "sonner";
import { pages, type PageDoc } from "@/lib/api";
import { media } from "@/lib/media";
import {
  pageProperties,
  propertyTypes,
  type PageProperty,
  type PropertyKind,
} from "@/lib/workspace";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { PropertySelect } from "./PropertySelect";
import { DateField } from "./DateField";
import "./pages.css";

const propertyIcons = {
  text: AlignLeft,
  number: Hash,
  single_select: CircleChevronDown,
  multi_select: List,
  date: Calendar,
  checkbox: SquareCheck,
  email: AtSign,
  url: Link,
  media: Paperclip,
  status: CircleDashed,
  created: Clock,
  updated: Clock,
};
export function PropertyIcon({ type }: { type: PropertyKind }) {
  const Icon = propertyIcons[type];
  return <Icon size={15} />;
}

export function PropertyValue({
  page,
  field,
  onChange,
  onFieldChange,
  disabled = false,
}: {
  page: PageDoc;
  field: PageProperty;
  onChange: (value: PageProperty["value"]) => void;
  disabled?: boolean;
  onFieldChange?: (field: PageProperty) => void;
}) {
  const [draft, setDraft] = useState(String(field.value ?? ""));
  useEffect(() => setDraft(String(field.value ?? "")), [field.value]);
  const [preview, setPreview] = useState("");
  useEffect(() => {
    if (
      field.type !== "media" ||
      typeof field.value !== "string" ||
      !/\.(png|jpe?g|webp)$/i.test(field.value)
    ) {
      setPreview("");
      return;
    }
    let live = true;
    let url = "";
    void media
      .blob(page.id, field.value)
      .then((blob) => {
        if (live) {
          url = URL.createObjectURL(blob);
          setPreview(url);
        }
      })
      .catch(() => {});
    return () => {
      live = false;
      if (url) URL.revokeObjectURL(url);
    };
  }, [page.id, field.type, field.value]);
  if (field.type === "created" || field.type === "updated")
    return (
      <span className="property-readonly">
        {String(page.frontmatter[field.type] ?? "—")
          .replace("T", " ")
          .replace(/\.\d+Z$|Z$/, "")}
      </span>
    );
  if (field.type === "checkbox")
    return (
      <input
        type="checkbox"
        aria-label={field.name}
        checked={field.value === true}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
    );
  if (["single_select", "status", "multi_select"].includes(field.type))
    return (
      <PropertySelect
        field={field}
        disabled={disabled}
        onChange={onChange}
        onFieldChange={onFieldChange}
      />
    );
  if (field.type === "date")
    return (
      <DateField
        value={typeof field.value === "string" && field.value ? field.value : null}
        label={field.name}
        disabled={disabled}
        onChange={onChange}
      />
    );
  if (field.type === "media")
    return (
      <div className="property-media">
        {preview && (
          <img src={preview} alt={field.name} className="property-thumbnail" draggable={false} />
        )}
        {field.value && (
          <button
            type="button"
            onClick={() =>
              void media
                .blob(page.id, String(field.value))
                .then((blob) => {
                  const a = document.createElement("a");
                  const url = URL.createObjectURL(blob);
                  a.href = url;
                  a.download = String(field.value);
                  a.click();
                  setTimeout(() => URL.revokeObjectURL(url), 60000);
                })
                .catch((e) => toast.error((e as Error).message))
            }
          >
            <Paperclip size={13} />
            {String(field.value).replace(/^[a-f0-9]{32}-/, "")}
          </button>
        )}
        <label className="property-upload">
          {field.value ? "Replace" : "Choose file"}
          <input
            type="file"
            hidden
            disabled={disabled}
            accept="image/png,image/jpeg,image/webp,.pdf,audio/*"
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = "";
              if (file)
                void media
                  .upload(page.id, file, file.name)
                  .then((result) => onChange(result.file))
                  .catch((e) => toast.error((e as Error).message));
            }}
          />
        </label>
        {field.value && (
          <button onClick={() => onChange(null)} disabled={disabled}>
            Clear
          </button>
        )}
      </div>
    );
  return (
    <input
      aria-label={field.name}
      step={field.type === "number" ? "any" : undefined}
      type={
        field.type === "number"
          ? "number"
          : field.type === "email"
            ? "email"
            : field.type === "url"
              ? "url"
              : "text"
      }
      value={draft}
      placeholder="Empty"
      disabled={disabled}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={(e) => {
        if (e.target.checkValidity() && draft !== String(field.value ?? ""))
          onChange(field.type === "number" ? (draft === "" ? null : Number(draft)) : draft);
        else if (!e.target.checkValidity()) {
          e.target.reportValidity();
        }
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.currentTarget.blur();
      }}
    />
  );
}

export function PropertyForm({
  initial,
  onSave,
  onDelete,
}: {
  initial?: PageProperty;
  onSave: (field: PageProperty) => Promise<void>;
  onDelete?: () => Promise<void>;
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [type, setType] = useState<PropertyKind>(initial?.type ?? "text");
  const [options, setOptions] = useState(initial?.options.join(", ") ?? "");
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    if (!name.trim()) return;
    setBusy(true);
    const choices = [
      ...new Set(
        (options || (type === "status" ? "To do, In progress, Done" : ""))
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
      ),
    ];
    const sameType = initial?.type === type;
    let value = sameType
      ? initial.value
      : type === "checkbox"
        ? false
        : type === "multi_select"
          ? []
          : null;
    if (type === "single_select" || type === "status")
      value = choices.includes(String(value)) ? value : null;
    if (type === "multi_select")
      value = Array.isArray(value) ? value.filter((v) => choices.includes(v)) : [];
    try {
      await onSave({
        id: initial?.id ?? crypto.randomUUID(),
        name: name.trim(),
        type,
        options: choices,
        colors: initial?.colors ?? {},
        value,
      });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="property-form property-definition">
      <div className="property-name-input">
        <PropertyIcon type={type} />
        <input
          aria-label="Property name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Property name"
          autoFocus
          maxLength={100}
        />
      </div>
      <small>Type</small>
      <div className="property-type-list" role="listbox" aria-label="Property type">
        {Object.entries(propertyTypes).map(([key, label]) => (
          <button
            key={key}
            role="option"
            aria-selected={type === key}
            onClick={() => setType(key as PropertyKind)}
          >
            <PropertyIcon type={key as PropertyKind} />
            {label}
            {type === key && <Check size={13} className="ml-auto" />}
          </button>
        ))}
      </div>
      {["status", "single_select", "multi_select"].includes(type) && (
        <label>
          Options
          <input
            value={options}
            onChange={(e) => setOptions(e.target.value)}
            placeholder={type === "status" ? "To do, In progress, Done" : "One, Two, Three"}
          />
          <small>
            Separate options with commas. You can color and edit each option after saving.
          </small>
        </label>
      )}
      <div className="property-form-actions">
        <button
          disabled={busy || !name.trim()}
          onClick={() => void submit().catch((e) => toast.error((e as Error).message))}
        >
          {busy ? "Saving…" : initial ? "Save property" : "Add property"}
        </button>
        {onDelete && (
          <button
            disabled={busy}
            onClick={() => void onDelete().catch((e) => toast.error((e as Error).message))}
          >
            Remove
          </button>
        )}
      </div>
    </div>
  );
}

export function PageProperties({
  page,
  onSave,
}: {
  page: PageDoc;
  onSave: (fields: PageProperty[]) => Promise<PageDoc>;
}) {
  const [stored, setStored] = useState(page);
  const [editing, setEditing] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let live = true;
    void pages
      .get(page.path)
      .then((p) => {
        if (live) setStored(p);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [page.path, page.hash]);
  const fields = pageProperties(stored);
  const persist = async (next: PageProperty[]) => {
    setBusy(true);
    try {
      setStored(await onSave(next));
      setEditing(null);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="page-properties" aria-label="Page properties">
      {fields.map((field) => (
        <div className="property-row" key={field.id}>
          <Popover
            open={editing === field.id}
            onOpenChange={(v) => setEditing(v ? field.id : null)}
          >
            <PopoverTrigger className="property-name">
              <PropertyIcon type={field.type} />
              <span>{field.name}</span>
            </PopoverTrigger>
            <PopoverContent align="start">
              <PropertyForm
                initial={field}
                onSave={(next) => persist(fields.map((f) => (f.id === next.id ? next : f)))}
                onDelete={() => persist(fields.filter((f) => f.id !== field.id))}
              />
            </PopoverContent>
          </Popover>
          <PropertyValue
            page={stored}
            field={field}
            disabled={busy}
            onFieldChange={(next) =>
              void persist(fields.map((f) => (f.id === next.id ? next : f))).catch((e) =>
                toast.error((e as Error).message),
              )
            }
            onChange={(value) =>
              void persist(fields.map((f) => (f.id === field.id ? { ...f, value } : f))).catch(
                (e) => toast.error((e as Error).message),
              )
            }
          />
        </div>
      ))}
      <Popover open={editing === "new"} onOpenChange={(v) => setEditing(v ? "new" : null)}>
        <PopoverTrigger className="add-property" disabled={busy}>
          <Plus size={14} /> Add new property
        </PopoverTrigger>
        <PopoverContent align="start">
          <PropertyForm onSave={(field) => persist([...fields, field])} />
        </PopoverContent>
      </Popover>
    </section>
  );
}
