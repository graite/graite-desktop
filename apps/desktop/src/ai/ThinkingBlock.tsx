/** The model's reasoning, collapsed above the answer it led to. */
export function ThinkingBlock({
  text,
  streaming = false,
  label,
  className = "ai-thinking",
}: {
  text: string;
  streaming?: boolean;
  /** The summary line; defaults to "Thinking" (or "Thinking…" while streaming). */
  label?: string;
  className?: string;
}) {
  if (!text.trim()) return null;
  return (
    <details className={className}>
      <summary>{label ?? (streaming ? "Thinking…" : "Thinking")}</summary>
      <div>{text}</div>
    </details>
  );
}
