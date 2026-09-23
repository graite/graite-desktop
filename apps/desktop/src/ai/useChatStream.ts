import { useCallback, useEffect, useRef, useState } from "react";
import type { Proposal } from "@/lib/review";
import {
  ai,
  sendMessage,
  type AIEvent,
  type ActivityStep,
  type ChatMessage,
  type ChatMode,
  type ContextEntry,
  type Conversation,
  type Limits,
  type Source,
} from "@/lib/ai";

export const TOOL_LABELS: Record<string, string> = {
  search_vault: "Searching your pages",
  list_children: "Finding subpages",
  read_page: "Reading a page",
  load_skill: "Loading a skill",
  propose_create: "Creating a page",
  propose_edit: "Editing a page",
  propose_append: "Adding content",
  propose_properties: "Setting card properties",
  propose_move: "Moving a page",
  propose_delete: "Removing a page",
  list_proposals: "Checking changes",
  request_clarification: "Asking for clarification",
  schedule: "Scheduling work",
};

/** The same tools once a step has finished, for the compact list of completed steps. */
export const TOOL_DONE_LABELS: Record<string, string> = {
  search_vault: "Searched your pages",
  list_children: "Listed subpages",
  read_page: "Read",
  load_skill: "Loaded a skill",
  propose_create: "Proposed a page",
  propose_edit: "Proposed an edit",
  propose_append: "Proposed an addition",
  propose_properties: "Proposed card properties",
  propose_move: "Proposed a move",
  propose_delete: "Proposed a removal",
  list_proposals: "Checked changes",
  request_clarification: "Asked for clarification",
  schedule: "Scheduled work",
};

export interface SendOptions {
  mode?: ChatMode;
  attachments?: string[];
  selection?: { page_path: string; text: string };
  pagePath?: string;
}

function asContext(sources: Source[], previous: ContextEntry[], turn: number): ContextEntry[] {
  const known = new Map(previous.map((c) => [c.n, c]));
  return sources.map(
    (s) => known.get(s.n) ?? { ...s, added_turn: turn, last_cited_turn: 0, stale: false },
  );
}

