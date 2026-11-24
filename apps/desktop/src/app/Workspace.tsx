import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { connectEvents, isOwnRequest, pages, trash, type PageDoc, type TreeNode } from "@/lib/api";
import { workspace } from "@/lib/workspace";
import { PageEditor } from "@/editor/PageEditor";
import { findNode, mapTree, parentPath } from "@/editor/tree-utils";
import { TrashPage } from "./TrashPage";
import { MailPage } from "@/mail/MailPage";
import { MailRail } from "@/mail/MailRail";
import { useMail } from "@/mail/useMail";
import { AddAccountDialog } from "@/mail/AddAccountDialog";
import { RowPage } from "./RowPage";
import type { OpenRow } from "@/editor/tables/RowView";
import { TemplatesPage } from "./TemplatesPage";
import { WelcomePage } from "./WelcomePage";
import { Onboarding, type OnboardingResult } from "./onboarding/Onboarding";
import { markOnboarded, needsOnboarding } from "./onboarding/state";
import { useProfile } from "@/lib/profile";
import { FeedbackDialog, useFeedbackEnabled } from "./FeedbackDialog";
import { StartupLoader } from "./StartupLoader";
import { Sidebar } from "./Sidebar";

import { ModelsPage, type SettingsTab } from "@/models/ModelsPage";
import { SECTIONS } from "@/settings/sections";
import { ChatPanel, type ChatRequest } from "@/chat/ChatPanel";
import { SearchPalette } from "@/search/SearchPalette";
import { useAssistant } from "@/assistant/useAssistant";
import { AIPage } from "@/ai/AIPage";
import type { DaemonInfo } from "@/lib/platform";
import type { Section } from "@/ai/ConversationList";
import { scopedKey } from "@/lib/storage";
import { takeNewTabIntent, watchNewTabIntent } from "@/lib/newTabIntent";
import { TabBar } from "./TabBar";
import { closeTab, cycleTab, dropTabs, parseTabs, renameTabs, showInTab } from "./tabs";

