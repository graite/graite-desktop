import { useContext, useEffect } from "react";
import { SideMenuExtension } from "@blocknote/core/extensions";
import { BlockNoteView } from "@blocknote/shadcn";
import {
  SuggestionMenuController,
  SideMenuController,
  SideMenu,
  DragHandleMenu,
  RemoveBlockItem,
  BlockColorsItem,
  TableHandlesController,
} from "@blocknote/react";
import "@blocknote/shadcn/style.css";
import "./editor.css";
import type { GraiteEditor } from "./schema";
import { getSlashMenuItems, filterSlashItems, type SlashMenuDeps } from "./slash-menu";
import { MediaContext } from "./media/context";
import { BlockTypeMenuItem } from "./BlockTypeMenuItem";

const SIDEBAR_PAGE = "application/graite-sidebar-page";

export interface EditorSurfaceProps {
  editor: GraiteEditor;
  slashDeps: SlashMenuDeps;
  onChange: () => void;
  instructionsOnly?: boolean;
}

/** The BlockNote view with Graite's menus. Shared by PageEditor and the mounted tests. */
export function EditorSurface({
  editor,
  slashDeps,
  onChange,
  instructionsOnly = false,
}: EditorSurfaceProps) {
  const { moveMedia, movePage } = useContext(MediaContext);
  useEffect(() => {
    // A page dragged from the sidebar onto a page link in the text moves it under that page.
    if (!movePage) return;
    const root = editor.prosemirrorView.dom;
    let highlighted: HTMLElement | null = null;
    const clearHighlight = () => {
      highlighted?.removeAttribute("data-media-drop-active");
      highlighted = null;
    };
    const linkAt = (event: DragEvent) =>
      event.dataTransfer?.types.includes(SIDEBAR_PAGE) && event.target instanceof Element
        ? event.target.closest<HTMLElement>("[data-media-drop-page]")
        : null;
    const over = (event: DragEvent) => {
      const target = linkAt(event);
      if (highlighted !== target) clearHighlight();
      if (!target) return;
      event.preventDefault();
      event.stopPropagation();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
      highlighted = target;
      target.setAttribute("data-media-drop-active", "");
    };
    const drop = (event: DragEvent) => {
      const target = linkAt(event);
      const path = target?.dataset.mediaDropPage;
      clearHighlight();
      if (!path) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      try {
        const source = JSON.parse(event.dataTransfer?.getData(SIDEBAR_PAGE) ?? "") as {
          path: string;
        };
        void movePage(source.path, path);
      } catch {
        /* Not a sidebar page. */
      }
    };
    root.addEventListener("dragover", over, true);
    root.addEventListener("dragleave", clearHighlight, true);
    root.addEventListener("drop", drop, true);
    return () => {
      clearHighlight();
      root.removeEventListener("dragover", over, true);
      root.removeEventListener("dragleave", clearHighlight, true);
      root.removeEventListener("drop", drop, true);
    };
  }, [editor, movePage]);
  useEffect(() => {
    if (!moveMedia) return;
    let dragged: string | undefined;
    let highlighted: HTMLElement | null = null;
    const clearHighlight = () => {
      highlighted?.removeAttribute("data-media-drop-active");
      highlighted = null;
    };
    const start = (event: DragEvent) => {
      if (!event.dataTransfer?.types.includes("blocknote/html")) {
        dragged = undefined;
        return;
      }
      const block = editor.getExtension(SideMenuExtension)?.store.state?.block;
      dragged = block?.type === "localMedia" ? block.id : undefined;
    };
    const over = (event: DragEvent) => {
      if (!dragged) return;
      const target =
        event.target instanceof Element
          ? event.target.closest<HTMLElement>("[data-media-drop-page]")
          : null;
      if (highlighted !== target) {
        clearHighlight();
        highlighted = target;
      }
      if (!target) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
      target.setAttribute("data-media-drop-active", "");
    };
    const end = () => {
      dragged = undefined;
      clearHighlight();
    };
    const drop = (event: DragEvent) => {
      const target =
        event.target instanceof Element
          ? event.target.closest<HTMLElement>("[data-media-drop-page]")
          : null;
      const path = target?.dataset.mediaDropPage;
      if (!dragged || !path) return;
      const block = dragged;
      event.preventDefault();
      event.stopImmediatePropagation();
      editor.prosemirrorView.dragging = null;
      const menu = editor.getExtension(SideMenuExtension);
      menu?.blockDragEnd();
      end();
      void moveMedia(block, path);
    };
    window.addEventListener("dragstart", start);
    window.addEventListener("dragover", over, true);
    window.addEventListener("drop", drop, true);
    window.addEventListener("dragend", end);
    return () => {
      end();
      window.removeEventListener("dragstart", start);
      window.removeEventListener("dragover", over, true);
      window.removeEventListener("drop", drop, true);
      window.removeEventListener("dragend", end);
    };
  }, [editor, moveMedia]);
  useEffect(() => {
    const root = editor.prosemirrorView.dom.ownerDocument;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finishDrag = () => {
      if (!editor.prosemirrorView.dragging) return;
      // A moved block can unmount its drag handle before React receives dragend.
      // Let ProseMirror finish the drop before clearing the preview and selection.
      timer = setTimeout(() => {
        editor.prosemirrorView.dragging = null;
        const menu = editor.getExtension(SideMenuExtension);
        menu?.blockDragEnd();
      }, 0);
    };
    root.addEventListener("drop", finishDrag, true);
    root.addEventListener("dragend", finishDrag, true);
    return () => {
      clearTimeout(timer);
      root.removeEventListener("drop", finishDrag, true);
      root.removeEventListener("dragend", finishDrag, true);
    };
  }, [editor]);
  useEffect(() => {
    const root = editor.prosemirrorView.dom;
    let frame = 0;
    const revealNewLine = (event: KeyboardEvent) => {
      if (event.key !== "Enter" || event.isComposing) return;
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (!editor.prosemirrorView.hasFocus()) return;
        const scroller = root.closest<HTMLElement>("[data-page-scroll]");
        if (!scroller) return;
        const cursor = editor.prosemirrorView.coordsAtPos(editor.prosemirrorState.selection.head);
        const bounds = scroller.getBoundingClientRect();
        const overflow = cursor.bottom - (bounds.bottom - 80);
        if (overflow > 0) scroller.scrollTop += overflow;
      });
    };
    root.addEventListener("keydown", revealNewLine);
    return () => {
      root.removeEventListener("keydown", revealNewLine);
      cancelAnimationFrame(frame);
    };
  }, [editor]);
  return (
    <BlockNoteView
      editor={editor}
      onChange={onChange}
      theme="light"
      slashMenu={false}
      sideMenu={false}
    >
      <SuggestionMenuController
        triggerCharacter="/"
        floatingUIOptions={{
          elementProps: { style: { overflowY: "auto", overscrollBehavior: "contain" } },
        }}
        getItems={async (query) =>
          filterSlashItems(
            getSlashMenuItems(editor, slashDeps).filter(
              (item) =>
                !instructionsOnly ||
                (item.title !== "Page" && !["Media", "Views"].includes(item.group ?? "")),
            ),
            query,
          )
        }
      />
      <TableHandlesController />
      <SideMenuController
        sideMenu={(props) => (
          <SideMenu
            {...props}
            dragHandleMenu={() => (
              <DragHandleMenu>
                <BlockTypeMenuItem />
                <RemoveBlockItem>Delete</RemoveBlockItem>
                <BlockColorsItem>Colors</BlockColorsItem>
              </DragHandleMenu>
            )}
          />
        )}
      />
    </BlockNoteView>
  );
}

// A partial hot swap of editor modules leaves ProseMirror plugins and React controllers
// pointing at different instances; reload the whole webview instead.
if (import.meta.hot) import.meta.hot.accept(() => window.location.reload());
