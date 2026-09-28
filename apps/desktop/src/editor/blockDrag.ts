import { useEffect } from "react";
import { SideMenuExtension } from "@blocknote/core/extensions";
import type { GraiteBlock, GraiteEditor } from "./schema";

/**
 * Moving blocks with the side-menu handle, driven by pointer events instead of HTML5 drag and
 * drop. The native drag runs inside the OS drag loop (OLE on Windows, GTK on Linux), which
 * delivers `dragover` in bursts, so the drop line and preview stutter behind the cursor there.
 * Pointer events arrive every frame on every platform.
 *
 * A press on the handle that moves less than DRAG_THRESHOLD stays a click and opens the
 * handle's menu as before. Dropping a media block on a page (sidebar row or page link) moves
 * the file there; dropping a page link on another page link nests that page under it.
 */

const DRAG_THRESHOLD = 4;
const SCROLL_EDGE = 56;
const HANDLE = '.bn-side-menu [draggable="true"]';
const PAGE_TARGET = "[data-media-drop-page]";

export interface BlockDropActions {
  moveMedia?: (blockId: string, path: string) => Promise<void>;
  movePage?: (sourcePath: string, targetPath: string) => Promise<void>;
}

type Placement = "before" | "after";
type Target =
  | { kind: "block"; id: string; placement: Placement; line: DOMRect }
  | { kind: "page"; path: string; element: HTMLElement }
  | null;

/** The blocks a press on `block`'s handle drags: the selection when it spans that block. */
function draggedBlocks(editor: GraiteEditor, block: GraiteBlock): GraiteBlock[] {
  const selected = editor.getSelection()?.blocks as GraiteBlock[] | undefined;
  if (selected && selected.length > 1 && selected.some((b) => b.id === block.id)) {
    const parent = editor.getParentBlock(block.id)?.id;
    if (selected.every((b) => editor.getParentBlock(b.id)?.id === parent)) return selected;
  }
  return [block];
}

function isInside(el: Element, ids: Set<string>): boolean {
  for (let node: Element | null = el; node; node = node.parentElement?.closest("[data-id]") ?? null)
    if (node.getAttribute("data-id") && ids.has(node.getAttribute("data-id")!)) return true;
  return false;
}

