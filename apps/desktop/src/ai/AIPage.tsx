import { createPortal } from "react-dom";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Database, Settings2, Orbit } from "lucide-react";
import { toast } from "sonner";
import { onDaemonEvent, pages, type TreeNode } from "@/lib/api";
import {
  ai,
  type ChatMessage,
  type ChatMode,
  type Conversation,
  type IndexStatus,
  type Scope,
  toScope,
} from "@/lib/ai";
import { checkedFromScope, countSelected, scopeLabel } from "@/lib/scope";
import { Button } from "@/components/ui/button";
import { Composer } from "./Composer";
import { ContextBlock } from "./ContextBlock";
import { ConversationList } from "./ConversationList";
import { MessageList } from "./MessageList";
import { LimitsCallout } from "./Sources";
import { ScopeDialog } from "./ScopeDialog";
import { StreamingAnswer } from "./StreamingAnswer";
import { useChangedPages } from "./useChangedPages";
import { useChatStream } from "./useChatStream";
import { isConfigured, useAttachments } from "./useConversationSurface";
import { ReviewView } from "@/review/ReviewView";
import { useProposals } from "@/review/useProposals";
import { AgentsView } from "./AgentsView";
import type { Section } from "./ConversationList";
import { RunsView } from "./RunsView";
import { SchedulesView } from "./SchedulesView";
import { AssistantView } from "@/assistant/AssistantView";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import type { useAssistant } from "@/assistant/useAssistant";
import "@/models/ai.css";
import "./ai-page.css";

const ALL_PAGES: Scope = { kind: "vault", roots: [], excluded: [] };

