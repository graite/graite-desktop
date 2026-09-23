const KEY_LABELS: Record<string, string> = {
  instructions: "instructions",
  autonomy: "permission",
  auto_apply_kinds: "auto-apply kinds",
  cloud: "cloud",
  skills: "skills",
  model: "model",
};

export interface Layer {
  source: string;
  values: Record<string, unknown>;
}

function describe(source: string, page: string): string {
  if (source === "vault") return "Vault settings";
  if (source === "default") return "Defaults";
  if (source === page) return "This page";
  return source;
}

/** Where every effective value comes from, root first, ending with this page. */
export function CascadeStack({
  layers,
  page,
  pending,
}: {
  layers: Layer[];
  page: string;
  /** Keys this page will set once saved (unsaved edits included). */
  pending: string[];
}) {
  const rows = layers.filter((l) => l.source !== page);
  return (
    <details className="ai-cascade">
      <summary>
        Where these settings come from ({rows.length + (pending.length ? 1 : 0)}{" "}
        {rows.length + (pending.length ? 1 : 0) === 1 ? "layer" : "layers"})
      </summary>
      <ol>
        {rows.map((layer) => (
          <li key={layer.source}>
            <span className="ai-cascade-source">{describe(layer.source, page)}</span>
            <span className="ai-cascade-keys">
              {Object.keys(layer.values).map((key) => (
                <span key={key}>{KEY_LABELS[key] ?? key}</span>
              ))}
            </span>
          </li>
        ))}
        <li data-current>
          <span className="ai-cascade-source">This page</span>
          <span className="ai-cascade-keys">
            {pending.length ? (
              pending.map((key) => <span key={key}>{KEY_LABELS[key] ?? key}</span>)
            ) : (
              <em>inherits everything</em>
            )}
          </span>
        </li>
      </ol>
    </details>
  );
}
