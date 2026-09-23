import { useEffect, useRef, useState, type DragEvent } from "react";
import { PageIcon } from "@/components/PageIcon";
import { EmojiPickerPanel } from "@/components/EmojiPickerPanel";
import {
  ChevronRight,
  MoreHorizontal,
  Plus,
  Pencil,
  Trash2,
  SmilePlus,
  FolderInput,
  FolderOpen,
  Orbit,
} from "lucide-react";
import { canRevealPage, revealPage } from "@/pages/revealPage";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import type { TreeNode } from "@/lib/api";

export interface PageTreeItemProps {
  node: TreeNode;
  depth: number;
  selectedPath: string | null;
  expanded: Set<string>;
  renamingPath: string | null;
  onSelect: (path: string) => void;
  onToggle: (path: string) => void;
  onCreateSubpage: (parentPath: string) => void;
  onStartRename: (path: string) => void;
  onCommitRename: (path: string, title: string) => void;
  onCancelRename: () => void;
  onDelete: (path: string) => void;
  onMove: (
    sourceId: string,
    sourcePath: string,
    targetId: string | null,
    position: "before" | "after" | "inside",
  ) => Promise<void>;
  onMoveMenu: (node: TreeNode) => void;
  onAiSettings: (node: TreeNode) => void;
  onIconChange: (path: string, icon: string | null) => void;
}

