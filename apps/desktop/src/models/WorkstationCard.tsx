import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { compute, type ComputeDevice, type ComputeStatus, type ComputeTask } from "@/lib/compute";
import type { components } from "@graite/api-types";
import { ModelSelect } from "./ModelSelect";
import "./cloud.css";

type AIConfig = components["schemas"]["AIConfig"];

const TASKS: { what: ComputeTask; label: string; hint: string }[] = [
  { what: "chat", label: "Chat", hint: "Answers your questions" },
  { what: "documents", label: "Documents", hint: "Reads scans and PDFs" },
  { what: "speech", label: "Speech", hint: "Turns what you say into text" },
  { what: "voice", label: "Voice", hint: "Speaks for your assistant" },
];

const offered = (device: ComputeDevice, what: ComputeTask) =>
  what === "chat" ? device.chat_models.length > 0 : device[what];

/** What this computer has for the others, in words. */
function lends(status: ComputeStatus): string {
  const parts = [
    status.chat_model && "chat",
    status.documents && "documents",
    status.speech && "speech",
    status.voice && "voice",
  ].filter(Boolean);
  if (parts.length === 0)
    return "There are no local AI models on this computer yet. Download one under Chat first.";
  return `Your other devices can use it for ${parts.join(", ")}, while Graite is open here.`;
}

/** Settings → AI workstation: two separate things. Above, let another of your computers do
 * the AI work for this one. Below, let this computer do it for the others. */
export function WorkstationCard({
  status,
  shared,
  refresh,
  onStatus,
  onUsed,
  onOpenSync,
}: {
  status: ComputeStatus | null;
  /** Whether this vault is shared with your other devices; null while that is unknown. */
  shared: boolean | null;
  refresh: () => Promise<void>;
  onStatus: (status: ComputeStatus) => void;
  /** A task moved to or from another computer: the saved settings changed. */
  onUsed?: (config: AIConfig) => void;
  onOpenSync: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (e) {
      setError(e instanceof Error ? e.message : "That did not work. Try again.");
    } finally {
      setBusy(false);
    }
  };
  const use = (device: ComputeDevice, what: ComputeTask, on: boolean, model?: string) =>
    void run(async () => {
      const saved = await compute.use(device.id, what, on, model);
      onUsed?.(saved);
      await refresh();
    });

  const devices = status?.devices ?? [];
  return (
    <>
      <section className="settings-card" aria-label="Use a workstation">
        <h2>Use a workstation from this computer</h2>
        {error && (
          <p className="ai-error" role="alert">
            {error}
          </p>
        )}
        {shared === false ? (
          <div className="sync-choice">
            <div>
              <strong>First share this vault with that computer</strong>
              <small>A workstation is one of the devices you sync with.</small>
            </div>
            <Button variant="outline" size="sm" onClick={onOpenSync}>
              Open Sync devices
            </Button>
          </div>
        ) : devices.length > 0 ? (
          <>
            <p>Switch on what it should do for this computer. Everything else stays as it is.</p>
            {devices.map((device) => (
              <div className="workstation" key={device.id} role="group" aria-label={device.name}>
                <strong>
                  <i aria-hidden /> {device.name}
                </strong>
                {TASKS.filter(({ what }) => offered(device, what)).map(({ what, label, hint }) => (
                  <div className="workstation-task" key={what}>
                    <div>
                      <label htmlFor={`use-${device.id}-${what}`}>{label}</label>
                      <small>{hint}</small>
                    </div>
                    {what === "chat" && device.chat_models.length === 1 && (
                      <span className="workstation-model">{device.chat_model}</span>
                    )}
                    {what === "chat" && device.chat_models.length > 1 && (
                      <ModelSelect
                        label={`Chat model on ${device.name}`}
                        value={device.chat_model ?? ""}
                        disabled={busy}
                        onValueChange={(model) =>
                          // Choosing a model is choosing to chat with it.
                          use(device, "chat", true, model)
                        }
                      >
                        {device.chat_models.map((model) => (
                          <option key={model} value={model}>
                            {model}
                          </option>
                        ))}
                      </ModelSelect>
                    )}
                    <Switch
                      id={`use-${device.id}-${what}`}
                      aria-label={`${label} on ${device.name}`}
                      checked={device.uses.includes(what)}
                      disabled={busy}
                      onCheckedChange={(on) =>
                        use(
                          device,
                          what,
                          on,
                          what === "chat" ? (device.chat_model ?? undefined) : undefined,
                        )
                      }
                    />
                  </div>
                ))}
              </div>
            ))}
          </>
        ) : (
          <>
            <p>No workstation is switched on yet. On your strong computer:</p>
            <ol className="workstation-steps">
              <li>Open Graite with this same vault (Settings → Sync devices).</li>
              <li>Download a model under Settings → Chat.</li>
              <li>Open Settings → AI workstation and switch on the card below.</li>
            </ol>
            <p className="cloud-muted">It then shows up here within a few seconds.</p>
          </>
        )}
      </section>
      {status && (
        <section className="settings-card" aria-label="Be a workstation">
          <h2>Turn this computer into a workstation</h2>
          <div className="sync-choice">
            <div>
              <label htmlFor="compute-serve">
                <strong>Let my other devices use the AI on this computer</strong>
              </label>
              <small>{lends(status)}</small>
            </div>
            <Switch
              id="compute-serve"
              aria-label="Let my other devices use the AI on this computer"
              checked={status.serving}
              disabled={busy}
              onCheckedChange={(on) => void run(async () => onStatus(await compute.serve(on)))}
            />
          </div>
        </section>
      )}
    </>
  );
}
