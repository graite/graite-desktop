import { useCallback, useEffect, useState } from "react";
import {
  ChevronDown,
  FolderOpen,
  FolderSearch,
  Plus,
  Settings2,
  Trash2,
  Orbit,
  Files,
  Sparkles,
  MessageSquareHeart,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
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
import { pages, type TreeNode } from "@/lib/api";
import { findNode, parentPath } from "@/editor/tree-utils";
import { workspace } from "@/lib/workspace";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { scopedKey, vaultName } from "@/lib/storage";
import type { VaultList } from "@/lib/platform";
import { PageTreeItem } from "./PageTreeItem";
import { DaemonStatus } from "./DaemonStatus";
import { useVault } from "./vault-context";
import "./vault.css";

const EXPANDED_KEY = "graite.sidebar.expanded";

function loadExpanded(): Set<string> | null {
  try {
    const raw = localStorage.getItem(scopedKey(EXPANDED_KEY));
    return raw ? new Set(JSON.parse(raw) as string[]) : null;
  } catch {
    return null;
  }
}

function allPaths(nodes: TreeNode[], out: string[] = []): string[] {
  for (const n of nodes) {
    out.push(n.path);
    allPaths(n.children, out);
  }
  return out;
}

interface SidebarProps {
  onModels: () => void;
  onAI: () => void;
  onPages?: () => void;
  askHost?: (node: HTMLDivElement | null) => void;
  aiActive: boolean;
  onTrash: () => void;
  trashActive: boolean;
  onWelcome?: () => void;
  welcomeActive?: boolean;
  /** Absent when this build has nowhere to send feedback. */
  onFeedback?: () => void;
  beforeMove: () => Promise<void>;
  onMoved: (oldPath: string, newPath: string) => void;
  tree: TreeNode[];
  selectedPath: string | null;
  onSelect: (path: string) => void;
  onNavigateSettings?: (path: string) => Promise<void>;
  onTreeChanged: () => void;
  onRenamed: (oldPath: string, newPath: string) => void;
  onTrashed: (path: string) => void;
  onIconChanged: (path: string, icon: string | null) => void;
}

export function Sidebar({
  onModels,
  onAI,
  onPages,
  askHost,
  aiActive,
  onTrash,
  trashActive,
  onWelcome,
  welcomeActive = false,
  onFeedback,
  beforeMove,
  onMoved,
  tree,
  selectedPath,
  onSelect,
  onNavigateSettings,
  onTreeChanged,
  onRenamed,
  onTrashed,
  onIconChanged,
}: SidebarProps) {
  const [movingPage, setMovingPage] = useState<TreeNode | null>(null);
  const [moveTarget, setMoveTarget] = useState("");
  const [movePosition, setMovePosition] = useState<"before" | "after" | "inside">("inside");
  const [moving, setMoving] = useState(false);
  const flatten = (nodes: TreeNode[]): TreeNode[] =>
    nodes.flatMap((node) => [node, ...flatten(node.children)]);
  const movePage = async (
    id: string,
    path: string,
    target: string | null,
    position: "before" | "after" | "inside",
  ) => {
    if (moving) return;
    setMoving(true);
    try {
      await beforeMove();
      const currentPath = flatten(await pages.tree()).find((n) => n.id === id)?.path ?? path;
      const result = await workspace.move(id, target, position);
      onMoved(currentPath, result.path);
      onTreeChanged();
      setMovingPage(null);
    } catch (e) {
      toast.error(`Could not move page: ${(e as Error).message}`);
    } finally {
      setMoving(false);
    }
  };
  // First run: everything expanded. Afterwards the user's toggles persist.
  const [expanded, setExpanded] = useState<Set<string>>(
    () => loadExpanded() ?? new Set(allPaths(tree)),
  );
  const [renamingPath, setRenamingPath] = useState<string | null>(null);
  const [deletePath, setDeletePath] = useState<string | null>(null);
  useEffect(() => {
    try {
      localStorage.setItem(scopedKey(EXPANDED_KEY), JSON.stringify([...expanded]));
    } catch {
      /* ignore */
    }
  }, [expanded]);

  const toggle = useCallback((path: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  const expand = useCallback((path: string | null) => {
    if (!path) return;
    setExpanded((prev) => {
      const next = new Set(prev);
      let p: string | null = path;
      while (p) {
        next.add(p);
        p = parentPath(p);
      }
      return next;
    });
  }, []);

  // Keep the selected page's ancestors open.
  useEffect(() => expand(parentPath(selectedPath ?? "")), [selectedPath, expand]);

  const create = useCallback(
    async (parent: string | null) => {
      try {
        const page = await pages.create({ parentPath: parent });
        onTreeChanged();
        expand(parent);
        onSelect(page.path);
      } catch (e) {
        toast.error(`Could not create page: ${(e as Error).message}`);
      }
    },
    [onTreeChanged, onSelect, expand],
  );

  const commitRename = useCallback(
    async (path: string, title: string) => {
      setRenamingPath(null);
      const next = title.trim();
      const node = findNode(tree, path);
      if (!next || !node || next === node.title) return;
      try {
        const updated = await pages.patch(path, { title: next });
        if (updated.path !== path) onRenamed(path, updated.path);
        onTreeChanged();
      } catch (e) {
        toast.error(`Rename failed: ${(e as Error).message}`);
      }
    },
    [tree, onRenamed, onTreeChanged],
  );

  const confirmDelete = useCallback(async () => {
    const path = deletePath;
    setDeletePath(null);
    if (!path) return;
    try {
      await pages.remove(path);
      onTrashed(path);
      onTreeChanged();
    } catch (e) {
      toast.error(`Could not move to trash: ${(e as Error).message}`);
    }
  }, [deletePath, onTrashed, onTreeChanged]);

  const changeIcon = useCallback(
    async (path: string, icon: string | null) => {
      onIconChanged(path, icon);
      try {
        await pages.patch(path, { icon });
        onTreeChanged();
      } catch (e) {
        toast.error(`Could not set icon: ${(e as Error).message}`);
      }
    },
    [onIconChanged, onTreeChanged],
  );

  const deleteNode = deletePath ? findNode(tree, deletePath) : null;

  return (
    <div className="flex h-full flex-col border-r bg-sidebar">
      <div className="flex items-center gap-2 px-3 py-2.5">
        <img src="/logo-graite.svg" alt="Graite" className="size-5 shrink-0 dark:invert" />
        <VaultMenu />
      </div>
      <nav className="flex gap-1 px-3 py-3" aria-label="Workspace sections">
        <button
          onClick={onPages}
          aria-current={!aiActive && !trashActive ? "page" : undefined}
          className={`flex items-center gap-2 rounded-lg px-3 py-2 text-sm hover:bg-accent ${!aiActive && !trashActive ? "bg-accent" : ""}`}
        >
          <Files size={16} />
          Pages
        </button>
        <button
          onClick={onAI}
          aria-current={aiActive ? "page" : undefined}
          className={`flex items-center gap-2 rounded-lg px-3 py-2 text-sm hover:bg-accent ${aiActive ? "bg-accent" : ""}`}
        >
          <Orbit size={16} />
          Studio
        </button>
      </nav>
      <div ref={askHost} className={aiActive ? "min-h-0 flex-1 flex flex-col" : "hidden"} />
      <div className={aiActive ? "hidden" : "min-h-0 flex-1 flex flex-col"}>
        <div className="flex items-center justify-between px-3 py-2">
          <span className="text-xs font-medium text-muted-foreground">Pages</span>
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="icon"
              className="size-7"
              onClick={() => void create(null)}
              title="New page"
            >
              <Plus className="size-4" />
            </Button>
          </div>
        </div>
        <ScrollArea className="sidebar-pages-scroll min-h-0 flex-1">
          <div className="w-full min-w-0 overflow-x-hidden px-1 py-1">
            {tree.map((node) => (
              <PageTreeItem
                key={node.id}
                node={node}
                depth={0}
                selectedPath={selectedPath}
                expanded={expanded}
                renamingPath={renamingPath}
                onSelect={onSelect}
                onToggle={toggle}
                onCreateSubpage={(p) => void create(p)}
                onStartRename={setRenamingPath}
                onCommitRename={(p, t) => void commitRename(p, t)}
                onCancelRename={() => setRenamingPath(null)}
                onDelete={setDeletePath}
                onIconChange={(p, i) => void changeIcon(p, i)}
                onMove={movePage}
                onMoveMenu={(node) => {
                  setMovingPage(node);
                  setMoveTarget("");
                  setMovePosition("inside");
                }}
                onAiSettings={(page) => {
                  if (onNavigateSettings)
                    void onNavigateSettings(page.path).catch((e: Error) => toast.error(e.message));
                  else onSelect(page.path);
                }}
              />
            ))}
            {tree.length === 0 && (
              <p className="px-3 py-4 text-xs text-muted-foreground">
                No pages yet. Click + to create one.
              </p>
            )}
          </div>
        </ScrollArea>
      </div>
      {onWelcome && (
        <button
          onClick={onWelcome}
          aria-current={welcomeActive ? "page" : undefined}
          className={`flex items-center gap-2 border-t px-4 py-3 text-xs text-muted-foreground hover:bg-accent ${welcomeActive ? "bg-accent" : ""}`}
        >
          <Sparkles className="size-4" />
          Welcome &amp; next steps
        </button>
      )}
      {onFeedback && (
        <button
          onClick={onFeedback}
          className="flex items-center gap-2 border-t px-4 py-3 text-xs text-muted-foreground hover:bg-accent"
        >
          <MessageSquareHeart className="size-4" />
          Send feedback
        </button>
      )}
      <button
        onClick={onTrash}
        aria-current={trashActive ? "page" : undefined}
        className={`flex items-center gap-2 border-t px-4 py-3 text-xs text-muted-foreground hover:bg-accent ${trashActive ? "bg-accent" : ""}`}
      >
        <Trash2 className="size-4" />
        Trash
      </button>
      <button
        onClick={onModels}
        className="flex items-center gap-2 border-t px-4 py-3 text-xs text-muted-foreground hover:bg-accent"
      >
        <Settings2 className="size-4" />
        Settings
      </button>
      <div className="border-t px-2 py-1.5">
        <DaemonStatus compact />
      </div>

      <Dialog
        open={movingPage !== null}
        onOpenChange={(open) => {
          if (!open && !moving) setMovingPage(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Move {movingPage?.title}</DialogTitle>
          </DialogHeader>
          <div className="property-form">
            <label>
              Destination
              <select
                value={moveTarget}
                onChange={(e) => {
                  setMoveTarget(e.target.value);
                  if (!e.target.value) setMovePosition("inside");
                }}
              >
                <option value="">Top level</option>
                {flatten(tree)
                  .filter(
                    (n) =>
                      n.path !== movingPage?.path &&
                      !n.path.startsWith((movingPage?.path ?? "") + "/"),
                  )
                  .map((n) => (
                    <option key={n.id} value={n.id}>
                      {n.path}
                    </option>
                  ))}
              </select>
            </label>
            {moveTarget && (
              <label>
                Position
                <select
                  value={movePosition}
                  onChange={(e) => setMovePosition(e.target.value as typeof movePosition)}
                >
                  <option value="inside">Inside this page</option>
                  <option value="before">Before this page</option>
                  <option value="after">After this page</option>
                </select>
              </label>
            )}
            <Button
              disabled={moving}
              onClick={() =>
                movingPage &&
                void movePage(movingPage.id, movingPage.path, moveTarget || null, movePosition)
              }
            >
              {moving ? "Moving…" : "Move page"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
      <AlertDialog open={deletePath !== null} onOpenChange={(open) => !open && setDeletePath(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Move “{deleteNode?.title ?? "page"}” to trash?</AlertDialogTitle>
            <AlertDialogDescription>
              The page and its sub-pages move to <code>.graite/trash/</code> inside the vault and
              can be restored from there.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => void confirmDelete()}>
              Move to trash
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

/** The vault's name in the sidebar header; on desktop a menu to switch or reveal it. */
function VaultMenu() {
  const vault = useVault();
  const [recent, setRecent] = useState<VaultList | null>(null);
  const [switching, setSwitching] = useState(false);
  const name = vaultName(vault?.info.vault);
  const path = vault?.info.vault ?? null;
  if (!vault || (!vault.canSwitch && !path)) {
    return (
      <span
        className="text-sm font-medium truncate"
        title={vault?.info.dev ? "Managed by the dev daemon" : undefined}
      >
        {name}
      </span>
    );
  }
  const open = async (target: string) => {
    setSwitching(true);
    try {
      await vault.switchTo(target, false);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSwitching(false);
    }
  };
  const pickAndOpen = async () => {
    const picked = await vault.pickFolder();
    if (picked) await open(picked);
  };
  return (
    <DropdownMenu onOpenChange={(opened) => opened && void vault.list().then(setRecent)}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="vault-menu-trigger"
          aria-label={`Vault ${name}`}
          disabled={switching}
        >
          <span>{switching ? "Switching…" : name}</span>
          <ChevronDown size={13} className="shrink-0 text-muted-foreground" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-64">
        <DropdownMenuLabel>
          {name}
          {path ? <span className="vault-menu-path">{path}</span> : null}
        </DropdownMenuLabel>
        {path ? (
          <DropdownMenuItem onSelect={() => void vault.reveal(path)}>
            <FolderSearch size={14} /> Reveal in file manager
          </DropdownMenuItem>
        ) : null}
        {vault.canSwitch ? (
          <>
            <DropdownMenuSeparator />
            {recent?.recent
              .filter((r) => r !== path)
              .map((r) => (
                <DropdownMenuItem key={r} onSelect={() => void open(r)} title={r}>
                  <FolderOpen size={14} /> {vaultName(r)}
                </DropdownMenuItem>
              ))}
            <DropdownMenuItem onSelect={() => void pickAndOpen()}>
              <FolderOpen size={14} /> Open another folder…
            </DropdownMenuItem>
          </>
        ) : (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem disabled>Managed by the dev daemon</DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
