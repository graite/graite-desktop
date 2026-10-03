import { useRef, useState } from "react";
import { ArrowUp, Loader2, Sparkles } from "lucide-react";
import { charts, type ChartSpec } from "@/lib/charts";

/**
 * Describe a chart (or a change to one) in words: the page's model answers with a chart spec,
 * checked against the data, which the block applies as the user's own edit (D73).
 */
export function ChartAI({
  pagePath,
  current,
  onResult,
  placeholder,
  autoFocus,
  onBusy,
  ideas = [],
}: {
  pagePath: string;
  /** The chart as it is, when asking for a change. */
  current?: ChartSpec;
  onResult: (spec: ChartSpec, message: string) => void;
  placeholder: string;
  autoFocus?: boolean;
  onBusy?: (busy: boolean) => void;
  /** Example requests shown under the bar; a click sends one. */
  ideas?: string[];
}) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const abort = useRef<AbortController | null>(null);

  const ask = async (prompt: string) => {
    if (!prompt.trim() || busy) return;
    abort.current?.abort();
    const controller = new AbortController();
    abort.current = controller;
    setBusy(true);
    onBusy?.(true);
    setError("");
    try {
      const { spec, message } = await charts.ai(
        pagePath,
        prompt.trim(),
        current,
        controller.signal,
      );
      setText("");
      onResult(spec, message);
    } catch (e) {
      if (!controller.signal.aborted) setError((e as Error).message);
    } finally {
      setBusy(false);
      onBusy?.(false);
    }
  };

  const needsModel = /Settings/.test(error);
  return (
    <div className="chart-ai">
      <form
        className={`chart-ai-bar${busy ? " busy" : ""}`}
        onSubmit={(e) => {
          e.preventDefault();
          void ask(text);
        }}
      >
        {busy ? <Loader2 size={16} className="chart-ai-spin" /> : <Sparkles size={16} />}
        <input
          autoFocus={autoFocus}
          value={text}
          disabled={busy}
          placeholder={busy ? "Thinking…" : placeholder}
          aria-label="Describe a chart"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape" && busy) abort.current?.abort();
          }}
        />
        <button type="submit" aria-label="Make the chart" disabled={busy || !text.trim()}>
          <ArrowUp size={15} />
        </button>
      </form>
      {ideas.length > 0 && !busy && (
        <div className="chart-ai-ideas">
          {ideas.map((idea) => (
            <button key={idea} type="button" onClick={() => void ask(idea)}>
              {idea}
            </button>
          ))}
        </div>
      )}
      {error && (
        <p className="chart-ai-error" role="alert">
          {error}
          {needsModel && (
            <button
              type="button"
              onClick={() => window.dispatchEvent(new CustomEvent("graite:open-settings"))}
            >
              Set up a model
            </button>
          )}
        </p>
      )}
    </div>
  );
}
