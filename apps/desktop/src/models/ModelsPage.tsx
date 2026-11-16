import { ModelSelect } from "./ModelSelect";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import {
  ArrowRight,
  AudioLines,
  Check,
  Cloud,
  FileText,
  KeyRound,
  Loader2,
  Monitor,
  Plug,
  Search,
  Server,
  Settings2,
  ShieldCheck,
} from "lucide-react";
import { toast } from "sonner";
import { ai, type AIConfig, type AIStatus } from "@/lib/ai";
import {
  connections as connectionsApi,
  hostOf,
  OPENROUTER_URL,
  type Connection,
  type SavedModel,
} from "@/lib/connections";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import "./ai.css";
import "@/settings/settings.css";
import { ConnectionsCard } from "./ConnectionsCard";
import { GraiteCloudCard } from "./GraiteCloudCard";
import { IndexCard } from "./IndexCard";
import { EngineCard } from "./EngineCard";
import { useEngine } from "./useEngine";
import { ModelLibrary } from "./ModelLibrary";
import { StarterModels } from "./StarterModels";
import { useTechMode } from "@/lib/techMode";
import { ConnectorsCard } from "./ConnectorsCard";
import { UpdateCard } from "@/settings/UpdateCard";
import { VaultCard } from "./VaultCard";
import { VoicesCard } from "@/settings/VoicesCard";
import { Explainer } from "@/settings/Explainer";
import { SettingsSidebar } from "@/settings/SettingsSidebar";
import {
  chatSection,
  isOwnNetwork,
  isThisComputer,
  resolveSection,
  sectionLabel,
  type SettingsSection,
  type SettingsTab,
} from "@/settings/sections";
import { saveProfile, useProfile } from "@/lib/profile";
import { setThemeChoice, useThemeChoice, type ThemeChoice } from "@/lib/theme";

export type { SettingsTab };

/** Sections that set the chat model: they end in "Save & check connection". */
const MODEL_SECTIONS: SettingsSection[] = ["local", "server", "graite", "keys"];
/** Sections that edit the shared draft of the model settings, and so show the Save bar. */
const DRAFT_SECTIONS: SettingsSection[] = [...MODEL_SECTIONS, "voice", "search", "documents"];

const SERVER_PRESETS = [
  { label: "Ollama", url: "http://127.0.0.1:11434/v1" },
  { label: "LM Studio", url: "http://127.0.0.1:1234/v1" },
  { label: "llama.cpp", url: "http://127.0.0.1:8080/v1" },
];
const KEY_PRESETS = [
  { label: "OpenAI", url: "https://api.openai.com/v1" },
  { label: "Grok (xAI)", url: "https://api.x.ai/v1" },
  { label: "OpenRouter", url: OPENROUTER_URL },
];

const ownServer = (connection: Connection) => isOwnNetwork(hostOf(connection.base_url));

/** Settings: a sidebar of sections, each explaining what it is for before its controls. The
 * sections share one draft of the model settings and one Save bar, and stay mounted so
 * switching sections never drops an unsaved change. */
