import { useRef, useState } from "react";
import { Search, X } from "lucide-react";

export function ViewSearch({
  query,
  onQuery,
}: {
  query: string;
  onQuery: (value: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  const open = expanded || !!query;
  const close = () => {
    onQuery("");
    setExpanded(false);
    requestAnimationFrame(() => toggle.current?.focus());
  };
  return (
    <div className="view-search-control" data-expanded={open || undefined}>
      <button
        ref={toggle}
        className="view-button view-search-toggle"
        aria-label="Search view"
        aria-expanded={open}
        title="Search view"
        onClick={() => {
          setExpanded(true);
          requestAnimationFrame(() => input.current?.focus());
        }}
      >
        <Search size={15} />
      </button>
      {open && (
        <div className="view-search">
          <input
            ref={input}
            autoFocus
            aria-label="Search pages in view"
            placeholder="Search pages…"
            value={query}
            onChange={(e) => onQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.stopPropagation();
                close();
              }
            }}
            onBlur={() => {
              if (!query) setExpanded(false);
            }}
          />
          <button
            aria-label={query ? "Clear search" : "Close search"}
            onMouseDown={(e) => e.preventDefault()}
            onClick={close}
          >
            <X size={13} />
          </button>
        </div>
      )}
    </div>
  );
}
