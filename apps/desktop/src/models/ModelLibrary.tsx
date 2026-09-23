import { ModelSelect } from "./ModelSelect";
import { useEffect, useState } from "react";
import { Download, Check, Pause, Trash2 } from "lucide-react";
import { request, connectEvents } from "@/lib/api";
import { megabytes } from "@/lib/engines";
import { Button } from "@/components/ui/button";
import type { components } from "@graite/api-types";

import { ModelSources } from "./ModelSources";
import { SpeechCheck } from "./SpeechCheck";

type Model = components["schemas"]["CatalogModel"];
/** Utility roles beyond speech-to-text; the three voice roles make up a voice conversation. */
const UTILITY_ROLES: Record<string, { title: string; tag: string }> = {
  embedding: { title: "Embeddings", tag: "Search" },
  ocr: { title: "Document to Markdown", tag: "OCR" },
  vad: { title: "Voice · hears you speak", tag: "Voice" },
  turn: { title: "Voice · knows when you are done", tag: "Voice" },
  tts: { title: "Voice · your assistant speaks", tag: "Voice" },
};
const VOICE_ROLES = new Set(["vad", "turn", "tts"]);
/** The combined VAD + turn-taking card acts on both models at once. */
const LISTENING = "listening";
const LISTENING_STATUS: Record<string, string> = {
  installed: "Installed",
  available: "Not downloaded yet",
  verifying: "Checking the download…",
  paused: "Paused",
  error: "Could not be downloaded",
  missing: "File missing",
};

