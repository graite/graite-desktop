import { ModelSelect } from "./ModelSelect";
import { useEffect, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  AudioLines,
  Check,
  Cpu,
  FileText,
  FolderOpen,
  Loader2,
  MessageSquare,
  Monitor,
  Plug,
  Search,
  ShieldCheck,
  Orbit,
} from "lucide-react";
import { ai, type AIConfig, type AIStatus } from "@/lib/ai";
import {
  connections as connectionsApi,
  hostOf,
  type Connection,
  type ConnectionKind,
  type SavedModel,
} from "@/lib/connections";
import { Button } from "@/components/ui/button";
import "./ai.css";
import "@/settings/settings.css";
import { ConnectionsCard } from "./ConnectionsCard";
import { IndexCard } from "./IndexCard";
import { EngineCard } from "./EngineCard";
import { useEngine } from "./useEngine";
import { ModelLibrary } from "./ModelLibrary";
import { VaultCard } from "./VaultCard";
import { VoicesCard } from "@/settings/VoicesCard";

export type SettingsTab = "chat" | "voice" | "search" | "documents" | "vault";
const TABS: { id: SettingsTab; label: string; icon: typeof Orbit }[] = [
  { id: "chat", label: "Chat", icon: MessageSquare },
  { id: "voice", label: "Voice", icon: AudioLines },
  { id: "search", label: "Search", icon: Search },
  { id: "documents", label: "Documents", icon: FileText },
  { id: "vault", label: "Vault", icon: FolderOpen },
];

type Kind = "local" | ConnectionKind;
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/** Settings: one page, a tab per concern. The tabs share one draft of the model settings and
 * one Save bar, and stay mounted so switching tabs never drops an unsaved change. */
