import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useCreateBlockNote } from "@blocknote/react";
import { toBlocks, fromBlocks } from "@graite/md-convert";
import { FolderOpen, Orbit, Paperclip } from "lucide-react";
import { canRevealPage, revealPage } from "@/pages/revealPage";
import { toast } from "sonner";
import { hasBodyContent, PageIcon } from "@/components/PageIcon";
import { EmojiPickerPanel } from "@/components/EmojiPickerPanel";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { ConflictError, pages, type PageDoc, type TreeNode } from "@/lib/api";
import { reportError } from "@/lib/clientLog";
import { schema, type GraiteBlock, type GraiteEditor, type GraitePartialBlock } from "./schema";
import { PageProperties } from "@/pages/PageProperties";
import { InlineProposalCard } from "@/review/InlineProposalCard";
import { InlineProposals } from "@/review/InlineProposals";
import { PageReviewBar } from "@/review/PageReviewBar";
import { usePageReviews } from "@/review/usePageReviews";
import { AiSettingsDialog } from "@/pages/AiSettingsDialog";
import { AttachmentsDialog } from "@/pages/AttachmentsDialog";
import { workspace, type PageProperty } from "@/lib/workspace";
import { media } from "@/lib/media";
import { MediaContext } from "./media/context";
import { EditorSurface } from "./EditorSurface";
import { editorExtensions } from "./reviewDecorations";
import { useSelectAllStages } from "./useSelectAllStages";
import { markdownPasteHandler } from "./paste";
import { Breadcrumbs } from "@/app/Breadcrumbs";
import { PagePicker } from "./PagePicker";
import { findNode, linkTarget, resolveTarget, type FlatPage } from "./tree-utils";
import type { PickedPage } from "./slash-menu";

export interface PageEditorProps {
  settingsRequested?: boolean;
  onSettingsOpened?: () => void;
  onNavigateSettings?: (path: string) => Promise<void>;
  registerFlush?: (flush: (() => Promise<void>) | null) => void;
  page: PageDoc;
  tree: TreeNode[];
  /** Bump to re-apply `page.body` (external change). */
  refreshNonce: number;
  onNavigate: (path: string) => void;
  onTitleChange: (title: string) => void;
  onIconChange: (icon: string | null) => void;
  /** The daemon renamed the folder (title change): old path -> new path. */
  onRenamed: (oldPath: string, newPath: string) => void;
  onTreeChanged: () => void;
  onSaved: (hash: string) => void;
  /** Selected text in the editor, so the chat panel can attach it. */
  onSelectionChange?: (text: string) => void;
}

const SAVE_DEBOUNCE_MS = 600;
const TITLE_DEBOUNCE_MS = 800;
const renameFailed = (e: unknown) => toast.error(`Rename failed: ${(e as Error).message}`);

function collectPageLinkPaths(blocks: GraiteBlock[], out = new Set<string>()): Set<string> {
  for (const b of blocks) {
    if (b.type === "pageLink" && b.props.path) out.add(b.props.path);
    if (b.children?.length) collectPageLinkPaths(b.children as GraiteBlock[], out);
  }
  return out;
}

/**
 * Replace the whole document WITHOUT recording an undo step: a page load must not be
 * undoable (Ctrl+Z would otherwise revert to the empty initial document).
 */
export function loadBlocks(editor: GraiteEditor, blocks: GraitePartialBlock[]): void {
  editor.transact((tr) => {
    editor.replaceBlocks(editor.document, blocks);
    tr.setMeta("addToHistory", false);
  });
}

/** True while the most recent editor transaction was an undo/redo (prosemirror-history marks them). */
export function trackHistoryTransactions(editor: GraiteEditor): {
  readonly lastWasHistory: boolean;
  dispose: () => void;
} {
  const state = { lastWasHistory: false, dispose: () => {} };
  const handler = ({ transaction }: { transaction: { getMeta: (k: string) => unknown } }) => {
    state.lastWasHistory = transaction.getMeta("history$") !== undefined;
  };
  editor._tiptapEditor.on("transaction", handler);
  state.dispose = () => editor._tiptapEditor.off("transaction", handler);
  return state;
}

