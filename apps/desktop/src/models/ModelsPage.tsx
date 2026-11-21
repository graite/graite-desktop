import { ModelSelect } from "./ModelSelect";
import { useCallback, useEffect, useState, type ReactNode, useRef } from "react";
import { createPortal } from "react-dom";
import {
  ArrowRight,
  AudioLines,
  Check,
  Cloud,
  FileText,
  KeyRound,
  Loader2,
  MessageSquare,
  MonitorCog,
  MonitorSmartphone,
  Plug,
  Search,
  Server,
  Settings2,
  ShieldCheck,
  BadgeCheck,
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
import { WorkstationCard } from "./WorkstationCard";
import { useWorkstations } from "./useWorkstations";
import { useSyncStatus } from "@/app/SyncStatus";
import { compute, type ComputeStatus, type ComputeTask } from "@/lib/compute";
import { SyncCard } from "./SyncCard";
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
  resolveSection,
  SECTIONS,
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

/** Where chat's model is, in words: "Your chats use …". */
const CHAT_SOURCE: Record<SettingsSection, string> = {
  general: "another model",
  local: "a model on this computer",
  documents: "a model on this computer",
  voice: "a model on this computer",
  search: "a model on this computer",
  server: "your own server",
  graite: "Graite Cloud",
  sync: "another model",
  workstation: "your AI workstation",
  connectors: "another model",
  keys: "your API key",
};

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
  // Settings is already open and something asks for a section (the vault menu's sync
  // line, a "set up a model" link): go there.
  useEffect(() => {
    const go = (event: Event) => {
      const tab = (event as CustomEvent<unknown>).detail;
      if (typeof tab !== "string") return;
      const known = [...SECTIONS, "chat", "vault"] as string[];
      if (known.includes(tab)) setSection(resolveSection(tab as SettingsTab, loadedRef.current));
    };
    window.addEventListener("graite:open-settings", go);
    return () => window.removeEventListener("graite:open-settings", go);
  }, []);
  const workstations = useWorkstations();
  const syncStatus = useSyncStatus();
  /** A task moved to or from a workstation: the saved settings changed under this page. */
  const moved = (saved: AIConfig) => {
    loadedRef.current = saved;
    setConfig(saved);
    void workstations.refresh();
  };
  // The config as it was last read from or written to the daemon: a save sends what differs.
  const loadedRef = useRef<AIConfig | null>(null);
  // Each section starts at its top: whichever of the two scrolls (with or without its own
  // sidebar) goes back up when the section changes.
  const rootRef = useRef<HTMLElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    for (const element of [rootRef.current, contentRef.current]) if (element) element.scrollTop = 0;
  }, [section]);

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
          loadedRef.current = loaded;
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
    const forChat = MODEL_SECTIONS.includes(section);
    // Only the settings changed on this page are written. Chat's model can be switched from
    // the composer while this page is open, and a save here must not put the old one back.
    const loaded = (loadedRef.current ?? {}) as Record<string, unknown>;
    const changed = Object.fromEntries(
      Object.entries(config).filter(
        ([key, value]) => JSON.stringify(value) !== JSON.stringify(loaded[key]),
      ),
    ) as Partial<AIConfig>;
    const next = { ...(await ai.status()).config, ...changed };
    // An unfinished chat model choice is no reason to refuse saving speech or search settings.
    if (forChat || "provider" in changed || "saved_model_id" in changed) {
      if (next.provider === "graite") {
        if (!next.model) throw new Error("Sign in and choose a Graite Cloud model first.");
      } else if (next.provider !== "local" && !next.saved_model_id) {
        throw new Error("Choose a saved model on this connection first.");
      }
    }
    const saved = await ai.save(next);
    loadedRef.current = saved;
    setConfig(saved);
    setStatus(await ai.status());
    setSuccess(forChat ? "Settings saved. Your model is ready to check." : "Settings saved.");
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
  // "auto" (never switched) follows what is in use: local when its model is installed.
  const documentsLocal =
    config?.ocr_provider === "local" ||
    (config?.ocr_provider === "auto" && status?.ocr_source === "local");
  const speechLocal =
    config?.stt_provider === "local" ||
    (config?.stt_provider === "auto" && status?.speech_source === "local");
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
        <Check size={15} /> Your chats use {CHAT_SOURCE[id]}
        {savedSection === id ? "" : " once you save"}.
      </p>
    ) : (
      <div className="settings-in-use" data-off>
        <span>
          Your chats use {draftSection ? CHAT_SOURCE[draftSection] : "another model"} now.
          {how ? ` ${how}` : ""}
        </span>
        {switchTo && (
          <Button variant="outline" size="sm" disabled={!!busy} onClick={switchTo}>
            Chat with {CHAT_SOURCE[id]}
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
      ref={rootRef}
      className="ai-settings"
      aria-label="Settings"
      data-own-sidebar={!sidebarHost || undefined}
    >
      {sidebarHost ? createPortal(sidebar, sidebarHost) : <aside>{sidebar}</aside>}
      <div className="ai-settings-content" ref={contentRef}>
        {error && (
          <div role="alert" className="ai-notice ai-error">
            {error}
          </div>
        )}
        {panel("general", <GeneralSection techMode={techMode} onTechMode={setTechMode} />)}
        {!config ? (
          section !== "general" && (
            <p>{error ? "Reopen Settings to try again." : "Checking your setup…"}</p>
          )
        ) : (
          <>
            {panel(
              "graite",
              <>
                <Explainer
                  icon={Cloud}
                  title="Graite Cloud"
                  text="Good models, zero setup. Sign in and chat; your chats and pages are not stored or used for training."
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
              "sync",
              <>
                <Explainer
                  icon={MonitorSmartphone}
                  title="Sync devices"
                  text="Your pages, on all your computers. Share this vault once, type six words on the other one, done. Only your devices can read them, not even us."
                />
                <SyncCard onOpenCloud={() => setSection("graite")} />
              </>,
            )}
            {panel(
              "connectors",
              <>
                <Explainer
                  icon={Plug}
                  title="AI connectors"
                  text="Already attached to Claude, ChatGPT or Cursor? Plug Graite in and it knows your pages. Whatever it wants to change waits for your OK."
                />
                <ConnectorsCard onOpenAccount={() => setSection("graite")} />
                <p className="settings-note settings-note-card">
                  <strong>After a Graite update, refresh the tools.</strong> New versions can add or
                  change what Graite offers your AI app. If something is missing or acts oddly, open
                  the connectors (or apps) settings in Claude, ChatGPT, Gemini or your other app,
                  find Graite, and sync or reconnect it.
                </p>
              </>,
            )}
            {panel(
              "keys",
              <>
                <Explainer
                  icon={KeyRound}
                  title="API keys"
                  text="Have your own account with OpenAI, Anthropic or another provider? Paste the key and pick a model. The bill goes to you, the chats go straight to them."
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
            {panel(
              "local",
              <>
                <Explainer
                  icon={MessageSquare}
                  title="Chat"
                  text="The model that answers when you ask about your pages. Pick one that runs on this computer and nothing leaves it."
                />
                <LocalSwitch
                  id="local-chat"
                  checked={config.provider === "local"}
                  disabled={!!busy}
                  hint="Run the chat model here instead of in the cloud."
                  onChange={(on) =>
                    patch(
                      on
                        ? { provider: "local", saved_model_id: null, connection_id: null }
                        : {
                            provider: "graite",
                            model: "",
                            saved_model_id: null,
                            connection_id: null,
                          },
                    )
                  }
                />
                {config.provider !== "local" ? (
                  <div className="settings-in-use" data-off>
                    <span>
                      Your chats use {draftSection ? CHAT_SOURCE[draftSection] : "another model"}
                      {savedSection === draftSection ? "" : " once you save"}.
                    </span>
                    {draftSection && draftSection !== "local" && (
                      <Button variant="outline" size="sm" onClick={() => setSection(draftSection)}>
                        Open {sectionLabel(draftSection)}
                      </Button>
                    )}
                  </div>
                ) : (
                  <fieldset className="ai-setup-card" disabled={!!busy}>
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
                        <small>
                          Turn off to release memory after 10 minutes without a question.
                        </small>
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
                            Full path to a llama-server executable you built or installed. Graite
                            runs it instead of its own build.
                          </small>
                        </label>
                      </div>
                    )}
                  </fieldset>
                )}
              </>,
            )}
            {panel(
              "search",
              <>
                <Explainer
                  icon={Search}
                  title="Search"
                  text="How AI finds the one paragraph that matters without reading your whole vault. It runs here, on this computer."
                />
                <div className="ai-privacy settings-recommend">
                  <BadgeCheck size={18} />
                  <p>
                    <strong>Recommended: download the search model below.</strong> It is small, runs
                    on this computer and makes finding things much faster and smarter than keywords
                    alone. Nothing to sign up for, and your pages stay here.
                  </p>
                </div>
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
              "workstation",
              <>
                <Explainer
                  icon={MonitorCog}
                  title="AI workstation"
                  text="Have a strong computer at home? Let it do the AI work for your laptop. Everything travels encrypted between your own devices; nobody else can read it."
                />
                <WorkstationCard
                  status={workstations.status}
                  shared={syncStatus ? !!syncStatus.space_id : null}
                  refresh={workstations.refresh}
                  onStatus={workstations.setStatus}
                  onUsed={moved}
                  onOpenSync={() => setSection("sync")}
                />
              </>,
            )}
            {panel(
              "documents",
              <>
                <Explainer
                  icon={FileText}
                  title="Documents"
                  text="Turns scans and photos into text you can search and quote. Drop in a PDF; Graite does the squinting."
                />
                <WorkstationSwitch
                  what="documents"
                  label="Read documents on"
                  status={workstations.status}
                  on={config.ocr_provider === "device"}
                  deviceId={config.ocr_device_id}
                  deviceName={config.ocr_device_name}
                  disabled={!!busy}
                  onUsed={moved}
                />
                {config.ocr_provider !== "device" && (
                  <LocalSwitch
                    id="local-documents"
                    checked={documentsLocal}
                    disabled={!!busy}
                    label="Read everything in-house"
                    hint="Your scans never leave the building: GLM-OCR reads every page right here, on this computer."
                    onChange={(on) => patch({ ocr_provider: on ? "local" : "graite" })}
                  />
                )}
                {documentsLocal ? (
                  <>
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
                  </>
                ) : config.ocr_provider === "device" ? null : (
                  <CloudNote
                    signedIn={!!status?.cloud_signed_in}
                    what="Documents are read"
                    onOpenCloud={() => setSection("graite")}
                  />
                )}
              </>,
            )}
            {panel(
              "voice",
              <>
                <Explainer
                  icon={AudioLines}
                  title="Speech"
                  text="Talk instead of type. Dictate a note, transcribe a recording, or have a chat with your assistant out loud."
                />
                <WorkstationSwitch
                  what="speech"
                  label="Turn speech into text on"
                  status={workstations.status}
                  on={config.stt_provider === "device"}
                  deviceId={config.stt_device_id}
                  deviceName={config.stt_device_name}
                  disabled={!!busy}
                  onUsed={moved}
                />
                {config.stt_provider !== "device" && (
                  <LocalSwitch
                    id="local-speech"
                    checked={speechLocal}
                    disabled={!!busy}
                    hint="Turn speech into text here with Whisper, instead of in the cloud."
                    onChange={(on) => patch({ stt_provider: on ? "local" : "graite" })}
                  />
                )}
                {speechLocal ? (
                  <ModelLibrary
                    kind="utilities"
                    roles={["speech"]}
                    selectedPath=""
                    onChoose={() => {}}
                    disabled={!!busy}
                  />
                ) : config.stt_provider === "device" ? null : (
                  <CloudNote
                    signedIn={!!status?.cloud_signed_in}
                    what="Speech to text runs"
                    onOpenCloud={() => setSection("graite")}
                  />
                )}
                <div className="ai-section-heading">
                  <h2>Talking with your assistant</h2>
                  <span>
                    {config.tts_provider === "device"
                      ? "Listening on this computer"
                      : "Always on this computer"}
                  </span>
                </div>
                <p className="settings-note">
                  {config.tts_provider === "device"
                    ? "Hearing when you start and stop talking still runs on this computer; the voice itself comes from your workstation."
                    : "Hearing when you start and stop talking, and your assistant’s own voice, run on this computer."}
                </p>
                <WorkstationSwitch
                  what="voice"
                  label="Let your assistant speak with"
                  status={workstations.status}
                  on={config.tts_provider === "device"}
                  deviceId={config.tts_device_id}
                  deviceName={config.tts_device_name}
                  disabled={!!busy}
                  onUsed={moved}
                />
                {/* The voice engine runs Whisper and the voice: with both on a workstation
                    there is nothing for it to do here. */}
                {!(config.tts_provider === "device" && config.stt_provider === "device") && (
                  <EngineCard engineId="crispasr" disabled={!!busy} />
                )}
                <ModelLibrary
                  kind="utilities"
                  roles={
                    config.tts_provider === "device" ? ["vad", "turn"] : ["vad", "turn", "tts"]
                  }
                  selectedPath=""
                  onChoose={() => {}}
                  voiceModel={config.tts_model ?? ""}
                  onChooseVoice={(tts_model) => patch({ tts_model })}
                  disabled={!!busy}
                />
                {techMode && (
                  <WhisperServerField
                    value={config.whisper_binary_path ?? ""}
                    found={status?.whisper_binary ?? ""}
                    onChange={(whisper_binary_path) => patch({ whisper_binary_path })}
                  />
                )}
                <VoicesCard />
              </>,
            )}
            {panel(
              "server",
              <>
                <Explainer
                  icon={Server}
                  title="Your own server"
                  text="Already running Ollama, LM Studio or llama.cpp? Point Graite at it and use the models you have."
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

/** General: who you are, how Graite looks, where this vault lives, and the geek switch. */
function GeneralSection({
  techMode,
  onTechMode,
}: {
  techMode: boolean;
  onTechMode: (on: boolean) => void;
}) {
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
        text="Your name, light or dark, and where your pages live. The small stuff that makes it yours."
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
      <section className="settings-card" aria-label="Advanced settings">
        <h2>Advanced settings</h2>
        <div className="ai-tech-mode">
          <span>
            <label htmlFor="ai-tech-mode-switch">
              <strong>I’m a proper geek</strong>
            </label>
            <small id="ai-tech-mode-hint">
              I know my GGUFs from my quants. Show me every knob for local AI: any model from
              Hugging Face or disk, engine builds, context size, GPU layers, my own engines and my
              own server.
            </small>
          </span>
          <Switch
            id="ai-tech-mode-switch"
            checked={techMode}
            aria-describedby="ai-tech-mode-hint"
            onCheckedChange={onTechMode}
          />
        </div>
      </section>
    </>
  );
}

/** Documents: local OCR runs on the chat engine, so this only reports whether that engine is
 * there and sends the user to Chat to set it up. */
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
        {ready ? "Manage under Chat" : "Set up under Chat"} <ArrowRight size={14} />
      </Button>
    </div>
  );
}

/**
 * Geek mode only: a whisper-server of your own instead of Graite's voice engine, which runs
 * Whisper by default. Saved with "Save settings" and checked by the daemon.
 */
function WhisperServerField({
  value,
  found,
  onChange,
}: {
  value: string;
  found: string;
  onChange: (path: string) => void;
}) {
  return (
    <div className="ai-engine-note" data-field>
      <label className="ai-field">
        Your own whisper-server
        <input
          value={value}
          placeholder="Leave empty to use Graite’s voice engine"
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          onChange={(e) => onChange(e.target.value)}
        />
        <small>
          {value
            ? "Speech to text runs this file. Clear the field to use Graite’s voice engine."
            : found
              ? `Speech to text runs ${found}. Give a path only to use a whisper.cpp build of your own.`
              : "Speech to text runs on Graite’s voice engine once it is installed above."}
        </small>
      </label>
    </div>
  );
}

/** The "Use local AI on my computer" switch at the top of Chat, Documents and Speech. Off
 * (the default for most people) means Graite Cloud does the work. */
function LocalSwitch({
  id,
  checked,
  disabled,
  label = "Use local AI on my computer",
  hint,
  onChange,
}: {
  id: string;
  checked: boolean;
  disabled?: boolean;
  label?: string;
  hint: string;
  onChange: (on: boolean) => void;
}) {
  return (
    <div className="ai-tech-mode ai-local-switch">
      <span>
        <label htmlFor={id}>
          <strong>{label}</strong>
        </label>
        <small id={`${id}-hint`}>{hint}</small>
      </span>
      <Switch
        id={id}
        checked={checked}
        disabled={disabled}
        aria-describedby={`${id}-hint`}
        onCheckedChange={onChange}
      />
    </div>
  );
}

/** With local AI off: who does the work, or what is missing for it. */
/** On a task's own page: hand that one task to an AI workstation, or take it back. Shown
 * when one of your other computers offers the task, or does it now. */
function WorkstationSwitch({
  what,
  label,
  status,
  on,
  deviceId,
  deviceName,
  disabled,
  onUsed,
}: {
  what: ComputeTask;
  /** Ends where the computer's name follows: "Read documents on". */
  label: string;
  status: ComputeStatus | null;
  on: boolean;
  deviceId?: string;
  deviceName?: string;
  disabled?: boolean;
  onUsed: (config: AIConfig) => void;
}) {
  const [busy, setBusy] = useState(false);
  const offering = status?.devices.find((d) => (on ? d.id === deviceId : d[what as "documents"]));
  if (!on && !offering) return null;
  const id = on ? (deviceId ?? "") : (offering?.id ?? "");
  const name = (on ? deviceName : offering?.name) || "your workstation";
  return (
    <div className="workstation-switch">
      <LocalSwitch
        id={`workstation-${what}`}
        checked={on}
        disabled={disabled || busy}
        label={`${label} ${name}`}
        hint={
          on && !offering
            ? `${name} is not connected right now. Until it is back this will not work; switch off to do it here instead.`
            : "Your AI workstation does the work. It travels encrypted between your own devices."
        }
        onChange={(next) => {
          setBusy(true);
          compute
            .use(id, what, next)
            .then(onUsed)
            .catch((e: unknown) => toast.error(e instanceof Error ? e.message : "Try again."))
            .finally(() => setBusy(false));
        }}
      />
    </div>
  );
}

function CloudNote({
  signedIn,
  what,
  onOpenCloud,
}: {
  signedIn: boolean;
  what: string;
  onOpenCloud: () => void;
}) {
  return signedIn ? (
    <p className="settings-in-use" role="status">
      <Cloud size={15} /> {what} through Graite Cloud, free with your account.
    </p>
  ) : (
    <div className="settings-in-use" data-off>
      <span>{what} through Graite Cloud once you sign in, or turn on local AI above.</span>
      <Button variant="outline" size="sm" onClick={onOpenCloud}>
        Sign in to Graite Cloud
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
