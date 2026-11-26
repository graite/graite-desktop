import { mentionedPaths } from "@/ai/mentions";
import { useCallback, useEffect, useRef, useState } from "react";
import { Check, Highlighter, History, Plus, Settings2, Orbit, X } from "lucide-react";
import { toast } from "sonner";
import { ai, toScope, type ChatMode, type Conversation, type Scope } from "@/lib/ai";
import type { TreeNode } from "@/lib/api";
import { useErrorToast } from "@/lib/useErrorToast";
/** This page and the pages nested under it: where a page's chat starts. */
const pageScope = (path: string): Scope => ({ kind: "folder", roots: [path], excluded: [] });
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { relative } from "@/lib/automation";
import { useContinueAfterReview } from "@/ai/useContinueAfterReview";
import { ClarifyNotice } from "@/ai/ClarifyNotice";
import { Composer } from "@/ai/Composer";
import { ScopeDialog } from "@/ai/ScopeDialog";
import { ScopeMenu } from "@/ai/ScopeMenu";
import { ContextBlock } from "@/ai/ContextBlock";
import { MessageList } from "@/ai/MessageList";
import { LimitsCallout } from "@/ai/Sources";
import { StreamingAnswer } from "@/ai/StreamingAnswer";
import { useChangedPages } from "@/ai/useChangedPages";
import { useChatStream } from "@/ai/useChatStream";
import { isConfigured, useAttachments } from "@/ai/useConversationSurface";
import { useProposals } from "@/review/useProposals";
import { splitThinking } from "./thinking";
import "@/models/ai.css";
import "@/ai/ai-page.css";

export { splitThinking };

export interface ChatRequest {
  id: number;
  prompt: string;
  mode?: ChatMode;
  /** False opens the panel with this text in the composer instead of sending it immediately. */
  send?: boolean;
}

/** "Ask AI": a chat panel beside the open page. It may use every page (the default), this
 * page, a chosen set or none; either way it knows which page it sits beside. */
