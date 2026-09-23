import { useEffect, useRef, useState } from "react";
import { ChevronDown, FileText, Highlighter, Paperclip } from "lucide-react";
import type { Source } from "@/lib/ai";

const ICONS = { page: FileText, attachment: Paperclip, selection: Highlighter };
/** Title chips on the collapsed line; the rest are counted in a "+N" chip. */
const CHIPS = 5;

/**
 * Sources under an answer: one line with the count and a few title chips, opening to the
 * numbered cards (clicking a page source there opens it). Citing a source opens the list.
 */
export function Sources({
  sources,
  onNavigate,
  highlight,
  changed,
  label = "all",
  stale,
}: {
  sources: Source[];
  onNavigate: (path: string) => void;
  highlight?: number | null;
  /** Pages edited since this answer was written; their passages may no longer say this. */
  changed?: Set<string>;
  /** "all": "N sources"; "new": "N new sources" (the rest is in the context block); "none". */
  label?: "all" | "new" | "none";
  /** Numbers whose passage no longer exists in its page. */
  stale?: Set<number>;
}) {
  const [open, setOpen] = useState(false);
  const list = useRef<HTMLDivElement>(null);
  const cited = highlight != null && sources.some((s) => s.n === highlight);
  // A citation click opens the list (adjusting state while rendering, not in an effect).
  const [seen, setSeen] = useState(highlight);
  if (highlight !== seen) {
    setSeen(highlight);
    if (cited) setOpen(true);
  }
  useEffect(() => {
    if (cited)
      list.current
        ?.querySelector(`[data-n="${highlight}"]`)
        ?.scrollIntoView?.({ block: "nearest" });
  }, [cited, highlight, open]);
  if (!sources.length) return null;
  const plural = sources.length === 1 ? "" : "s";
  const count = `${sources.length} ${label === "new" ? "new " : ""}source${plural}`;
  if (label !== "none" && !open) {
    const extra = sources.length - CHIPS;
    return (
      <div className="ai-sources" aria-label="Sources">
        <button
          type="button"
          className="ai-sources-line"
          aria-expanded={false}
          onClick={() => setOpen(true)}
        >
          <span className="ai-sources-count">{count}</span>
          {sources.slice(0, CHIPS).map((source) => {
            const Icon = ICONS[source.kind] ?? FileText;
            return (
              <span
                key={source.n}
                className="ai-source-chip"
                title={source.page_path ?? source.title}
              >
                <Icon size={11} aria-hidden="true" />
                <span>{source.title}</span>
              </span>
            );
          })}
          {extra > 0 && <span className="ai-source-chip">+{extra}</span>}
          <ChevronDown size={12} className="ai-sources-caret" aria-hidden="true" />
        </button>
      </div>
    );
  }
  return (
    <div className="ai-sources" aria-label="Sources" ref={list}>
      {label !== "none" && (
        <button
          type="button"
          className="ai-sources-head"
          aria-expanded
          onClick={() => setOpen(false)}
        >
          <span className="ai-sources-count">{count}</span>
          <ChevronDown size={12} className="ai-sources-caret" aria-hidden="true" />
        </button>
      )}
      {sources.map((source) => {
        const Icon = ICONS[source.kind] ?? FileText;
        const where = [source.title, ...source.heading_path].join(" › ");
        const outdated =
          (source.page_path && changed?.has(source.page_path)) || stale?.has(source.n);
        return (
          <div
            key={source.n}
            className="ai-source-card"
            data-highlight={highlight === source.n || undefined}
            data-n={source.n}
            id={label === "none" ? `source-${source.n}` : undefined}
          >
            <span className="ai-source-number">{source.n}</span>
            <div className="ai-source-body">
              <p className="ai-source-title">
                <Icon size={12} /> {where}
                {outdated && <span className="ai-source-stale">changed since</span>}
              </p>
              <p className="ai-source-snippet">{source.snippet}</p>
              {source.page_path && (
                <button
                  type="button"
                  className="ai-source"
                  onClick={() => onNavigate(source.page_path as string)}
                >
                  Open {source.page_path}
                </button>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/** Honest limits: what was searched, what was left out, what the notes do not establish. */
export function LimitsCallout({ items, excluded }: { items: string[]; excluded: string[] }) {
  if (!items.length) return null;
  return (
    <div className="ai-limits" aria-label="Answer limits">
      {items.map((line) => (
        <p key={line}>{line}</p>
      ))}
      {!!excluded.length && (
        <details>
          <summary>
            {excluded.length} local-only page{excluded.length === 1 ? "" : "s"} left out
          </summary>
          {excluded.map((path) => (
            <div key={path}>{path}</div>
          ))}
        </details>
      )}
    </div>
  );
}
