import { Loader2 } from "lucide-react";
import type { ActivityStep } from "@/lib/ai";
import { TOOL_DONE_LABELS, TOOL_LABELS } from "./useChatStream";
import { ThinkingBlock } from "./ThinkingBlock";

/** The last couple of lines of a running thought, on one line of plain text. */
export function lastLines(text: string, lines = 2): string {
  const kept = text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(-lines);
  return kept.join(" ").replace(/\s+/g, " ").trim();
}

/** What the model is doing right now, shown inline under the author line while it streams. */
export function LiveStep({ text }: { text: string }) {
  if (!text) return null;
  return (
    <div className="ai-live-step" role="status" aria-live="polite">
      <Loader2 size={12} className="ai-spin" aria-hidden="true" />
      <span className="ai-shimmer">{text}</span>
    </div>
  );
}

/**
 * Finished steps as compact one-liners: "Thought" (click to read it), "Read · Projects/Atlas".
 * Running tools are left to the live line, so a step never shows twice.
 */
export function TaskProgress({
  steps,
  hideRunning = false,
}: {
  steps: ActivityStep[];
  hideRunning?: boolean;
}) {
  const shown = [...steps]
    .sort((a, b) => a.round - b.round)
    .filter((step) => !(hideRunning && step.status === "running"));
  if (!shown.length) return null;
  return (
    <div className="ai-task-progress" aria-label="Task progress">
      {shown.map((step) =>
        step.kind === "thinking" ? (
          <ThinkingBlock
            key={step.id}
            text={step.text}
            label="Thought"
            className="ai-thinking ai-step"
          />
        ) : (
          <div
            key={step.id}
            className="ai-step ai-task-tool"
            data-status={step.status}
            title={step.text || undefined}
          >
            <span aria-hidden="true" className="ai-step-mark">
              {step.status === "running"
                ? "◌"
                : step.status === "failed"
                  ? "!"
                  : step.status === "cancelled"
                    ? "–"
                    : "✓"}
            </span>
            <span className="ai-step-label">
              {(step.status === "running" ? TOOL_LABELS[step.name] : TOOL_DONE_LABELS[step.name]) ??
                step.name}
            </span>
            {step.text && <small>{step.text}</small>}
          </div>
        ),
      )}
    </div>
  );
}
