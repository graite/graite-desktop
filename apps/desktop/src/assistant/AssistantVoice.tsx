import { ModelSelect } from "@/models/ModelSelect";
import { useEffect, useRef, useState } from "react";
import { Play } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { assistant, bodyOf, type AssistantInfo } from "@/lib/assistant";
import { BUILT_IN_VOICE, voice as voiceApi, type VoiceInfo, type VoiceStatus } from "@/lib/voice";

const LANGUAGES: [string, string][] = [
  ["auto", "The language I speak"],
  ["en", "English"],
  ["nl", "Dutch"],
  ["de", "German"],
  ["fr", "French"],
  ["es", "Spanish"],
  ["it", "Italian"],
  ["pt", "Portuguese"],
  ["pl", "Polish"],
  ["sv", "Swedish"],
  ["da", "Danish"],
  ["no", "Norwegian"],
  ["fi", "Finnish"],
  ["el", "Greek"],
  ["tr", "Turkish"],
  ["ru", "Russian"],
  ["ar", "Arabic"],
  ["he", "Hebrew"],
  ["hi", "Hindi"],
  ["ja", "Japanese"],
  ["ko", "Korean"],
  ["zh", "Chinese"],
  ["ms", "Malay"],
  ["sw", "Swahili"],
];

/** How the assistant sounds: which voice, which language, how lively. Voices are made and
 * tested in Settings → Voice; here one is chosen. */
export function AssistantVoice({
  info,
  onSaved,
  onSettings,
}: {
  info: AssistantInfo;
  onSaved: (info: AssistantInfo) => void;
  onSettings: (tab?: "voice") => void;
}) {
  const current = info.voice ?? { language: "auto", exaggeration: 0.5, cfg: 0.5 };
  const [status, setStatus] = useState<VoiceStatus | null>(null);
  const [voices, setVoices] = useState<VoiceInfo[]>([]);
  const [busy, setBusy] = useState("");
  const audio = useRef<HTMLAudioElement | null>(null);
  useEffect(() => {
    void voiceApi
      .status()
      .then(setStatus)
      .catch(() => setStatus(null));
    void voiceApi
      .voices()
      .then(setVoices)
      .catch(() => setVoices([]));
  }, [info]);
  useEffect(() => () => audio.current?.pause(), []);

  const run = async (label: string, work: () => Promise<void>) => {
    setBusy(label);
    try {
      await work();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy("");
    }
  };
  const patch = (next: Partial<typeof current>) =>
    run("Saving", async () =>
      onSaved(await assistant.save({ ...bodyOf(info), voice: { ...current, ...next } })),
    );
  const chosen =
    current.voice_id && voices.some((v) => v.id === current.voice_id)
      ? current.voice_id
      : BUILT_IN_VOICE;
  const sample = () =>
    run("Speaking", async () => {
      const { blob } = await voiceApi.sample({
        voiceId: chosen,
        language: current.language === "auto" ? "en" : current.language,
        exaggeration: current.exaggeration,
        cfg: current.cfg,
      });
      const url = URL.createObjectURL(blob);
      audio.current?.pause();
      audio.current = new Audio(url);
      audio.current.onended = () => URL.revokeObjectURL(url);
      await audio.current.play();
    });
  const missing = status && !status.ready ? (status.missing ?? []) : [];
  return (
    <div className="assistant-pane" data-page-scroll>
      <h2>Voice</h2>
      <p>
        {info.name} speaks with a voice model that runs on this computer. Everything it says is
        marked as AI-generated audio with an inaudible watermark.
      </p>
      {!!missing.length && (
        <div className="ai-notice assistant-optin">
          <span>To talk, set up: {missing.map((m) => m.text.replace(/\.$/, "")).join(", ")}.</span>
          <Button size="sm" onClick={() => onSettings("voice")}>
            Open Settings
          </Button>
        </div>
      )}
      <div className="assistant-voice-grid">
        <label>
          <span>Voice</span>
          <ModelSelect
            label="Voice"
            value={chosen}
            disabled={!!busy}
            onValueChange={(value) =>
              void patch({ voice_id: value === BUILT_IN_VOICE ? null : value })
            }
          >
            <option value={BUILT_IN_VOICE}>Built-in voice</option>
            {voices.map((v) => (
              <option key={v.id} value={v.id}>
                {v.name}
              </option>
            ))}
          </ModelSelect>
          <small>
            <button className="assistant-link" onClick={() => onSettings("voice")}>
              Add or test voices in Settings
            </button>
          </small>
        </label>
        <label>
          <span>Language</span>
          <ModelSelect
            label="Language"
            value={current.language ?? "auto"}
            disabled={!!busy}
            onValueChange={(language) => void patch({ language })}
          >
            {LANGUAGES.map(([code, label]) => (
              <option key={code} value={code}>
                {label}
              </option>
            ))}
          </ModelSelect>
          <small>“The language I speak” follows what speech recognition hears, turn by turn.</small>
        </label>
        <label>
          <span>Expressiveness · {Number(current.exaggeration ?? 0.5).toFixed(2)}</span>
          <input
            type="range"
            min={0}
            max={1.5}
            step={0.05}
            defaultValue={current.exaggeration ?? 0.5}
            disabled={!!busy}
            onPointerUp={(e) =>
              void patch({ exaggeration: Number((e.target as HTMLInputElement).value) })
            }
            onKeyUp={(e) =>
              void patch({ exaggeration: Number((e.target as HTMLInputElement).value) })
            }
          />
          <small>Higher is livelier and less steady.</small>
        </label>
        <label>
          <span>Pace and steadiness · {Number(current.cfg ?? 0.5).toFixed(2)}</span>
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            defaultValue={current.cfg ?? 0.5}
            disabled={!!busy}
            onPointerUp={(e) => void patch({ cfg: Number((e.target as HTMLInputElement).value) })}
            onKeyUp={(e) => void patch({ cfg: Number((e.target as HTMLInputElement).value) })}
          />
          <small>Lower it when a cloned voice speaks another language than its recording.</small>
        </label>
      </div>
      <Button
        variant="outline"
        size="sm"
        disabled={!!busy || !!missing.find((m) => m.key.startsWith("tts"))}
        onClick={() => void sample()}
      >
        <Play size={14} /> {busy === "Speaking" ? "Speaking…" : "Hear a sample"}
      </Button>
    </div>
  );
}
