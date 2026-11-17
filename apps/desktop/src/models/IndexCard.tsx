import { useEffect, useState } from "react";
import { Database, RefreshCw } from "lucide-react";
import { ai, type AIConfig, type IndexStatus } from "@/lib/ai";
import { onDaemonEvent, request } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { ModelSelect } from "./ModelSelect";
import type { components } from "@graite/api-types";

type Model = components["schemas"]["CatalogModel"];

/** Search index state plus the embedding model that powers it. */
export function IndexCard({
  config,
  onPatch,
  disabled,
}: {
  config: AIConfig;
  onPatch: (value: Partial<AIConfig>) => void;
  disabled: boolean;
}) {
  const [status, setStatus] = useState<IndexStatus | null>(null);
  const [installed, setInstalled] = useState<Model[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    void ai
      .indexStatus()
      .then((s) => live && setStatus(s))
      .catch((e: Error) => live && setError(e.message));
    void request<Model[]>("/api/v1/ai/catalog")
      .then(
        (m) =>
          live && setInstalled(m.filter((x) => x.role === "embedding" && x.status === "installed")),
      )
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);

  useEffect(
    () =>
      onDaemonEvent((event) => {
        if (event.type === "index_progress") setStatus(event.data as unknown as IndexStatus);
      }),
    [],
  );

  const pending = status?.pending_chunks ?? 0;
  const state = !status
    ? "Loading…"
    : !status.embedding_model
      ? "Keyword search only — download a search model to enable meaning-based search."
      : pending
        ? `Indexing ${pending} of ${status.chunks} sections…`
        : `${status.chunks} sections from ${status.pages} pages are searchable.`;

  return (
    <section className="ai-index-card" aria-label="Search index">
      <div className="ai-section-heading">
        <h2>
          <Database size={14} /> Search index
        </h2>
        <span>{status?.worker === "indexing" ? "Working" : "Idle"}</span>
      </div>
      <p className="ai-library-intro">
        Graite indexes your pages locally so chat can cite the passages it used. Indexing runs in
        the background and yields to your questions.
      </p>
      <label className="ai-field">
        Search model
        <ModelSelect
          label="Search model"
          value={config.embedding_model_id || (installed[0]?.id ?? "")}
          disabled={disabled || !installed.length}
          onValueChange={(value) => onPatch({ embedding_model_id: value })}
        >
          {installed.length ? (
            installed.map((model) => (
              <option key={model.id} value={model.id}>
                {model.name}
              </option>
            ))
          ) : (
            <option value="">No search model installed</option>
          )}
        </ModelSelect>
        <small>{state}</small>
      </label>
      {status && (
        <dl className="ai-index-facts" aria-label="Index status">
          <div>
            <dt>Pages indexed</dt>
            <dd>{status.pages.toLocaleString("en-US")}</dd>
          </div>
          <div>
            <dt>Page summaries</dt>
            <dd>
              {(status.summaries ?? 0).toLocaleString("en-US")} of{" "}
              {(status.summary_pages ?? 0).toLocaleString("en-US")}
              {(status.summaries ?? 0) < (status.summary_pages ?? 0)
                ? " · written by your local model while it is loaded"
                : ""}
            </dd>
          </div>
          <div>
            <dt>Last update</dt>
            <dd>{status.updated_at ? new Date(status.updated_at).toLocaleString() : "Never"}</dd>
          </div>
        </dl>
      )}
      <label className="ai-field">
        Context per answer
        <ModelSelect
          label="Context per answer"
          value={config.context_budget_tokens ?? 3000}
          disabled={disabled}
          onValueChange={(value) => onPatch({ context_budget_tokens: Number(value) })}
        >
          {[1500, 3000, 6000, 12000, 24000].map((n) => (
            <option key={n} value={n}>
              {n.toLocaleString("en-US")} tokens{n === 3000 ? " (recommended)" : ""}
            </option>
          ))}
        </ModelSelect>
        <small>
          The most text from your pages that one answer may put in front of the model. Smaller is
          faster on a local model; Deep research may use twice this.
        </small>
      </label>
      {status?.failed_pages ? (
        <p className="ai-index-warning">
          {status.failed_pages} page{status.failed_pages === 1 ? "" : "s"} could not be read.
        </p>
      ) : null}
      {error && <p className="ai-index-warning">{error}</p>}
      <div className="ai-actions">
        <Button
          variant="outline"
          size="sm"
          disabled={busy || disabled}
          onClick={() => {
            setBusy(true);
            setError("");
            void ai
              .rebuildIndex()
              .catch((e: Error) => setError(e.message))
              .finally(() => setBusy(false));
          }}
        >
          <RefreshCw size={13} /> {busy ? "Starting…" : "Rebuild index"}
        </Button>
      </div>
    </section>
  );
}
