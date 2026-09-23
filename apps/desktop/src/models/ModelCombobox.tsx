import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown, Loader2, Plus, Search } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { connections, contextLabel, type DiscoveredModel } from "@/lib/connections";

const cache = new Map<string, DiscoveredModel[]>();

/** Search a connection's models and save the ones worth keeping. */
export function ModelCombobox({
  connectionId,
  saved,
  onSave,
  disabled,
}: {
  connectionId: string;
  /** Model ids already saved on this connection. */
  saved: Set<string>;
  onSave: (model: DiscoveredModel) => Promise<void> | void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [models, setModels] = useState<DiscoveredModel[]>(cache.get(connectionId) ?? []);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [cursor, setCursor] = useState(0);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setCursor(0);
    setTimeout(() => input.current?.focus(), 0);
    if (cache.has(connectionId)) {
      setModels(cache.get(connectionId) ?? []);
      return;
    }
    let live = true;
    setLoading(true);
    setError("");
    connections
      .discover(connectionId)
      .then((result) => {
        if (!live) return;
        cache.set(connectionId, result.models);
        setModels(result.models);
      })
      .catch((e: Error) => live && setError(e.message))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [open, connectionId]);

  const needle = query.trim().toLowerCase();
  const shown = (
    needle ? models.filter((m) => `${m.id} ${m.name}`.toLowerCase().includes(needle)) : models
  ).slice(0, 200);

  const pick = (model: DiscoveredModel) => {
    if (saved.has(model.id)) return;
    void onSave(model);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button type="button" className="ai-select-trigger ai-combobox-trigger" disabled={disabled}>
          <span>Find models</span>
          <span className="ai-select-chevron">
            <ChevronDown size={15} />
          </span>
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="ai-combobox"
        onOpenAutoFocus={(e) => e.preventDefault()}
      >
        <div className="ai-combobox-search">
          <Search size={13} />
          <input
            ref={input}
            aria-label="Search models"
            placeholder="Search models…"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setCursor(0);
            }}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setCursor((c) => Math.min(c + 1, shown.length - 1));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setCursor((c) => Math.max(c - 1, 0));
              } else if (e.key === "Enter" && shown[cursor]) {
                e.preventDefault();
                pick(shown[cursor]);
              } else if (e.key === "Escape") {
                setOpen(false);
              }
            }}
          />
          {loading && <Loader2 size={13} className="animate-spin" />}
        </div>
        <div className="ai-combobox-list" role="listbox" aria-label="Available models">
          {error && <p className="ai-combobox-empty">{error}</p>}
          {!error && !loading && !shown.length && (
            <p className="ai-combobox-empty">
              {models.length ? "No model matches." : "No models found."}
            </p>
          )}
          {shown.map((model, index) => {
            const isSaved = saved.has(model.id);
            return (
              <div
                key={model.id}
                role="option"
                aria-selected={index === cursor}
                data-active={index === cursor || undefined}
                className="ai-combobox-row"
                onMouseEnter={() => setCursor(index)}
              >
                <span className="ai-combobox-text">
                  <strong>{model.name}</strong>
                  <small>
                    {model.id}
                    {model.context_length ? ` · ${contextLabel(model.context_length)}` : ""}
                  </small>
                </span>
                <button
                  type="button"
                  className="ai-combobox-save"
                  aria-label={isSaved ? `${model.name} saved` : `Save ${model.name}`}
                  disabled={isSaved}
                  onClick={() => pick(model)}
                >
                  {isSaved ? <Check size={13} /> : <Plus size={13} />}
                  {isSaved ? "Saved" : "Save"}
                </button>
              </div>
            );
          })}
        </div>
      </PopoverContent>
    </Popover>
  );
}
