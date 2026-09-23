import { useCallback, useEffect, useRef, useState } from "react";
import { Orbit } from "lucide-react";
import { toast } from "sonner";
import { connectEvents, isOwnRequest, pages, type PageDoc, type TreeNode } from "@/lib/api";
import { PageEditor } from "@/editor/PageEditor";
import { mapTree, parentPath } from "@/editor/tree-utils";
import { TrashPage } from "./TrashPage";
import { WelcomePage } from "./WelcomePage";
import { FeedbackDialog, useFeedbackEnabled } from "./FeedbackDialog";
import { StartupLoader } from "./StartupLoader";
import { Sidebar } from "./Sidebar";

import { ModelsPage, type SettingsTab } from "@/models/ModelsPage";
import { ChatPanel } from "@/chat/ChatPanel";
import { useAssistant } from "@/assistant/useAssistant";
import { AIPage } from "@/ai/AIPage";
import { Button } from "@/components/ui/button";
import type { DaemonInfo } from "@/lib/platform";
import type { Section } from "@/ai/ConversationList";
import { scopedKey } from "@/lib/storage";

const SELECTED_KEY = "graite.selectedPath";
const WELCOME_KEY = "graite.welcomeSeen";

/** The welcome page opens by itself once per vault. Storage may be unavailable; then it just shows. */
function firstVisit(): boolean {
  try {
    if (localStorage.getItem(scopedKey(WELCOME_KEY))) return false;
    localStorage.setItem(scopedKey(WELCOME_KEY), "1");
  } catch {
    /* private mode: show it */
  }
  return true;
}

