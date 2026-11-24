import { useEffect, useState } from "react";
import { Download, FilePlus, FileSearch, Orbit, ScanText } from "lucide-react";
import { toast } from "sonner";
import type { TreeNode } from "@/lib/api";
import { mail, saveAttachment, type MailFileInfo } from "@/lib/mail";
import { formatBytes } from "@/lib/media";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { PagePicker } from "@/editor/PagePicker";
import { findNode } from "@/editor/tree-utils";

/** Pages of a PDF drawn at first; the rest come with "Show more pages". */
const PAGES_AT_ONCE = 5;

export interface OpenFile {
  accountId: string;
  messageId: number;
  index: number;
  name: string;
  size: number;
}

/**
 * An attachment, looked at inside Graite. PDFs and pictures are drawn by the daemon and shown
 * as plain images, so the file itself is never opened by the app. From here it can go onto a
 * page (with or without its text read), to the AI, or to the downloads folder.
 */
export function AttachmentDialog({
  file,
  tree,
  onClose,
  onAskAI,
  onNavigate,
}: {
  file: OpenFile | null;
  tree: TreeNode[];
  onClose: () => void;
  onAskAI?: () => void;
  onNavigate?: (path: string) => void;
}) {
  const [info, setInfo] = useState<MailFileInfo | null>(null);
  const [error, setError] = useState("");
  const [pages, setPages] = useState<string[]>([]);
  const [wanted, setWanted] = useState(PAGES_AT_ONCE);
  // Choosing a page for "Add to page": with or without reading the text.
  const [picking, setPicking] = useState<null | { extract: boolean }>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setInfo(null);
    setError("");
    setPages([]);
    setWanted(PAGES_AT_ONCE);
    if (!file) return;
    let live = true;
    mail
      .attachmentInfo(file.accountId, file.messageId, file.index)
      .then((found) => live && setInfo(found))
      .catch((e: Error) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [file]);

  // Pages are drawn one after another, so the first is on screen as soon as it is ready.
  useEffect(() => {
    if (!file || !info || info.kind === "other") return;
    let live = true;
    const made: string[] = [];
    void (async () => {
      for (let page = pages.length; page < Math.min(info.pages, wanted); page++) {
        try {
          const blob = await mail.attachmentPreview(
            file.accountId,
            file.messageId,
            file.index,
            page,
          );
          if (!live) return;
          const url = URL.createObjectURL(blob);
          made.push(url);
          setPages((old) => [...old, url]);
        } catch (e) {
          if (live) setError((e as Error).message);
          return;
        }
      }
    })();
    return () => {
      live = false;
    };
    // `pages` grows inside this effect; it starts again only for another file or more pages.
  }, [file, info, wanted]);
  useEffect(
    () => () => {
      for (const url of pages) URL.revokeObjectURL(url);
    },
    // Freed when the dialog moves to another file or closes.
    [file],
  );

  const download = () => {
    if (!file) return;
    const done = toast.loading(`Saving ${file.name}…`);
    void saveAttachment(file.accountId, file.messageId, file.index, file.name)
      .then(() => toast.success(`${file.name} saved to your downloads`, { id: done }))
      .catch((e: Error) => toast.error(e.message, { id: done }));
  };

  const addTo = async (page: { path: string; title: string }, extract: boolean) => {
    const id = findNode(tree, page.path)?.id;
    if (!file || !id) return;
    setPicking(null);
    setBusy(true);
    try {
      const saved = await mail.saveAttachmentToPage(
        file.accountId,
        file.messageId,
        file.index,
        id,
        extract,
      );
      // The dialog makes way, so the note with "Open page" can be reached.
      onClose();
      toast.success(
        extract
          ? `Added to ${page.title}. Its text is being read and will appear under the file.`
          : `Added to ${page.title}`,
        {
          action: onNavigate
            ? { label: "Open page", onClick: () => onNavigate(saved.page_path) }
            : undefined,
        },
      );
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const viewable = info !== null && info.kind !== "other";
  return (
    <>
      <Dialog open={file !== null && picking === null} onOpenChange={(open) => !open && onClose()}>
        <DialogContent className="flex h-[88vh] max-w-4xl flex-col gap-0 p-0 sm:max-w-4xl">
          <DialogHeader className="border-b px-5 py-3">
            <DialogTitle className="truncate pr-8 text-base">{file?.name}</DialogTitle>
            <DialogDescription className="text-xs">
              {file ? formatBytes(file.size) : ""}
              {info?.kind === "pdf" && ` · ${info.pages} ${info.pages === 1 ? "page" : "pages"}`}
              {" · fetched from your mailbox, kept here for an hour at most"}
            </DialogDescription>
            <div className="flex flex-wrap gap-1.5 pt-2">
              <Button variant="outline" size="sm" onClick={download}>
                <Download /> Download
              </Button>
              {viewable && (
                <>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busy}
                    onClick={() => setPicking({ extract: false })}
                  >
                    <FilePlus /> Add to a page
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busy}
                    title="Add it to a page and read its text into the page (a PDF's text, or OCR for scans and pictures)"
                    onClick={() => setPicking({ extract: true })}
                  >
                    <ScanText /> Add to a page and read its text
                  </Button>
                </>
              )}
              {onAskAI && (
                <Button
                  variant="outline"
                  size="sm"
                  title="Ask AI about the email and its attachments"
                  onClick={() => {
                    onClose();
                    onAskAI();
                  }}
                >
                  <Orbit /> Ask AI
                </Button>
              )}
            </div>
          </DialogHeader>
          <div className="min-h-0 flex-1 overflow-y-auto bg-muted/40 p-5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            {error ? (
              <p role="alert" className="py-16 text-center text-sm text-muted-foreground">
                {error}
              </p>
            ) : info === null ? (
              <p className="py-16 text-center text-sm text-muted-foreground">
                Fetching the attachment…
              </p>
            ) : !viewable ? (
              <div className="py-16 text-center text-sm text-muted-foreground">
                <FileSearch className="mx-auto mb-3 size-6" />
                This kind of file cannot be shown here. Download it to open it.
              </div>
            ) : (
              <div className="mx-auto grid max-w-3xl gap-4">
                {pages.map((url, page) => (
                  <img
                    key={url}
                    src={url}
                    alt={info.kind === "pdf" ? `Page ${page + 1}` : info.name}
                    className="mx-auto max-w-full rounded-md border bg-white shadow-sm"
                  />
                ))}
                {pages.length < Math.min(info.pages, wanted) && (
                  <p className="py-6 text-center text-sm text-muted-foreground">Drawing…</p>
                )}
                {pages.length >= wanted && info.pages > wanted && (
                  <Button
                    variant="outline"
                    size="sm"
                    className="mx-auto"
                    onClick={() => setWanted((n) => n + PAGES_AT_ONCE * 2)}
                  >
                    Show more pages ({info.pages - wanted} left)
                  </Button>
                )}
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>
      <PagePicker
        open={picking !== null}
        tree={tree}
        excludePath={null}
        title={picking?.extract ? "Add to a page and read its text" : "Add to a page"}
        onPick={(page) => void addTo(page, picking?.extract ?? false)}
        onCancel={() => setPicking(null)}
      />
    </>
  );
}