/** Streaming state for one conversation, shared by the Graite AI page and the page panel. */
export function useChatStream(options: {
  conversation: Conversation | null;
  ensureConversation: () => Promise<Conversation>;
  onConversationSaved?: (conversation: Conversation) => void;
}) {
  const { conversation, ensureConversation, onConversationSaved } = options;
  const [messages, setMessages] = useState<ChatMessage[]>(conversation?.messages ?? []);
  const [stream, setStream] = useState("");
  const [thinking, setThinking] = useState("");
  const [activity, setActivity] = useState<ActivityStep[]>([]);
  const [status, setStatus] = useState("");
  const [tools, setTools] = useState<string[]>([]);
  const [sources, setSources] = useState<Source[]>([]);
  /** The conversation's context set; grows as turns add sources, never renumbers. */
  const [context, setContext] = useState<ContextEntry[]>(conversation?.context ?? []);
  /** Numbers added in the running turn (shown under the streaming answer). */
  const [newNumbers, setNewNumbers] = useState<number[]>([]);
  const [limits, setLimits] = useState<Limits | null>(null);
  /** Proposals filed during the running turn, in order. */
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [clarify, setClarify] = useState<string | null>(null);
  const [instructions, setInstructions] = useState<string[]>([]);
  const [meta, setMeta] = useState<{ pages?: number; excluded_local_only?: string[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const abort = useRef<AbortController | null>(null);
  const activeId = useRef<string | null>(null);
  const savedRef = useRef(onConversationSaved);
  savedRef.current = onConversationSaved;

  const openId = conversation?.id ?? null;
  useEffect(() => {
    // A turn streaming into the open chat keeps its view; anything else starts clean.
    if (activeId.current !== null && activeId.current === openId) return;
    if (activeId.current) {
      // The user opened another chat while an answer was streaming: stop it on the daemon
      // too, so the model is free for the next question instead of finishing unseen work.
      const abandoned = activeId.current;
      activeId.current = null;
      void ai.cancel(abandoned).catch(() => {});
      abort.current?.abort();
      setBusy(false);
      setStatus("");
    }
    setMessages(conversation?.messages ?? []);
    setContext(conversation?.context ?? []);
    setNewNumbers([]);
    setSources([]);
    setLimits(null);
    setProposals([]);
    setClarify(null);
    setError("");
    setTools([]);
    setThinking("");
    setActivity([]);
    setStream("");
  }, [openId, conversation?.messages, conversation?.context]);

  useEffect(() => () => abort.current?.abort(), []);

  const reset = () => {
    setError("");
    setStream("");
    setThinking("");
    setActivity([]);
    setTools([]);
    setSources([]);
    setNewNumbers([]);
    setLimits(null);
    setProposals([]);
    setClarify(null);
    setStatus("Preparing…");
  };

  const handle = useCallback((event: AIEvent, id: string) => {
    if (activeId.current !== id) return; // a later turn (or another conversation) owns the view
    switch (event.type) {
      case "round_start":
        setThinking("");
        setStatus(event.round === 1 ? "Working…" : `Step ${event.round}: checking results…`);
        break;
      case "activity":
        setActivity((old) => [...old.filter((s) => s.id !== event.step.id), event.step]);
        break;
      case "token":
        setStream((s) => s + event.text);
        setStatus("");
        break;
      case "thinking":
        setThinking((s) => s + event.text);
        break;
      case "reset":
        setThinking("");
        setStream("");
        break;
      case "answer":
        setStream(event.text);
        break;
      case "status":
        setStatus(event.text);
        break;
      case "meta":
        setInstructions(event.instructions ?? []);
        setMeta({ pages: event.pages, excluded_local_only: event.excluded_local_only });
        break;
      case "sources":
        setSources(event.sources);
        setNewNumbers(event.new ?? event.sources.map((s) => s.n));
        setContext((old) => asContext(event.sources, old, old.length ? 2 : 1));
        break;
      case "limits":
        setLimits({
          items: event.items,
          excluded_local_only: event.excluded_local_only,
          pending_chunks: event.pending_chunks,
        });
        break;
      case "clarify":
        setClarify(event.question);
        break;
      case "proposal":
        setProposals((old) => [...old.filter((p) => p.id !== event.proposal.id), event.proposal]);
        break;
      case "tool_start": {
        const label = TOOL_LABELS[event.name] ?? "Working";
        setStatus(label);
        setTools((old) => [...old, label]);
        break;
      }
      default:
        break;
    }
  }, []);

  const send = useCallback(
    async (text: string, opts: SendOptions = {}) => {
      if (busy || !text.trim()) return null;
      setBusy(true);
      reset();
      const controller = new AbortController();
      abort.current = controller;
      let current: Conversation | null = null;
      try {
        current = conversation ?? (await ensureConversation());
        activeId.current = current.id;
        const user: ChatMessage = {
          role: "user",
          content: text,
          interrupted: false,
          mode: opts.mode,
          selection: opts.selection,
        };
        setMessages((old) => [...old, user]);
        const id = current.id;
        await sendMessage(
          id,
          {
            message: text,
            mode: opts.mode,
            attachments: opts.attachments,
            selection: opts.selection,
            page_path: opts.pagePath,
          },
          controller.signal,
          (event) => handle(event, id),
        );
      } catch (e) {
        const error = e as Error;
        const stopped =
          error.name === "AbortError" || /ended before the answer/.test(error.message);
        if (!stopped && activeId.current === current?.id) setError(error.message);
      } finally {
        const owned = current !== null && activeId.current === current.id;
        if (current) {
          try {
            const saved = await ai.conversation(current.id);
            // Only refresh the view if this turn's conversation is still the open one.
            if (owned) {
              setMessages(saved.messages);
              setContext(saved.context ?? []);
              savedRef.current?.(saved);
            }
          } catch {
            /* The visible error remains; the next open reloads persisted history. */
          }
        }
        if (owned) {
          setStream("");
          setBusy(false);
          setStatus("");
          activeId.current = null;
        }
        abort.current = null;
      }
      return current;
    },
    [busy, conversation, ensureConversation, handle],
  );

  const stop = useCallback(async () => {
    const id = activeId.current;
    if (id) await ai.cancel(id).catch(() => {});
    abort.current?.abort();
  }, []);

  return {
    messages,
    setMessages,
    stream,
    thinking,
    activity,
    status,
    tools,
    sources,
    context,
    /** Sources new in the running turn, in number order. */
    newSources: sources.filter((s) => newNumbers.includes(s.n)),
    limits,
    proposals,
    clarify,
    instructions,
    meta,
    busy,
    error,
    setError,
    send,
    stop,
  };
}