export function Workspace({ vault }: { vault?: DaemonInfo }) {
  const assistantState = useAssistant();
  void vault; // the VaultGate keys this component by vault; the sidebar reads the context
  const flushEditor = useRef<(() => Promise<void>) | null>(null);
  const registerFlush = useCallback((flush: (() => Promise<void>) | null) => {
    flushEditor.current = flush;
  }, []);
  const [trashOpen, setTrashOpen] = useState(false);
  const [welcomeOpen, setWelcomeOpen] = useState(firstVisit);
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const feedbackEnabled = useFeedbackEnabled();
  const [studioSection, setStudioSection] = useState<{ section: Section; n: number } | null>(null);
  const [askHost, setAskHost] = useState<HTMLDivElement | null>(null);
  const [assistantPage, setAssistantPage] = useState<{ path: string; n: number } | null>(null);
  const [aiOpen, setAiOpen] = useState(false);
  const [modelsOpen, setModelsOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState<SettingsTab>("chat");
  /** Open Settings, on a tab when the caller knows where the user needs to be. Buttons pass
   * their click event here, so anything that is not a tab name means "the first tab". */
  const openSettings = (tab?: unknown) => {
    setSettingsTab(
      tab === "voice" || tab === "search" || tab === "documents" || tab === "vault" ? tab : "chat",
    );
    setModelsOpen(true);
  };
  const [settingsVersion, setSettingsVersion] = useState(0);
  const [chatOpen, setChatOpen] = useState(false);
  const [selection, setSelection] = useState("");
  const [tree, setTree] = useState<TreeNode[]>([]);
  const [settingsPath, setSettingsPath] = useState<string | null>(null);
  const [startupError, setStartupError] = useState("");
  const [loading, setLoading] = useState(true);
  const [selectedPath, setSelectedPath] = useState<string | null>(() =>
    localStorage.getItem(scopedKey(SELECTED_KEY)),
  );
  const [activePage, setActivePage] = useState<PageDoc | null>(null);
  const [refreshNonce, setRefreshNonce] = useState(0);
  const activeIdRef = useRef<string | null>(null);
  activeIdRef.current = activePage?.id ?? null;
  const lastSavedHashRef = useRef<string | null>(null);
  const selectedRef = useRef(selectedPath);
  selectedRef.current = selectedPath;

  const memoryRoot = assistantState.info?.memory?.root;
  const knowledgeTree = (nodes: TreeNode[]): TreeNode[] =>
    nodes
      .filter((node) => node.path !== memoryRoot)
      .map((node) => ({ ...node, children: knowledgeTree(node.children) }));

  const loadTree = useCallback(async () => {
    try {
      setTree(await pages.tree());
      setStartupError("");
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setStartupError(message);
      toast.error(`Could not load pages: ${message}`);
    } finally {
      setLoading(false);
    }
  }, []);

  const loadPage = useCallback(async (path: string): Promise<PageDoc | null> => {
    try {
      const page = await pages.get(path);
      setActivePage(page);
      lastSavedHashRef.current = page.hash;
      return page;
    } catch {
      setActivePage(null);
      return null;
    }
  }, []);

  const navigatePage = (path: string) => {
    if (memoryRoot && (path === memoryRoot || path.startsWith(memoryRoot + "/"))) {
      void (async () => {
        try {
          await flushEditor.current?.();
          setAssistantPage((old) => ({ path, n: (old?.n ?? 0) + 1 }));
          setTrashOpen(false);
          setWelcomeOpen(false);
          setAiOpen(true);
        } catch (e) {
          toast.error((e as Error).message);
        }
      })();
      return;
    }
    if (trashOpen || aiOpen || welcomeOpen) {
      // The editor was unmounted; fetch the saved body even when the path is unchanged.
      void loadPage(path).then((page) => {
        if (page) {
          setSelectedPath(path);
          setTrashOpen(false);
          setAiOpen(false);
          setWelcomeOpen(false);
        }
      });
    } else setSelectedPath(path);
  };

  const navigateSettings = async (path: string) => {
    await flushEditor.current?.();
    // Fetch before leaving so failed navigation keeps the current settings available.
    const page = await pages.get(path);
    setActivePage(page);
    lastSavedHashRef.current = page.hash;
    setSelectedPath(path);
    setTrashOpen(false);
    setAiOpen(false);
    setWelcomeOpen(false);
    setSettingsPath(path);
  };

  const createPage = async () => {
    try {
      const page = await pages.create({});
      void loadTree();
      navigatePage(page.path);
    } catch (e) {
      toast.error(`Could not create page: ${(e as Error).message}`);
    }
  };

  const openFullScreen = (open: () => void) => {
    void (async () => {
      try {
        await flushEditor.current?.();
        open();
      } catch (e) {
        toast.error((e as Error).message);
      }
    })();
  };

  useEffect(() => void loadTree(), [loadTree]);

  useEffect(() => {
    if (selectedPath) {
      localStorage.setItem(scopedKey(SELECTED_KEY), selectedPath);
      void loadPage(selectedPath);
    } else {
      localStorage.removeItem(scopedKey(SELECTED_KEY));
      setActivePage(null);
    }
  }, [selectedPath, loadPage]);

  // Daemon events: tree changes from any actor; file changes on the open page from elsewhere.
  useEffect(() => {
    return connectEvents((e) => {
      if (e.type === "tree_changed") void loadTree();
      if (e.type === "file_changed") {
        const { path, hash, request_id } = e.data as {
          path: string;
          hash: string;
          request_id?: string | null;
        };
        // Our own writes echo back here too; only genuinely external changes reload the editor.
        if (isOwnRequest(request_id)) return;
        if (path === selectedRef.current && hash !== lastSavedHashRef.current) {
          void loadPage(path).then((p) => p && setRefreshNonce((n) => n + 1));
        }
      }
    });
  }, [loadTree, loadPage]);

  const handleRenamed = useCallback(
    (oldPath: string, newPath: string) => {
      const selected = selectedRef.current;
      if (selected === oldPath) setSelectedPath(newPath);
      else if (selected?.startsWith(oldPath + "/")) {
        setSelectedPath(newPath + selected.slice(oldPath.length));
      } else if (selected && parentPath(oldPath) === selected) {
        // The daemon rewrote the open parent's [[link]] on disk; pick that up.
        void loadPage(selected).then((p) => p && setRefreshNonce((n) => n + 1));
      }
    },
    [loadPage],
  );

  const handleTrashed = useCallback((path: string) => {
    if (selectedRef.current === path || selectedRef.current?.startsWith(path + "/"))
      setSelectedPath(null);
  }, []);

  // Optimistic title/icon updates into both the active page and the tree.
  const handleTitleChange = useCallback((title: string) => {
    const path = selectedRef.current;
    setActivePage((p) => (p ? { ...p, title } : p));
    setTree((t) => mapTree(t, (n) => (n.path === path ? { ...n, title } : n)));
  }, []);
  const handleIconChanged = useCallback((path: string, icon: string | null) => {
    setActivePage((p) => (p && p.path === path ? { ...p, icon } : p));
    setTree((t) => mapTree(t, (n) => (n.path === path ? { ...n, icon } : n)));
  }, []);

  const handleSaved = useCallback((hash: string) => {
    lastSavedHashRef.current = hash;
    setActivePage((p) => (p ? { ...p, hash } : p));
  }, []);

  const saveActivePage = useCallback(
    (hash: string) => {
      // A blur-triggered property save may finish after navigation.
      if (activeIdRef.current === activePage?.id) handleSaved(hash);
    },
    [activePage?.id, handleSaved],
  );

  if (loading || (startupError && tree.length === 0))
    return (
      <StartupLoader
        error={startupError}
        onRetry={() => {
          setLoading(true);
          setStartupError("");
          void loadTree();
        }}
      />
    );

  return (
    <div className="relative flex h-screen overflow-hidden">
      <div className="w-64 shrink-0">
        <Sidebar
          onModels={() => openSettings()}
          onAI={() =>
            openFullScreen(() => {
              setTrashOpen(false);
              setWelcomeOpen(false);
              setAiOpen(true);
            })
          }
          onPages={() => {
            if (selectedPath) navigatePage(selectedPath);
            else {
              setAiOpen(false);
              setTrashOpen(false);
            }
          }}
          askHost={setAskHost}
          aiActive={aiOpen}
          onTrash={() =>
            openFullScreen(() => {
              setAiOpen(false);
              setWelcomeOpen(false);
              setTrashOpen(true);
            })
          }
          trashActive={trashOpen}
          onWelcome={() =>
            openFullScreen(() => {
              setAiOpen(false);
              setTrashOpen(false);
              setWelcomeOpen(true);
            })
          }
          welcomeActive={welcomeOpen && !aiOpen && !trashOpen}
          onFeedback={feedbackEnabled ? () => setFeedbackOpen(true) : undefined}
          beforeMove={async () => {
            await flushEditor.current?.();
          }}
          onMoved={(oldPath, newPath) => {
            const selected = selectedRef.current;
            if (!selected) return;
            const next =
              selected === oldPath || selected.startsWith(oldPath + "/")
                ? newPath + selected.slice(oldPath.length)
                : selected;
            setSelectedPath(next);
            void loadPage(next).then((p) => p && setRefreshNonce((n) => n + 1));
          }}
          tree={knowledgeTree(tree)}
          selectedPath={trashOpen || aiOpen || welcomeOpen ? null : selectedPath}
          onSelect={navigatePage}
          onNavigateSettings={navigateSettings}
          onTreeChanged={() => void loadTree()}
          onRenamed={handleRenamed}
          onTrashed={handleTrashed}
          onIconChanged={handleIconChanged}
        />
      </div>
      <div className="relative min-w-0 flex-1">
        {activePage && !chatOpen && !trashOpen && !aiOpen && !welcomeOpen && (
          <Button
            variant="outline"
            size="sm"
            className="absolute right-4 top-2 z-10 bg-background"
            onClick={() => setChatOpen(true)}
          >
            <Orbit size={14} /> Ask AI
          </Button>
        )}
        <div className={aiOpen ? "h-full" : "hidden"}>
          <AIPage
            assistantState={assistantState}
            assistantPage={assistantPage}
            openSection={studioSection}
            sidebarHost={askHost}
            active={aiOpen}
            tree={tree}
            onNavigate={navigatePage}
            onSettings={openSettings}
            onTreeChanged={() => void loadTree()}
            settingsVersion={settingsVersion}
          />
        </div>
        {aiOpen ? null : trashOpen ? (
          <TrashPage
            version={tree}
            onRestored={(path) => {
              void loadTree();
              navigatePage(path);
            }}
            onNavigate={navigatePage}
          />
        ) : activePage && !welcomeOpen ? (
          <PageEditor
            registerFlush={registerFlush}
            settingsRequested={settingsPath === activePage.path}
            onSettingsOpened={() => setSettingsPath(null)}
            onNavigateSettings={navigateSettings}
            key={activePage.id}
            page={activePage}
            tree={tree}
            refreshNonce={refreshNonce}
            onNavigate={navigatePage}
            onTitleChange={handleTitleChange}
            onIconChange={(icon) => activePage && handleIconChanged(activePage.path, icon)}
            onRenamed={handleRenamed}
            onTreeChanged={() => void loadTree()}
            onSaved={saveActivePage}
            onSelectionChange={setSelection}
          />
        ) : (
          <WelcomePage
            onCreatePage={() => void createPage()}
            onSettings={() => openSettings()}
            onStudio={(section) => {
              setStudioSection((old) => ({ section, n: (old?.n ?? 0) + 1 }));
              setTrashOpen(false);
              setAiOpen(true);
            }}
            onFeedback={feedbackEnabled ? () => setFeedbackOpen(true) : undefined}
          />
        )}
      </div>
      {chatOpen && activePage && !trashOpen && !aiOpen && !welcomeOpen && (
        <ChatPanel
          key={activePage.path}
          path={activePage.path}
          title={activePage.title}
          onClose={() => setChatOpen(false)}
          onSettings={openSettings}
          onNavigate={navigatePage}
          settingsVersion={settingsVersion}
          selection={selection}
        />
      )}
      <FeedbackDialog open={feedbackOpen} onOpenChange={setFeedbackOpen} />
      {modelsOpen && (
        <ModelsPage
          initialTab={settingsTab}
          onClose={() => {
            setModelsOpen(false);
            setSettingsVersion((v) => v + 1);
          }}
        />
      )}
    </div>
  );
}
