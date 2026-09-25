import { useEffect, useRef, useState } from "react";
import { Check, Download, Loader2, Pause, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { engines, megabytes } from "@/lib/engines";
import { modelFit, recommended, type Fit } from "@/lib/modelFit";
import type { components } from "@graite/api-types";
import { BrandMark } from "./BrandMark";
import { useCatalog } from "./useCatalog";
import { useEngine } from "./useEngine";

type Hardware = components["schemas"]["Hardware"];

const FIT: Record<Fit, string> = {
  good: "Runs well on this computer",
  slow: "Runs, but slowly on this computer",
  too_big: "Too big for this computer",
};

/**
 * The beginner's model picker: a few pinned 4-bit models with what they are good for and
 * what they need, one button each. Graite sets up the chat engine along with the first
 * download, so nobody has to know what an engine or a quantization is.
 */
export function StarterModels({
  hardware,
  selectedPath,
  disabled,
  onChoose,
  showInstalled,
}: {
  hardware?: Hardware;
  selectedPath: string;
  disabled: boolean;
  onChoose: (path: string) => void;
  /** Also list other chat models already on this computer (the full library is hidden). */
  showInstalled: boolean;
}) {
  const { models, error, setError, act } = useCatalog();
  const engine = useEngine("llama");
  const [pending, setPending] = useState("");
  const [removing, setRemoving] = useState<string | null>(null);
  const started = useRef<string | null>(null);
  const starters = models.filter((m) => m.role === "chat" && m.tier === "starter");
  const pick = hardware ? recommended(starters, hardware) : null;

  // The first model someone downloads is the one they want to use.
  useEffect(() => {
    const done = models.find((m) => m.id === started.current && m.status === "installed");
    if (done && !selectedPath) {
      started.current = null;
      onChoose(done.local_path);
    }
  }, [models, selectedPath, onChoose]);

  const run = async (id: string, action: string) => {
    setPending(id);
    try {
      await act(id, action);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setPending("");
      setRemoving(null);
    }
  };
  const engineState = engine.state;
  const engineWorking =
    !!engineState && ["downloading", "verifying", "installing"].includes(engineState.status);
  const engineMissing = !!engineState && !engineState.installed_version && !engineState.custom_path;
  const installEngine = async () => {
    try {
      engine.setState(await engines.install("llama"));
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const download = async (id: string) => {
    started.current = id;
    if (engineMissing && !engineWorking && engineState?.recommended) void installEngine();
    await run(id, "download");
  };
  const others = models.filter(
    (m) => m.role === "chat" && m.tier !== "starter" && m.status === "installed",
  );

  return (
    <section className="ai-starters" aria-label="Models for this computer">
      <p className="ai-starters-intro">
        {hardware && (
          <>
            <strong>
              Your computer: {Math.round(hardware.ram_gb)} GB memory
              {hardware.gpu ? ` · ${hardware.gpu}` : ""}.
            </strong>{" "}
          </>
        )}
        Pick a model to run privately on it. Bigger models give better answers, but need more memory
        and take longer to download.
      </p>
      <div className="ai-starter-grid">
        {starters.map((m) => {
          const fit = hardware ? modelFit(m, hardware) : null;
          const selected = m.status === "installed" && m.local_path === selectedPath;
          return (
            <article
              key={m.id}
              className={`ai-starter ${selected ? "selected" : ""}`}
              aria-label={`${m.level}: ${m.name}`}
            >
              <header>
                <BrandMark of={m.repo} size={30} />
                <div>
                  <span className="ai-starter-level">{m.level}</span>
                  <strong>{m.name}</strong>
                </div>
                {pick?.id === m.id && <span className="ai-starter-badge">Recommended</span>}
              </header>
              <p>{m.summary}</p>
              <dl>
                <dt>Needs</dt>
                <dd>{m.needs}</dd>
                <dt>Download</dt>
                <dd>{megabytes(m.size)}</dd>
              </dl>
              {fit && <span className={`ai-starter-fit ${fit}`}>{FIT[fit]}</span>}
              <div className="ai-starter-action">
                {m.status === "installed" ? (
                  <>
                    {selected ? (
                      <span className="ai-engine-ok">
                        <Check size={14} /> In use
                      </span>
                    ) : (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={disabled}
                        onClick={() => onChoose(m.local_path)}
                      >
                        Use this model
                      </Button>
                    )}
                    {!selected && (
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
                  </>
                ) : m.status === "downloading" || m.status === "verifying" ? (
                  <div className="ai-download-progress">
                    <progress max={100} value={m.progress} aria-label={`${m.name} download`} />
                    <span>{m.status === "verifying" ? "Checking…" : `${m.progress}%`}</span>
                    <Button
                      size="icon"
                      variant="ghost"
                      aria-label="Pause download"
                      disabled={pending === m.id}
                      onClick={() => void run(m.id, "pause")}
                    >
                      <Pause size={14} />
                    </Button>
                  </div>
                ) : (
                  <Button
                    size="sm"
                    variant={pick?.id === m.id ? "default" : "outline"}
                    disabled={disabled || pending === m.id}
                    onClick={() => void download(m.id)}
                  >
                    <Download size={13} />
                    {m.status === "paused" ? "Resume" : m.status === "error" ? "Retry" : "Download"}
                  </Button>
                )}
              </div>
              {m.error && (
                <p role="alert" className="ai-error">
                  {m.error}
                </p>
              )}
              {removing === m.id && (
                <div className="ai-remove-confirm">
                  <span>Remove this download to free {megabytes(m.size)}?</span>
                  <Button size="sm" variant="outline" onClick={() => setRemoving(null)}>
                    Keep
                  </Button>
                  <Button
                    size="sm"
                    disabled={pending === m.id}
                    onClick={() => void run(m.id, "remove")}
                  >
                    Remove
                  </Button>
                </div>
              )}
            </article>
          );
        })}
      </div>
      {engineWorking ? (
        <p className="ai-starters-engine" role="status">
          <Loader2 size={14} className="animate-spin" /> Setting up Graite’s model runner
          {engineState?.status === "downloading" ? ` · ${Math.round(engineState.progress)}%` : "…"}
        </p>
      ) : (
        engineState?.error && (
          <p className="ai-starters-engine">
            <span className="ai-error" role="alert">
              Could not set up the model runner: {engineState.error}
            </span>
            <Button size="sm" variant="outline" onClick={() => void installEngine()}>
              Try again
            </Button>
          </p>
        )
      )}
      {!engineWorking &&
        !engineState?.error &&
        engineMissing &&
        engineState?.recommended &&
        models.some((m) => m.role === "chat" && m.status === "installed") && (
          <p className="ai-starters-engine">
            <span>Graite still needs its model runner to use your model.</span>
            <Button size="sm" onClick={() => void installEngine()}>
              <Download size={13} /> Set it up
              {engineState.recommended_size ? ` · ${megabytes(engineState.recommended_size)}` : ""}
            </Button>
          </p>
        )}
      {showInstalled && !!others.length && (
        <div className="ai-starters-others">
          <span>Other models on this computer</span>
          {others.map((m) => (
            <div key={m.id}>
              <span>{m.name}</span>
              {m.local_path === selectedPath ? (
                <span className="ai-engine-ok">
                  <Check size={14} /> In use
                </span>
              ) : (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={disabled}
                  onClick={() => onChoose(m.local_path)}
                >
                  Use
                </Button>
              )}
            </div>
          ))}
        </div>
      )}
      {error && (
        <p className="ai-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