export function ModelsPage({
  onClose,
  initialTab = "chat",
}: {
  onClose: () => void;
  initialTab?: SettingsTab;
}) {
  const [tab, setTab] = useState<SettingsTab>(initialTab);
  const [status, setStatus] = useState<AIStatus | null>(null);
  const [config, setConfig] = useState<AIConfig | null>(null);
  const [kind, setKind] = useState<Kind>("local");
  const [store, setStore] = useState<{ connections: Connection[]; models: SavedModel[] }>({
    connections: [],
    models: [],
  });
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  const refreshStore = () =>
    connectionsApi
      .list()
      .then(setStore)
      .catch((e: Error) => setError(e.message));

  useEffect(() => {
    let live = true;
    ai.status()
      .then((s) => {
        if (live) {
          setStatus(s);
          setConfig(s.config);
          // Older vault rows may still say "openrouter"; that is a model server now.
          setKind(s.config.provider === "openrouter" ? "compatible" : s.config.provider);
        }
      })
      .catch((e: Error) => {
        if (live) setError(e.message);
      });
    void refreshStore();
    return () => {
      live = false;
    };
  }, []);
  const patch = (value: Partial<AIConfig>) => {
    setConfig((c) => c && { ...c, ...value });
    setSuccess("");
  };
  const action = async (label: string, work: () => Promise<void>) => {
    setBusy(label);
    setError("");
    setSuccess("");
    try {
      await work();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy("");
    }
  };
  const save = async () => {
    if (!config) return;
    if (kind !== "local" && !config.saved_model_id) {
      throw new Error("Choose a saved model on this connection first.");
    }
    const saved = await ai.save(config);
    setConfig(saved);
    setStatus(await ai.status());
    setSuccess("Settings saved. Your model is ready to check.");
  };
  const activeModelId = kind !== "local" ? (config?.saved_model_id ?? null) : null;
  const activeHost = hostOf(
    store.connections.find((c) => c.id === config?.connection_id)?.base_url ?? config?.base_url,
  );
  return (
    <section className="ai-settings" aria-label="Settings">
      <header className="ai-topbar">
        <Button variant="ghost" onClick={onClose}>
          <ArrowLeft size={16} /> Back to pages
        </Button>
        <span>Settings / {TABS.find((t) => t.id === tab)?.label}</span>
      </header>
      <div className="ai-settings-content">
        <div className="ai-eyebrow">MAKE IT YOURS</div>
        <h1>Settings</h1>
        <p className="ai-lede">
          Your chat model, your assistant’s voice, search, documents and your vault.
        </p>
        <nav className="ai-settings-tabs" aria-label="Settings sections">
          {TABS.map(({ id, label, icon: Icon }) => (
            <button key={id} role="tab" aria-selected={tab === id} onClick={() => setTab(id)}>
              <Icon size={15} /> {label}
            </button>
          ))}
        </nav>
        {error && (
          <div role="alert" className="ai-notice ai-error">
            {error}
          </div>
        )}
        {!config ? (
          <p>{error ? "Reopen Settings to try again." : "Checking your setup…"}</p>
        ) : (
          <>
            <div
              className="settings-panel"
              role="tabpanel"
              aria-label="Chat"
              hidden={tab !== "chat"}
            >
              <div className="ai-section-heading">
                <h2>Chat</h2>
                <span>Your thinking partner</span>
              </div>
              <div className="ai-choices" role="group" aria-label="Chat connection">
                {(
                  [
                    [
                      "local",
                      Monitor,
                      "On device",
                      "Private by default. Run a GGUF model locally.",
                    ],
                    [
                      "compatible",
                      Plug,
                      "Model server",
                      "LM Studio or Ollama on this computer, OpenRouter, or any OpenAI-compatible address you paste.",
                    ],
                    ["anthropic", Orbit, "Claude", "Use Claude with your Anthropic API key."],
                  ] as const
                ).map(([id, Icon, title, description]) => (
                  <button
                    key={id}
                    type="button"
                    disabled={!!busy}
                    className={`ai-choice ${kind === id ? "selected" : ""}`}
                    aria-pressed={kind === id}
                    onClick={() => {
                      if (kind === id) return;
                      setKind(id);
                      if (id === "local")
                        patch({ provider: "local", saved_model_id: null, connection_id: null });
                      else if (config.provider !== id)
                        patch({ saved_model_id: null, connection_id: null });
                    }}
                  >
                    <div className="ai-choice-icon">
                      <Icon size={20} />
                      {kind === id && <Check size={15} />}
                    </div>
                    <strong>{title}</strong>
                    <span>{description}</span>
                  </button>
                ))}
              </div>
              <fieldset className="ai-setup-card" disabled={!!busy}>
                {kind === "local" ? (
                  <>
                    <div className="ai-hardware">
                      <Cpu size={22} />
                      <div>
                        <strong>
                          {status?.hardware.ram_gb} GB memory{" "}
                          {status?.hardware.gpu && `· ${status.hardware.gpu}`}
                        </strong>
                        <p>Models run privately on your device.</p>
                      </div>
                    </div>
                    <EngineCard
                      engineId="llama"
                      disabled={!!busy}
                      onChanged={() =>
                        void ai
                          .status()
                          .then(setStatus)
                          .catch(() => undefined)
                      }
                    />
                    <ModelLibrary
                      selectedPath={config.model_path}
                      disabled={!!busy}
                      onChoose={(model_path) => patch({ model_path })}
                    />
                    <label className="ai-check">
                      <input
                        type="checkbox"
                        checked={config.resident}
                        onChange={(e) => patch({ resident: e.target.checked })}
                      />
                      <span>
                        <strong>Keep ready for the next question</strong>
                        <small>
                          Turn off to release memory after 10 minutes without a question.
                        </small>
                      </span>
                    </label>
                    <details className="ai-advanced">
                      <summary>Advanced settings</summary>

                      <div className="ai-field-row">
                        <label className="ai-field">
                          Context size
                          <ModelSelect
                            label="Context size"
                            value={config.context_size}
                            onValueChange={(value) => patch({ context_size: Number(value) })}
                          >
                            {[2048, 4096, 8192, 16384, 32768].map((n) => (
                              <option key={n} value={n}>
                                {n.toLocaleString()} tokens
                              </option>
                            ))}
                          </ModelSelect>
                        </label>
                        <label className="ai-field">
                          GPU layers
                          <input
                            type="number"
                            min={-1}
                            max={999}
                            value={config.gpu_layers}
                            onChange={(e) => patch({ gpu_layers: Number(e.target.value) })}
                          />
                          <small>−1 chooses automatically · 0 uses CPU</small>
                        </label>
                      </div>
                    </details>
                  </>
                ) : (
                  <>
                    <div className="ai-privacy">
                      <ShieldCheck size={19} />
                      <p>
                        {kind === "anthropic"
                          ? "Your questions, page context, and inherited instructions are sent to Anthropic."
                          : activeHost && !LOCAL_HOSTS.has(activeHost)
                            ? `Your questions, page context, and inherited instructions are sent to ${activeHost}${activeHost.endsWith("openrouter.ai") ? " and the model's provider" : ""}.`
                            : "Your questions, page context, and inherited instructions are sent to the server you connect. A server on this computer keeps them here."}{" "}
                        API keys are stored in your operating system’s keychain. Connections and
                        saved models are shared by all your vaults.
                      </p>
                    </div>
                    {status?.keychain_error && <p className="ai-error">{status.keychain_error}</p>}
                    <ConnectionsCard
                      kind={kind}
                      connections={store.connections}
                      models={store.models}
                      activeModelId={activeModelId}
                      disabled={!!busy}
                      onChanged={() => void refreshStore()}
                      onPick={(model) => {
                        const connection = store.connections.find(
                          (c) => c.id === model.connection_id,
                        );
                        patch({
                          provider: kind,
                          saved_model_id: model.id,
                          connection_id: model.connection_id,
                          model: model.model,
                          base_url: connection?.base_url ?? config.base_url,
                        });
                      }}
                    />
                  </>
                )}
              </fieldset>
            </div>
            <div
              className="settings-panel"
              role="tabpanel"
              aria-label="Voice"
              hidden={tab !== "voice"}
            >
              <div className="ai-section-heading">
                <h2>Voice</h2>
                <span>Talk with your assistant</span>
              </div>
              <p className="ai-library-intro">
                Set up speech recognition, conversation listening and your assistant’s speaking
                voice below. Everything runs privately on this computer.
              </p>
              <EngineCard engineId="crispasr" disabled={!!busy} />
              <ModelLibrary
                kind="utilities"
                roles={["speech", "vad", "turn", "tts"]}
                selectedPath=""
                onChoose={() => {}}
                disabled={!!busy}
              />
              <OwnBuild label="Speech to text" path={config.whisper_binary_path} />
              <VoicesCard />
            </div>
            <div
              className="settings-panel"
              role="tabpanel"
              aria-label="Search"
              hidden={tab !== "search"}
            >
              <IndexCard config={config} onPatch={patch} disabled={!!busy} />
              <ModelLibrary
                kind="utilities"
                roles={["embedding"]}
                selectedPath=""
                onChoose={() => {}}
                disabled={!!busy}
              />
            </div>
            <div
              className="settings-panel"
              role="tabpanel"
              aria-label="Documents"
              hidden={tab !== "documents"}
            >
              <div className="ai-section-heading">
                <h2>OCR</h2>
                <span>PDFs and images into text</span>
              </div>
              <p className="ai-library-intro">
                Reads scanned PDFs and images into Markdown on this computer. It loads for each job
                and releases memory afterwards.
              </p>
              <OcrEngineNote
                override={config.ocr_binary_path || ""}
                onOpenChat={() => setTab("chat")}
              />
              <ModelLibrary
                kind="utilities"
                roles={["ocr"]}
                selectedPath=""
                onChoose={() => {}}
                disabled={!!busy}
              />
            </div>
            <div
              className="settings-panel"
              role="tabpanel"
              aria-label="Vault"
              hidden={tab !== "vault"}
            >
              <VaultCard />
            </div>
            <div className="ai-actions" hidden={tab === "vault"}>
              <Button
                variant="outline"
                disabled={!!busy}
                onClick={() => void action("Saving", save)}
              >
                Save settings
              </Button>
              {tab === "chat" && (
                <Button
                  disabled={!!busy}
                  onClick={() =>
                    void action("Checking your model", async () => {
                      await save();
                      const result = await ai.check();
                      setStatus(await ai.status());
                      setSuccess(`${result.message}. First response in ${result.seconds}s.`);
                    })
                  }
                >
                  {busy ? <Loader2 size={16} className="animate-spin" /> : <ArrowRight size={16} />}
                  {busy || "Save & check connection"}
                </Button>
              )}
            </div>
            {success && (
              <div className="ai-notice ai-success" role="status">
                <Check size={17} />
                {success}
              </div>
            )}
            {status?.runtime_warning && (
              <div className="ai-notice" role="status">
                {status.runtime_warning}
              </div>
            )}
            {tab === "chat" && status?.loaded && (
              <div className="ai-runtime">
                <span>
                  <span className="ai-dot" /> Local model loaded · {status.gpu_layers} GPU layers
                </span>
                <Button
                  variant="ghost"
                  disabled={!!busy}
                  onClick={() =>
                    void action("Releasing memory", async () => {
                      await ai.unload();
                      setStatus(await ai.status());
                      setSuccess(
                        "Memory released. Graite will load the model for your next question.",
                      );
                    })
                  }
                >
                  Release memory
                </Button>
              </div>
            )}
            {tab === "chat" && status?.benchmark && (
              <div className="ai-benchmark">
                <Check size={15} />
                <span>
                  Last connection check: {String(status.benchmark.seconds)}s
                  {typeof status.benchmark.tokens_per_second === "number"
                    ? ` · ${status.benchmark.tokens_per_second.toFixed(1)} tokens/s`
                    : ""}
                </span>
              </div>
            )}
            <footer className="ai-footnote">
              <ShieldCheck size={15} />
              Graite can read and discuss your pages. Your words stay in your hands.
            </footer>
          </>
        )}
      </div>
    </section>
  );
}