/**
 * Which removed page links may be trashed for this change. Undo/redo, an emptied document,
 * or several links vanishing at once are never an intentional "delete this page".
 */
export function linksToTrash(
  removed: string[],
  opts: { lastWasHistory: boolean; documentEmpty: boolean },
): string[] {
  if (opts.lastWasHistory || opts.documentEmpty || removed.length !== 1) return [];
  return removed;
}

/** A page with a table / board / list view gets the full-width layout. */
function hasPageView(blocks: GraiteBlock[]): boolean {
  return blocks.some(
    (b) =>
      b.type === "pageView" || (!!b.children?.length && hasPageView(b.children as GraiteBlock[])),
  );
}

function isDocumentEmpty(blocks: GraiteBlock[]): boolean {
  return blocks.every(
    (b) =>
      b.type === "paragraph" &&
      (!Array.isArray(b.content) || b.content.length === 0) &&
      !b.children?.length,
  );
}

/** Fill pageLink path/title/icon from the tree (markdown only stores the `[[target]]` text). */
function hydratePageLinks(
  blocks: GraitePartialBlock[],
  tree: TreeNode[],
  pagePath: string,
): GraitePartialBlock[] {
  return blocks.map((b) => {
    if (b.type === "pageLink" && b.props) {
      const target = b.props.target || b.props.title || b.props.path || "";
      const node = resolveTarget(tree, pagePath, target);
      const props = node
        ? {
            path: node.path,
            title: node.title,
            icon: node.icon ?? "",
            target: linkTarget(pagePath, node),
            empty: node.has_content ? "" : "1",
          }
        : { path: b.props.path ?? "", title: target, icon: b.props.icon ?? "", target };
      return { ...b, props };
    }
    if (b.children?.length) {
      return {
        ...b,
        children: hydratePageLinks(b.children as GraitePartialBlock[], tree, pagePath),
      };
    }
    return b;
  });
}

