import { useEffect, useMemo, useState } from "react";
import {
  BarChart3,
  Check,
  FileText,
  LayoutDashboard,
  LayoutTemplate,
  Loader2,
  Table2,
} from "lucide-react";
import { toast } from "sonner";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import { templates, type Template } from "@/lib/templates";
import { TypeIcon } from "@/editor/tables/columns";

const CATEGORIES = ["All", "Business", "Finance", "Work", "Personal"] as const;

/** The built-in template gallery (D77): pick one, and its pages, tables, charts and
 *  dashboards are made at the top level or inside the page that was open. */
export function TemplatesPage({
  currentPage,
  onCreated,
}: {
  /** The page that was open, offered as the place to put it. */
  currentPage: { path: string; title: string } | null;
  onCreated: (path: string) => void;
}) {
  const [all, setAll] = useState<Template[] | null>(null);
  const [error, setError] = useState("");
  const [category, setCategory] = useState<(typeof CATEGORIES)[number]>("All");
  const [chosen, setChosen] = useState<Template | null>(null);

  useEffect(() => {
    templates
      .list()
      .then(setAll)
      .catch((e: Error) => setError(e.message));
  }, []);

  const shown = useMemo(
    () => (all ?? []).filter((t) => category === "All" || t.category === category),
    [all, category],
  );

  return (
    <main className="h-full overflow-auto px-10 py-12">
      <div className="mx-auto max-w-4xl">
        <h1 className="mb-2 flex items-center gap-3 text-2xl font-semibold">
          <LayoutTemplate className="size-6 text-muted-foreground" />
          Templates
        </h1>
        <p className="mb-6 text-sm text-muted-foreground">
          Ready-made pages with linked tables, charts and dashboards. Pick one to add it to your
          vault; everything it makes is ordinary pages and CSV files you can change.
        </p>
        <div className="mb-5 flex flex-wrap gap-1.5" role="tablist" aria-label="Category">
          {CATEGORIES.map((c) => (
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
        <div className="grid gap-3 sm:grid-cols-2">
          {shown.map((t) => (
            <button
              key={t.slug}
              onClick={() => setChosen(t)}
              className="flex flex-col gap-2 rounded-xl border p-4 text-left transition-colors hover:bg-accent/60"
            >
              <span className="flex items-center gap-2">
                <span className="text-2xl leading-none">{t.icon}</span>
                <span className="font-medium">{t.name}</span>
                <span className="ml-auto rounded-full bg-muted px-2 py-0.5 text-[10px] text-muted-foreground">
                  {t.category}
                </span>
              </span>
              <span className="text-sm text-muted-foreground">{t.description}</span>
              <span className="mt-auto flex flex-wrap gap-3 pt-1 text-xs text-muted-foreground">
                <span className="flex items-center gap-1">
                  <Table2 className="size-3.5" /> {t.tables.length} tables
                </span>
                {t.charts > 0 && (
                  <span className="flex items-center gap-1">
                    <BarChart3 className="size-3.5" /> {t.charts} charts
                  </span>
                )}
                {t.dashboards.length > 0 && (
                  <span className="flex items-center gap-1">
                    <LayoutDashboard className="size-3.5" /> {t.dashboards.length}{" "}
                    {t.dashboards.length === 1 ? "dashboard" : "dashboards"}
                  </span>
                )}
                <span className="flex items-center gap-1">
                  <FileText className="size-3.5" /> {t.pages.length}{" "}
                  {t.pages.length === 1 ? "page" : "pages"}
                </span>
              </span>
            </button>
          ))}
        </div>
      </div>
      {chosen && (
        <UseTemplateDialog
          template={chosen}
          currentPage={currentPage}
          onClose={() => setChosen(null)}
          onCreated={(path) => {
            setChosen(null);
            onCreated(path);
          }}
        />
      )}
    </main>
  );
}

function UseTemplateDialog({
  template,
  currentPage,
  onClose,
  onCreated,
}: {
  template: Template;
  currentPage: { path: string; title: string } | null;
  onClose: () => void;
  onCreated: (path: string) => void;
}) {
  const [title, setTitle] = useState(template.name);
  const [inside, setInside] = useState(false);
  const [sample, setSample] = useState(true);
  const [busy, setBusy] = useState(false);

  const create = async () => {
    setBusy(true);
    try {
      const page = await templates.use(template.slug, {
        title,
        parentPath: inside && currentPage ? currentPage.path : null,
        sampleData: sample,
      });
      toast.success(`${page.title} is ready.`);
      onCreated(page.path);
    } catch (e) {
      toast.error((e as Error).message);
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => !open && !busy && onClose()}>
      <DialogContent className="max-h-[85vh] overflow-auto sm:max-w-xl">
        <DialogTitle className="flex items-center gap-2">
          <span className="text-2xl leading-none">{template.icon}</span>
          {template.name}
        </DialogTitle>
        <DialogDescription>{template.description}</DialogDescription>
        {(template.highlights ?? []).length > 0 && (
          <ul className="space-y-1 text-sm">
            {(template.highlights ?? []).map((h) => (
              <li key={h} className="flex gap-2">
                <Check className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                {h}
              </li>
            ))}
          </ul>
        )}
        <div className="space-y-2">
          <p className="text-xs font-medium text-muted-foreground">What it makes</p>
          <div className="divide-y rounded-lg border text-sm">
            {template.tables.map((t) => (
              <div key={`${t.page}/${t.name}`} className="px-3 py-2">
                <div className="flex items-center gap-2 font-medium">
                  <Table2 className="size-3.5 text-muted-foreground" />
                  {t.name}
                </div>
                <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
                  {t.columns.map((c) => (
                    <span key={c.name} className="flex items-center gap-1">
                      <TypeIcon type={c.type} size={11} />
                      {c.name}
                    </span>
                  ))}
                </div>
              </div>
            ))}
            {template.dashboards.length > 0 && (
              <div className="flex items-center gap-2 px-3 py-2 text-xs text-muted-foreground">
                <LayoutDashboard className="size-3.5" />
                Dashboards: {template.dashboards.join(", ")}
              </div>
            )}
            {template.pages.length > 1 && (
              <div className="flex items-center gap-2 px-3 py-2 text-xs text-muted-foreground">
                <FileText className="size-3.5" />
                Pages: {template.pages.slice(1).join(", ")}
              </div>
            )}
          </div>
        </div>
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (!busy) void create();
          }}
        >
          <label className="block text-sm">
            <span className="mb-1 block text-xs font-medium text-muted-foreground">Title</span>
            <input
              className="w-full rounded-md border bg-transparent px-3 py-1.5 text-sm outline-none focus:border-ring"
              value={title}
              maxLength={200}
              onChange={(e) => setTitle(e.target.value)}
            />
          </label>
          {currentPage && (
            <label className="flex items-center justify-between gap-3 text-sm">
              <span>
                Put it inside <strong>{currentPage.title}</strong>
                <span className="block text-xs text-muted-foreground">
                  Otherwise it becomes a new top-level page.
                </span>
              </span>
              <Switch checked={inside} onCheckedChange={setInside} />
            </label>
          )}
          <label className="flex items-center justify-between gap-3 text-sm">
            <span>
              Include example data
              <span className="block text-xs text-muted-foreground">
                Sample rows and pages show how it works; without them the tables start empty
                (categories and accounts stay).
              </span>
            </span>
            <Switch checked={sample} onCheckedChange={setSample} />
          </label>
          <div className="flex justify-end gap-2 pt-1">
            <button
              type="button"
              onClick={onClose}
              disabled={busy}
              className="rounded-md border px-3 py-1.5 text-sm hover:bg-accent"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={busy}
              className="flex items-center gap-2 rounded-md bg-foreground px-3 py-1.5 text-sm text-background disabled:opacity-60"
            >
              {busy && <Loader2 className="size-4 animate-spin" />}
              Use template
            </button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
