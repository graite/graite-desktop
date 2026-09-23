import { useEffect, useRef, useState } from "react";
import {
  Activity,
  ArrowLeft,
  ArrowUp,
  BookOpen,
  Bot,
  Check,
  Loader2,
  MessageSquare,
  Play,
  PanelLeftClose,
  Settings2,
  Sparkles,
  Square,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { AgentInstructionsEditor } from "@/editor/AgentInstructionsEditor";
import type { TreeNode } from "@/lib/api";
import { onDaemonEvent } from "@/lib/api";
import {
  automation,
  relative,
  RUN_STATUS_LABELS,
  type AgentBody,
  type AgentInfo,
  type BuilderMessage,
} from "@/lib/automation";
import { MarkdownAnswer } from "@/chat/MarkdownAnswer";
import { AgentSettings } from "./AgentSettings";
import { agentBody } from "./agent-templates";
import "./agent-workspace.css";

interface LastRun {
  jobId?: string;
  runId: string | null;
  status: string;
  message: string;
  at: string;
}

export function AgentWorkspace({
  initial,
  agent,
  initialPrompt,
  tree,
  onClose,
  onSaved,
  onNavigate,
  onOpenRun,
}: {
  initial: AgentBody;
  agent: AgentInfo | null;
  initialPrompt?: string;
  tree: TreeNode[];
  onClose: () => void;
  onSaved: () => void;
  onNavigate: (path: string) => void;
  onOpenRun?: (runId: string) => void;
}) {
  const [draft, setDraft] = useState(initial);
  const [saved, setSaved] = useState<AgentBody | null>(agent ? initial : null);
  const [savedName, setSavedName] = useState(agent?.name ?? null);
  const [tab, setTab] = useState<"instructions" | "settings">("instructions");
  const [chatOpen, setChatOpen] = useState(!agent);
  const [messages, setMessages] = useState<BuilderMessage[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [running, setRunning] = useState(false);
  const [lastRun, setLastRun] = useState<LastRun | null>(() =>
    agent?.last_run
      ? {
          runId: String(agent.last_run.id),
          status: String(agent.last_run.status),
          message: agent.last_run.error ? String(agent.last_run.error) : "",
          at: String(agent.last_run.started_at),
        }
      : null,
  );
  const [error, setError] = useState("");
  const [leave, setLeave] = useState<(() => void) | null>(null);
  const [suggestion, setSuggestion] = useState<{ before: AgentBody; after: AgentBody } | null>(
    null,
  );
  const abort = useRef<AbortController | null>(null);
  const end = useRef<HTMLDivElement>(null);
  const dirty = JSON.stringify(draft) !== JSON.stringify(saved);
  const patch = (values: Partial<AgentBody>) => setDraft((current) => ({ ...current, ...values }));
  const navigate = (action: () => void) => {
    if (dirty) setLeave(() => action);
    else action();
  };
  useEffect(() => () => abort.current?.abort(), []);
  // Follow the run we queued: the job carries its run id and progress until it finishes.
  useEffect(
    () =>
      onDaemonEvent((event) => {
        if (event.type !== "job_update" && event.type !== "run_update") return;
        const data = event.data as {
          id?: string;
          job_id?: string | null;
          status?: string;
          run_id?: string | null;
          progress?: { message?: string } | null;
          error?: string | null;
        };
        setLastRun((current) => {
          if (!current?.jobId) return current;
          if (event.type === "job_update" && data.id === current.jobId) {
            const runId = data.run_id ?? current.runId;
            const status =
              data.status === "done"
                ? current.status === "needs_input"
                  ? "needs_input"
                  : "succeeded"
                : data.status === "pending"
                  ? "queued"
                  : (data.status ?? current.status);
            return {
              ...current,
              runId,
              status,
              message: data.error ?? data.progress?.message ?? current.message,
            };
          }
          if (event.type === "run_update" && data.job_id === current.jobId && data.status) {
            return { ...current, runId: data.id ?? current.runId, status: data.status };
          }
          return current;
        });
      }),
    [],
  );
  useEffect(() => {
    end.current?.scrollIntoView?.({ behavior: "smooth" });
  }, [messages, busy, suggestion]);
  useEffect(() => {
    if (!dirty) return;
    const guard = (e: BeforeUnloadEvent) => {
      e.preventDefault();
    };
    window.addEventListener("beforeunload", guard);
    return () => window.removeEventListener("beforeunload", guard);
  }, [dirty]);
  const send = async (text: string) => {
    if (!text.trim() || busy) return;
    const next: BuilderMessage[] = [...messages, { role: "user", content: text.trim() }];
    const snapshot = structuredClone(draft);
    setMessages(next);
    setInput("");
    setBusy(true);
    setError("");
    setSuggestion(null);
    const controller = new AbortController();
    abort.current = controller;
    try {
      const reply = await automation.buildAgent(snapshot, next.slice(-40), controller.signal);
      if (controller.signal.aborted) return;
      setMessages([...next, { role: "assistant", content: reply.message }]);
      if (reply.draft) setSuggestion({ before: snapshot, after: reply.draft });
    } catch (e) {
      if (!controller.signal.aborted) {
        setError((e as Error).message);
        setInput(text);
        setMessages(next.slice(0, -1));
      }
    } finally {
      if (abort.current === controller) {
        setBusy(false);
        abort.current = null;
      }
    }
  };
  useEffect(() => {
    if (!initialPrompt) return;
    const timer = setTimeout(() => {
      void send(initialPrompt);
    }, 0);
    return () => clearTimeout(timer);
    // Only the initial creation prompt; subsequent turns are sent by the composer.
  }, []);
  const save = async () => {
    setSaving(true);
    setError("");
    try {
      const body = { ...draft, name: draft.name.trim() };
      const result = savedName
        ? await automation.updateAgent(savedName, body)
        : await automation.createAgent(body);
      const next = agentBody(result);
      setDraft((current) => (JSON.stringify(current) === JSON.stringify(draft) ? next : current));
      setSaved(next);
      setSavedName(result.name);
      onSaved();
      toast.success("Agent saved");
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    } finally {
      setSaving(false);
    }
  };
  const changedKeys = suggestion
    ? (Object.keys(suggestion.after) as (keyof AgentBody)[]).filter(
        (k) => JSON.stringify(suggestion.before[k]) !== JSON.stringify(suggestion.after[k]),
      )
    : [];
  return (
    <section className="agent-workspace" aria-label="Agent workspace">
      <header className="agent-workspace-header">
        <button
          className="agent-back"
          onClick={() => navigate(onClose)}
          aria-label="Back to agents"
          disabled={saving}
        >
          <ArrowLeft size={17} />
        </button>
        <Bot size={18} />
        <span>{draft.name || "Untitled agent"}</span>
        <span className="agent-save-state">
          {dirty ? (
            "Unsaved changes"
          ) : (
            <>
              <Check size={12} /> Saved
            </>
          )}
        </span>
        <Button
          variant="ghost"
          size="sm"
          aria-expanded={chatOpen}
          aria-controls="agent-configuration-chat"
          onClick={() => setChatOpen(!chatOpen)}
        >
          <MessageSquare size={15} /> Configure in chat
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={dirty || !savedName || running || saving}
          title={dirty ? "Save your agent before running it" : "Run agent"}
          onClick={async () => {
            if (!savedName) return;
            setRunning(true);
            try {
              const { job_id } = await automation.runAgent(savedName);
              setLastRun({
                jobId: job_id,
                runId: null,
                status: "queued",
                message: "Waiting for the model…",
                at: new Date().toISOString(),
              });
              toast.success(`${savedName} queued`);
            } catch (e) {
              setError((e as Error).message);
            } finally {
              setRunning(false);
            }
          }}
        >
          <Play size={13} />
          {running ? "Queuing…" : "Run agent"}
        </Button>
        <Button
          size="sm"
          disabled={saving || !dirty || !draft.name.trim() || !draft.instructions?.trim()}
          onClick={() => void save()}
        >
          {saving ? "Saving…" : savedName ? "Save changes" : "Create agent"}
        </Button>
      </header>
      {lastRun && (
        <div className="agent-last-run-strip" data-status={lastRun.status} aria-label="Last run">
          {lastRun.status === "queued" || lastRun.status === "running" ? (
            <Loader2 size={13} className="animate-spin" />
          ) : (
            <Activity size={13} />
          )}
          <strong>{RUN_STATUS_LABELS[lastRun.status] ?? lastRun.status}</strong>
          <span>{lastRun.message || `Last run ${relative(lastRun.at)}`}</span>
          {lastRun.runId && onOpenRun ? (
            <Button size="sm" variant="ghost" onClick={() => onOpenRun(lastRun.runId as string)}>
              Open run
            </Button>
          ) : null}
        </div>
      )}
      {leave && (
        <div className="agent-leave" role="alert">
          You have unsaved changes.
          <Button size="sm" variant="ghost" onClick={() => setLeave(null)}>
            Keep editing
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              leave();
              setLeave(null);
            }}
          >
            Discard changes
          </Button>
          <Button
            size="sm"
            disabled={saving || !draft.name.trim() || !draft.instructions?.trim()}
            onClick={async () => {
              if (await save()) {
                leave();
                setLeave(null);
              }
            }}
          >
            Save and continue
          </Button>
        </div>
      )}
      <div className="agent-workspace-body" inert={saving}>
        <aside
          id="agent-configuration-chat"
          className="agent-builder-chat"
          aria-label="Configure agent in chat"
          hidden={!chatOpen}
        >
          <div className="agent-chat-heading">
            <MessageSquare size={16} />
            <strong>Build together</strong>
            <span>Configuration chat</span>
            <button aria-label="Minimize configuration chat" onClick={() => setChatOpen(false)}>
              <PanelLeftClose size={16} />
            </button>
          </div>
          <div className="agent-chat-messages" aria-live="polite">
            {!messages.length && (
              <div className="agent-chat-welcome">
                <span className="agent-avatar">
                  <Sparkles size={24} />
                </span>
                <h2>Make it your agent.</h2>
                <p>
                  Describe what it should do, ask a question, or change its instructions and
                  settings together.
                </p>
                <div className="agent-chat-starters">
                  {[
                    "Help me refine the workflow",
                    "What knowledge pages should I link?",
                    "Help me set up a schedule",
                  ].map((text) => (
                    <button key={text} onClick={() => void send(text)}>
                      {text}
                      <ArrowUp size={13} />
                    </button>
                  ))}
                </div>
              </div>
            )}
            {messages.map((message, i) => (
              <div className={`agent-chat-message ${message.role}`} key={i}>
                <small>{message.role === "user" ? "You" : "Agent builder"}</small>
                <MarkdownAnswer
                  content={message.content}
                  onNavigate={(path) => navigate(() => onNavigate(path))}
                />
              </div>
            ))}
            {busy && (
              <div className="agent-chat-thinking">
                <span /> Working on your agent…
              </div>
            )}
            {suggestion && (
              <div className="agent-draft-proposal">
                <strong>
                  <Sparkles size={15} /> Suggested changes
                </strong>
                <p>
                  {changedKeys.length
                    ? changedKeys.map((k) => k.replace(/_/g, " ")).join(", ")
                    : "No configuration changes"}
                </p>
                <details>
                  <summary>Review draft</summary>
                  {changedKeys.map((k) => (
                    <div className="agent-draft-field" key={k}>
                      <b>{k}</b>
                      {k === "instructions" ? (
                        <MarkdownAnswer
                          content={suggestion.after.instructions ?? ""}
                          onNavigate={(path) => navigate(() => onNavigate(path))}
                        />
                      ) : (
                        <pre>{JSON.stringify(suggestion.after[k], null, 2)}</pre>
                      )}
                    </div>
                  ))}
                </details>
                <div>
                  <Button
                    size="sm"
                    onClick={() => {
                      if (JSON.stringify(draft) !== JSON.stringify(suggestion.before)) {
                        setError(
                          "You edited the draft while this suggestion was prepared. Ask again to include those edits.",
                        );
                        return;
                      }
                      setDraft(suggestion.after);
                      setSuggestion(null);
                      setError("");
                    }}
                    disabled={!changedKeys.length}
                  >
                    Apply to draft
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setSuggestion(null)}>
                    Dismiss
                  </Button>
                </div>
                <small>Review in the editor, then save to activate.</small>
              </div>
            )}
            <div ref={end} />
          </div>
          <form
            className="agent-chat-composer"
            onSubmit={(e) => {
              e.preventDefault();
              void send(input);
            }}
          >
            <textarea
              aria-label="Message agent builder"
              placeholder="Ask a question or describe a change…"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  void send(input);
                }
              }}
              rows={3}
              maxLength={12000}
            />
            <div>
              <span>Changes stay in draft until saved</span>
              {busy ? (
                <button
                  type="button"
                  aria-label="Stop generating"
                  onClick={() => abort.current?.abort()}
                >
                  <Square size={14} />
                </button>
              ) : (
                <button type="submit" aria-label="Send to agent builder" disabled={!input.trim()}>
                  <ArrowUp size={17} />
                </button>
              )}
            </div>
          </form>
        </aside>
        <div className="agent-document">
          <nav className="agent-document-tabs" aria-label="Agent editor">
            <button
              role="tab"
              aria-selected={tab === "instructions"}
              onClick={() => setTab("instructions")}
            >
              <BookOpen size={15} /> Instructions
            </button>
            <button
              role="tab"
              aria-selected={tab === "settings"}
              onClick={() => setTab("settings")}
            >
              <Settings2 size={15} /> Settings
            </button>
          </nav>
          <div className="agent-document-scroll" data-page-scroll>
            {tab === "instructions" ? (
              <>
                <div className="agent-instruction-notice">
                  <BookOpen size={17} />
                  <span>This is your agent’s instruction page. Its content guides every run.</span>
                </div>
                <div className="agent-page-content">
                  <div className="agent-document-title">
                    <div className="agent-name-row">
                      <span className="agent-avatar">
                        <Bot size={25} />
                      </span>
                      <input
                        aria-label="Agent name"
                        value={draft.name}
                        maxLength={80}
                        placeholder="Name your agent"
                        onChange={(e) => patch({ name: e.target.value })}
                      />
                    </div>
                    <input
                      aria-label="Agent description"
                      value={draft.description ?? ""}
                      maxLength={300}
                      placeholder="Add a short description…"
                      onChange={(e) => patch({ description: e.target.value })}
                    />
                  </div>
                  <AgentInstructionsEditor
                    value={draft.instructions ?? ""}
                    onChange={(instructions) => patch({ instructions })}
                    tree={tree}
                    onNavigate={(path) => navigate(() => onNavigate(path))}
                  />
                </div>
              </>
            ) : (
              <AgentSettings draft={draft} onChange={patch} tree={tree} />
            )}
          </div>
        </div>
      </div>
      {error && (
        <div className="agent-workspace-error" role="alert">
          {error}
          <button onClick={() => setError("")}>Dismiss</button>
        </div>
      )}
    </section>
  );
}
