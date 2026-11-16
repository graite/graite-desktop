import { useEffect, useMemo, useState } from "react";
import { Copy, Search } from "lucide-react";
import { toast } from "sonner";
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
import "@/pages/ai-settings.css";

/** The examples of AI instructions (D90) as a gallery: search, filter by subject, and open
 * one to read it and copy it into a page's AI settings. */
export function InstructionGallery() {
  const [all, setAll] = useState<InstructionExample[] | null>(null);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("All");
  const [open, setOpen] = useState<InstructionExample | null>(null);

  useEffect(() => {
    templates
      .instructions()
      .then(setAll)
      .catch((e: Error) => setError(e.message));
  }, []);

  const categories = useMemo(() => ["All", ...new Set((all ?? []).map((e) => e.category))], [all]);
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (all ?? []).filter(
      (e) =>
        (category === "All" || e.category === category) &&
        (!q || `${e.name} ${e.description} ${e.category} ${e.text}`.toLowerCase().includes(q)),
    );
  }, [all, query, category]);

  return (
    <>
      <label className="mb-3 flex h-9 items-center gap-2 rounded-lg border bg-background px-3 text-muted-foreground">
        <Search className="size-4" />
        <input
          className="w-full bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
          value={query}
          placeholder="Search instructions…"
          aria-label="Search instructions"
          onChange={(e) => setQuery(e.target.value)}
        />
      </label>
      <div className="mb-5 flex flex-wrap gap-1.5" role="tablist" aria-label="Subject">
        {categories.map((c) => (
          <button
            key={c}
            role="tab"
            aria-selected={c === category}
            onClick={() => setCategory(c)}
            className={`rounded-full border px-3 py-1 text-xs ${c === category ? "bg-foreground text-background" : "text-muted-foreground hover:bg-accent"}`}
          >
            {c}
          </button>
        ))}
      </div>
      {error && <p className="py-12 text-center text-sm text-destructive">{error}</p>}
      {!all && !error && (
        <p className="py-12 text-center text-sm text-muted-foreground">Loading…</p>
      )}
      {all && shown.length === 0 && (
        <p className="py-12 text-center text-sm text-muted-foreground">No instructions match.</p>
      )}
      <div className="grid gap-3 sm:grid-cols-2">
        {shown.map((e) => (
          <button
            key={e.slug}
            onClick={() => setOpen(e)}
            className="flex flex-col gap-2 rounded-xl border p-4 text-left transition-colors hover:bg-accent/60"
          >
            <span className="flex items-center gap-2">
              <span className="text-2xl leading-none">{e.icon}</span>
              <span className="font-medium">{e.name}</span>
              <span className="ml-auto rounded-full bg-muted px-2 py-0.5 text-[10px] text-muted-foreground">
                {e.category}
              </span>
            </span>
            <span className="text-sm text-muted-foreground">{e.description}</span>
          </button>
        ))}
      </div>
      {open && <InstructionDialog example={open} onClose={() => setOpen(null)} />}
    </>
  );
}

/** One example: its text, and Copy or Cancel. */
function InstructionDialog({
  example,
  onClose,
}: {
  example: InstructionExample;
  onClose: () => void;
}) {
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="instruction-example">
        <DialogHeader>
          <DialogTitle>
            <span aria-hidden="true">{example.icon}</span> {example.name}
          </DialogTitle>
          <DialogDescription>{example.description}</DialogDescription>
        </DialogHeader>
        <div className="instruction-example-text">
          <TextInstructionsEditor
            value={example.text}
            readOnly
            label={`Instructions: ${example.name}`}
          />
        </div>
        <footer>
          <Button variant="ghost" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button
            size="sm"
            onClick={() =>
              void navigator.clipboard
                .writeText(example.text)
                .then(() => {
                  toast.success("Copied. Paste it in a page’s AI settings, under Instructions.");
                  onClose();
                })
                .catch(() => toast.error("Could not copy the instructions."))
            }
          >
            <Copy size={14} /> Copy
          </Button>
        </footer>
      </DialogContent>
    </Dialog>
  );
}