/** Documents tab: OCR runs on the chat engine, so this only reports whether that engine is
 * there and sends the user to Chat to set it up. */
function OcrEngineNote({ override, onOpenChat }: { override: string; onOpenChat: () => void }) {
  const { state, error } = useEngine("llama");
  if (override.trim()) return <OwnBuild label="OCR" path={override} />;
  if (error)
    return (
      <p className="ai-error" role="alert">
        {error}
      </p>
    );
  if (!state) return null;
  const ready = !!state.installed_version;
  return (
    <div className="ai-engine-note">
      <div>
        <strong>
          {ready && <Check size={15} />}
          Uses the {state.name.toLowerCase()} — {ready ? "already downloaded" : "not set up yet"}
        </strong>
        {state.path && (
          <small>
            <code>{state.path}</code>
          </small>
        )}
      </div>
      <Button variant="ghost" size="sm" onClick={onOpenChat}>
        {ready ? "Manage in Chat" : "Set up in Chat"} <ArrowRight size={14} />
      </Button>
    </div>
  );
}

/** An executable set outside the app, which quietly replaces the engine Graite installed.
 * Read-only on purpose: it is here so the override is never invisible, not to be edited. */
function OwnBuild({ label, path }: { label: string; path: string | null | undefined }) {
  if (!path?.trim()) return null;
  return (
    <div className="ai-engine-note">
      <div>
        <strong>{label} runs a build of your own</strong>
        <small>
          <code>{path}</code>
        </small>
      </div>
    </div>
  );
}
