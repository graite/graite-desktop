import { useState } from "react";
import {
  Activity,
  Bot,
  CalendarClock,
  Orbit,
  ChevronDown,
  ChevronRight,
  ClipboardCheck,
  MessageSquare,
  Plus,
  Search,
  Trash2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import type { Conversation } from "@/lib/ai";

export type Section = "chat" | "assistant" | "agents" | "review" | "schedules" | "runs";
export function ConversationList({
  conversations,
  selectedId,
  busy,
  onSelect,
  onNew,
  onDelete,
  section = "chat",
  onSection,
  pendingReviews = 0,
  assistantName,
}: {
  conversations: Conversation[];
  selectedId: string | null;
  busy: boolean;
  onSelect: (conversation: Conversation) => void;
  onNew: () => void;
  onDelete: (conversation: Conversation) => void;
  section?: Section;
  onSection?: (section: Section) => void;
  /** Proposals awaiting a decision, shown next to the Review entry. */
  pendingReviews?: number;
  /** The personal assistant's name; its Studio entry is titled with it. */
  assistantName?: string;
}) {
  const [query, setQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [expanded, setExpanded] = useState(true);
  const sorted = [...conversations].sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  const needle = query.trim().toLocaleLowerCase();
  const shown = sorted.filter((c) =>
    [c.title, ...c.messages.map((m) => m.content)].some((text) =>
      text.toLocaleLowerCase().includes(needle),
    ),
  );
  const open = (c: Conversation) => {
    onSelect(c);
    setSearchOpen(false);
  };
  return (
    <aside className="ai-page-rail" aria-label="Conversations">
      <button className="ai-rail-nav" disabled={busy} onClick={onNew}>
        <Plus size={16} />
        New chat
      </button>
      <div className="ai-rail-spaces">
        <button
          className="ai-rail-nav"
          data-active={section === "assistant" || undefined}
          onClick={() => onSection?.("assistant")}
        >
          <Orbit size={16} />
          <span className="truncate">{assistantName || "Assistant"}</span>
        </button>
        <button
          className="ai-rail-nav"
          data-active={section === "agents" || undefined}
          onClick={() => onSection?.("agents")}
        >
          <Bot size={16} />
          Agents
        </button>
        <button
          className="ai-rail-nav"
          data-active={section === "review" || undefined}
          onClick={() => onSection?.("review")}
        >
          <ClipboardCheck size={16} />
          Review{pendingReviews > 0 && <span className="ai-rail-count">{pendingReviews}</span>}
        </button>
        <button
          className="ai-rail-nav"
          data-active={section === "schedules" || undefined}
          onClick={() => onSection?.("schedules")}
        >
          <CalendarClock size={16} />
          Schedules
        </button>
        <button
          className="ai-rail-nav"
          data-active={section === "runs" || undefined}
          onClick={() => onSection?.("runs")}
        >
          <Activity size={16} />
          Runs
        </button>
      </div>
      <div className="ai-rail-head">
        <button
          className="ai-chats-toggle"
          aria-expanded={expanded}
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}Chats
        </button>
        <Button
          variant="ghost"
          size="icon"
          className="size-7"
          title="Search chat history"
          aria-label="Search chat history"
          onClick={() => {
            setQuery("");
            setSearchOpen(true);
          }}
        >
          <Search size={14} />
        </Button>
      </div>
      {expanded && (
        <div className="ai-rail-list">
          {!sorted.length && <p className="ai-rail-empty">Your conversations will appear here.</p>}
          {sorted.map((c) => (
            <div
              key={c.id}
              className="ai-rail-item"
              data-active={(section === "chat" && c.id === selectedId) || undefined}
            >
              <button
                className="ai-rail-open"
                title={c.title}
                onClick={() => open(c)}
                disabled={busy}
              >
                <MessageSquare size={14} />
                <span>{c.title}</span>
              </button>
              <button
                className="ai-rail-delete"
                aria-label={`Delete ${c.title}`}
                disabled={busy}
                onClick={() => onDelete(c)}
              >
                <Trash2 size={13} />
              </button>
            </div>
          ))}
        </div>
      )}
      <Dialog open={searchOpen} onOpenChange={setSearchOpen}>
        <DialogContent className="ai-history-dialog">
          <DialogHeader>
            <DialogTitle>Chat history</DialogTitle>
          </DialogHeader>
          <label className="ai-history-search">
            <Search size={18} />
            <input
              autoFocus
              aria-label="Search chats"
              placeholder="Search titles and messages…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </label>
          <div className="ai-history-results">
            {shown.length === 0 && (
              <p className="ai-rail-empty">
                {needle ? "No chats match your search." : "No chats yet."}
              </p>
            )}
            {shown.map((c) => (
              <button
                key={c.id}
                className="ai-history-result"
                disabled={busy}
                onClick={() => open(c)}
              >
                <MessageSquare size={16} />
                <span>
                  <strong>{c.title}</strong>
                  <small>
                    {c.messages.find((m) => m.content.toLocaleLowerCase().includes(needle))
                      ?.content || "New conversation"}
                  </small>
                </span>
              </button>
            ))}
          </div>
        </DialogContent>
      </Dialog>
    </aside>
  );
}