export function ChatPanel({
  path,
  tree,
  onClose,
  onSettings,
  onNavigate,
  settingsVersion,
  selection = "",
  request,
}: {
  path: string;
  tree: TreeNode[];
  onClose: () => void;
  onSettings: () => void;
  onNavigate: (path: string) => void;
  settingsVersion: number;
  /** Text currently selected in the editor, offered as a source for the next question. */
  selection?: string;
  /** A request from elsewhere in the app, handled once per `id`. */
  request?: ChatRequest | null;
}) {
  const [modelVersion, setModelVersion] = useState(0);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [selected, setSelected] = useState<Conversation | null>(null);
  // A page's chat starts with that page and the pages nested under it.
  const [scope, setScope] = useState<Scope>(() => pageScope(path));
  const [scopeOpen, setScopeOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [useSelection, setUseSelection] = useState(false);
  const [loading, setLoading] = useState(true);
  const [configured, setConfigured] = useState(false);
  const [connection, setConnection] = useState("");
  const end = useRef<HTMLDivElement>(null);
  const changedPages = useChangedPages();

  const ensureConversation = useCallback(async () => {
    const created = await ai.createConversation({ page_path: path, scope });
    setSelected(created);
    setConversations((old) => [created, ...old]);
    return created;
  }, [scope, path]);

  const chat = useChatStream({
    conversation: selected,
    ensureConversation,
    onConversationSaved: (saved) => {
      setSelected(saved);
      setConversations((old) => [saved, ...old.filter((c) => c.id !== saved.id)]);
    },
  });
  useErrorToast(chat.error, { label: "Open Settings", onClick: () => onSettings() });

  const files = useAttachments(selected, ensureConversation);
  const setAttachments = files.setAttachments;
  const reviews = useProposals(selected ? { conversation_id: selected.id } : null);

  const readStatus = useCallback((setup: Awaited<ReturnType<typeof ai.status>>) => {
    const c = setup.config;
    setConfigured(isConfigured(setup));
    setConnection(
      c.provider === "local"
        ? "On device"
        : c.provider === "anthropic"
          ? "Connected to Claude"
          : "Connected to your model server",
    );
  }, []);

  useEffect(() => {
    let live = true;
    void Promise.all([ai.conversations(path), ai.status()])
      .then(([items, setup]) => {
        if (!live) return;
        readStatus(setup);
        setConversations(items);
        if (items[0]) {
          setSelected(items[0]);
          setScope(toScope(items[0].scope));
        } else {
          setScope(pageScope(path));
        }
      })
      .catch((e: Error) => live && chat.setError(e.message))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [path, readStatus, chat.setError]);

  useEffect(() => {
    let live = true;
    void ai
      .status()
      .then((setup) => live && readStatus(setup))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [settingsVersion, readStatus, modelVersion]);

  useEffect(() => {
    end.current?.scrollIntoView?.({ block: "end" });
  }, [chat.stream, chat.messages, chat.status]);

  const changeScope = async (next: Scope) => {
    setScope(next);
    setScopeOpen(false);
    if (!selected) return;
    try {
      const updated = await ai.updateConversation(selected.id, { scope: next });
      setSelected(updated);
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  const pagesMenu = () => (
    <ScopeMenu
      scope={scope}
      tree={tree}
      page={path}
      iconOnly
      onChange={(next) => void changeScope(next)}
      onChoose={() => setScopeOpen(true)}
      disabled={chat.busy}
    />
  );

  const send = async (text = draft) => {
    if (!configured) {
      onSettings();
      return;
    }
    setDraft("");
    const attached =
      useSelection && selection.trim() ? { page_path: path, text: selection } : undefined;
    setUseSelection(false);
    await chat.send(text, {
      attachments: files.take(),
      selection: attached,
      pagePath: path,
      pinned: mentionedPaths(text),
    });
  };

  // Send a request handed over by a block once the panel knows whether a model is set up;
  // without one, it waits in the composer.
  const handled = useRef<number | null>(null);
  useEffect(() => {
    if (!request || loading || handled.current === request.id) return;
    handled.current = request.id;
    if (request.send === false || !configured) setDraft(request.prompt);
    else void send(request.prompt);
    // `send` reads the latest state; it only has to run when a new request arrives.
  }, [request, loading, configured]);

  useContinueAfterReview({
    messages: chat.messages,
    byId: reviews.byId,
    busy: chat.busy,
    send: (text) => void send(text),
  });

  return (
    <aside className="ai-chat" aria-label="Ask AI">
      <header className="ai-chat-header">
        <span>
          <Orbit size={17} /> Ask AI
        </span>
        <div>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                title="Conversation history"
                aria-label="Conversation history"
                disabled={chat.busy || !conversations.length}
              >
                <History size={16} />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="ai-history-menu">
              <DropdownMenuLabel className="ai-model-group">Earlier on this page</DropdownMenuLabel>
              {[...conversations]
                .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
                .map((c) => (
                  <DropdownMenuItem
                    key={c.id}
                    onSelect={() => {
                      setSelected(c);
                      setScope(toScope(c.scope));
                    }}
                  >
                    <span className="ai-history-item">
                      <strong>{c.title}</strong>
                      <small>{relative(c.updated_at)}</small>
                    </span>
                    {selected?.id === c.id && <Check size={14} />}
                  </DropdownMenuItem>
                ))}
            </DropdownMenuContent>
          </DropdownMenu>
          <Button
            variant="ghost"
            size="icon"
            title="New conversation"
            aria-label="New conversation"
            disabled={chat.busy || loading}
            onClick={() => {
              setSelected(null);
              chat.setMessages([]);
              setAttachments([]);
              setScope(pageScope(path));
            }}
          >
            <Plus size={16} />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            title="AI settings"
            aria-label="AI settings"
            onClick={onSettings}
          >
            <Settings2 size={16} />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            title="Close chat"
            aria-label="Close chat"
            onClick={onClose}
          >
            <X size={17} />
          </Button>
        </div>
      </header>
      <div className="ai-chat-body">
        {loading && <p className="text-sm text-muted-foreground">Loading conversations…</p>}
        {!chat.messages.length && !loading && (
          <div className="ai-chat-empty">
            <div className="ai-orb">
              <Orbit size={27} />
            </div>
            <h2>A fresh look at your ideas.</h2>
            <p>
              Ask about this page or anything else in your workspace. Graite searches your pages and
              opens only the ones it needs.
            </p>
          </div>
        )}
        <ContextBlock context={chat.context} onNavigate={onNavigate} changed={changedPages} />
        <MessageList
          messages={chat.messages}
          onNavigate={onNavigate}
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
        {!!chat.tools.length && (
          <details className="ai-tool-log">
            <summary>
              {chat.tools.length} page {chat.tools.length === 1 ? "activity" : "activities"}
            </summary>
            {chat.tools.map((t, i) => (
              <div key={i}>{t}</div>
            ))}
          </details>
        )}
        {chat.clarify && (
          <ClarifyNotice
            question={chat.clarify}
            options={chat.clarifyOptions}
            disabled={chat.busy}
            onPick={(answer) => void send(answer)}
          />
        )}
        {!chat.busy && chat.limits && (
          <LimitsCallout items={chat.limits.items} excluded={chat.limits.excluded_local_only} />
        )}
        <div ref={end} />
      </div>
      <footer className="ai-chat-footer">
        {!!chat.instructions.length && (
          <details className="ai-instructions">
            <summary>
              Following {chat.instructions.length} instruction{" "}
              {chat.instructions.length === 1 ? "source" : "sources"}
            </summary>
            {chat.instructions.map((p) => (
              <div key={p}>{p}</div>
            ))}
          </details>
        )}
        <Composer
          compact
          contextId={selected?.id ?? "new"}
          onSettings={onSettings}
          settingsVersion={settingsVersion}
          onModelChanged={() => setModelVersion((v) => v + 1)}
          value={draft}
          onChange={setDraft}
          onSend={() => void send()}
          onStop={() => void chat.stop()}
          busy={chat.busy}
          disabled={loading}
          attachments={files.attachments}
          onAttach={(list) => void files.attach(list)}
          onRemoveAttachment={(id) => void files.remove(id)}
          placeholder="Ask about this page…"
          pages={pagesMenu()}
          left={
            selection.trim() ? (
              <button
                type="button"
                className="ai-composer-icon ai-selection-toggle"
                data-active={useSelection || undefined}
                aria-pressed={useSelection}
                aria-label={useSelection ? "Using your selection" : "Use your selection"}
                title={
                  useSelection
                    ? "Asking about the text you selected. Click to ask about the page instead."
                    : "Ask about the text you selected in the page"
                }
                onClick={() => setUseSelection((on) => !on)}
              >
                <Highlighter size={16} />
              </button>
            ) : null
          }
        />
        <p className="ai-chat-footnote">{connection} · Uses saved pages</p>
      </footer>
      <ScopeDialog
        open={scopeOpen}
        tree={tree}
        scope={scope}
        onApply={(next) => void changeScope(next)}
        onCancel={() => setScopeOpen(false)}
        allowNone
      />
    </aside>
  );
}
