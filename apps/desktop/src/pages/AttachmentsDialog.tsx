import { useCallback, useEffect, useState } from "react";
import {
  AudioLines,
  ExternalLink,
  File,
  FileText,
  FolderOpen,
  Image as ImageIcon,
  Paperclip,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";
import { ApiError, onDaemonEvent } from "@/lib/api";
import { formatBytes, media, openAttachment, type AttachmentInfo } from "@/lib/media";
import { platform } from "@/lib/platform";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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

const ICONS = { audio: AudioLines, image: ImageIcon, pdf: FileText, text: FileText, other: File };

/** Every file in this page's `_assets` folder: open it, find it on disk, or move it to the trash. */
export function AttachmentsDialog({
  pageId,
  title,
  open,
  onOpenChange,
}: {
  pageId: string;
  title: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [all, setAll] = useState<AttachmentInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<AttachmentInfo | null>(null);

  const load = useCallback(async () => {
    try {
      setAll(await media.attachments(pageId));
      setError("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [pageId]);

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    void load();
    return onDaemonEvent((e) => {
      if (e.type === "attachments_changed" && (e.data as { page_id?: string }).page_id === pageId)
        void load();
    });
  }, [open, pageId, load]);

  const moveToTrash = async (item: AttachmentInfo, force: boolean) => {
    setBusy(item.file);
    try {
      await media.trashAttachment(pageId, item.file, force);
      setAll((list) => list.filter((i) => i.file !== item.file));
      toast.success(`Moved “${item.name}” to trash`);
    } catch (e) {
      // The page was saved with this file after the list loaded: ask before breaking the block.
      if (e instanceof ApiError && e.status === 409 && !force) {
        setConfirm({ ...item, referenced: true });
        void load();
      } else toast.error((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  // Text that earlier versions saved next to the original after "Extract text". It was never
  // attached by the user, so it is not listed. What an old text block still shows stays where
  // it is; the rest was read once, when its text went onto the page, and can go in one step.
  const items = all.filter((i) => !i.generated);
  const leftovers = all.filter((i) => i.generated && !i.referenced);
  const leftoverBytes = leftovers.reduce((sum, i) => sum + i.size, 0);
  const clearLeftovers = async () => {
    setBusy("*");
    let moved = 0;
    for (const item of leftovers) {
      // Never forced: a file that came into use since the list loaded is simply kept.
      try {
        await media.trashAttachment(pageId, item.file, false);
        moved += 1;
      } catch (e) {
        if (!(e instanceof ApiError && e.status === 409)) toast.error((e as Error).message);
      }
    }
    setBusy(null);
    if (moved)
      toast.success(`Moved ${moved} leftover text ${moved === 1 ? "file" : "files"} to trash`);
    void load();
  };

  const unused = items.filter((i) => !i.referenced).length;
  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="attachments-dialog sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Paperclip size={18} />
              Attachments · {title}
            </DialogTitle>
            <DialogDescription>
              Files stored with this page. Removing a block from the page keeps its file here until
              you move it to the trash.
            </DialogDescription>
          </DialogHeader>
          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : loading ? (
            <p className="py-8 text-center text-sm text-muted-foreground">Loading…</p>
          ) : !items.length ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              This page has no attachments.
            </p>
          ) : (
            <ul
              aria-label="Attachments"
              className="max-h-[55vh] divide-y overflow-auto rounded-lg border"
            >
              {items.map((item) => {
                const Icon = ICONS[item.kind];
                return (
                  <li key={item.file} className="flex items-center gap-3 px-3 py-2.5">
                    <Icon size={18} className="shrink-0 text-muted-foreground" />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium" title={item.name}>
                        {item.name}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {formatBytes(item.size)} · {new Date(item.modified).toLocaleDateString()}
                        {" · "}
                        {item.referenced ? (
                          <span title={`Used on: ${item.referenced_by.join(", ")}`}>In use</span>
                        ) : (
                          <span className="font-medium text-amber-600 dark:text-amber-400">
                            Not used
                          </span>
                        )}
                      </p>
                    </div>
                    <button
                      className="rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground"
                      aria-label={`Open ${item.name}`}
                      title="Open"
                      onClick={() =>
                        void openAttachment(pageId, item).catch((e) =>
                          toast.error((e as Error).message),
                        )
                      }
                    >
                      <ExternalLink size={15} />
                    </button>
                    <button
                      className="rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-40"
                      aria-label={`Show ${item.name} in folder`}
                      title="Show in folder"
                      disabled={!platform.revealFolder}
                      onClick={() =>
                        void media
                          .location(pageId, item.file)
                          .then((r) => platform.revealFolder?.(r.folder))
                          .catch((e) => toast.error((e as Error).message))
                      }
                    >
                      <FolderOpen size={15} />
                    </button>
                    <button
                      className="rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-destructive disabled:opacity-40"
                      aria-label={`Move ${item.name} to trash`}
                      title="Move to trash"
                      disabled={busy !== null}
                      onClick={() =>
                        item.referenced ? setConfirm(item) : void moveToTrash(item, false)
                      }
                    >
                      <Trash2 size={15} />
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
          {!loading && !error && items.length > 0 && (
            <p className="text-xs text-muted-foreground">
              {unused ? `${unused} of ${items.length} not used on this page or its subpages. ` : ""}
              Files moved to the trash can be restored from Trash.
            </p>
          )}
          {!loading && !error && leftovers.length > 0 && (
            <p className="flex items-center gap-2 text-xs text-muted-foreground">
              <span className="min-w-0 flex-1">
                {leftovers.length} leftover text {leftovers.length === 1 ? "file" : "files"} from
                earlier extractions · {formatBytes(leftoverBytes)}. Nothing on this page uses{" "}
                {leftovers.length === 1 ? "it" : "them"}.
              </span>
              <button
                className="shrink-0 rounded-md border px-2.5 py-1 hover:bg-accent disabled:opacity-50"
                disabled={busy !== null}
                onClick={() => void clearLeftovers()}
              >
                {busy === "*" ? "Moving…" : "Move to trash"}
              </button>
            </p>
          )}
        </DialogContent>
      </Dialog>
      <AlertDialog open={confirm !== null} onOpenChange={(next) => !next && setConfirm(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Move “{confirm?.name}” to trash?</AlertDialogTitle>
            <AlertDialogDescription>
              This file is still used on {confirm?.referenced_by.join(", ") || "this page"}. Blocks
              that show it will stop working until you restore it from Trash.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                const item = confirm;
                setConfirm(null);
                if (item) void moveToTrash(item, true);
              }}
            >
              Move to trash
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
