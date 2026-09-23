import { useState } from "react";
import { Check, Download, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { engines, megabytes, variantSize, type EngineState } from "@/lib/engines";
import { ModelSelect } from "./ModelSelect";
import { useEngine } from "./useEngine";

const WORKING: Record<string, string> = {
  downloading: "Downloading",
  verifying: "Checking the download",
  installing: "Setting up",
};

/**
 * One engine Graite can install for the user. The default view is one sentence and one
 * button; which build and which version live under Advanced. Graite always runs the engine
 * it installed: pointing at an outside executable is a developer setting, in the daemon's
 * environment, not on this page.
 */
export function EngineCard({
  engineId,
  disabled,
  onChanged,
}: {
  engineId: "llama" | "crispasr";
  disabled?: boolean;
  onChanged?: () => void;
}) {
  const { state, error: loadError, refresh, setState } = useEngine(engineId, onChanged);
  const [variant, setVariant] = useState("");
  // A failed lookup used to make the whole card disappear with no explanation.
  if (!state) {
    return (
      <section className="ai-engine" aria-label="Engine">
        {loadError ? (
          <div className="ai-engine-main">
            <p className="ai-error" role="alert">
              {loadError}
            </p>
            <Button variant="outline" size="sm" onClick={() => void refresh()}>
              Try again
            </Button>
          </div>
        ) : (
          <div className="ai-engine-progress" role="status">
            <Loader2 size={15} className="animate-spin" /> <span>Checking the engine…</span>
          </div>
        )}
      </section>
    );
  }

  const run = async (work: () => Promise<EngineState>) => {
    try {
      setState(await work());
    } catch (e) {
      toast.error((e as Error).message);
    }
  };
  const working = state.status in WORKING;
  const installed = !!state.installed_version;
  const chosen = variant || state.installed_variant || state.recommended || "";
  const size = state.recommended_size ? megabytes(state.recommended_size) : "";
  return (
    <section className="ai-engine" aria-label={state.name}>
      <div className="ai-engine-main">
        <div>
          <strong>{state.name}</strong>
          <p>{state.purpose}</p>
          <small>
            {installed
              ? `Installed. ${state.reason}`
              : state.recommended
                ? `Graite downloads it, checks it and runs it for you. Nothing else is installed on your computer, and you can remove it with one click. ${state.reason}`
                : state.reason}
          </small>
        </div>
        {working ? (
          <div className="ai-engine-progress" role="status">
            <Loader2 size={15} className="animate-spin" />
            <span>
              {WORKING[state.status]}{" "}
              {state.status === "downloading" ? `${Math.round(state.progress)}%` : "…"}
            </span>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => void run(() => engines.cancel(engineId))}
            >
              Cancel
            </Button>
          </div>
        ) : installed && !state.update_available ? (
          <span className="ai-engine-ok">
            <Check size={15} /> Ready
          </span>
        ) : (
          <Button
            size="sm"
            disabled={disabled || !state.recommended}
            onClick={() => void run(() => engines.install(engineId))}
          >
            <Download size={14} /> {installed ? "Update" : `Install${size ? ` · ${size}` : ""}`}
          </Button>
        )}
      </div>
      {state.error && (
        <p className="ai-error" role="alert">
          {state.error}
        </p>
      )}
      <details className="ai-advanced">
        <summary>Build options</summary>
        {!!state.variants?.length && (
          <label className="ai-field">
            Build
            <ModelSelect
              label="Build"
              value={chosen}
              disabled={disabled || working}
              onValueChange={setVariant}
            >
              {state.variants.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.label} · {megabytes(variantSize(v))}
                  {v.id === state.recommended ? " · recommended" : ""}
                </option>
              ))}
            </ModelSelect>
            <small>
              Graite picks the recommended build by itself. Vulkan uses an AMD, Intel or NVIDIA
              graphics card and does not need CUDA; CUDA is a separate, larger NVIDIA-only build
              that needs a matching driver; CPU builds use the processor only.
              {engineId === "crispasr" &&
                " Choose a graphics-card build if you have one — speech generated on the processor is usually too slow to hold a conversation."}
            </small>
          </label>
        )}
        <div className="ai-engine-actions">
          <Button
            variant="outline"
            size="sm"
            disabled={
              disabled ||
              working ||
              !chosen ||
              (chosen === state.installed_variant && !state.update_available)
            }
            onClick={() => void run(() => engines.install(engineId, chosen))}
          >
            Install this build
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={disabled || working || !state.previous_version}
            onClick={() => void run(() => engines.rollback(engineId))}
          >
            Roll back{state.previous_version ? ` to ${state.previous_version}` : ""}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={disabled || working || !installed}
            onClick={() => void run(() => engines.remove(engineId))}
          >
            Remove
          </Button>
        </div>
        <small className="ai-engine-version">
          {installed
            ? `Installed ${state.installed_version} (${state.installed_variant}).`
            : "Not installed."}{" "}
          This version of Graite was tested with {state.version}.
          {/* An override set outside the app would otherwise look like Graite's own build. */}
          {state.custom_path ? (
            <>
              {" "}
              Running a build of your own: <code>{state.custom_path}</code>.
            </>
          ) : (
            state.path && (
              <>
                {" "}
                Running <code>{state.path}</code>.
              </>
            )
          )}
        </small>
      </details>
    </section>
  );
}
