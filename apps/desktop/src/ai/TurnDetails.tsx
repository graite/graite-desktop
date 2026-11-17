/** What one answer cost (the daemon's `TurnMetrics`), as one line that opens into the rest. */
export interface TurnMetrics {
  retrieval_ms: number;
  pages: number;
  chunks: number;
  context_tokens: number;
  prompt_tokens: number;
  completion_tokens: number;
  cached_tokens: number;
  prompt_ms?: number | null;
  first_token_ms: number | null;
  total_ms: number;
  tokens_per_second: number | null;
  model_calls: number;
  tool_calls: number;
  searches: { query: string; hits: number; ms: number }[];
}

const count = (n: number) => n.toLocaleString("en-US");
const plural = (n: number, word: string) => `${count(n)} ${word}${n === 1 ? "" : "s"}`;

/** "120 ms" under a second, "1.2 s" above. */
export function duration(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`;
}

/** The collapsed line: the three numbers that say whether a turn was fast and lean. */
export function summary(m: TurnMetrics): string {
  return [
    m.first_token_ms !== null ? `${duration(m.first_token_ms)} to first word` : "",
    m.tokens_per_second ? `${m.tokens_per_second.toFixed(0)} tokens/s` : "",
    `${count(m.context_tokens)} context tokens`,
    m.pages ? plural(m.pages, "page") : "",
  ]
    .filter(Boolean)
    .join(" · ");
}

export function TurnDetails({ metrics }: { metrics: unknown }) {
  const m = metrics as TurnMetrics | null | undefined;
  if (!m || typeof m.total_ms !== "number") return null;
  const rows: [string, string][] = [
    ["Finding context", duration(m.retrieval_ms)],
    [
      "Context given to the model",
      `about ${count(m.context_tokens)} tokens from ${plural(m.pages, "page")} (${plural(m.chunks, "passage")})`,
    ],
  ];
  if (m.prompt_tokens)
    rows.push([
      "Prompt",
      `${count(m.prompt_tokens)} tokens` +
        (m.cached_tokens ? `, ${count(m.cached_tokens)} reused from the last turn` : "") +
        (m.prompt_ms ? `, read in ${duration(m.prompt_ms)}` : ""),
    ]);
  if (m.first_token_ms !== null) rows.push(["First word after", duration(m.first_token_ms)]);
  if (m.completion_tokens)
    rows.push([
      "Answer",
      `${count(m.completion_tokens)} tokens` +
        (m.tokens_per_second ? ` at ${m.tokens_per_second.toFixed(1)} tokens/s` : ""),
    ]);
  rows.push(["Total", duration(m.total_ms)]);
  if (m.model_calls > 1 || m.tool_calls)
    rows.push([
      "Steps",
      `${plural(m.model_calls, "model call")}, ${plural(m.tool_calls, "tool call")}`,
    ]);
  return (
    <details className="ai-turn-details">
      <summary aria-label="Answer details">{summary(m)}</summary>
      <dl>
        {rows.map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
      {m.searches.length > 0 && (
        <ul aria-label="Searches">
          {m.searches.map((s, i) => (
            <li key={i}>
              Searched “{s.query}” · {plural(s.hits, "hit")} · {duration(s.ms)}
            </li>
          ))}
        </ul>
      )}
    </details>
  );
}
