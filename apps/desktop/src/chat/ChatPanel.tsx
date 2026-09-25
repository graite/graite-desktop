import { useCallback, useEffect, useRef, useState } from "react";
import {
  Check,
  Highlighter,
  History,
  MessageSquare,
  Plus,
  Settings2,
  Orbit,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { ai, toScope, type ChatMode, type Conversation } from "@/lib/ai";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { relative } from "@/lib/automation";
import { Composer } from "@/ai/Composer";
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

/** "Ask AI": a chat panel beside the open page, scoped to that page or its subtree. */
export function ChatPanel({
  path,
  title,
  onClose,
  onSettings,
  onNavigate,
  settingsVersion,
  selection = "",
}: {
  path: string;
  title: string;
  onClose: () => void;
  onSettings: () => void;
  onNavigate: (path: string) => void;
  settingsVersion: number;
  /** Text currently selected in the editor, offered as a source for the next question. */
  selection?: string;
}) {
  const [modelVersion, setModelVersion] = useState(0);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [selected, setSelected] = useState<Conversation | null>(null);
  const [includeSubpages, setIncludeSubpages] = useState(true);
  const [mode, setMode] = useState<ChatMode>("ask");
  const [draft, setDraft] = useState("");
  const [useSelection, setUseSelection] = useState(false);
  const [loading, setLoading] = useState(true);
  const [configured, setConfigured] = useState(false);
  const [connection, setConnection] = useState("");
  const end = useRef<HTMLDivElement>(null);
  const changedPages = useChangedPages();

  const ensureConversation = useCallback(async () => {
    const created = await ai.createConversation({
      scope: { kind: includeSubpages ? "folder" : "page", roots: [path], excluded: [] },
      mode,
    });
    setSelected(created);
    setConversations((old) => [created, ...old]);
    return created;
  }, [includeSubpages, path, mode]);

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
          setIncludeSubpages(toScope(items[0].scope).kind !== "page");
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

  const changeScope = async (subpages: boolean) => {
    setIncludeSubpages(subpages);
    if (!selected) return;
    try {
      const updated = await ai.updateConversation(selected.id, {
        scope: { kind: subpages ? "folder" : "page", roots: [path], excluded: [] },
      });
      setSelected(updated);
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  const send = async (text = draft) => {
    if (!configured) {
      onSettings();
      return;
    }
    setDraft("");
    const attached =
      useSelection && selection.trim() ? { page_path: path, text: selection } : undefined;
    setUseSelection(false);
    await chat.send(text, { mode, attachments: files.take(), selection: attached, pagePath: path });
  };

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
                      setIncludeSubpages(toScope(c.scope).kind !== "page");
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
      <div className="ai-chat-scope">
        <MessageSquare size={13} />
        <span>{title}</span>
        <div className="ai-modes ai-scope-toggle" role="group" aria-label="Chat scope">
          <button
            type="button"
            data-active={!includeSubpages || undefined}
            aria-pressed={!includeSubpages}
            onClick={() => void changeScope(false)}
          >
            This page
          </button>
          <button
            type="button"
            data-active={includeSubpages || undefined}
            aria-pressed={includeSubpages}
            onClick={() => void changeScope(true)}
          >
            & subpages
          </button>
        </div>
      </div>
      <div className="ai-chat-body">
        {loading && <p className="text-sm text-muted-foreground">Loading conversations…</p>}
        {!chat.messages.length && !loading && (
          <div className="ai-chat-empty">
            <div className="ai-orb">
              <Orbit size={27} />
            </div>
            <h2>A fresh look at your ideas.</h2>
            <p>Ask about this page. Graite can explore its subpages to help you find an answer.</p>
            {!configured ? (
              <Button className="mb-4 w-full" onClick={onSettings}>
                <Settings2 size={15} /> Choose your model
              </Button>
            ) : null}
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
        {chat.clarify && <div className="ai-notice">{chat.clarify}</div>}
        {!chat.busy && chat.limits && (
          <LimitsCallout items={chat.limits.items} excluded={chat.limits.excluded_local_only} />
        )}
        {chat.error && (
          <div className="ai-notice ai-error" role="alert">
            {chat.error}
            <button onClick={onSettings}>Open Settings</button>
          </div>
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
          mode={mode}
          onModeChange={setMode}
          attachments={files.attachments}
          onAttach={(list) => void files.attach(list)}
          onRemoveAttachment={(id) => void files.remove(id)}
          placeholder="Ask about this page…"
          left={
            selection.trim() ? (
              <button
                type="button"
                className="ai-selection-chip"
                data-active={useSelection || undefined}
                aria-pressed={useSelection}
                onClick={() => setUseSelection((on) => !on)}
              >
                <Highlighter size={12} />
                {useSelection ? "Using selection" : "Use selection"}
              </button>
            ) : null
          }
        />
        <p className="ai-chat-footnote">{connection} · Uses saved pages</p>
      </footer>
    </aside>
  );
}
