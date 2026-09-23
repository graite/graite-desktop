import { useCallback, useEffect, useState } from "react";
import { FileText, Paperclip, RotateCcw, Search, Trash2, X } from "lucide-react";
import { toast } from "sonner";
import { onDaemonEvent, trash, type TrashEntry } from "@/lib/api";
import { formatBytes } from "@/lib/media";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

/** What the confirm dialog is about to delete for good: one entry, or everything. */
type Purge = { entry: TrashEntry } | { all: true };

export function TrashPage({
  version,
  onRestored,
  onNavigate,
}: {
  version: unknown;
  onRestored: (path: string) => void;
  onNavigate?: (path: string) => void;
}) {
  const [entries, setEntries] = useState<TrashEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [purge, setPurge] = useState<Purge | null>(null);

  const load = useCallback(async (live: () => boolean = () => true) => {
    try {
      const items = await trash.list();
      if (live()) {
        setEntries(items);
        setError("");
      }
    } catch (e) {
      if (live()) setError((e as Error).message);
    } finally {
      if (live()) setLoading(false);
    }
  }, []);
  useEffect(() => {
    let live = true;
    void load(() => live);
    return () => {
      live = false;
    };
  }, [version, load]);
  // Trashing a file does not change the page tree, so it has its own event.
  useEffect(
    () =>
      onDaemonEvent((e) => {
        if (e.type === "trash_changed") void load();
      }),
    [load],
  );

  const restore = async (entry: TrashEntry) => {
    setBusy(entry.trash_id);
    try {
      const page = await trash.restore(entry.trash_id);
      setEntries((items) => items.filter((e) => e.trash_id !== entry.trash_id));
      // A restored file goes back into its page; stay here instead of leaving the trash.
      if (entry.kind === "attachment")
        toast.success(
          `Restored “${entry.title}” to ${page.title}`,
          onNavigate
            ? { action: { label: "Open page", onClick: () => onNavigate(page.path) } }
            : undefined,
        );
      else onRestored(page.path);
    } catch (e) {
      toast.error(`Could not restore: ${(e as Error).message}`);
    } finally {
      setBusy(null);
    }
  };

  const confirmPurge = async () => {
    const target = purge;
    setPurge(null);
    if (!target) return;
    setBusy("entry" in target ? target.entry.trash_id : "*");
    try {
      const result =
        "entry" in target ? await trash.purge(target.entry.trash_id) : await trash.empty();
      setEntries((items) =>
        "entry" in target ? items.filter((e) => e.trash_id !== target.entry.trash_id) : [],
      );
      toast.success(`Deleted permanently · ${formatBytes(result.bytes)} freed`);
    } catch (e) {
      toast.error(`Could not delete: ${(e as Error).message}`);
      void load();
    } finally {
      setBusy(null);
    }
  };

  const shown = entries.filter((e) =>
    `${e.title} ${e.path ?? ""}`.toLowerCase().includes(query.toLowerCase()),
  );
  const total = entries.reduce((sum, e) => sum + (e.size ?? 0), 0);
  return (
    <main className="h-full overflow-auto px-10 py-12">
      <div className="mx-auto max-w-3xl">
        <div className="mb-2 flex items-center gap-3">
          <h1 className="flex flex-1 items-center gap-3 text-2xl font-semibold">
            <Trash2 size={24} />
            Trash
          </h1>
          {entries.length > 0 && (
            <button
              className="flex shrink-0 items-center gap-2 rounded-md border px-3 py-1.5 text-xs hover:bg-accent disabled:opacity-50"
              disabled={busy !== null}
              onClick={() => setPurge({ all: true })}
            >
              <Trash2 size={13} />
              Empty trash · {formatBytes(total)}
            </button>
          )}
        </div>
        <p className="mb-6 text-sm text-muted-foreground">
          Restore deleted pages, their subpages and files to your workspace.
        </p>
        <label className="mb-5 flex items-center gap-2 rounded-lg border px-3 py-2 text-muted-foreground">
          <Search size={16} />
          <input
            className="min-w-0 flex-1 bg-transparent text-sm outline-none"
            aria-label="Search trash"
            placeholder="Search deleted pages and files…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
        {error ? (
          <p role="alert">{error}</p>
        ) : loading ? (
          <p>Loading…</p>
        ) : !shown.length ? (
          <p className="py-12 text-center text-sm text-muted-foreground">
            {entries.length ? "Nothing matches." : "Trash is empty."}
          </p>
        ) : (
          <div className="divide-y rounded-lg border">
            {shown.map((entry) => (
              <div key={entry.trash_id} className="flex items-center gap-4 px-4 py-3">
                {entry.kind === "attachment" ? (
                  <Paperclip
                    size={16}
                    className="shrink-0 text-muted-foreground"
                    aria-label="File"
                  />
                ) : (
                  <FileText
                    size={16}
                    className="shrink-0 text-muted-foreground"
                    aria-label="Page"
                  />
                )}
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium" title={entry.title}>
                    {entry.title}
                  </p>
                  <p className="truncate text-xs text-muted-foreground" title={entry.path ?? ""}>
                    {entry.kind === "attachment"
                      ? `File from ${entry.path ?? "a deleted page"}`
                      : entry.path}
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Deleted {new Date(entry.trashed_at).toLocaleString()}
                    {entry.size ? ` · ${formatBytes(entry.size)}` : ""}
                  </p>
                </div>
                <button
                  className="flex shrink-0 items-center gap-2 rounded-md border px-3 py-1.5 text-xs hover:bg-accent disabled:opacity-50"
                  disabled={busy !== null}
                  onClick={() => void restore(entry)}
                >
                  <RotateCcw size={13} />
                  {busy === entry.trash_id ? "Restoring…" : "Restore"}
                </button>
                <button
                  className="shrink-0 rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-destructive disabled:opacity-50"
                  aria-label={`Delete ${entry.title} permanently`}
                  title="Delete permanently"
                  disabled={busy !== null}
                  onClick={() => setPurge({ entry })}
                >
                  <X size={15} />
                </button>
              </div>
            ))}
          </div>
        )}
        <AlertDialog open={purge !== null} onOpenChange={(open) => !open && setPurge(null)}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>
                {purge && "entry" in purge
                  ? `Delete “${purge.entry.title}” permanently?`
                  : `Permanently delete ${entries.length} ${entries.length === 1 ? "item" : "items"}?`}
              </AlertDialogTitle>
              <AlertDialogDescription>
                {purge && "entry" in purge
                  ? "It is removed from disk"
                  : `This frees ${formatBytes(total)} and removes everything in the trash from disk`}
                . This cannot be undone, and AI changes that deleted these pages can no longer be
                reverted.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction onClick={() => void confirmPurge()}>
                Delete permanently
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
    </main>
  );
}