export function ModelLibrary({
  onChoose,
  selectedPath,
  disabled,
  kind = "chat",
  roles,
}: {
  onChoose: (path: string) => void;
  selectedPath: string;
  disabled: boolean;
  kind?: "chat" | "utilities";
  /** Utilities only: show just these roles (a Settings tab shows its own models). */
  roles?: string[];
}) {
  const [models, setModels] = useState<Model[]>([]);
  const [error, setError] = useState("");
  const [showSetup, setShowSetup] = useState(false);
  const [pending, setPending] = useState("");
  const [removing, setRemoving] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    const refresh = () =>
      request<Model[]>("/api/v1/ai/catalog")
        .then((m) => {
          if (live) setModels(m);
        })
        .catch((e: Error) => {
          if (live) setError(e.message);
        });
    void refresh();
    const unsubscribe = connectEvents((e) => {
      if (e.type === "model_progress") void refresh();
    });
    // Reconcile after reconnect, including downloads that finished while the UI was closed.
    const timer = setInterval(() => void refresh(), 5000);
    return () => {
      live = false;
      unsubscribe();
      clearInterval(timer);
    };
  }, []);
  const act = async (id: string, action: string) => {
    setError("");
    setPending(id);
    try {
      const updated = await request<Model>(`/api/v1/ai/catalog/${id}/${action}`, {
        method: "POST",
      });
      if (action === "remove" && updated.source === "local")
        setModels((items) => items.filter((m) => m.id !== id));
      else setModels((items) => items.map((m) => (m.id === id ? updated : m)));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setPending("");
      setRemoving(null);
    }
  };
  const listening =
    kind === "utilities" && roles?.includes("vad") && roles.includes("turn")
      ? models.filter((m) => m.role === "vad" || m.role === "turn")
      : [];
  const listeningReady = listening.length >= 2 && listening.every((m) => m.status === "installed");
  const listeningBusy = listening.some(
    (m) => m.status === "downloading" || m.status === "verifying",
  );
  /** The two listening models are downloaded, paused and removed as one. */
  const actOnListening = async (
    action: "download" | "pause" | "remove",
    only: Model[] = listening,
  ) => {
    setPending(LISTENING);
    setError("");
    const results = await Promise.allSettled(
      only.map(async (m) => {
        const updated = await request<Model>(`/api/v1/ai/catalog/${m.id}/${action}`, {
          method: "POST",
        });
        setModels((items) => items.map((item) => (item.id === updated.id ? updated : item)));
      }),
    );
    const errors = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    if (errors.length)
      setError(
        errors
          .map((r) => (r.reason instanceof Error ? r.reason.message : String(r.reason)))
          .join("; "),
      );
    setPending("");
    setRemoving(null);
  };
  const downloadListening = () =>
    actOnListening(
      "download",
      listening.filter((m) => !["installed", "downloading", "verifying"].includes(m.status)),
    );
  return (
    <div className="ai-library">
      {kind === "chat" && (
        <>
          <label className="ai-field">
            Chat model
            <ModelSelect
              label="Chat model"
              value={selectedPath}
              disabled={disabled}
              onValueChange={(value) => onChoose(value)}
            >
              <option value="">Choose a downloaded model</option>
              {selectedPath && !models.some((m) => m.local_path === selectedPath) && (
                <option value={selectedPath}>{selectedPath.split(/[\\/]/).pop()}</option>
              )}
              {models
                .filter((m) => m.role === "chat" && m.status === "installed")
                .map((m) => (
                  <option key={m.id} value={m.local_path}>
                    {m.name}
                  </option>
                ))}
            </ModelSelect>
            <small>Choose a model, then save and check it below.</small>
          </label>
          <ModelSources
            disabled={disabled}
            onChange={async () => setModels(await request<Model[]>("/api/v1/ai/catalog"))}
          />
        </>
      )}
      {kind === "utilities" &&
        !roles &&
        models.some((m) => m.role !== "chat" && m.status === "available") && (
          <Button
            size="sm"
            variant="outline"
            aria-expanded={showSetup}
            onClick={() => setShowSetup(!showSetup)}
          >
            {showSetup ? "Hide available utilities" : "Set up local utilities"}
          </Button>
        )}
      <div className="ai-model-card-list">
        {!!listening.length && (
          <section className="ai-library-model" aria-label="Speech & turn taking">
            <div>
              <div className="ai-utility-role">Conversation listening</div>
              <strong>Speech &amp; turn taking</strong>
              <span>
                {megabytes(listening.reduce((sum, m) => sum + m.size, 0))} · two models, one
                download
              </span>
              <p>
                Silero VAD detects when you speak. Smart Turn distinguishes a thinking pause from
                the end of your turn, so the assistant knows when to reply. Both run on the CPU; no
                GPU is required for listening.
              </p>
              {listening.map((m) => (
                <div key={m.id} className="ai-listening-status">
                  <small>
                    {m.name} ·{" "}
                    {LISTENING_STATUS[m.status] ??
                      (m.status === "downloading" ? `Downloading ${m.progress}%` : m.status)}
                  </small>
                  {(m.status === "downloading" || m.status === "verifying") && (
                    <progress max={100} value={m.progress} aria-label={`${m.name} download`} />
                  )}
                  {m.error && (
                    <p role="alert" className="ai-error">
                      {m.error}
                    </p>
                  )}
                </div>
              ))}
            </div>
            {listeningReady ? (
              <div className="ai-library-buttons">
                <span className="ai-engine-ok">
                  <Check size={13} /> Installed
                </span>
                <Button
                  size="icon"
                  variant="ghost"
                  aria-label="Remove the speech models"
                  disabled={disabled || pending === LISTENING}
                  onClick={() => setRemoving(LISTENING)}
                >
                  <Trash2 size={14} />
                </Button>
              </div>
            ) : listeningBusy ? (
              <Button
                size="sm"
                variant="ghost"
                aria-label="Pause the speech model downloads"
                disabled={pending === LISTENING}
                onClick={() =>
                  void actOnListening(
                    "pause",
                    listening.filter((m) => m.status === "downloading" || m.status === "verifying"),
                  )
                }
              >
                <Pause size={14} /> Pause
              </Button>
            ) : (
              <Button
                size="sm"
                variant="outline"
                disabled={disabled || pending === LISTENING}
                onClick={() => void downloadListening()}
              >
                <Download size={13} />{" "}
                {listening.some((m) => m.status === "paused")
                  ? "Resume speech models"
                  : "Download speech models"}
              </Button>
            )}
            {removing === LISTENING && (
              <div className="ai-remove-confirm">
                <span>
                  Remove both to free {megabytes(listening.reduce((sum, m) => sum + m.size, 0))}?
                  Your assistant cannot hold a spoken conversation without them.
                </span>
                <Button size="sm" variant="outline" onClick={() => setRemoving(null)}>
                  Keep
                </Button>
                <Button
                  size="sm"
                  disabled={pending === LISTENING}
                  onClick={() => void actOnListening("remove")}
                >
                  Remove
                </Button>
              </div>
            )}
          </section>
        )}
        {models
          .filter((m) =>
            kind === "chat"
              ? m.role === "chat"
              : roles
                ? roles.includes(m.role)
                : m.role !== "chat",
          )
          .filter((m) => !listening.some((item) => item.id === m.id))
          .filter(
            (m) => m.status !== "available" || (kind === "utilities" && (showSetup || !!roles)),
          )
          .map((m) => (
            <div className="ai-library-model" key={m.id}>
              <div>
                {kind === "utilities" && (
                  <div className="ai-utility-role">
                    {UTILITY_ROLES[m.role]?.title ?? "Speech to text"}
                  </div>
                )}
                <strong>{m.name}</strong>
                <span>
                  {UTILITY_ROLES[m.role]?.tag ?? (m.role === "speech" ? "Speech" : "Chat")} ·{" "}
                  {megabytes(m.size)} ·{" "}
                  {m.source === "local"
                    ? "Local folder"
                    : m.source === "huggingface"
                      ? "Unsloth"
                      : "Recommended"}
                </span>
                <p>
                  {kind === "utilities"
                    ? m.role === "embedding"
                      ? "Turns text into search vectors. Loads for each job, then releases memory."
                      : m.role === "ocr"
                        ? "Reads scanned PDFs and images into text. Loads for each job, then releases memory."
                        : VOICE_ROLES.has(m.role)
                          ? m.notes
                          : "Transcribes recordings on device. Loads only while transcribing."
                    : m.notes}
                </p>
              </div>
              {m.status === "installed" ? (
                <div className="ai-library-buttons">
                  {m.role === "chat" ? (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={disabled}
                      onClick={() => onChoose(m.local_path)}
                    >
                      <Check size={13} />
                      {selectedPath === m.local_path ? "Selected" : "Use model"}
                    </Button>
                  ) : (
                    <span className="flex items-center gap-1">
                      <Check size={13} />
                      Installed
                    </span>
                  )}
                  {selectedPath !== m.local_path && (
                    <Button
                      size="icon"
                      variant="ghost"
                      aria-label={`Remove ${m.name}`}
                      disabled={disabled || pending === m.id}
                      onClick={() => setRemoving(m.id)}
                    >
                      <Trash2 size={14} />
                    </Button>
                  )}
                </div>
              ) : m.status === "missing" ? (
                <span>File missing · scan its folder again</span>
              ) : m.status === "downloading" || m.status === "verifying" ? (
                <div className="ai-download-progress">
                  <progress max={100} value={m.progress} aria-label={`${m.name} download`} />
                  <span>{m.status === "verifying" ? "Verifying…" : `${m.progress}%`}</span>
                  <Button
                    size="icon"
                    variant="ghost"
                    aria-label="Pause download"
                    disabled={pending === m.id}
                    onClick={() => void act(m.id, "pause")}
                  >
                    <Pause size={14} />
                  </Button>
                </div>
              ) : (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={disabled || pending === m.id}
                  onClick={() => void act(m.id, "download")}
                >
                  <Download size={13} />
                  {m.status === "paused" ? "Resume" : m.status === "error" ? "Retry" : "Download"}
                </Button>
              )}
              {m.role === "speech" && m.status === "installed" && (
                <details className="ai-utility-test">
                  <summary>Test speech to text</summary>
                  <SpeechCheck disabled={disabled} />
                </details>
              )}
              {m.error && (
                <p role="alert" className="ai-error">
                  {m.error}
                </p>
              )}
              {removing === m.id && (
                <div className="ai-remove-confirm">
                  <span>
                    {m.source === "local"
                      ? "Remove from Graite? Your original files will stay in their folder."
                      : `Remove this download to free ${megabytes(m.size)}?`}
                  </span>
                  <Button size="sm" variant="outline" onClick={() => setRemoving(null)}>
                    Keep
                  </Button>
                  <Button
                    size="sm"
                    disabled={pending === m.id}
                    onClick={() => void act(m.id, "remove")}
                  >
                    Remove
                  </Button>
                </div>
              )}
            </div>
          ))}
      </div>
      {error && (
        <p className="ai-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