export function ModelsPage({
  onClose,
  initialTab = "chat",
  sidebarHost,
}: {
  onClose: () => void;
  initialTab?: SettingsTab;
  /** Where the settings sidebar goes: the app's sidebar column. Without one (the page on its
   * own) the sidebar sits beside the content. */
  sidebarHost?: HTMLElement | null;
}) {
  // "chat" means the section of the model in use, which is only known once the status loads.
  const [section, setSection] = useState<SettingsSection>(() => resolveSection(initialTab, null));
  const [status, setStatus] = useState<AIStatus | null>(null);
  const [config, setConfig] = useState<AIConfig | null>(null);
  const [store, setStore] = useState<{ connections: Connection[]; models: SavedModel[] }>({
    connections: [],
    models: [],
  });
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [techMode, setTechMode] = useTechMode();

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
          // Older vault rows may still say "openrouter"; that is a model server now.
          const loaded =
            s.config.provider === "openrouter"
              ? { ...s.config, provider: "compatible" as const }
              : s.config;
          setStatus(s);
          setConfig(loaded);
          if (initialTab === "chat") setSection(chatSection(loaded));
        }
      })
      .catch((e: Error) => {
        if (live) setError(e.message);
      });
    void refreshStore();
    return () => {
      live = false;
    };
    // Loaded once per visit; `initialTab` only decides where that visit starts.
  }, []);
  const patch = (value: Partial<AIConfig>) => {
    setConfig((c) => c && { ...c, ...value });
    setSuccess("");
  };
  // Stable, so the starter picker can choose a model once its first download finishes.
  const chooseModel = useCallback((model_path: string) => {
    setConfig((c) => c && { ...c, model_path });
    setSuccess("");
  }, []);
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
    if (config.provider === "graite") {
      if (!config.model) throw new Error("Sign in and choose a Graite Cloud model first.");
    } else if (config.provider !== "local" && !config.saved_model_id) {
      throw new Error("Choose a saved model on this connection first.");
    }
    const saved = await ai.save(config);
    setConfig(saved);
    setStatus(await ai.status());
    setSuccess("Settings saved. Your model is ready to check.");
  };
  const draftSection = config ? chatSection(config) : null;
  const savedSection = status ? chatSection(status.config) : null;
  const activeModelId =
    config && config.provider !== "local" ? (config.saved_model_id ?? null) : null;
  const pickSaved = (model: SavedModel) => {
    const connection = store.connections.find((c) => c.id === model.connection_id);
    if (!connection || !config) return;
    patch({
      provider: connection.kind,
      saved_model_id: model.id,
      connection_id: model.connection_id,
      model: model.model,
      base_url: connection.base_url ?? config.base_url,
    });
  };
  /** A connection lands in the section its address belongs to; take the user there. */
  const connectionAdded = (created?: Connection) => {
    void refreshStore();
    if (!created || created.kind !== "compatible") return;
    const home: SettingsSection = ownServer(created) ? "server" : "keys";
    if (home !== section) {
      setSection(home);
      toast(`${created.name} is listed under ${sectionLabel(home)}.`);
    }
  };
  const activeHost = hostOf(
    store.connections.find((c) => c.id === config?.connection_id)?.base_url ?? config?.base_url,
  );
  const panel = (id: SettingsSection, children: ReactNode) => (
    <div
      className="settings-panel"
      role="tabpanel"
      aria-label={sectionLabel(id)}
      hidden={section !== id}
    >
      {children}
    </div>
  );
  /** Says whether chat uses this section's model, and offers the switch when it does not. */
  const chatUse = (id: SettingsSection, switchTo?: () => void, how?: string) =>
    draftSection === id ? (
      <p className="settings-in-use" role="status">
        <Check size={15} /> Chat uses this{savedSection === id ? "" : " once you save"}.
      </p>
    ) : (
      <div className="settings-in-use" data-off>
        <span>
          Chat uses {draftSection ? sectionLabel(draftSection) : "another model"} now.
          {how ? ` ${how}` : ""}
        </span>
        {switchTo && (
          <Button variant="outline" size="sm" disabled={!!busy} onClick={switchTo}>
            Use for chat
          </Button>
        )}
      </div>
    );

  const sidebar = (
    <SettingsSidebar
      section={section}
      inUse={savedSection}
      onSection={setSection}
      onBack={onClose}
    />
  );
  return (
    <section
      className="ai-settings"
      aria-label="Settings"
      data-own-sidebar={!sidebarHost || undefined}
    >
      {sidebarHost ? createPortal(sidebar, sidebarHost) : <aside>{sidebar}</aside>}
      <div className="ai-settings-content">
        {error && (
          <div role="alert" className="ai-notice ai-error">
            {error}
          </div>
        )}
        {panel("general", <GeneralSection />)}
        {!config ? (
          section !== "general" && (
            <p>{error ? "Reopen Settings to try again." : "Checking your setup…"}</p>
          )
        ) : (
          <>
            {panel(
              "local",
              <>
                <Explainer
                  icon={Monitor}
                  title="On this computer"
                  lede="Run an AI model on your own machine."
                  why="Private and free. Nothing you write leaves this computer, and it works offline."
                  need="Enough memory for the model. Graite shows which ones fit."
                  leaves="Nothing."
                />
                {chatUse("local", () =>
                  patch({ provider: "local", saved_model_id: null, connection_id: null }),
                )}
                <fieldset className="ai-setup-card" disabled={!!busy}>
                  <div className="ai-tech-mode">
                    <span>
                      <label htmlFor="ai-tech-mode-switch">
                        <strong>I’m a proper geek</strong>
                      </label>
                      <small id="ai-tech-mode-hint">
                        I know my GGUFs from my quants. Show me every knob for local models: any
                        model from Hugging Face or disk, engine builds, context size, GPU layers, or
                        my own llama-server.
                      </small>
                    </span>
                    <Switch
                      id="ai-tech-mode-switch"
                      checked={techMode}
                      aria-describedby="ai-tech-mode-hint"
                      onCheckedChange={setTechMode}
                    />
                  </div>
                  {techMode && (
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
                  )}
                  <StarterModels
                    hardware={status?.hardware}
                    selectedPath={config.model_path}
                    disabled={!!busy}
                    onChoose={chooseModel}
                    showInstalled={!techMode}
                  />
                  {techMode && (
                    <ModelLibrary
                      selectedPath={config.model_path}
                      disabled={!!busy}
                      onChoose={chooseModel}
                    />
                  )}
                  <label className="ai-check">
                    <input
                      type="checkbox"
                      checked={config.resident}
                      onChange={(e) => patch({ resident: e.target.checked })}
                    />
                    <span>
                      <strong>Keep ready for the next question</strong>
                      <small>Turn off to release memory after 10 minutes without a question.</small>
                    </span>
                  </label>
                  {techMode && (
                    <div className="ai-advanced-fields">
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
                      <label className="ai-field">
                        Your own llama-server
                        <input
                          value={config.binary_path}
                          placeholder="Leave empty to use Graite’s build"
                          spellCheck={false}
                          onChange={(e) => patch({ binary_path: e.target.value.trim() })}
                        />
                        <small>
                          Full path to a llama-server executable you built or installed. Graite runs
                          it instead of its own build.
                        </small>
                      </label>
                    </div>
                  )}
                </fieldset>
              </>,
            )}
            {panel(
              "server",
              <>
                <Explainer
                  icon={Server}
                  title="Your own server"
                  lede="Use models you already run with Ollama, LM Studio or llama.cpp."
                  why="Keep the setup you have, or use a stronger machine in your own network."
                  need="The server’s address, ending in /v1."
                  leaves="Only what you ask, to that address. A server on this computer keeps everything here."
                />
                {chatUse("server", undefined, "Pick a saved model below to use it for chat.")}
                <fieldset className="ai-setup-card" disabled={!!busy}>
                  {status?.keychain_error && <p className="ai-error">{status.keychain_error}</p>}
                  <ConnectionsCard
                    kind="compatible"
                    filter={ownServer}
                    presets={SERVER_PRESETS}
                    connections={store.connections}
                    models={store.models}
                    activeModelId={activeModelId}
                    disabled={!!busy}
                    onChanged={connectionAdded}
                    onPick={pickSaved}
                  />
                </fieldset>
              </>,
            )}
            {panel(
              "voice",
              <>
                <Explainer
                  icon={AudioLines}
                  title="Speech"
                  lede="Talk to your assistant and hear it answer."
                  why="Think out loud or dictate notes instead of typing."
                  need="A one-time download of the speech models below."
                  leaves="Nothing. Your voice becomes text on this computer."
                />
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
              </>,
            )}
            {panel(
              "search",
              <>
                <Explainer
                  icon={Search}
                  title="Search"
                  lede="How AI finds the right passage without reading every page."
                  why="Faster answers, fewer tokens, and every answer shows its sources."
                  need="A small search model. Without it, keyword search still works."
                  leaves="Nothing. The index lives in your vault."
                />
                <IndexCard config={config} onPatch={patch} disabled={!!busy} />
                <ModelLibrary
                  kind="utilities"
                  roles={["embedding"]}
                  selectedPath=""
                  onChoose={() => {}}
                  disabled={!!busy}
                />
              </>,
            )}
            {panel(
              "documents",
              <>
                <Explainer
                  icon={FileText}
                  title="Documents"
                  lede="Turn scanned PDFs and images into text."
                  why="A scan is only a picture. Once read, you can search it and ask about it."
                  need="The chat engine from “On this computer” and a document model."
                  leaves="Nothing."
                />
                <OcrEngineNote
                  override={config.ocr_binary_path || ""}
                  onOpenLocal={() => setSection("local")}
                />
                <ModelLibrary
                  kind="utilities"
                  roles={["ocr"]}
                  selectedPath=""
                  onChoose={() => {}}
                  disabled={!!busy}
                />
              </>,
            )}
            {panel(
              "graite",
              <>
                <Explainer
                  icon={Cloud}
                  title="Graite Cloud"
                  lede="Hosted models that just work, and the link to Claude and ChatGPT."
                  why={
                    <ul>
                      <li>Nothing to download or set up.</li>
                      <li>Free daily credits.</li>
                      <li>Zero data retention: never stored, never used for training.</li>
                      <li>Lets Claude, ChatGPT and Grok work with your pages.</li>
                    </ul>
                  }
                  need="A free Graite account and an internet connection."
                  leaves="Your question and the passages needed to answer it. Pages marked “Local models only” or “No AI” are never sent."
                />
                {chatUse("graite", () =>
                  patch({
                    provider: "graite",
                    model: "",
                    saved_model_id: null,
                    connection_id: null,
                  }),
                )}
                <fieldset className="ai-setup-card" disabled={!!busy}>
                  <GraiteCloudCard
                    activeModel={config.provider === "graite" ? config.model : null}
                    autoPick={config.provider === "graite"}
                    disabled={!!busy}
                    onPick={(model) =>
                      patch({
                        provider: "graite",
                        model: model.id,
                        saved_model_id: null,
                        connection_id: null,
                      })
                    }
                  />
                </fieldset>
              </>,
            )}
            {panel(
              "connectors",
              <>
                <Explainer
                  icon={Plug}
                  title="AI connectors"
                  lede="Let the AI app you already use work with your pages."
                  why="Keep your favourite assistant, with your own notes as what it knows."
                  need="Apps in the browser: a Graite account. Apps on this computer: nothing."
                  leaves="Only the pages the app asks for. Its changes wait for your review."
                />
                <ConnectorsCard onOpenAccount={() => setSection("graite")} />
              </>,
            )}
            {panel(
              "keys",
              <>
                <Explainer
                  icon={KeyRound}
                  title="API keys"
                  lede="Use a model from a provider you have your own account with."
                  why="The strongest models, billed to your own account."
                  need="An API key. A ChatGPT or Claude subscription does not include one."
                  leaves={`Your questions and the passages they need go to ${
                    activeHost && draftSection === "keys" && !isThisComputer(activeHost)
                      ? activeHost
                      : "the provider you choose"
                  }. Pages marked “Local models only” or “No AI” are never sent.`}
                />
                {chatUse("keys", undefined, "Pick a saved model below to use it for chat.")}
                <div className="ai-privacy">
                  <ShieldCheck size={19} />
                  <p>Keys are kept in your system’s keychain, never in your vault.</p>
                </div>
                {status?.keychain_error && <p className="ai-error">{status.keychain_error}</p>}
                <fieldset className="ai-setup-card" disabled={!!busy}>
                  <div className="ai-section-heading">
                    <h2>Claude</h2>
                    <span>Anthropic API key</span>
                  </div>
                  <ConnectionsCard
                    kind="anthropic"
                    connections={store.connections}
                    models={store.models}
                    activeModelId={activeModelId}
                    disabled={!!busy}
                    onChanged={connectionAdded}
                    onPick={pickSaved}
                  />
                  <div className="ai-section-heading">
                    <h2>OpenAI, Grok, OpenRouter and others</h2>
                    <span>Any OpenAI-compatible service</span>
                  </div>
                  <ConnectionsCard
                    kind="compatible"
                    filter={(connection) => !ownServer(connection)}
                    presets={KEY_PRESETS}
                    urlPlaceholder="https://api.openai.com/v1"
                    keyOptional={false}
                    connections={store.connections}
                    models={store.models}
                    activeModelId={activeModelId}
                    disabled={!!busy}
                    onChanged={connectionAdded}
                    onPick={pickSaved}
                  />
                </fieldset>
              </>,
            )}
            <div className="ai-actions" hidden={!DRAFT_SECTIONS.includes(section)}>
              <Button
                variant="outline"
                disabled={!!busy}
                onClick={() => void action("Saving", save)}
              >
                Save settings
              </Button>
              {MODEL_SECTIONS.includes(section) && (
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
            {section === "local" && status?.loaded && (
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
            {MODEL_SECTIONS.includes(section) && status?.benchmark && (
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
          </>
        )}
        <footer className="ai-footnote">
          <ShieldCheck size={15} />
          Graite can read and discuss your pages. Your words stay in your hands.
        </footer>
      </div>
    </section>
  );
}

const THEMES: [ThemeChoice, string][] = [
  ["light", "Light"],
  ["dark", "Dark"],
  ["system", "Same as my computer"],
];

/** General: who you are, how Graite looks, and where this vault lives. */
function GeneralSection() {
  const me = useProfile();
  const theme = useThemeChoice();
  const [name, setName] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const shown = name ?? me?.first_name ?? "";
  const dirty = me !== null && shown.trim() !== me.first_name;
  return (
    <>
      <Explainer
        icon={Settings2}
        title="General"
        lede="Your name, how Graite looks, and where your pages live."
      />
      <section className="settings-card" aria-label="Your name">
        <h2>Your name</h2>
        <p>So chat and your assistant can address you. It stays on this computer.</p>
        <form
          className="settings-row"
          onSubmit={(e) => {
            e.preventDefault();
            setSaving(true);
            void saveProfile({ first_name: shown.trim() })
              .then(() => {
                setName(null);
                toast.success("Name saved");
              })
              .catch((error: Error) => toast.error(error.message))
              .finally(() => setSaving(false));
          }}
        >
          <input
            aria-label="First name"
            value={shown}
            maxLength={60}
            autoComplete="given-name"
            placeholder="Your first name"
            disabled={me === null}
            onChange={(e) => setName(e.target.value)}
          />
          <Button type="submit" variant="outline" disabled={!dirty || saving}>
            Save name
          </Button>
        </form>
      </section>
      <section className="settings-card" aria-label="Appearance">
        <h2>Appearance</h2>
        <div className="settings-segments" role="radiogroup" aria-label="Theme">
          {THEMES.map(([value, label]) => (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={theme === value}
              onClick={() => setThemeChoice(value)}
            >
              {label}
            </button>
          ))}
        </div>
      </section>
      <VaultCard />
      <UpdateCard />
    </>
  );
}

/** Documents: OCR runs on the chat engine, so this only reports whether that engine is there
 * and sends the user to "On this computer" to set it up. */
function OcrEngineNote({ override, onOpenLocal }: { override: string; onOpenLocal: () => void }) {
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
      <Button variant="ghost" size="sm" onClick={onOpenLocal}>
        {ready ? "Manage under On this computer" : "Set up under On this computer"}{" "}
        <ArrowRight size={14} />
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