export function PageEditor({
  settingsRequested,
  onSettingsOpened,
  onNavigateSettings,
  registerFlush,
  page,
  tree,
  refreshNonce,
  onNavigate,
  onTitleChange,
  onIconChange,
  onRenamed,
  onTreeChanged,
  onSaved,
  onSelectionChange,
}: PageEditorProps) {
  // Pasted links resolve against the current tree and page, which change after mount.
  const linkContextRef = useRef({ tree, path: page.path });
  linkContextRef.current = { tree, path: page.path };
  const [pasteHandler] = useState(() =>
    markdownPasteHandler((blocks) =>
      hydratePageLinks(blocks, linkContextRef.current.tree, linkContextRef.current.path),
    ),
  );
  const editor = useCreateBlockNote({ schema, extensions: editorExtensions, pasteHandler });
  useSelectAllStages(editor);

  // Report the editor's selected text so "Ask AI" can attach it as a source.
  const selectionRef = useRef(onSelectionChange);
  selectionRef.current = onSelectionChange;
  useEffect(
    () => editor.onSelectionChange(() => selectionRef.current?.(editor.getSelectedText())),
    [editor],
  );
  const historyRef = useRef<ReturnType<typeof trackHistoryTransactions> | null>(null);
  useEffect(() => {
    historyRef.current = trackHistoryTransactions(editor);
    return () => historyRef.current?.dispose();
  }, [editor]);

  // A rename moves the folder before the workspace reloads the page, so only take the
  // path from props when the props themselves change.
  const pathRef = useRef(page.path);
  const propPathRef = useRef(page.path);
  if (propPathRef.current !== page.path) {
    propPathRef.current = page.path;
    pathRef.current = page.path;
  }
  const baseHashRef = useRef<string | null>(null);
  // The body as it is on disk, and a counter bumped whenever the editor is known to match it
  // (a load or a save): review markers are placed against this text.
  const diskBodyRef = useRef(page.body);
  const [bodyVersion, setBodyVersion] = useState(0);
  const markDisk = useCallback((markdown: string) => {
    diskBodyRef.current = markdown;
    setBodyVersion((v) => v + 1);
  }, []);
  const syncingRef = useRef(false);
  const dirtyRef = useRef(false);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const titleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Renames run one at a time: each moves the folder, so the next one needs the new path.
  const titleCommitRef = useRef<Promise<void>>(Promise.resolve());
  const titleInputRef = useRef<HTMLInputElement>(null);
  const titleFocusedRef = useRef(false);
  const linkPathsRef = useRef<Set<string>>(new Set());
  const appliedRef = useRef<{ id: string | null; nonce: number }>({ id: null, nonce: -1 });

  const [title, setTitle] = useState(page.title);
  const [emojiOpen, setEmojiOpen] = useState(false);
  const flushPendingRef = useRef<(() => Promise<void>) | null>(null);
  const [aiSettingsOpen, setAiSettingsOpen] = useState(false);
  const [attachmentsOpen, setAttachmentsOpen] = useState(false);
  useEffect(() => {
    if (settingsRequested) {
      setAiSettingsOpen(true);
      onSettingsOpened?.();
    }
  }, [settingsRequested, onSettingsOpened]);
  const [hasContent, setHasContent] = useState(() => hasBodyContent(page.body));
  const [hasView, setHasView] = useState(false);
  const [conflict, setConflict] = useState<{ hash: string; body: string } | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const pickerResolveRef = useRef<((page: PickedPage | null) => void) | null>(null);

  // Never overwrite what the user is typing with a title reloaded from disk.
  useEffect(() => {
    if (!titleFocusedRef.current && !titleTimerRef.current) setTitle(page.title);
  }, [page.title]);
  // A fresh, empty page opens with the cursor in its title.
  useEffect(() => {
    if (page.title === "Untitled" && !hasBodyContent(page.body)) titleInputRef.current?.focus();
    // Only on mount: the editor is keyed by page id.
  }, []);

  const applyBody = useCallback(
    (body: string, hash: string) => {
      let blocks: GraitePartialBlock[];
      try {
        blocks = hydratePageLinks(toBlocks(body) as GraitePartialBlock[], tree, pathRef.current);
      } catch (e) {
        // Never show an empty editor for a page that has content: fall back to raw markdown.
        reportError(`toBlocks failed for ${pathRef.current}`, e, "applyBody");
        toast.error("Could not render this page; showing raw markdown.");
        blocks = [{ type: "rawMarkdown", props: { source: body } }];
      }
      if (blocks.length === 0) blocks = [{ type: "paragraph" }];
      syncingRef.current = true;
      try {
        loadBlocks(editor, blocks);
      } catch (e) {
        reportError(`replaceBlocks failed for ${pathRef.current}`, e, "applyBody");
        toast.error("Could not render this page; showing raw markdown.");
        loadBlocks(editor, [{ type: "rawMarkdown", props: { source: body } }]);
      } finally {
        syncingRef.current = false;
      }
      linkPathsRef.current = collectPageLinkPaths(editor.document as GraiteBlock[]);
      setHasContent(!isDocumentEmpty(editor.document as GraiteBlock[]));
      setHasView(hasPageView(editor.document as GraiteBlock[]));
      baseHashRef.current = hash;
      dirtyRef.current = false;
      markDisk(body);
      setConflict(null);
    },
    [editor, tree, markDisk],
  );

  // Apply content on first mount for this page and on explicit external refreshes only.
  useEffect(() => {
    const first = appliedRef.current.id !== page.id;
    const refreshed = appliedRef.current.nonce !== refreshNonce;
    if (!first && !refreshed) return;
    appliedRef.current = { id: page.id, nonce: refreshNonce };
    if (!first && dirtyRef.current) {
      // The user has unsaved edits: do not clobber them, surface the conflict instead.
      setConflict({ hash: page.hash, body: page.body });
      return;
    }
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    applyBody(page.body, page.hash);
  }, [page, refreshNonce, applyBody]);

  // Tree -> editor: keep pageLink titles/icons in sync (never removes blocks).
  useEffect(() => {
    for (const block of editor.document as GraiteBlock[]) {
      if (block.type !== "pageLink" || !block.props.path) continue;
      const node = findNode(tree, block.props.path);
      if (!node) continue;
      const next: { title?: string; icon?: string; target?: string; empty?: string } = {};
      if (node.title !== block.props.title) next.title = node.title;
      if ((node.icon ?? "") !== block.props.icon) next.icon = node.icon ?? "";
      const empty = node.has_content ? "" : "1";
      if (empty !== block.props.empty) next.empty = empty;
      const target = linkTarget(pathRef.current, node);
      if (target !== block.props.target) next.target = target;
      if (Object.keys(next).length) {
        syncingRef.current = true;
        editor.updateBlock(block, { type: "pageLink", props: next });
        syncingRef.current = false;
      }
    }
  }, [tree, editor]);

  const save = useCallback(async () => {
    await titleCommitRef.current;
    const path = pathRef.current;
    const markdown = fromBlocks(editor.document as unknown as Parameters<typeof fromBlocks>[0]);
    try {
      const { hash } = await pages.put(path, markdown, baseHashRef.current);
      baseHashRef.current = hash;
      dirtyRef.current = false;
      markDisk(markdown);
      onSaved(hash);
    } catch (e) {
      if (e instanceof ConflictError) setConflict({ hash: e.hash, body: e.body });
      else toast.error(`Save failed: ${(e as Error).message}`);
    }
  }, [editor, onSaved, markDisk]);

  // Title: debounced rename (the daemon renames the folder), flushed on blur/Enter.
  const commitTitle = useCallback(
    (value: string) => {
      const run = async () => {
        const oldPath = pathRef.current;
        const updated = await pages.patch(oldPath, { title: value.trim() || "Untitled" });
        pathRef.current = updated.path;
        baseHashRef.current = updated.hash;
        onSaved(updated.hash);
        if (updated.path !== oldPath) onRenamed(oldPath, updated.path);
        onTreeChanged();
      };
      const done = titleCommitRef.current.then(run);
      titleCommitRef.current = done.catch(() => {});
      return done;
    },
    [onSaved, onRenamed, onTreeChanged],
  );

  useEffect(() => {
    const flush = async () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      if (titleTimerRef.current) {
        clearTimeout(titleTimerRef.current);
        titleTimerRef.current = null;
        await commitTitle(title);
      }
      await titleCommitRef.current;
      if (!dirtyRef.current) return;
      const markdown = fromBlocks(editor.document as unknown as Parameters<typeof fromBlocks>[0]);
      const saved = await pages.put(pathRef.current, markdown, baseHashRef.current);
      baseHashRef.current = saved.hash;
      dirtyRef.current = false;
      markDisk(markdown);
      onSaved(saved.hash);
    };
    flushPendingRef.current = flush;
    registerFlush?.(flush);
    return () => {
      flushPendingRef.current = null;
      registerFlush?.(null);
    };
  }, [registerFlush, editor, onSaved, title, commitTitle, markDisk]);

  const saveProperties = useCallback(
    async (fields: PageProperty[]) => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      const markdown = fromBlocks(editor.document as unknown as Parameters<typeof fromBlocks>[0]);
      const saved = await pages.put(pathRef.current, markdown, baseHashRef.current);
      baseHashRef.current = saved.hash;
      dirtyRef.current = false;
      markDisk(markdown);
      const result = await workspace.properties(page.id, fields, saved.hash);
      baseHashRef.current = result.hash;
      onSaved(result.hash);
      return result;
    },
    [editor, page.id, onSaved, markDisk],
  );

  const moveMedia = useCallback(
    async (blockId: string, targetPath: string) => {
      const block = editor.getBlock(blockId);
      if (!block || block.type !== "localMedia") return;
      if (targetPath === pathRef.current) return;
      if (block.props.job || !block.props.file) {
        toast.error("Finish uploading or transcribing before moving this file.");
        return;
      }
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      editor.isEditable = false;
      try {
        const markdown = fromBlocks(editor.document as unknown as Parameters<typeof fromBlocks>[0]);
        const saved = await pages.put(pathRef.current, markdown, baseHashRef.current);
        baseHashRef.current = saved.hash;
        dirtyRef.current = false;
        const result = await media.move(
          page.id,
          targetPath,
          block.props.file,
          fromBlocks([block] as unknown as Parameters<typeof fromBlocks>[0]),
          saved.hash,
        );
        syncingRef.current = true;
        if (editor.getBlock(blockId)) editor.removeBlocks([blockId]);
        syncingRef.current = false;
        baseHashRef.current = result.source_hash;
        dirtyRef.current = false;
        markDisk(fromBlocks(editor.document as unknown as Parameters<typeof fromBlocks>[0]));
        onSaved(result.source_hash);
        onTreeChanged();
        onNavigate(result.path);
      } catch (e) {
        toast.error(`Could not move media: ${(e as Error).message}`);
      } finally {
        editor.isEditable = true;
      }
    },
    [editor, page.id, onSaved, onTreeChanged, onNavigate, markDisk],
  );

  const scheduleSave = useCallback(() => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => void save(), SAVE_DEBOUNCE_MS);
  }, [save]);

  // Editor -> tree: deleting a single pageLink block trashes its page (product decision),
  // but never as a side effect of undo/redo, an emptied document, or bulk disappearance.
  const handleChange = useCallback(() => {
    if (syncingRef.current) return;
    dirtyRef.current = true;
    const doc = editor.document as GraiteBlock[];
    setHasContent(!isDocumentEmpty(doc));
    setHasView(hasPageView(doc));
    const current = collectPageLinkPaths(doc);
    const removed = [...linkPathsRef.current].filter((p) => !current.has(p));
    for (const path of linksToTrash(removed, {
      lastWasHistory: historyRef.current?.lastWasHistory ?? false,
      documentEmpty: isDocumentEmpty(doc),
    })) {
      pages
        .remove(path)
        .then(() => onTreeChanged())
        .catch((e: Error) => toast.error(`Could not trash page: ${e.message}`));
    }
    linkPathsRef.current = current;
    scheduleSave();
  }, [editor, onTreeChanged, scheduleSave]);

  // Flush a pending save when leaving the page.
  useEffect(() => {
    return () => {
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current);
        if (dirtyRef.current) void save();
      }
    };
  }, [save]);

  const handleTitleChange = (value: string) => {
    setTitle(value);
    onTitleChange(value);
    if (titleTimerRef.current) clearTimeout(titleTimerRef.current);
    titleTimerRef.current = setTimeout(() => {
      titleTimerRef.current = null;
      void commitTitle(value).catch(renameFailed);
    }, TITLE_DEBOUNCE_MS);
  };
  // The title shown in the workspace is already the typed one, so a pending timer is the
  // only sign of an unsaved rename.
  const flushTitle = () => {
    if (titleTimerRef.current) {
      clearTimeout(titleTimerRef.current);
      titleTimerRef.current = null;
      void commitTitle(title).catch(renameFailed);
    }
  };

  const setIcon = async (icon: string | null) => {
    onIconChange(icon);
    setEmojiOpen(false);
    try {
      await pages.patch(pathRef.current, { icon });
      onTreeChanged();
    } catch (e) {
      toast.error(`Could not set icon: ${(e as Error).message}`);
    }
  };

  const handleClick = (e: React.MouseEvent) => {
    const target = e.target as HTMLElement;
    const source = target.closest<HTMLAnchorElement>("a[href]")?.getAttribute("href");
    // In the app, a generated Markdown source link opens its owning page and embedded file.
    // The relative link itself remains usable in Obsidian and other Markdown readers.
    if (source && /^(?:\.\.\/)*_assets\/[^/]+$/.test(source)) {
      e.preventDefault();
      const depth = (source.match(/\.\.\//g) || []).length;
      const parts = pathRef.current.split("/");
      if (depth < parts.length) onNavigate(parts.slice(0, parts.length - depth).join("/"));
      return;
    }
    const link = target.closest("[data-page-link]");
    if (link) {
      const path = link.getAttribute("data-page-path");
      if (path) onNavigate(path);
      return;
    }
    const wiki = target.closest("[data-wikilink]");
    if (wiki) {
      const t = wiki.getAttribute("data-wikilink-target") ?? "";
      pages
        .resolveLink(pathRef.current, t)
        .then((r) => onNavigate(r.path))
        .catch(() => toast.error(`No page named "${t}"`));
    }
  };

  const onTreeChangedRef = useRef(onTreeChanged);
  onTreeChangedRef.current = onTreeChanged;
  const slashDeps = useMemo(
    () => ({
      createChildPage: async (): Promise<PickedPage> => {
        const child = await pages.create({ parentPath: pathRef.current });
        return { path: child.path, title: child.title, icon: child.icon, target: child.title };
      },
      pickPage: () =>
        new Promise<PickedPage | null>((resolve) => {
          pickerResolveRef.current = resolve;
          setPickerOpen(true);
        }),
      onTreeChanged: () => onTreeChangedRef.current(),
    }),
    [],
  );
  const finishPick = (page: FlatPage | null) => {
    setPickerOpen(false);
    const resolve = pickerResolveRef.current;
    pickerResolveRef.current = null;
    resolve?.(page ? { ...page, target: linkTarget(pathRef.current, page) } : null);
    // The awaiting slash item updates the block in a microtask; focus after that.
    setTimeout(() => editor.focus(), 0);
  };

  const isDirty = useCallback(() => dirtyRef.current, []);
  const flushPending = useCallback(async () => {
    await flushPendingRef.current?.();
  }, []);
  const reviews = usePageReviews({
    editor,
    path: page.path,
    diskBody: diskBodyRef,
    bodyVersion,
    isDirty,
    flush: flushPending,
  });

  const isUntitled = title === "Untitled" || title === "";

  return (
    <div className="flex h-full flex-col">
      {conflict && (
        <div className="flex items-center gap-3 border-b bg-amber-50 px-6 py-2 text-sm text-amber-900">
          <span className="flex-1">This page changed on disk while you were editing.</span>
          <Button
            size="sm"
            variant="outline"
            onClick={() => applyBody(conflict.body, conflict.hash)}
          >
            Take disk
          </Button>
          <Button
            size="sm"
            onClick={() => {
              baseHashRef.current = conflict.hash;
              setConflict(null);
              void save();
            }}
          >
            Keep mine
          </Button>
        </div>
      )}
      <header className="page-topbar">
        <Breadcrumbs path={page.path} tree={tree} onNavigate={onNavigate} />
        <PageReviewBar
          proposals={reviews.open}
          beforeAccept={reviews.flush}
          onDecided={() => void reviews.refresh()}
          onJump={reviews.jump}
        />
      </header>
      <div
        data-page-scroll
        data-page-wide={hasView || undefined}
        className={`min-h-0 flex-1 overflow-auto py-4 ${hasView ? "px-8 lg:px-12" : "px-6"}`}
        onClick={handleClick}
      >
        <div className={hasView ? "page-wide w-full" : "mx-auto max-w-4xl"}>
          <div
            className={`mt-6 flex items-center gap-2 ${page.path.includes("/") ? "mb-0" : "mb-2"}`}
            style={{ paddingLeft: 40 }}
          >
            <Popover open={emojiOpen} onOpenChange={setEmojiOpen}>
              <PopoverTrigger asChild>
                {page.icon ? (
                  <button
                    className="shrink-0 cursor-pointer rounded text-3xl leading-none hover:bg-accent"
                    title="Change icon"
                  >
                    {page.icon}
                  </button>
                ) : (
                  <button
                    className="shrink-0 cursor-pointer rounded text-muted-foreground hover:bg-accent"
                    title="Add icon"
                  >
                    <PageIcon icon={null} hasContent={hasContent} className="size-7" />
                  </button>
                )}
              </PopoverTrigger>
              <PopoverContent
                className="w-auto border-none p-0 shadow-lg"
                side="bottom"
                align="start"
              >
                <EmojiPickerPanel
                  hasIcon={!!page.icon}
                  onPick={(emoji) => void setIcon(emoji)}
                  onRemove={() => void setIcon(null)}
                />
              </PopoverContent>
            </Popover>
            <input
              ref={titleInputRef}
              aria-label="Page title"
              className={`w-full bg-transparent text-2xl font-bold outline-none placeholder:text-muted-foreground ${
                isUntitled ? "text-muted-foreground" : ""
              }`}
              value={title === "Untitled" ? "" : title}
              onChange={(e) => handleTitleChange(e.target.value)}
              onFocus={() => {
                titleFocusedRef.current = true;
              }}
              onBlur={() => {
                titleFocusedRef.current = false;
                flushTitle();
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  flushTitle();
                  editor.focus();
                }
              }}
              placeholder="Untitled"
            />
            <Button
              variant="ghost"
              size="sm"
              className="shrink-0 text-muted-foreground"
              title="Files stored with this page"
              aria-label="Attachments for this page"
              onClick={() =>
                void (async () => {
                  // Usage is read from disk, so save the open edits first.
                  try {
                    await flushPendingRef.current?.();
                    setAttachmentsOpen(true);
                  } catch (e) {
                    toast.error((e as Error).message);
                  }
                })()
              }
            >
              <Paperclip size={15} /> Attachments
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="shrink-0 text-muted-foreground"
              title="AI settings for this page"
              aria-label="AI settings for this page"
              onClick={() =>
                void (async () => {
                  try {
                    await flushPendingRef.current?.();
                    setAiSettingsOpen(true);
                  } catch (e) {
                    toast.error((e as Error).message);
                  }
                })()
              }
            >
              <Orbit size={15} /> AI settings
            </Button>
            {canRevealPage() && (
              <Button
                variant="ghost"
                size="icon"
                className="size-8 shrink-0 text-muted-foreground"
                title="Show in file manager"
                aria-label="Show this page in the file manager"
                onClick={() => void revealPage(pathRef.current)}
              >
                <FolderOpen size={15} />
              </Button>
            )}
          </div>
          <AiSettingsDialog
            path={page.path}
            title={page.title}
            open={aiSettingsOpen}
            onOpenChange={setAiSettingsOpen}
            onNavigateSettings={onNavigateSettings}
            onSaved={(saved) => {
              baseHashRef.current = saved.hash;
              onSaved(saved.hash);
            }}
          />
          <AttachmentsDialog
            pageId={page.id}
            title={page.title}
            open={attachmentsOpen}
            onOpenChange={setAttachmentsOpen}
          />

          {page.path.includes("/") && <PageProperties page={page} onSave={saveProperties} />}
          {!!reviews.unanchored.length && (
            <div data-review-unanchored className="review-unanchored">
              {reviews.unanchored.map((p) => (
                <InlineProposalCard key={p.id} proposal={p} actions={reviews.actions} />
              ))}
            </div>
          )}
          <MediaContext.Provider
            value={{
              pageId: page.id,
              pagePath: page.path,
              navigate: onNavigate,
              onTreeChanged,
              moveMedia,
            }}
          >
            <EditorSurface editor={editor} slashDeps={slashDeps} onChange={handleChange} />
            <InlineProposals
              editor={editor}
              anchors={reviews.anchors}
              proposals={reviews.open}
              actions={reviews.actions}
            />
          </MediaContext.Provider>
        </div>
      </div>
      <PagePicker
        open={pickerOpen}
        tree={tree}
        excludePath={page.path}
        onPick={(p) => finishPick(p)}
        onCancel={() => finishPick(null)}
      />
    </div>
  );
}

if (import.meta.hot) import.meta.hot.accept(() => window.location.reload());
