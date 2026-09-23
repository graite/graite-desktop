import { ChevronDown, Layers } from "lucide-react";
import type { ContextEntry } from "@/lib/ai";
import { Sources } from "./Sources";

/** Everything this conversation has gathered so far, shown once at the top of the thread. */
export function ContextBlock({
  context,
  onNavigate,
  highlight,
  changed,
}: {
  context: ContextEntry[];
  onNavigate: (path: string) => void;
  highlight?: number | null;
  changed?: Set<string>;
}) {
  if (!context.length) return null;
  const pages = new Set(context.filter((s) => s.page_path).map((s) => s.page_path));
  const label = pages.size
    ? `${pages.size} page${pages.size === 1 ? "" : "s"}`
    : `${context.length} source${context.length === 1 ? "" : "s"}`;
  return (
    <details className="ai-context" aria-label="Conversation context">
      <summary>
        <Layers size={12} /> Using {label}
        <ChevronDown size={12} className="ai-context-caret" aria-hidden="true" />
      </summary>
      <Sources
        sources={context}
        onNavigate={onNavigate}
        highlight={highlight}
        changed={changed}
        label="none"
        stale={new Set(context.filter((s) => s.stale).map((s) => s.n))}
      />
    </details>
  );
}
