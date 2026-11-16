import { useEffect } from "react";
import { toast } from "sonner";
import { media } from "@/lib/media";
import type { GraiteEditor, GraitePartialBlock } from "./schema";

/**
 * Files dropped on (or pasted into) the text become media blocks where they were dropped.
 * Each file is stored as an attachment of the page first, then its block is inserted, so a
 * failed upload leaves nothing behind in the text.
 */

// What the daemon stores as page media (graite/api/media.py `upload`).
const ACCEPTED = /\.(png|jpe?g|webp|tiff?|pdf|wav|mp3|m4a|mp4|webm|ogg|oga|flac|aac)$/i;

type Placement = "before" | "after";
interface Spot {
  id: string;
  placement: Placement;
  line: DOMRect;
}

export function hasFiles(event: DragEvent | ClipboardEvent): boolean {
  const data = "dataTransfer" in event ? event.dataTransfer : event.clipboardData;
  return !!data && [...data.types].includes("Files");
}

/** The top-level block nearest to height `y`, and the side of it the files go on. */
export function dropSpot(root: HTMLElement, y: number): Spot | null {
  const blocks = [
    ...root.querySelectorAll<HTMLElement>(":scope > .bn-block-group > .bn-block-outer"),
  ];
  if (!blocks.length) return null;
  let chosen = blocks[blocks.length - 1]!;
  for (const block of blocks) {
    if (y <= block.getBoundingClientRect().bottom) {
      chosen = block;
      break;
    }
  }
  const box = chosen.getBoundingClientRect();
  const placement: Placement = y < box.top + box.height / 2 ? "before" : "after";
  const lineY = placement === "before" ? box.top : box.bottom;
  const id = chosen.getAttribute("data-id");
  return id ? { id, placement, line: new DOMRect(box.left, lineY, box.width, 0) } : null;
}

/** A clipboard screenshot arrives as "image.png" every time; give it a name of its own. */
function nameOf(file: File): string {
  if (file.name && file.name !== "image.png") return file.name;
  const stamp = new Date().toISOString().slice(0, 19).replace(/[T:]/g, "-");
  const extension = file.type === "image/jpeg" ? "jpg" : (file.type.split("/")[1] ?? "png");
  return `Pasted image ${stamp}.${extension}`;
}

/**
 * Upload `files` to the page and insert one media block per file at `spot` (or at the end
 * of the document). Returns how many were inserted.
 */
export async function insertFiles(
  editor: GraiteEditor,
  pageId: string,
  files: File[],
  spot: Pick<Spot, "id" | "placement"> | null,
): Promise<number> {
  const accepted = files.filter((file) => ACCEPTED.test(nameOf(file)));
  const refused = files.length - accepted.length;
  if (refused)
    toast.error(
      refused === 1 && files.length === 1
        ? "This kind of file cannot be added to a page. Use a PNG, JPEG, WebP or TIFF image, a PDF or audio."
        : `${refused} of ${files.length} files were skipped: only PNG, JPEG, WebP and TIFF images, PDFs and audio can be added.`,
    );
  let reference = spot?.id;
  let placement: Placement = spot?.placement ?? "after";
  let inserted = 0;
  for (const file of accepted) {
    const name = nameOf(file);
    try {
      const stored = await media.upload(pageId, file, name);
      const block = { type: "localMedia", props: { ...stored, job: "" } } as GraitePartialBlock;
      // The block the files were dropped next to may be gone by the time the upload ends.
      const anchor =
        (reference && editor.getBlock(reference)) || editor.document[editor.document.length - 1]!;
      if (!reference || !editor.getBlock(reference)) placement = "after";
      const [added] = editor.insertBlocks([block], anchor, placement);
      // The next file goes under this one, in the order the files were given.
      reference = added?.id;
      placement = "after";
      inserted++;
    } catch (e) {
      toast.error(`Could not add ${name}: ${(e as Error).message}`);
    }
  }
  return inserted;
}

/** Wire file drops and file pastes on the editor to `insertFiles`. */
export function useFileDrop(editor: GraiteEditor, pageId: string, enabled: boolean): void {
  useEffect(() => {
    if (!enabled || !pageId) return;
    const root = editor.prosemirrorView.dom;
    const doc = root.ownerDocument;
    // The whole page column takes the drop, so the margins beside the text count too.
    const area = root.closest<HTMLElement>("[data-page-scroll]") ?? root;
    // BlockNote re-sends drags near the editor as synthetic events aimed at it; the real
    // event already reaches `area`.
    const real = (event: Event) => !(event as { synthetic?: boolean }).synthetic;
    let line: HTMLElement | null = null;
    const hideLine = () => {
      line?.remove();
      line = null;
    };
    const over = (event: DragEvent) => {
      if (!real(event) || !hasFiles(event) || !editor.isEditable) return;
      event.preventDefault();
      event.stopPropagation();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
      const spot = dropSpot(root, event.clientY);
      if (!spot) return hideLine();
      if (!line) {
        line = doc.createElement("div");
        line.className = "block-drop-line";
        doc.body.append(line);
      }
      line.style.display = "block";
      line.style.transform = `translate3d(${spot.line.left}px, ${spot.line.top - 1}px, 0)`;
      line.style.width = `${spot.line.width}px`;
    };
    const drop = (event: DragEvent) => {
      if (!real(event) || !hasFiles(event) || !editor.isEditable) return;
      // Keep BlockNote's own file handler (which has nowhere to upload to) out of it.
      event.preventDefault();
      event.stopImmediatePropagation();
      hideLine();
      const files = [...(event.dataTransfer?.files ?? [])];
      if (files.length) void insertFiles(editor, pageId, files, dropSpot(root, event.clientY));
    };
    const paste = (event: ClipboardEvent) => {
      const data = event.clipboardData;
      // Text copied from an office app also carries a picture of itself: text wins.
      if (!data?.files.length || data.getData("text/plain") || !editor.isEditable) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      let spot: Pick<Spot, "id" | "placement"> | null = null;
      try {
        spot = { id: editor.getTextCursorPosition().block.id, placement: "after" };
      } catch {
        /* no text cursor: add at the end */
      }
      void insertFiles(editor, pageId, [...data.files], spot);
    };
    // A file dropped beside the text would otherwise replace the app with that file.
    const guard = (event: DragEvent) => {
      if (hasFiles(event) && !event.defaultPrevented) event.preventDefault();
    };
    area.addEventListener("dragover", over, true);
    area.addEventListener("dragleave", hideLine, true);
    area.addEventListener("drop", drop, true);
    root.addEventListener("paste", paste, true);
    doc.addEventListener("dragend", hideLine);
    window.addEventListener("dragover", guard);
    window.addEventListener("drop", guard);
    return () => {
      hideLine();
      area.removeEventListener("dragover", over, true);
      area.removeEventListener("dragleave", hideLine, true);
      area.removeEventListener("drop", drop, true);
      root.removeEventListener("paste", paste, true);
      doc.removeEventListener("dragend", hideLine);
      window.removeEventListener("dragover", guard);
      window.removeEventListener("drop", guard);
    };
  }, [editor, pageId, enabled]);
}
