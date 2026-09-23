import { useState } from "react";
import { Check, KeyRound, Pencil, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  connections as api,
  contextLabel,
  hostOf,
  KIND_LABELS,
  OPENROUTER_URL,
  type Connection,
  type ConnectionKind,
  type DiscoveredModel,
  type SavedModel,
} from "@/lib/connections";
import { ModelCombobox } from "./ModelCombobox";

const URL_PLACEHOLDER = "http://127.0.0.1:1234/v1";

/** A name to suggest for a server address: "OpenRouter", "LM Studio", "Ollama" or the host. */
function suggestName(url: string): string {
  const host = hostOf(url.trim());
  if (!host) return "";
  if (host.endsWith("openrouter.ai")) return "OpenRouter";
  if (/^(localhost|127\.0\.0\.1|\[?::1\]?)$/.test(host)) {
    const port = (() => {
      try {
        return new URL(url.trim()).port;
      } catch {
        return "";
      }
    })();
    return port === "11434" ? "Ollama" : port === "1234" ? "LM Studio" : "Local server";
  }
  return host.replace(/^api\./, "").replace(/^www\./, "");
}

function AddConnection({
  kind,
  onAdded,
  onError,
}: {
  kind: ConnectionKind;
  onAdded: (connection: Connection) => void;
  onError: (message: string) => void;
}) {
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const isServer = kind === "compatible";
  const suggested = isServer ? suggestName(url) : KIND_LABELS[kind];
  const submit = async () => {
    setBusy(true);
    try {
      const created = await api.add({
        name: name.trim() || suggested || KIND_LABELS[kind],
        kind,
        base_url: isServer ? url.trim() : undefined,
        api_key: key.trim() || undefined,
      });
      setName("");
      setUrl("");
      setKey("");
      onAdded(created);
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      className="ai-connection-add"
      aria-label={`Add ${KIND_LABELS[kind]} connection`}
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <div className="ai-field-row">
        {isServer && (
          <label className="ai-field">
            Server address <span className="ai-optional">include /v1</span>
            <input
              value={url}
              placeholder={URL_PLACEHOLDER}
              onChange={(e) => setUrl(e.target.value)}
              required
            />
          </label>
        )}
        <label className="ai-field">
          Name <span className="ai-optional">what you call it</span>
          <input
            value={name}
            placeholder={suggested || KIND_LABELS[kind]}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <label className="ai-field">
          API key {isServer && <span className="ai-optional">optional for local servers</span>}
          <input
            type="password"
            autoComplete="off"
            value={key}
            placeholder="Paste your API key"
            onChange={(e) => setKey(e.target.value)}
          />
        </label>
      </div>
      <div className="ai-connection-add-foot">
        <Button type="submit" variant="outline" disabled={busy}>
          Add connection
        </Button>
        {isServer && (
          <small>
            For OpenRouter use{" "}
            <button type="button" className="ai-source" onClick={() => setUrl(OPENROUTER_URL)}>
              {OPENROUTER_URL}
            </button>
            . For Ollama use http://127.0.0.1:11434/v1.
          </small>
        )}
      </div>
    </form>
  );
}

function KeyEditor({
  connection,
  onChanged,
  onError,
}: {
  connection: Connection;
  onChanged: () => void;
  onError: (message: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [key, setKey] = useState("");
  if (!editing) {
    return (
      <button type="button" className="ai-connection-key" onClick={() => setEditing(true)}>
        <KeyRound size={12} /> {connection.key_saved ? "Key saved · change" : "Add key"}
      </button>
    );
  }
  return (
    <form
      className="ai-connection-keyform"
      onSubmit={(e) => {
        e.preventDefault();
        void api
          .update(connection.id, key.trim() ? { api_key: key.trim() } : { clear_key: true })
          .then(() => {
            setEditing(false);
            setKey("");
            onChanged();
          })
          .catch((err: Error) => onError(err.message));
      }}
    >
      <input
        type="password"
        autoComplete="off"
        aria-label={`API key for ${connection.name}`}
        value={key}
        placeholder="Paste a new key, or leave empty to remove"
        onChange={(e) => setKey(e.target.value)}
      />
      <Button type="submit" size="sm">
        Save key
      </Button>
      <Button type="button" size="sm" variant="ghost" onClick={() => setEditing(false)}>
        Cancel
      </Button>
    </form>
  );
}

/** Rename a connection and, for a model server, change its address. */
function DetailsEditor({
  connection,
  onDone,
  onError,
}: {
  connection: Connection;
  onDone: () => void;
  onError: (message: string) => void;
}) {
  const [name, setName] = useState(connection.name);
  const [url, setUrl] = useState(connection.base_url);
  const [busy, setBusy] = useState(false);
  const isServer = connection.kind === "compatible";
  return (
    <form
      className="ai-connection-edit"
      aria-label={`Edit ${connection.name}`}
      onSubmit={(e) => {
        e.preventDefault();
        setBusy(true);
        void api
          .update(connection.id, {
            name: name.trim() || connection.name,
            ...(isServer && url.trim() !== connection.base_url ? { base_url: url.trim() } : {}),
          })
          .then(onDone)
          .catch((err: Error) => onError(err.message))
          .finally(() => setBusy(false));
      }}
    >
      <label className="ai-field">
        Name
        <input
          aria-label={`Name of ${connection.name}`}
          value={name}
          maxLength={80}
          onChange={(e) => setName(e.target.value)}
        />
      </label>
      {isServer && (
        <label className="ai-field">
          Server address <span className="ai-optional">include /v1</span>
          <input
            aria-label={`Server address of ${connection.name}`}
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            required
          />
        </label>
      )}
      <div>
        <Button type="submit" size="sm" disabled={busy}>
          Save
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

/** The connections of one kind, their saved models, and which one this vault uses. */
export function ConnectionsCard({
  kind,
  connections,
  models,
  activeModelId,
  onPick,
  onChanged,
  disabled,
}: {
  kind: ConnectionKind;
  connections: Connection[];
  models: SavedModel[];
  activeModelId: string | null;
  onPick: (model: SavedModel) => void;
  onChanged: () => void;
  disabled?: boolean;
}) {
  const [error, setError] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const mine = connections.filter((c) => c.kind === kind);
  return (
    <div className="ai-connections" aria-label={`${KIND_LABELS[kind]} connections`}>
      {error && (
        <p className="ai-error" role="alert">
          {error}
        </p>
      )}
      {mine.map((connection) => {
        const saved = models.filter((m) => m.connection_id === connection.id);
        const ids = new Set(saved.map((m) => m.model));
        const save = async (model: DiscoveredModel) => {
          try {
            await api.saveModel(connection.id, {
              model: model.id,
              label: model.name,
              context_length: model.context_length ?? null,
            });
            onChanged();
          } catch (e) {
            setError((e as Error).message);
          }
        };
        return (
          <section key={connection.id} className="ai-connection" aria-label={connection.name}>
            <header>
              <div>
                <strong>{connection.name}</strong>
                <small>{connection.base_url}</small>
              </div>
              <button
                type="button"
                className="ai-connection-key"
                aria-label={`Edit ${connection.name}`}
                disabled={disabled}
                onClick={() => setEditing((id) => (id === connection.id ? null : connection.id))}
              >
                <Pencil size={12} /> Edit
              </button>
              <KeyEditor connection={connection} onChanged={onChanged} onError={setError} />
              <button
                type="button"
                className="ai-connection-remove"
                aria-label={`Remove ${connection.name}`}
                disabled={disabled}
                onClick={() =>
                  void api
                    .remove(connection.id)
                    .then(onChanged)
                    .catch((e: Error) => setError(e.message))
                }
              >
                <Trash2 size={13} />
              </button>
            </header>
            {editing === connection.id && (
              <DetailsEditor
                connection={connection}
                onDone={() => {
                  setEditing(null);
                  onChanged();
                }}
                onError={setError}
              />
            )}
            <div className="ai-connection-models">
              {saved.length ? (
                <ul aria-label={`Saved models on ${connection.name}`}>
                  {saved.map((model) => {
                    const active = model.id === activeModelId;
                    return (
                      <li key={model.id} data-active={active || undefined}>
                        <button
                          type="button"
                          className="ai-saved-model"
                          aria-pressed={active}
                          disabled={disabled}
                          onClick={() => onPick(model)}
                        >
                          {active ? <Check size={13} /> : <span className="ai-saved-dot" />}
                          <span>
                            <strong>{model.label}</strong>
                            <small>
                              {model.model}
                              {model.context_length
                                ? ` · ${contextLabel(model.context_length)}`
                                : ""}
                            </small>
                          </span>
                        </button>
                        <button
                          type="button"
                          className="ai-saved-remove"
                          aria-label={`Remove ${model.label}`}
                          disabled={disabled || active}
                          onClick={() =>
                            void api
                              .removeModel(model.id)
                              .then(onChanged)
                              .catch((e: Error) => setError(e.message))
                          }
                        >
                          <X size={12} />
                        </button>
                      </li>
                    );
                  })}
                </ul>
              ) : (
                <p className="ai-connection-empty">
                  No saved models yet. Find one to use it in chats.
                </p>
              )}
              <ModelCombobox
                connectionId={connection.id}
                saved={ids}
                onSave={save}
                disabled={disabled}
              />
            </div>
          </section>
        );
      })}
      <AddConnection kind={kind} onAdded={onChanged} onError={setError} />
    </div>
  );
}