export function useBlockDrag(editor: GraiteEditor, actions: BlockDropActions) {
  const { moveMedia, movePage } = actions;
  useEffect(() => {
    const view = editor.prosemirrorView;
    const root = view.dom;
    const doc = root.ownerDocument;
    let session: (() => void) | null = null;

    const begin = (down: PointerEvent, handle: HTMLElement) => {
      const block = editor.getExtension(SideMenuExtension)?.store.state?.block as
        GraiteBlock | undefined;
      if (!block) return;
      const startX = down.clientX;
      const startY = down.clientY;
      let x = startX;
      let y = startY;
      let dragging = false;
      let frame = 0;
      let target: Target = null;
      let blocks: GraiteBlock[] = [];
      let ids = new Set<string>();
      let ghost: HTMLElement | null = null;
      let line: HTMLElement | null = null;
      let highlighted: HTMLElement | null = null;
      const scroller = root.closest<HTMLElement>("[data-page-scroll]");
      const sideMenu = editor.getExtension(SideMenuExtension);
      // Keep the handle on the dragged block while the pointer crosses others. BlockNote's
      // freeze needs the menu's view state, which a menu that never showed does not have.
      const freeze = (frozen: boolean) => {
        try {
          if (frozen) sideMenu?.freezeMenu();
          else sideMenu?.unfreezeMenu();
        } catch {
          /* No menu view to freeze. */
        }
      };

      const start = () => {
        dragging = true;
        blocks = draggedBlocks(editor, block);
        ids = new Set(blocks.map((b) => b.id));
        freeze(true);
        doc.body.classList.add("block-dragging");
        for (const id of ids)
          root
            .querySelector(`.bn-block-outer[data-id="${CSS.escape(id)}"]`)
            ?.classList.add("block-drag-source");
        const source = root.querySelector<HTMLElement>(
          `.bn-block-outer[data-id="${CSS.escape(block.id)}"] .bn-block-content`,
        );
        ghost = doc.createElement("div");
        ghost.className = "block-drag-ghost";
        const label = (source?.textContent ?? "").trim().slice(0, 80) || block.type;
        ghost.textContent = blocks.length > 1 ? `${label}  +${blocks.length - 1}` : label;
        line = doc.createElement("div");
        line.className = "block-drop-line";
        doc.body.append(ghost, line);
      };

      const pageTarget = (el: Element | null): Target => {
        const kind = blocks.length === 1 ? blocks[0]!.type : "";
        const page = el?.closest<HTMLElement>(PAGE_TARGET);
        const path = page?.dataset.mediaDropPage;
        if (!page || !path || isInside(page, ids)) return null;
        if (kind === "localMedia" && moveMedia) return { kind: "page", path, element: page };
        // A page link can only be nested under another page link in the text.
        if (kind === "pageLink" && movePage && root.contains(page)) {
          const source = (blocks[0]!.props as { path?: string }).path;
          if (source && source !== path && !path.startsWith(source + "/"))
            return { kind: "page", path, element: page };
        }
        return null;
      };

      const blockTarget = (): Target => {
        const box = root.getBoundingClientRect();
        // Sample inside the text column so the gutter and margins still find a block.
        const probeX = Math.min(Math.max(x, box.left + 24), box.right - 8);
        let outer = doc.elementFromPoint(probeX, y)?.closest<HTMLElement>(".bn-block-outer");
        if (outer && !root.contains(outer)) outer = null;
        while (outer && isInside(outer, ids))
          outer = outer.parentElement?.closest<HTMLElement>(".bn-block-outer") ?? null;
        if (!outer) {
          const all = [
            ...root.querySelectorAll<HTMLElement>(":scope .bn-block-group > .bn-block-outer"),
          ];
          const top = all.filter(
            (el) => !isInside(el, ids) && el.parentElement?.closest(".bn-block-outer") === null,
          );
          if (!top.length) return null;
          outer = y < box.top + box.height / 2 ? top[0]! : top[top.length - 1]!;
        }
        const id = outer.getAttribute("data-id")!;
        const content =
          outer.querySelector<HTMLElement>(":scope > .bn-block > .bn-block-content") ?? outer;
        const rect = content.getBoundingClientRect();
        const placement: Placement = y < rect.top + rect.height / 2 ? "before" : "after";
        // "after" a block with children goes after its whole subtree.
        const whole = outer.getBoundingClientRect();
        const lineY = placement === "before" ? rect.top : whole.bottom;
        return { kind: "block", id, placement, line: new DOMRect(rect.left, lineY, rect.width, 0) };
      };

      const render = () => {
        frame = 0;
        if (!ghost || !line) return;
        ghost.style.transform = `translate3d(${x + 12}px, ${y + 8}px, 0)`;
        target = pageTarget(doc.elementFromPoint(x, y)) ?? blockTarget();
        const page = target?.kind === "page" ? target.element : null;
        if (highlighted !== page) {
          highlighted?.removeAttribute("data-media-drop-active");
          page?.setAttribute("data-media-drop-active", "");
          highlighted = page;
        }
        if (target?.kind === "block") {
          line.style.display = "block";
          line.style.transform = `translate3d(${target.line.left}px, ${target.line.top - 1}px, 0)`;
          line.style.width = `${target.line.width}px`;
        } else line.style.display = "none";
        if (scroller) {
          const box = scroller.getBoundingClientRect();
          const speed =
            y < box.top + SCROLL_EDGE
              ? -Math.ceil((box.top + SCROLL_EDGE - y) / 4)
              : y > box.bottom - SCROLL_EDGE
                ? Math.ceil((y - box.bottom + SCROLL_EDGE) / 4)
                : 0;
          if (speed) {
            scroller.scrollTop += speed;
            schedule();
          }
        }
      };
      const schedule = () => {
        if (!frame) frame = requestAnimationFrame(render);
      };

      // With `draggable` set, the browser's own drag detection swallows the pointer moves that
      // follow the press, so it is off for the length of the press.
      handle.draggable = false;

      const cleanup = () => {
        handle.draggable = true;
        cancelAnimationFrame(frame);
        window.removeEventListener("pointermove", move, true);
        window.removeEventListener("pointerup", up, true);
        window.removeEventListener("pointercancel", cancel, true);
        window.removeEventListener("keydown", key, true);
        window.removeEventListener("mouseup", mouseUp, true);
        window.removeEventListener("blur", cleanup);
        highlighted?.removeAttribute("data-media-drop-active");
        ghost?.remove();
        line?.remove();
        doc.body.classList.remove("block-dragging");
        root
          .querySelectorAll(".block-drag-source")
          .forEach((el) => el.classList.remove("block-drag-source"));
        if (dragging) freeze(false);
        session = null;
      };

      const drop = () => {
        const done = target;
        if (!done) return;
        if (done.kind === "page") {
          const moved = blocks[0]!;
          if (moved.type === "localMedia") void moveMedia?.(moved.id, done.path);
          else void movePage?.((moved.props as { path: string }).path, done.path);
          return;
        }
        if (ids.has(done.id)) return;
        const current = blocks.map((b) => editor.getBlock(b.id)).filter(Boolean) as GraiteBlock[];
        if (!current.length) return;
        editor.transact(() => {
          editor.removeBlocks(current.map((b) => b.id));
          editor.insertBlocks(current, done.id, done.placement);
        });
        // Focus the moved block, as a native drop does, so Ctrl+Z undoes the move right away.
        editor.focus();
        try {
          editor.setTextCursorPosition(current[0]!.id, "end");
        } catch {
          /* A block without text (image, view) keeps the editor's selection. */
        }
      };

      const move = (event: PointerEvent) => {
        if (event.pointerId !== down.pointerId) return;
        // The button is no longer held: the release never reached us (the handle's menu can
        // take it). A drag only ever happens while the button is down, so end here.
        if ((event.buttons & 1) === 0) {
          cleanup();
          return;
        }
        x = event.clientX;
        y = event.clientY;
        if (!dragging) {
          if (Math.hypot(x - startX, y - startY) < DRAG_THRESHOLD) return;
          start();
        }
        event.preventDefault();
        schedule();
      };
      const release = (event: Event) => {
        if (dragging) {
          // Keep the release from reaching the handle, which would open its menu.
          event.stopPropagation();
          event.preventDefault();
          cancelAnimationFrame(frame);
          render();
          drop();
          const swallowClick = (e: MouseEvent) => {
            e.stopPropagation();
            e.preventDefault();
          };
          window.addEventListener("click", swallowClick, { capture: true, once: true });
          setTimeout(() => window.removeEventListener("click", swallowClick, true), 0);
        }
        cleanup();
      };
      const up = (event: PointerEvent) => {
        if (event.pointerId === down.pointerId) release(event);
      };
      // Fallback for webviews that deliver the mouse release but not the pointer one.
      const mouseUp = (event: MouseEvent) => {
        if (session === cleanup) release(event);
      };
      const cancel = () => cleanup();
      const key = (event: KeyboardEvent) => {
        if (event.key === "Escape" && dragging) {
          event.preventDefault();
          cleanup();
        }
      };
      window.addEventListener("pointermove", move, true);
      window.addEventListener("pointerup", up, true);
      window.addEventListener("pointercancel", cancel, true);
      window.addEventListener("keydown", key, true);
      window.addEventListener("mouseup", mouseUp, true);
      window.addEventListener("blur", cleanup);
      session = cleanup;
    };

    const pointerDown = (event: PointerEvent) => {
      // A new press always starts fresh, even if an earlier one was never released for us.
      session?.();
      if (event.button !== 0 || !editor.isEditable) return;
      const handle = (event.target as Element | null)?.closest?.<HTMLElement>(HANDLE);
      if (handle) begin(event, handle);
    };
    // The handle is `draggable` for BlockNote's own drag; this module replaces that drag.
    const nativeDrag = (event: DragEvent) => {
      if ((event.target as Element | null)?.closest?.(HANDLE)) event.preventDefault();
    };
    doc.addEventListener("pointerdown", pointerDown, true);
    doc.addEventListener("dragstart", nativeDrag, true);
    return () => {
      session?.();
      doc.removeEventListener("pointerdown", pointerDown, true);
      doc.removeEventListener("dragstart", nativeDrag, true);
    };
  }, [editor, moveMedia, movePage]);
}