/** The Graite AI page: a full-window chat over the whole knowledge base. */
export function AIPage({
  tree,
  assistantState,
  assistantPage,
  openSection,
  onNavigate,
  onSettings,
  onTreeChanged,
  settingsVersion,
  sidebarHost,
  active = true,
}: {
  assistantPage?: { path: string; n: number } | null;
  /** Open a section from elsewhere in the app; `n` changes on every request. */
  openSection?: { section: Section; n: number } | null;
  assistantState: ReturnType<typeof useAssistant>;
  active?: boolean;
  sidebarHost?: HTMLElement | null;
  tree: TreeNode[];
  onNavigate: (path: string) => void;
  onSettings: (tab?: "voice") => void;
  onTreeChanged: () => void;
  settingsVersion: number;
}) {
  const [modelVersion, setModelVersion] = useState(0);
  const [section, setSection] = useState<Section>("chat");
  useEffect(() => {
    if (assistantPage) setSection("assistant");
  }, [assistantPage]);
  useEffect(() => {
    if (openSection) setSection(openSection.section);
  }, [openSection]);
  const [openRunId, setOpenRunId] = useState<string | null>(null);
  const openRun = (id: string | null) => {
    setOpenRunId(id);
    if (id) setSection("runs");
  };
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [selected, setSelected] = useState<Conversation | null>(null);
  const [scope, setScope] = useState<Scope>(ALL_PAGES);
  const [scopeOpen, setScopeOpen] = useState(false);
  const [mode, setMode] = useState<ChatMode>("ask");
  const [draft, setDraft] = useState("");
  const [index, setIndex] = useState<IndexStatus | null>(null);
  const [configured, setConfigured] = useState(true);
  const [loading, setLoading] = useState(true);
  const end = useRef<HTMLDivElement>(null);
  const changedPages = useChangedPages();

  const ensureConversation = useCallback(async () => {
    const created = await ai.createConversation({ scope, mode });
    setSelected(created);
    setConversations((old) => [created, ...old]);
    return created;
  }, [scope, mode]);

  const chat = useChatStream({
    conversation: selected,
    ensureConversation,
    onConversationSaved: (saved) => {
      setSelected(saved);
      setConversations((old) => [saved, ...old.filter((c) => c.id !== saved.id)]);
    },
  });
  const files = useAttachments(selected, ensureConversation);
  const setAttachments = files.setAttachments;
  const reviews = useProposals(selected ? { conversation_id: selected.id } : null);
  const pendingReviews = useProposals(active ? { status: "pending", limit: 200 } : null);

  useEffect(() => {
    if (!active) return;
    let live = true;
    void Promise.all([ai.allConversations(), ai.status(), ai.indexStatus()])
      .then(([items, status, indexStatus]) => {
        if (!live) return;
        setConversations(items);
        setIndex(indexStatus);
        setConfigured(isConfigured(status));
      })
      .catch((e: Error) => toast.error(e.message))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [settingsVersion, active, modelVersion]);

  useEffect(
    () =>
      onDaemonEvent((event) => {
        if (event.type === "index_progress") setIndex(event.data as unknown as IndexStatus);
      }),
    [],
  );

  useEffect(() => {
    end.current?.scrollIntoView?.({ block: "end" });
  }, [chat.stream, chat.messages, chat.status]);

  const scopeText = useMemo(
    () => scopeLabel(scope, countSelected(tree, checkedFromScope(tree, scope))),
    [scope, tree],
  );

  const applyScope = async (next: Scope) => {
    setScope(next);
    setScopeOpen(false);
    if (selected) {
      try {
        const updated = await ai.updateConversation(selected.id, { scope: next });
        setSelected(updated);
      } catch (e) {
        toast.error((e as Error).message);
      }
    }
  };

  const send = async (text = draft) => {
    if (!configured) {
      onSettings();
      return;
    }
    setDraft("");
    await chat.send(text, { mode, attachments: files.take() });
  };

  const turnIntoPage = async (message: ChatMessage) => {
    try {
      const title =
        message.content
          .split("\n")[0]
          .replace(/^#+\s*/, "")
          .slice(0, 70) || "Graite answer";
      const page = await pages.create({ title });
      await pages.put(page.path, message.content, page.hash);
      onTreeChanged();
      onNavigate(page.path);
      toast.success(`Created “${title}”`);
    } catch (e) {
      toast.error(`Could not create the page: ${(e as Error).message}`);
    }
  };

  const pending = index?.pending_chunks ?? 0;

  const rail = (
    <ConversationList
      section={section}
      onSection={setSection}
      conversations={conversations}
      selectedId={selected?.id ?? null}
      busy={chat.busy}
      pendingReviews={pendingReviews.proposals.length}
      assistantName={assistantState.info?.configured ? assistantState.info.name : undefined}
      onSelect={(c) => {
        setSection("chat");
        setDraft("");
        setSelected(c);
        setScope(toScope(c.scope));
        setMode((c.mode as ChatMode) ?? "ask");
        setAttachments([]);
      }}
      onNew={() => {
        setSection("chat");
        setDraft("");
        setSelected(null);
        chat.setMessages([]);
        setAttachments([]);
        setScope(ALL_PAGES);
      }}
      onDelete={async (c) => {
        try {
          await ai.deleteConversation(c.id);
          setConversations((old) => old.filter((x) => x.id !== c.id));
          if (selected?.id === c.id) {
            setSelected(null);
            chat.setMessages([]);
          }
        } catch (e) {
          toast.error((e as Error).message);
        }
      }}
    />
  );
  const empty = !chat.messages.length && !chat.busy;
  return (
    <main className="ai-page" aria-label="Studio">
      {sidebarHost ? createPortal(rail, sidebarHost) : rail}
      {/* Kept mounted: a voice session or a running answer must survive leaving the section. */}
      <div className="ai-agents-surface" hidden={section !== "assistant"}>
        <ErrorBoundary area="the assistant">
          <AssistantView
            requestedPage={assistantPage}
            state={assistantState}
            tree={tree}
            visible={active && section === "assistant"}
            onNavigate={onNavigate}
            onSettings={onSettings}
            settingsVersion={settingsVersion}
            onOpenRun={openRun}
          />
        </ErrorBoundary>
      </div>
      {section === "review" && <ReviewView onNavigate={onNavigate} />}
      <div className="ai-agents-surface" hidden={section !== "agents"}>
        <AgentsView tree={tree} onOpenRun={openRun} onNavigate={onNavigate} />
      </div>
      {section === "schedules" && <SchedulesView onNavigate={onNavigate} />}
      {section === "runs" && (
        <RunsView onNavigate={onNavigate} openRunId={openRunId} onOpenRun={setOpenRunId} />
      )}
      <section
        className={`ai-page-main ${empty ? "ai-page-start" : ""}`}
        hidden={section !== "chat"}
      >
        <header className="ai-page-header">
          <nav className="ai-page-title" aria-label="Studio breadcrumb">
            <Orbit size={18} />
            <button
              disabled={chat.busy}
              onClick={() => {
                setSelected(null);
                chat.setMessages([]);
                setDraft("");
                setAttachments([]);
                setScope(ALL_PAGES);
              }}
            >
              Studio
            </button>
            {selected && !empty && (
              <>
                <span className="text-muted-foreground">/</span>
                <span className="ai-chat-title" title={selected.title}>
                  {selected.title}
                </span>
              </>
            )}
          </nav>
          <div className="ai-page-header-actions">
            <button type="button" className="ai-page-scope" onClick={() => setScopeOpen(true)}>
              <Database size={12} /> {scopeText}
            </button>
            {!!pending && (
              <span className="ai-index-pill" title="Sections still being indexed">
                Indexing {pending}
              </span>
            )}
            <Button
              variant="ghost"
              size="icon"
              title="Settings"
              aria-label="Settings"
              onClick={() => onSettings()}
            >
              <Settings2 size={15} />
            </Button>
          </div>
        </header>
        <div className="ai-page-body">
          <div className="ai-page-thread">
            {loading && <p className="text-sm text-muted-foreground">Loading…</p>}
            {!loading && !chat.messages.length && (
              <div className="ai-chat-empty">
                <div className="ai-orb">
                  <Orbit size={27} />
                </div>
                <h2>How can I help you today?</h2>
                <p>Explore your ideas, find answers, and make something new.</p>
                {!configured ? (
                  <Button className="mb-4" onClick={() => onSettings()}>
                    <Settings2 size={15} /> Choose your model
                  </Button>
                ) : null}
              </div>
            )}
            <ContextBlock context={chat.context} onNavigate={onNavigate} changed={changedPages} />
            <MessageList
              messages={chat.messages}
              onNavigate={onNavigate}
              onTurnIntoPage={turnIntoPage}
              changed={changedPages}
              proposals={reviews.byId}
              actions={reviews.actions}
            />
            {chat.busy && (
              <StreamingAnswer
                stream={chat.stream}
                thinking={chat.thinking}
                activity={chat.activity}
                status={chat.status}
                newSources={chat.newSources}
                onNavigate={onNavigate}
                proposals={chat.proposals}
                actions={reviews.actions}
              />
            )}
            {chat.clarify && <div className="ai-notice">{chat.clarify}</div>}
            {!chat.busy && chat.limits && (
              <LimitsCallout items={chat.limits.items} excluded={chat.limits.excluded_local_only} />
            )}
            {chat.error && (
              <div className="ai-notice ai-error" role="alert">
                {chat.error}
                <button onClick={() => onSettings()}>Open Settings</button>
              </div>
            )}
            <div ref={end} />
          </div>
        </div>
        <footer className="ai-page-footer">
          {active && section === "chat" && (
            <Composer
              contextId={selected?.id ?? "new"}
              onPages={() => setScopeOpen(true)}
              pageLabel={scopeText}
              onSettings={() => onSettings()}
              settingsVersion={settingsVersion}
              onModelChanged={() => setModelVersion((v) => v + 1)}
              value={draft}
              onChange={setDraft}
              onSend={() => void send()}
              onStop={() => void chat.stop()}
              busy={chat.busy}
              disabled={loading}
              mode={mode}
              onModeChange={setMode}
              attachments={files.attachments}
              onAttach={(list) => void files.attach(list)}
              onRemoveAttachment={(id) => void files.remove(id)}
            />
          )}
        </footer>
      </section>
      <ScopeDialog
        open={scopeOpen}
        tree={tree}
        scope={scope}
        onApply={(next) => void applyScope(next)}
        onCancel={() => setScopeOpen(false)}
      />
    </main>
  );
}
