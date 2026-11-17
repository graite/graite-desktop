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
import { TableExtendButton } from "./TableExtendButton";
import type { GraiteEditor } from "./schema";
import { getSlashMenuItems, filterSlashItems, type SlashMenuDeps } from "./slash-menu";
import { MediaContext } from "./media/context";
import { BlockTypeMenuItem } from "./BlockTypeMenuItem";
import { useBlockDrag } from "./blockDrag";
import { useFileDrop } from "./fileDrop";
import { TEXT_DRAG, beginTextDrag, dropTextOnPage, endTextDrag } from "./textDrag";
import { useTheme } from "@/lib/theme";

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
  const { pageId, pagePath, moveMedia, movePage, moveBlocks, moveSelection } =
    useContext(MediaContext);
  useFileDrop(editor, pageId, !instructionsOnly);
  const theme = useTheme();
  useEffect(() => {
    // Dropped on a page: a page dragged from the sidebar onto a page link in the text moves
    // under that page, and text dragged out of this page onto a page link or a sidebar row
    // moves into that page. Listening on the window, ahead of BlockNote's document-level
    // handler, which would otherwise treat a drop on the sidebar as a drop into the text.
    if (!movePage && !moveSelection) return;
    const root = editor.prosemirrorView.dom;
    let highlighted: HTMLElement | null = null;
    const clearHighlight = () => {
      highlighted?.removeAttribute("data-media-drop-active");
      highlighted = null;
    };
    const kindOf = (event: DragEvent) => {
      const types = event.dataTransfer?.types ?? [];
      if (movePage && types.includes(SIDEBAR_PAGE)) return "page";
      if (moveSelection && types.includes(TEXT_DRAG)) return "text";
      return null;
    };
    const pageAt = (event: DragEvent) => {
      const kind = kindOf(event);
      if (!kind || !(event.target instanceof Element)) return null;
      const page = event.target.closest<HTMLElement>("[data-media-drop-page]");
      if (!page) return null;
      // A sidebar page is only nested by dropping it on a link in the text; the sidebar
      // handles drops on its own rows.
      if (kind === "page") return root.contains(page) ? page : null;
      // Text dropped on this page itself, or on a link inside the dragged selection, stays.
      if (page.dataset.mediaDropPage === pagePath) return null;
      if (page.closest(".ProseMirror-selectednode")) return null;
      return page;
    };
    const over = (event: DragEvent) => {
      const target = pageAt(event);
      if (highlighted !== target) clearHighlight();
      if (!target) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
      highlighted = target;
      target.setAttribute("data-media-drop-active", "");
    };
    const drop = (event: DragEvent) => {
      const target = pageAt(event);
      const path = target?.dataset.mediaDropPage;
      const kind = kindOf(event);
      clearHighlight();
      if (!path) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (kind === "text") {
        dropTextOnPage(path);
        return;
      }
      try {
        const source = JSON.parse(event.dataTransfer?.getData(SIDEBAR_PAGE) ?? "") as {
          path: string;
        };
        void movePage?.(source.path, path);
      } catch {
        /* Not a sidebar page. */
      }
    };
    // ProseMirror starts the drag of selected text; mark it so pages accept the drop.
    const dragStart = (event: DragEvent) => {
      if (!moveSelection || !event.dataTransfer || !editor.prosemirrorView.dragging) return;
      if (editor.prosemirrorState.selection.empty) return;
      event.dataTransfer.setData(TEXT_DRAG, "1");
      event.dataTransfer.effectAllowed = "copyMove";
      beginTextDrag((path) => void moveSelection(path));
    };
    const dragEnd = () => {
      clearHighlight();
      setTimeout(endTextDrag, 0);
    };
    root.addEventListener("dragstart", dragStart);
    window.addEventListener("dragend", dragEnd);
    window.addEventListener("dragover", over, true);
    window.addEventListener("drop", drop, true);
    return () => {
      clearHighlight();
      endTextDrag();
      root.removeEventListener("dragstart", dragStart);
      window.removeEventListener("dragend", dragEnd);
      window.removeEventListener("dragover", over, true);
      window.removeEventListener("drop", drop, true);
    };
  }, [editor, pagePath, movePage, moveSelection]);
  useBlockDrag(editor, { moveMedia, movePage, moveBlocks });
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
      theme={theme}
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
      <TableHandlesController extendButton={TableExtendButton} />
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
