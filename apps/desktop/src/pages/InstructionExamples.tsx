import { useEffect, useMemo, useState } from "react";
import { Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { TextInstructionsEditor } from "@/editor/TextInstructionsEditor";
import { templates, type InstructionExample } from "@/lib/templates";
import "./ai-settings.css";

/** The built-in examples of AI instructions (D90), as a picker in a page's AI settings:
 * the chosen text goes into the instructions being edited. */
export function InstructionExamples({
  open,
  onOpenChange,
  onUse,
  hasText = false,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Put the example in the instructions; `replace` drops what was there. */
  onUse: (example: InstructionExample, replace: boolean) => void;
  /** The instructions being edited already hold text, so offer adding or replacing. */
  hasText?: boolean;
}) {
  const [all, setAll] = useState<InstructionExample[] | null>(null);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("All");
  const [slug, setSlug] = useState<string | null>(null);

  useEffect(() => {
    if (!open || all) return;
    templates
      .instructions()
      .then(setAll)
      .catch((e: Error) => setError(e.message));
  }, [open, all]);
  useEffect(() => {
    if (!open) return;
    setQuery("");
    setCategory("All");
    setSlug(null);
  }, [open]);

  const categories = useMemo(() => ["All", ...new Set((all ?? []).map((e) => e.category))], [all]);
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (all ?? []).filter(
      (e) =>
        (category === "All" || e.category === category) &&
        (!q || `${e.name} ${e.description} ${e.category} ${e.text}`.toLowerCase().includes(q)),
    );
  }, [all, query, category]);
  const current = shown.find((e) => e.slug === slug) ?? shown[0] ?? null;

  const use = (replace: boolean) => {
    if (!current) return;
    onUse(current, replace);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="instruction-examples">
        <DialogHeader>
          <DialogTitle>Instruction examples</DialogTitle>
          <DialogDescription>
            Ready-made instructions to start from. Pick one, then change it to fit how you work.
          </DialogDescription>
        </DialogHeader>
        <div className="instruction-examples-body">
          <nav aria-label="Examples">
            <label className="instruction-examples-search">
              <Search size={14} />
              <input
                value={query}
                placeholder="Search examples…"
                aria-label="Search examples"
                onChange={(e) => setQuery(e.target.value)}
              />
            </label>
            <div className="instruction-examples-categories" role="tablist" aria-label="Category">
              {categories.map((c) => (
                <button
                  key={c}
                  type="button"
                  role="tab"
                  aria-selected={c === category}
                  onClick={() => setCategory(c)}
                >
                  {c}
                </button>
              ))}
            </div>
            <ul>
              {shown.map((e) => (
                <li key={e.slug}>
                  <button
                    type="button"
                    aria-current={e.slug === current?.slug || undefined}
                    onClick={() => setSlug(e.slug)}
                  >
                    <span aria-hidden="true">{e.icon}</span>
                    <span>
                      <strong>{e.name}</strong>
                      <small>{e.description}</small>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
            {all && shown.length === 0 && <p>No examples match.</p>}
            {!all && <p>{error || "Loading…"}</p>}
          </nav>
          <section aria-label="Example">
            {current && (
              <>
                <h3>
                  <span aria-hidden="true">{current.icon}</span> {current.name}
                  <small>{current.category}</small>
                </h3>
                <TextInstructionsEditor
                  key={current.slug}
                  value={current.text}
                  readOnly
                  label={`Example instructions: ${current.name}`}
                />
              </>
            )}
          </section>
        </div>
        <footer>
          <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          {hasText ? (
            <>
              <Button variant="outline" size="sm" disabled={!current} onClick={() => use(true)}>
                Replace my instructions
              </Button>
              <Button size="sm" disabled={!current} onClick={() => use(false)}>
                Add below my instructions
              </Button>
            </>
          ) : (
            <Button size="sm" disabled={!current} onClick={() => use(false)}>
              Use these instructions
            </Button>
          )}
        </footer>
      </DialogContent>
    </Dialog>
  );
}