const SELECTED_KEY = "graite.selectedPath";
const WELCOME_KEY = "graite.welcomeSeen";
const TABS_KEY = "graite.tabs";
/** Section names `openSettings` accepts; "chat" is the section of the model in use. */
const SETTINGS_TABS: SettingsTab[] = [...SECTIONS, "chat", "vault"];

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
  // Mail: `mailTab` is its tab in the tab bar, `mailOpen` whether that tab is the one shown,
  // `sidebarMail` whether the sidebar lists mail accounts instead of pages. The sidebar only
  // changes when the user picks Pages or Mail there, never by switching tabs.
  const mailState = useMail();
  const [mailTab, setMailTab] = useState(false);
  const [mailOpen, setMailOpen] = useState(false);
  const [sidebarMail, setSidebarMail] = useState(false);
  // A table row opened as a full page (D80), and the rows opened before it (for Back).
  const [rowPages, setRowPages] = useState<OpenRow[]>([]);
  const rowPage = rowPages[rowPages.length - 1] ?? null;
  const [templatesOpen, setTemplatesOpen] = useState(false);
  // Open the templates on the AI instruction examples (from the Welcome page).
  const [templatesInstructions, setTemplatesInstructions] = useState(false);
  const [welcomeOpen, setWelcomeOpen] = useState(firstVisit);
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  // The first-run onboarding: decided once, when the profile has loaded, so saving a name in
  // its first step does not end it.
  const me = useProfile();
  const [onboarding, setOnboarding] = useState<boolean | null>(null);
  if (onboarding === null && me !== null) setOnboarding(needsOnboarding(me));
  const showOnboarding = onboarding === true;
  const feedbackEnabled = useFeedbackEnabled();
  const [studioSection, setStudioSection] = useState<{ section: Section; n: number } | null>(null);
  const [askHost, setAskHost] = useState<HTMLDivElement | null>(null);
  const [assistantPage, setAssistantPage] = useState<{ path: string; n: number } | null>(null);
  const [aiOpen, setAiOpen] = useState(false);
  const [modelsOpen, setModelsOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState<SettingsTab>("general");
  /** Open Settings, on a tab when the caller knows where the user needs to be. Buttons pass
   * their click event here, so anything that is not a tab name means the first one, General. */
  const openSettings = (tab?: unknown) => {
    const known = typeof tab === "string" && (SETTINGS_TABS as string[]).includes(tab);
    setSettingsTab(known ? (tab as SettingsTab) : "general");
    setModelsOpen(true);
  };
  // The settings sidebar is drawn by the settings page into the app's sidebar column.
  const [settingsHost, setSettingsHost] = useState<HTMLDivElement | null>(null);
  const [settingsVersion, setSettingsVersion] = useState(0);
  const [chatOpen, setChatOpen] = useState(false);
  // A request for the page's AI from a block, sent (or drafted) when the panel opens.
  const [aiRequest, setAiRequest] = useState<ChatRequest | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const aiRequestId = useRef(0);
  useEffect(() => {
    const onAsk = (e: Event) => {
      const detail = (e as CustomEvent<Omit<ChatRequest, "id">>).detail;
      const prompt = detail?.prompt;
      if (!prompt) return;
      void (async () => {
        try {
          await flushEditor.current?.();
          setAiRequest({
            id: ++aiRequestId.current,
            prompt,
            mode: detail.mode,
            send: detail.send,
          });
          setChatOpen(true);
        } catch (error) {
          toast.error((error as Error).message);
        }
      })();
    };
    window.addEventListener("graite:ask-ai", onAsk);
    // A block that needs a model ("describe a chart") sends people to set one up; others
    // name the section they lead to in the event's detail.
    const onSettings = (event: Event) =>
      openSettings((event as CustomEvent<unknown>).detail ?? "chat");
    window.addEventListener("graite:open-settings", onSettings);
    return () => {
      window.removeEventListener("graite:ask-ai", onAsk);
      window.removeEventListener("graite:open-settings", onSettings);
    };
    // openSettings only sets state; the listeners are added once.
  }, []);
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
  const activePathRef = useRef<string | null>(null);
  activePathRef.current = activePage?.path ?? null;
  const lastSavedHashRef = useRef<string | null>(null);
  const selectedRef = useRef(selectedPath);
  selectedRef.current = selectedPath;
  // Open page tabs; `selectedPath` is the active one.
  const [tabs, setTabs] = useState<string[]>(() => {
    const stored = parseTabs(localStorage.getItem(scopedKey(TABS_KEY)));
    return selectedPath && !stored.includes(selectedPath) ? [...stored, selectedPath] : stored;
  });
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  const shownRef = useRef(selectedPath);
  const newTabRef = useRef(false);
  useEffect(() => watchNewTabIntent(), []);
  // Ctrl/Cmd+W closes the open tab; Ctrl+Tab and Ctrl+Shift+Tab step through the tabs.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
      const active = selectedRef.current;
      if (e.key.toLowerCase() === "w" && !e.shiftKey && active) {
        e.preventDefault();
        const next = closeTab(tabsRef.current, active, active);
        setTabs(next.tabs);
        setSelectedPath(next.active);
      } else if (e.key.toLowerCase() === "k" && !e.shiftKey) {
        // Find a page by title or text, from anywhere in the app.
        e.preventDefault();
        setSearchOpen((open) => !open);
      } else if (e.key === "Tab" && e.ctrlKey && tabsRef.current.length > 1) {
        e.preventDefault();
        setSelectedPath(cycleTab(tabsRef.current, active, e.shiftKey ? -1 : 1));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  // Every way of changing the open page ends here: it takes over the tab of the page it
  // came from, or gets its own tab when that was asked for.
  useEffect(() => {
    const from = shownRef.current;
    const newTab = newTabRef.current;
    shownRef.current = selectedPath;
    newTabRef.current = false;
    if (selectedPath) setTabs((old) => showInTab(old, selectedPath, from, newTab));
  }, [selectedPath]);
  useEffect(() => {
    try {
      localStorage.setItem(scopedKey(TABS_KEY), JSON.stringify(tabs));
    } catch {
      /* storage unavailable: tabs last for this session */
    }
  }, [tabs]);

  const memoryRoot = assistantState.info?.memory?.root;
  const knowledgeTree = (nodes: TreeNode[]): TreeNode[] =>
    nodes
      .filter((node) => node.path !== memoryRoot)
      .map((node) => ({ ...node, children: knowledgeTree(node.children) }));

  const treeRequest = useRef(0);
  const loadTree = useCallback(async () => {
    const request = ++treeRequest.current;
    try {
      const next = await pages.tree();
      // Several events in a row start several loads; only the latest one may land.
      if (request !== treeRequest.current) return;
      setTree(next);
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
    // Ctrl/Cmd+click and middle-click open the page in a tab of its own.
    if (takeNewTabIntent()) newTabRef.current = true;
    if (memoryRoot && (path === memoryRoot || path.startsWith(memoryRoot + "/"))) {
      void (async () => {
        try {
          await flushEditor.current?.();
          setAssistantPage((old) => ({ path, n: (old?.n ?? 0) + 1 }));
          setTrashOpen(false);
          setMailOpen(false);
          setRowPages([]);
          setTemplatesOpen(false);
          setWelcomeOpen(false);
          setAiOpen(true);
        } catch (e) {
          toast.error((e as Error).message);
        }
      })();
      return;
    }
    if (trashOpen || mailOpen || templatesOpen || aiOpen || welcomeOpen) {
      // The editor was unmounted; fetch the saved body even when the path is unchanged.
      void loadPage(path).then((page) => {
        if (page) {
          setSelectedPath(path);
          setTrashOpen(false);
          setMailOpen(false);
          setRowPages([]);
          setTemplatesOpen(false);
          setAiOpen(false);
          setWelcomeOpen(false);
        }
      });
    } else setSelectedPath(path);
  };

  const openInNewTab = (path: string) => {
    newTabRef.current = true;
    navigatePage(path);
  };

  const closePageTab = (path: string) => {
    const next = closeTab(tabsRef.current, path, selectedRef.current);
    setTabs(next.tabs);
    if (next.active !== selectedRef.current) setSelectedPath(next.active);
  };

  const navigateSettings = async (path: string) => {
    await flushEditor.current?.();
    // Fetch before leaving so failed navigation keeps the current settings available.
    const page = await pages.get(path);
    setActivePage(page);
    lastSavedHashRef.current = page.hash;
    setSelectedPath(path);
    setTrashOpen(false);
    setMailOpen(false);
    setRowPages([]);
    setTemplatesOpen(false);
    setAiOpen(false);
    setWelcomeOpen(false);
    setSettingsPath(path);
  };

  const finishOnboarding = ({ createdPath }: OnboardingResult) => {
    markOnboarded();
    setOnboarding(false);
    if (createdPath) {
      void loadTree();
      navigatePage(createdPath);
    } else setWelcomeOpen(true);
  };

  const createPage = async () => {
    try {
      const page = await pages.create({});
      void loadTree();
      if (tabsRef.current.length) newTabRef.current = true;
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

  const showMail = () =>
    openFullScreen(() => {
      setAiOpen(false);
      setWelcomeOpen(false);
      setTrashOpen(false);
      setRowPages([]);
      setTemplatesOpen(false);
      setMailTab(true);
      setMailOpen(true);
    });

  const closeMail = () => {
    setMailTab(false);
    if (!mailOpen) return;
    if (selectedPath) navigatePage(selectedPath);
    else setMailOpen(false);
  };

  useEffect(() => void loadTree(), [loadTree]);

  useEffect(() => {
    if (selectedPath) {
      const previous = activePathRef.current;
      void loadPage(selectedPath).then((page) => {
        if (page) {
          localStorage.setItem(scopedKey(SELECTED_KEY), selectedPath);
        } else if (previous && previous !== selectedPath && selectedRef.current === selectedPath) {
          // A failed navigation keeps the page you were on instead of dropping to Welcome.
          toast.error(`Could not open ${selectedPath}`);
          setSelectedPath(previous);
        } else if (selectedRef.current === selectedPath) {
          localStorage.removeItem(scopedKey(SELECTED_KEY));
        }
      });
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
      setTabs((old) => renameTabs(old, oldPath, newPath));
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

  const handleMoved = useCallback(
    (oldPath: string, newPath: string) => {
      const selected = selectedRef.current;
      setTabs((old) => renameTabs(old, oldPath, newPath));
      if (!selected) return;
      const next =
        selected === oldPath || selected.startsWith(oldPath + "/")
          ? newPath + selected.slice(oldPath.length)
          : selected;
      setSelectedPath(next);
      void loadPage(next).then((p) => p && setRefreshNonce((n) => n + 1));
    },
    [loadPage],
  );

  /** Move `sourcePath` under `targetPath`, e.g. a page dropped on a page link in the editor. */
  const movePageInto = useCallback(
    async (sourcePath: string, targetPath: string) => {
      if (sourcePath === targetPath || targetPath.startsWith(sourcePath + "/")) return;
      try {
        await flushEditor.current?.();
        const flatten = (nodes: TreeNode[]): TreeNode[] =>
          nodes.flatMap((node) => [node, ...flatten(node.children)]);
        const nodes = flatten(await pages.tree());
        const source = nodes.find((n) => n.path === sourcePath);
        const target = nodes.find((n) => n.path === targetPath);
        if (!source || !target) throw new Error("That page no longer exists.");
        const result = await workspace.move(source.id, target.id, "inside");
        handleMoved(sourcePath, result.path);
        void loadTree();
      } catch (e) {
        toast.error(`Could not move page: ${(e as Error).message}`);
      }
    },
    [handleMoved, loadTree],
  );

  /** Delete from the page itself: trash it, go to its parent, offer Undo. */
  const deletePage = useCallback(
    async (path: string, title: string) => {
      try {
        await flushEditor.current?.();
        const { trash_id } = await pages.remove(path, { unlink: true });
        // The parent takes over this tab; tabs of the deleted subpages close.
        setTabs((old) => old.filter((p) => !p.startsWith(path + "/")));
        setSelectedPath(parentPath(path));
        void loadTree();
        toast(`Deleted ${title || "Untitled"}`, {
          action: {
            label: "Undo",
            onClick: () =>
              void trash
                .restore(trash_id)
                .then((page) => {
                  void loadTree();
                  setSelectedPath(page.path);
                })
                .catch((e: Error) => toast.error(`Could not restore: ${e.message}`)),
          },
        });
      } catch (e) {
        toast.error(`Could not move to trash: ${(e as Error).message}`);
      }
    },
    [loadTree],
  );

  const handleTrashed = useCallback((path: string) => {
    const left = dropTabs(tabsRef.current, path);
    setTabs(left);
    if (selectedRef.current === path || selectedRef.current?.startsWith(path + "/"))
      setSelectedPath(left[left.length - 1] ?? null);
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

  // "Work: Inbox", so the tab says which mailbox it shows.
  const mailFolder = mailState.folders.find((f) => f.name === mailState.shownFolder);
  const mailTitle = mailState.account
    ? `${mailState.account.name}: ${mailState.search.trim() ? "Search" : mailState.showsDrafts ? "Drafts" : (mailFolder?.title ?? "Inbox")}`
    : "Mail";
  const fullScreen = trashOpen || mailOpen || templatesOpen || aiOpen || welcomeOpen;
  // A tab whose page is gone (deleted elsewhere) is not shown; the tree is the truth.
  const shownTabs = tabs.filter((path) => path === selectedPath || findNode(tree, path));

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
        <div ref={setSettingsHost} className={modelsOpen ? "h-full" : "hidden"} />
        <div className={modelsOpen ? "hidden" : "h-full"}>
          <Sidebar
            onModels={() => openSettings()}
            onAI={() =>
              openFullScreen(() => {
                setTrashOpen(false);
                setMailOpen(false);
                setRowPages([]);
                setTemplatesOpen(false);
                setWelcomeOpen(false);
                setAiOpen(true);
              })
            }
            onPages={() => {
              setSidebarMail(false);
              // Reading mail: only the sidebar changes, to find a page to open next to it.
              if (mailOpen && !aiOpen) return;
              if (selectedPath) navigatePage(selectedPath);
              else {
                setAiOpen(false);
                setTrashOpen(false);
                setMailOpen(false);
                setRowPages([]);
                setTemplatesOpen(false);
              }
            }}
            askHost={setAskHost}
            aiActive={aiOpen}
            onTrash={() =>
              openFullScreen(() => {
                setAiOpen(false);
                setWelcomeOpen(false);
                setMailOpen(false);
                setTrashOpen(true);
              })
            }
            trashActive={trashOpen}
            mailMenu={{
              accounts: mailState.accounts?.length ?? 0,
              unread: (mailState.accounts ?? []).reduce((sum, a) => sum + a.unread, 0),
              onOpen: () => {
                setSidebarMail(true);
                showMail();
              },
            }}
            mailActive={sidebarMail}
            mailRail={<MailRail state={mailState} onOpen={showMail} />}
            onWelcome={() =>
              openFullScreen(() => {
                setAiOpen(false);
                setTrashOpen(false);
                setMailOpen(false);
                setRowPages([]);
                setTemplatesOpen(false);
                setWelcomeOpen(true);
              })
            }
            welcomeActive={welcomeOpen && !aiOpen && !trashOpen && !mailOpen && !templatesOpen}
            onTemplates={() =>
              openFullScreen(() => {
                setAiOpen(false);
                setWelcomeOpen(false);
                setTrashOpen(false);
                setMailOpen(false);
                setRowPages([]);
                setTemplatesInstructions(false);
                setTemplatesOpen(true);
              })
            }
            templatesActive={templatesOpen}
            onFeedback={feedbackEnabled ? () => setFeedbackOpen(true) : undefined}
            beforeMove={async () => {
              await flushEditor.current?.();
            }}
            onMoved={handleMoved}
            tree={knowledgeTree(tree)}
            selectedPath={fullScreen ? null : selectedPath}
            onSelect={navigatePage}
            onOpenInNewTab={openInNewTab}
            onNavigateSettings={navigateSettings}
            onTreeChanged={() => void loadTree()}
            onRenamed={handleRenamed}
            onTrashed={handleTrashed}
            onIconChanged={handleIconChanged}
          />
        </div>
      </div>
      <div className="relative flex min-w-0 flex-1 flex-col">
        {!aiOpen && !showOnboarding && (shownTabs.length > 0 || mailTab) && (
          <TabBar
            tabs={shownTabs}
            active={fullScreen ? null : selectedPath}
            tree={tree}
            onSelect={navigatePage}
            onClose={closePageTab}
            onNew={() => void createPage()}
            onOpen={openInNewTab}
            mail={
              mailTab
                ? { title: mailTitle, active: mailOpen, onSelect: showMail, onClose: closeMail }
                : undefined
            }
          />
        )}
        <div className="relative min-h-0 flex-1">
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
          {aiOpen ? null : showOnboarding ? (
            <Onboarding
              onCreateBlankPage={async () => (await pages.create({})).path}
              onFinish={finishOnboarding}
            />
          ) : rowPage ? (
            <RowPage
              row={rowPage}
              onBack={() => setRowPages((s) => s.slice(0, -1))}
              onOpen={(row) => setRowPages((s) => [...s, row])}
              onNavigate={(path) => {
                setRowPages([]);
                navigatePage(path);
              }}
            />
          ) : templatesOpen ? (
            <TemplatesPage
              key={templatesInstructions ? "instructions" : "all"}
              initialView={templatesInstructions ? "instructions" : "templates"}
              currentPage={activePage ? { path: activePage.path, title: activePage.title } : null}
              onCreated={(path) => {
                void loadTree();
                navigatePage(path);
              }}
            />
          ) : mailOpen ? (
            <MailPage
              state={mailState}
              tree={tree}
              onSettings={() => openSettings()}
              onNavigate={openInNewTab}
              settingsVersion={settingsVersion}
            />
          ) : trashOpen ? (
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
              onOpenRow={(table, id) => openFullScreen(() => setRowPages([{ table, id }]))}
              onTitleChange={handleTitleChange}
              onIconChange={(icon) => activePage && handleIconChanged(activePage.path, icon)}
              onRenamed={handleRenamed}
              onMovePage={movePageInto}
              onDelete={() => void deletePage(activePage.path, activePage.title)}
              onAskAI={chatOpen ? undefined : () => setChatOpen(true)}
              onTreeChanged={() => void loadTree()}
              onSaved={saveActivePage}
              onSelectionChange={setSelection}
            />
          ) : (
            <WelcomePage
              onCreatePage={() => void createPage()}
              onSettings={(section) => openSettings(section)}
              onStudio={(section) => {
                setStudioSection((old) => ({ section, n: (old?.n ?? 0) + 1 }));
                setTrashOpen(false);
                setMailOpen(false);
                setRowPages([]);
                setTemplatesOpen(false);
                setAiOpen(true);
              }}
              onTemplates={() =>
                openFullScreen(() => {
                  setAiOpen(false);
                  setWelcomeOpen(false);
                  setTrashOpen(false);
                  setMailOpen(false);
                  setRowPages([]);
                  setTemplatesInstructions(true);
                  setTemplatesOpen(true);
                })
              }
              onFeedback={feedbackEnabled ? () => setFeedbackOpen(true) : undefined}
              firstName={me?.first_name || undefined}
            />
          )}
        </div>
      </div>
      {chatOpen &&
        activePage &&
        !rowPage &&
        !trashOpen &&
        !mailOpen &&
        !templatesOpen &&
        !aiOpen &&
        !welcomeOpen && (
          <ChatPanel
            key={activePage.path}
            path={activePage.path}
            tree={tree}
            onClose={() => setChatOpen(false)}
            onSettings={openSettings}
            onNavigate={navigatePage}
            settingsVersion={settingsVersion}
            selection={selection}
            request={aiRequest}
          />
        )}
      <AddAccountDialog
        open={mailState.adding}
        onClose={() => mailState.setAdding(false)}
        onAdded={(added) => {
          mailState.setAdding(false);
          mailState.choose(added.id);
          void mailState.loadAccounts();
          setSidebarMail(true);
          showMail();
        }}
      />
      <SearchPalette
        open={searchOpen}
        tree={tree}
        onOpenPage={navigatePage}
        onClose={() => setSearchOpen(false)}
        onAsk={
          activePage
            ? (question) => {
                setChatOpen(true);
                setAiRequest({ id: ++aiRequestId.current, prompt: question, mode: "ask" });
              }
            : undefined
        }
      />
      <FeedbackDialog open={feedbackOpen} onOpenChange={setFeedbackOpen} />
      {modelsOpen && (
        <ModelsPage
          initialTab={settingsTab}
          sidebarHost={settingsHost}
          onClose={() => {
            setModelsOpen(false);
            setSettingsVersion((v) => v + 1);
          }}
        />
      )}
    </div>
  );
}
