import { useState } from "react";
import { Check, Copy, FilePlus2, Orbit } from "lucide-react";
import { MarkdownAnswer } from "@/chat/MarkdownAnswer";
import type { ChatMessage, Source } from "@/lib/ai";
import type { Proposal, ReviewActions } from "@/lib/review";
import { ChatProposals } from "./ChatProposals";
import { LimitsCallout, Sources } from "./Sources";
import { ThinkingBlock } from "./ThinkingBlock";
import { TaskProgress } from "./TaskProgress";

function Attachments({ message }: { message: ChatMessage }) {
  if (!message.attachments?.length && !message.selection) return null;
  return (
    <div className="ai-message-extras">
      {message.attachments?.map((a) => (
        <span key={a.id}>{a.name}</span>
      ))}
      {message.selection && <span>Selection from {message.selection.page_path}</span>}
    </div>
  );
}

/** Scroll the context block's card for a citation into view and flash it. */
export function flashSource(n: number) {
  const card = document.getElementById(`source-${n}`);
  if (!card) return;
  const details = card.closest("details");
  if (details && !details.open) details.open = true;
  card.scrollIntoView?.({ block: "nearest" });
  card.setAttribute("data-highlight", "true");
  setTimeout(() => card.removeAttribute("data-highlight"), 1500);
}

function UserMessage({ message }: { message: ChatMessage }) {
  return (
    <div className="ai-message user">
      <div className="ai-prose">{message.content}</div>
      <Attachments message={message} />
    </div>
  );
}

function AssistantMessage({
  message,
  onNavigate,
  onTurnIntoPage,
  changed,
  proposals,
  actions,
}: {
  message: ChatMessage;
  onNavigate: (path: string) => void;
  onTurnIntoPage?: (message: ChatMessage) => void;
  changed?: Set<string>;
  proposals?: Map<string, Proposal>;
  actions?: ReviewActions;
}) {
  const [copied, setCopied] = useState(false);
  const [highlight, setHighlight] = useState<number | null>(null);
  const sources = (message.sources ?? []) as unknown as Source[];
  const cards = (message.proposals ?? []).flatMap((id) => {
    const proposal = proposals?.get(id);
    return proposal ? [proposal] : [];
  });
  return (
    <div className="ai-message assistant">
      <div className="ai-message-author">
        <Orbit size={12} /> Graite
      </div>
      {message.activity?.length ? (
        <TaskProgress steps={message.activity} />
      ) : (
        <ThinkingBlock text={message.thinking ?? ""} />
      )}
      <div className="ai-prose markdown">
        <MarkdownAnswer
          content={message.content}
          onNavigate={onNavigate}
          onCite={(n) => {
            // The answer's own sources open to the card; the context block flashes its copy.
            setHighlight(n);
            setTimeout(() => setHighlight((h) => (h === n ? null : h)), 1500);
            if (message.context) flashSource(n);
          }}
        />
      </div>
      {message.interrupted && <small className="text-muted-foreground">Response stopped</small>}
      {message.cut_short && <small className="text-muted-foreground">You interrupted here</small>}
      {actions && <ChatProposals proposals={cards} actions={actions} onNavigate={onNavigate} />}
      <Sources
        sources={sources}
        onNavigate={onNavigate}
        highlight={highlight}
        changed={changed}
        label={message.context ? "new" : "all"}
      />
      <LimitsCallout items={message.limits ?? []} excluded={[]} />
      <div className="ai-message-actions">
        <button
          type="button"
          onClick={() => {
            void navigator.clipboard?.writeText(message.content);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          }}
        >
          {copied ? <Check size={11} /> : <Copy size={11} />} {copied ? "Copied" : "Copy"}
        </button>
        {onTurnIntoPage && (
          <button type="button" onClick={() => onTurnIntoPage(message)}>
            <FilePlus2 size={11} /> Turn into page
          </button>
        )}
      </div>
    </div>
  );
}

export function MessageList({
  messages,
  onNavigate,
  onTurnIntoPage,
  changed,
  proposals,
  actions,
}: {
  messages: ChatMessage[];
  onNavigate: (path: string) => void;
  onTurnIntoPage?: (message: ChatMessage) => void;
  changed?: Set<string>;
  /** Proposals of this conversation by id, so answers can show their cards. */
  proposals?: Map<string, Proposal>;
  actions?: ReviewActions;
}) {
  return (
    <>
      {messages.map((message, index) =>
        message.role === "user" ? (
          <UserMessage key={index} message={message} />
        ) : (
          <AssistantMessage
            key={index}
            message={message}
            onNavigate={onNavigate}
            onTurnIntoPage={onTurnIntoPage}
            changed={changed}
            proposals={proposals}
            actions={actions}
          />
        ),
      )}
    </>
  );
}
