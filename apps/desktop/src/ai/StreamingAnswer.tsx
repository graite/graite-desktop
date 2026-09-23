import { Orbit } from "lucide-react";
import { MarkdownAnswer } from "@/chat/MarkdownAnswer";
import { splitThinking } from "@/chat/thinking";
import type { ActivityStep, Source } from "@/lib/ai";
import type { Proposal, ReviewActions } from "@/lib/review";
import { ChatProposals } from "./ChatProposals";
import { Sources } from "./Sources";
import { LiveStep, TaskProgress, lastLines } from "./TaskProgress";
import { TOOL_LABELS } from "./useChatStream";

/** The assistant bubble while an answer streams, shared by the Studio and the page panel. */
export function StreamingAnswer({
  stream,
  thinking,
  activity = [],
  status,
  newSources,
  onNavigate,
  proposals = [],
  actions,
}: {
  stream: string;
  thinking: string;
  activity?: ActivityStep[];
  status: string;
  /** Sources gathered for this turn that were not in the conversation's context before. */
  newSources: Source[];
  onNavigate: (path: string) => void;
  proposals?: Proposal[];
  actions?: ReviewActions;
}) {
  const parts = splitThinking(stream);
  const live = liveStep(activity, thinking + parts.thinking, parts.answer, status);
  return (
    <div className="ai-message assistant">
      <div className="ai-message-author">
        <Orbit size={12} /> Graite
      </div>
      <TaskProgress steps={activity} hideRunning />
      <LiveStep text={live} />
      <div className="ai-prose markdown">
        <MarkdownAnswer content={parts.answer} onNavigate={onNavigate} />
      </div>
      {actions && <ChatProposals proposals={proposals} actions={actions} onNavigate={onNavigate} />}
      <Sources sources={newSources} onNavigate={onNavigate} label="new" />
    </div>
  );
}

/**
 * The one line that says what is happening now: a running tool and what it works on, else the
 * tail of the thought still streaming, else the pipeline's status until the answer starts.
 */
function liveStep(
  activity: ActivityStep[],
  thinking: string,
  answer: string,
  status: string,
): string {
  const running = [...activity].reverse().find((s) => s.kind === "tool" && s.status === "running");
  if (running) {
    const label = TOOL_LABELS[running.name] ?? running.name;
    return running.text ? `${label} · ${running.text}` : `${label}…`;
  }
  // A finished thought is already listed as "Thought" once its round ends.
  const thought = thinking.trim();
  const finished = activity.some((s) => s.kind === "thinking" && s.text.trim() === thought);
  if (thought && !finished && !answer.trim()) return lastLines(thought);
  return status;
}
