import { useState } from "react";
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

/** "Read 2×" for repeated tools, or the one step's label and what it worked on. */
export function summarize(steps: ActivityStep[]): string {
  const groups = new Map<string, ActivityStep[]>();
  for (const step of steps) {
    if (step.kind !== "tool") continue;
    groups.set(step.name, [...(groups.get(step.name) ?? []), step]);
  }
  const parts = [...groups.entries()].map(([name, group]) => {
    const label = TOOL_DONE_LABELS[name] ?? name;
    if (group.length > 1) return `${label} ${group.length}×`;
    // A failed step's text is its error, which the expanded list shows.
    return group[0].text && group[0].status !== "failed" ? `${label} ${group[0].text}` : label;
  });
  if (!parts.length && steps.some((s) => s.kind === "thinking")) return "Thought";
  return parts.join(" · ");
}

/**
 * Every step of a turn on one line ("✓ Read 2× · Read tables · Queried tables ›"), with what
 * is happening now at its end while the answer streams. Clicking it lists each step, and a
 * thought opens to its full text. Running tools are left to the live text, so a step never
 * shows twice.
 */
export function TaskProgress({
  steps,
  hideRunning = false,
  live = "",
}: {
  steps: ActivityStep[];
  hideRunning?: boolean;
  /** What the model is doing right now; shown at the end of the line. */
  live?: string;
}) {
  const [open, setOpen] = useState(false);
  const shown = [...steps]
    .sort((a, b) => a.round - b.round)
    .filter((step) => !(hideRunning && step.status === "running"));
  if (!shown.length) return <LiveStep text={live} />;
  const failed = shown.filter((s) => s.status === "failed").length;
  const summary = summarize(shown);
  return (
    <div className="ai-task-progress" aria-label="Task progress">
      <button
        type="button"
        className="ai-step ai-task-summary"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        title={summary}
      >
        <span aria-hidden="true" className="ai-step-mark">
          {live ? <Loader2 size={11} className="ai-spin" /> : "✓"}
        </span>
        <span className="ai-task-summary-text">
          {summary}
          {live && (
            <>
              {" · "}
              <span role="status" aria-live="polite">
                <span className="ai-shimmer">{live}</span>
              </span>
            </>
          )}
        </span>
        {failed > 0 && <span className="ai-task-failed">! {failed} failed</span>}
        <span aria-hidden="true" className="ai-task-chevron">
          ›
        </span>
      </button>
      {open && (
        <div className="ai-task-steps">
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
                  {(step.status === "running"
                    ? TOOL_LABELS[step.name]
                    : TOOL_DONE_LABELS[step.name]) ?? step.name}
                </span>
                {step.text && <small>{step.text}</small>}
              </div>
            ),
          )}
        </div>
      )}
    </div>
  );
}
