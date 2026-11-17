import { useEffect, useMemo, useRef, useState } from "react";
import { CornerDownLeft, Search, Sparkles } from "lucide-react";
import { PageIcon } from "@/components/PageIcon";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import type { TreeNode } from "@/lib/api";
import { allPages } from "@/editor/tree-utils";
import { highlight, queryTerms, search, type SearchHit, type SearchResult } from "@/lib/search";
import "./search.css";

const DEBOUNCE_MS = 70;

/** Query words in `text`, marked. */
export function Marked({ text, terms }: { text: string; terms: string[] }) {
  return (
    <>
      {highlight(text, terms).map((piece, i) =>
        piece.hit ? <mark key={i}>{piece.text}</mark> : <span key={i}>{piece.text}</span>,
      )}
    </>
  );
}

/** One found page: title, where in the page, and the text around the match. */
export function SearchRow({ hit, terms }: { hit: SearchHit; terms: string[] }) {
  return (
    <>
      <PageIcon icon={hit.icon ?? null} hasContent className="search-row-icon" />
      <span className="search-row-text">
        <span className="search-row-title">
          <Marked text={hit.title} terms={terms} />
          {hit.heading_path.length > 0 && <small> › {hit.heading_path.join(" › ")}</small>}
        </span>
        {hit.snippet && (
          <span className="search-row-snippet">
            <Marked text={hit.snippet} terms={terms} />
          </span>
        )}
        <small className="search-row-path">
          {hit.path}
          {hit.matches > 1 ? ` · ${hit.matches} passages` : ""}
          {hit.via.length === 1 && hit.via[0] === "meaning" ? " · by meaning" : ""}
        </small>
      </span>
    </>
  );
}

/**
 * Cmd/Ctrl+K: find a page by its title or by what it says. Titles match at once from the
 * page tree already in memory; the daemon's index adds matches in the text a moment later.
 * No AI model answers here, so there is nothing to wait for.
 */
export function SearchPalette({
  open,
  tree,
  onOpenPage,
  onClose,
  onAsk,
}: {
  open: boolean;
  tree: TreeNode[];
  onOpenPage: (path: string) => void;
  onClose: () => void;
  /** Hand the typed text to chat as a question. */
  onAsk?: (question: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [found, setFound] = useState<SearchResult | null>(null);
  const [failed, setFailed] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const sequence = useRef(0);
  const pages = useMemo(() => allPages(tree), [tree]);
  const terms = useMemo(() => queryTerms(query), [query]);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setFound(null);
    setFailed("");
    setActive(0);
    void search.warm().catch(() => {});
    requestAnimationFrame(() => inputRef.current?.focus());
  }, [open]);

  useEffect(() => {
    setActive(0);
    const text = query.trim();
    const mine = ++sequence.current;
    if (!text) {
      setFound(null);
      return;
    }
    const timer = setTimeout(() => {
      search
        .find(text, { k: 12 })
        .then((result) => {
          // A slower answer to an older query must not replace a newer one.
          if (mine === sequence.current) {
            setFound(result);
            setFailed("");
          }
        })
        .catch((e: Error) => mine === sequence.current && setFailed(e.message));
    }, DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query]);

  // Until the index answers (and when it cannot), titles from the tree are shown.
  const titles = useMemo<SearchHit[]>(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return pages
      .filter((p) => p.title.toLowerCase().includes(q))
      .slice(0, 8)
      .map((p) => ({
        path: p.path,
        id: p.path,
        title: p.title,
        icon: p.icon ?? null,
        heading_path: [],
        snippet: "",
        score: 0,
        matches: 1,
        via: ["title"],
        start_line: null,
      }));
  }, [pages, query]);
  const current = found && found.query === query.trim() ? found : null;
  const results = current ? current.results : titles;
  const canAsk = !!onAsk && query.trim().length > 2;
  const rows = results.length + (canAsk ? 1 : 0);

  const choose = (index: number) => {
    const hit = results[index];
    if (hit) onOpenPage(hit.path);
    else if (canAsk && index === results.length) onAsk?.(query.trim());
    else return;
    onClose();
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="search-palette gap-0 p-0 sm:max-w-2xl" showCloseButton={false}>
        <DialogTitle className="sr-only">Search your pages</DialogTitle>
        <div className="search-input">
          <Search size={16} />
          <input
            ref={inputRef}
            role="combobox"
            aria-expanded="true"
            aria-controls="search-results"
            aria-label="Search your pages"
            placeholder="Search titles and text…"
            value={query}
            spellCheck={false}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setActive((i) => Math.min(i + 1, rows - 1));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setActive((i) => Math.max(i - 1, 0));
              } else if (e.key === "Enter") {
                e.preventDefault();
                choose(active);
              }
            }}
          />
        </div>
        <ul id="search-results" role="listbox" className="search-results">
          {results.map((hit, i) => (
            <li
              key={hit.path}
              role="option"
              aria-selected={i === active}
              className="search-row"
              onMouseMove={() => setActive(i)}
              onClick={() => choose(i)}
            >
              <SearchRow hit={hit} terms={terms} />
            </li>
          ))}
          {canAsk && (
            <li
              role="option"
              aria-selected={active === results.length}
              className="search-row search-row-ask"
              onMouseMove={() => setActive(results.length)}
              onClick={() => choose(results.length)}
            >
              <Sparkles size={15} className="search-row-icon" />
              <span className="search-row-text">
                <span className="search-row-title">Ask AI: “{query.trim()}”</span>
                <small className="search-row-path">
                  An answer written from your pages, with its sources
                </small>
              </span>
            </li>
          )}
          {query.trim() && current && results.length === 0 && (
            <li className="search-empty">No page has these words in its title or text.</li>
          )}
          {!query.trim() && (
            <li className="search-empty">
              Type a few words. Titles and text are searched as you type; no AI model is used.
            </li>
          )}
        </ul>
        <div className="search-foot" role="status">
          {failed ? (
            <span>Search is not answering: {failed}</span>
          ) : current ? (
            <span>
              {current.results.length} {current.results.length === 1 ? "page" : "pages"} ·{" "}
              {Math.max(1, Math.round(current.took_ms))} ms ·{" "}
              {current.semantic ? "words and meaning" : "words"}
            </span>
          ) : (
            <span>{query.trim() ? "Searching…" : "Find a page"}</span>
          )}
          <span>
            ↑↓ to move · <CornerDownLeft size={11} /> to open · Esc to close
          </span>
        </div>
      </DialogContent>
    </Dialog>
  );
}