/** Recursive page tree with distinct reorder gaps and nesting targets. */
export function PageTreeItem(props: PageTreeItemProps) {
  const { node, depth, selectedPath, expanded, renamingPath, onSelect, onToggle } = props;
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [dropPosition, setDropPosition] = useState<"before" | "after" | "inside" | null>(null);
  const [hovered, setHovered] = useState(false);
  // A view's entries live in the view, not the sidebar.
  const hasChildren = !node.has_view && node.children.length > 0;
  const isExpanded = expanded.has(node.path);
  const isRenaming = renamingPath === node.path;
  const [draft, setDraft] = useState(node.title);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isRenaming) {
      setDraft(node.title);
      requestAnimationFrame(() => inputRef.current?.select());
    }
  }, [isRenaming, node.title]);

  // Show chevron when hovered and the emoji picker is NOT open.
  const showChevron = hovered && !emojiOpen;

  const dragOver = (event: DragEvent<HTMLDivElement>, position: "before" | "after" | "inside") => {
    if (!event.dataTransfer.types.includes("application/graite-sidebar-page")) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = "move";
    if (position === "inside") {
      // The rows nearly touch, so the top and bottom edges of a row also mean before/after.
      const box = event.currentTarget.getBoundingClientRect();
      if (box.height > 0 && event.clientY < box.top + 5) position = "before";
      else if (box.height > 0 && event.clientY > box.bottom - 5) position = "after";
    }
    setDropPosition(position);
  };
  const drop = (event: DragEvent<HTMLDivElement>, position: "before" | "after" | "inside") => {
    const data = event.dataTransfer.getData("application/graite-sidebar-page");
    if (!data) return;
    event.preventDefault();
    event.stopPropagation();
    setDropPosition(null);
    try {
      const source = JSON.parse(data) as { id: string; path: string };
      if (source.id !== node.id) void props.onMove(source.id, source.path, node.id, position);
    } catch {
      /* Ignore unrelated drops. */
    }
  };
  const gap = (position: "before" | "after") => (
    <div
      className="sidebar-drop-gap"
      data-drop-gap={position}
      data-active={dropPosition === position || undefined}
      aria-label={`Move ${position} ${node.title}`}
      style={{ marginLeft: depth * 12 + 4 }}
      onDragOver={(e) => dragOver(e, position)}
      onDragLeave={() => setDropPosition(null)}
      onDrop={(e) => drop(e, position)}
    />
  );
  useEffect(() => {
    const clear = () => setDropPosition(null);
    window.addEventListener("dragend", clear);
    window.addEventListener("drop", clear);
    return () => {
      window.removeEventListener("dragend", clear);
      window.removeEventListener("drop", clear);
    };
  }, []);

  return (
    <div
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropPosition(null);
      }}
    >
      {gap("before")}
      <div
        className={`group flex min-w-0 max-w-full cursor-pointer items-center gap-0.5 rounded-sm px-1 py-0.5 text-sm hover:bg-accent ${
          selectedPath === node.path || (node.has_view && selectedPath?.startsWith(node.path + "/"))
            ? "bg-accent text-accent-foreground"
            : ""
        }`}
        draggable={!isRenaming}
        data-page-drop-position={dropPosition === "inside" ? "inside" : undefined}
        onDragStart={(e) => {
          e.stopPropagation();
          e.dataTransfer.setData(
            "application/graite-sidebar-page",
            JSON.stringify({ id: node.id, path: node.path }),
          );
          e.dataTransfer.effectAllowed = "move";
        }}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropPosition(null);
        }}
        onDragOver={(e) => dragOver(e, "inside")}
        onDrop={(e) => drop(e, dropPosition ?? "inside")}
        data-media-drop-page={node.path}
        style={{ paddingLeft: `${depth * 12 + 4}px` }}
        onClick={() => onSelect(node.path)}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
      >
        <div className="relative flex size-5 shrink-0 items-center justify-center">
          {showChevron ? (
            <button
              className="flex size-5 items-center justify-center rounded hover:bg-accent-foreground/10"
              onClick={(e) => {
                e.stopPropagation();
                if (hasChildren) onToggle(node.path);
              }}
            >
              <ChevronRight
                className={`size-3.5 transition-transform ${hasChildren && isExpanded ? "rotate-90" : ""} ${
                  !hasChildren ? "text-muted-foreground/40" : ""
                }`}
              />
            </button>
          ) : (
            <Popover open={emojiOpen} onOpenChange={setEmojiOpen}>
              <PopoverTrigger asChild>
                <button
                  className="flex size-5 items-center justify-center rounded hover:bg-accent-foreground/10"
                  onClick={(e) => e.stopPropagation()}
                >
                  <PageIcon icon={node.icon} hasContent={node.has_content} className="size-3.5" />
                </button>
              </PopoverTrigger>
              <PopoverContent
                className="w-auto border-none p-0 shadow-lg"
                side="right"
                align="start"
                onClick={(e) => e.stopPropagation()}
                onMouseEnter={() => setHovered(false)}
              >
                <EmojiPickerPanel
                  hasIcon={!!node.icon}
                  onPick={(emoji) => {
                    props.onIconChange(node.path, emoji);
                    setEmojiOpen(false);
                  }}
                  onRemove={() => {
                    props.onIconChange(node.path, null);
                    setEmojiOpen(false);
                  }}
                />
              </PopoverContent>
            </Popover>
          )}
        </div>

        {isRenaming ? (
          <input
            ref={inputRef}
            className="flex-1 rounded-sm border bg-background px-1 text-sm outline-none"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onClick={(e) => e.stopPropagation()}
            onBlur={() => props.onCommitRename(node.path, draft)}
            onKeyDown={(e) => {
              if (e.key === "Enter") props.onCommitRename(node.path, draft);
              if (e.key === "Escape") props.onCancelRename();
            }}
          />
        ) : (
          <span
            title={node.title}
            className={`min-w-0 flex-1 truncate ${node.title === "Untitled" ? "text-muted-foreground" : ""}`}
          >
            {node.title}
          </span>
        )}

        <div className="flex shrink-0 items-center opacity-0 group-hover:opacity-100">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="size-5"
                onClick={(e) => e.stopPropagation()}
              >
                <MoreHorizontal className="size-3.5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" side="right">
              <DropdownMenuItem onClick={() => props.onCreateSubpage(node.path)}>
                <Plus className="mr-2 size-4" /> New Subpage
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => setEmojiOpen(true)}>
                <SmilePlus className="mr-2 size-4" /> Set Icon
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => props.onMoveMenu(node)}>
                <FolderInput className="mr-2 size-4" /> Move…
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => props.onAiSettings(node)}>
                <Orbit className="mr-2 size-4" /> AI settings…
              </DropdownMenuItem>
              {canRevealPage() && (
                <DropdownMenuItem onClick={() => void revealPage(node.path)}>
                  <FolderOpen className="mr-2 size-4" /> Show in file manager
                </DropdownMenuItem>
              )}
              <DropdownMenuItem onClick={() => props.onStartRename(node.path)}>
                <Pencil className="mr-2 size-4" /> Rename
              </DropdownMenuItem>
              <DropdownMenuItem variant="destructive" onClick={() => props.onDelete(node.path)}>
                <Trash2 className="mr-2 size-4 text-destructive" /> Delete
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <Button
            variant="ghost"
            size="icon"
            className="size-5"
            onClick={(e) => {
              e.stopPropagation();
              props.onCreateSubpage(node.path);
            }}
          >
            <Plus className="size-3.5" />
          </Button>
        </div>
      </div>

      {gap("after")}
      {hasChildren && isExpanded && (
        <div>
          {node.children.map((child) => (
            <PageTreeItem key={child.id} {...props} node={child} depth={depth + 1} />
          ))}
        </div>
      )}
    </div>
  );
}
