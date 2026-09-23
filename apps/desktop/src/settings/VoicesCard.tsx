import { useCallback, useEffect, useRef, useState } from "react";
import { AudioLines, Play, Trash2, Upload } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Recorder } from "@/editor/media/Recorder";
import { BUILT_IN_VOICE, voice as voiceApi, type VoiceInfo } from "@/lib/voice";
import "./settings.css";

const ACCEPT = "audio/*,.wav,.mp3,.m4a,.ogg,.webm,.flac";

/** Voices your assistant can speak with: made and tried here, chosen on the assistant's page. */
export function VoicesCard() {
  const [voices, setVoices] = useState<VoiceInfo[]>([]);
  const [name, setName] = useState("");
  const [consent, setConsent] = useState(false);
  const [recording, setRecording] = useState(false);
  const [busy, setBusy] = useState("");
  const picker = useRef<HTMLInputElement>(null);
  const player = useRef<HTMLAudioElement | null>(null);
  const refresh = useCallback(() => {
    void voiceApi
      .voices()
      .then(setVoices)
      .catch(() => setVoices([]));
  }, []);
  useEffect(refresh, [refresh]);
  useEffect(() => () => player.current?.pause(), []);

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
  const hear = (voiceId: string) =>
    run(`hear:${voiceId}`, async () => {
      const { blob } = await voiceApi.sample({ voiceId });
      const url = URL.createObjectURL(blob);
      player.current?.pause();
      player.current = new Audio(url);
      player.current.onended = () => URL.revokeObjectURL(url);
      await player.current.play();
    });
  const add = (file: Blob, filename: string) =>
    run("Adding the voice", async () => {
      const made = await voiceApi.addVoice(file, name.trim() || "My voice", filename, consent);
      toast.success(`“${made.name}” added from ${made.seconds} seconds of speech`);
      setName("");
      setRecording(false);
      refresh();
    });
  return (
    <section className="settings-voices" aria-label="Voices">
      <div className="ai-section-heading">
        <h2>Voices</h2>
        <span>Choose one on your assistant’s Voice tab</span>
      </div>
      <div className="settings-voice-row">
        <AudioLines size={16} />
        <div>
          <strong>Built-in voice</strong>
          <small>The voice that comes with the model.</small>
        </div>
        <Button
          variant="ghost"
          size="sm"
          disabled={!!busy}
          onClick={() => void hear(BUILT_IN_VOICE)}
        >
          <Play size={14} /> {busy === `hear:${BUILT_IN_VOICE}` ? "Speaking…" : "Hear it"}
        </Button>
      </div>
      {voices.map((v) => (
        <div className="settings-voice-row" key={v.id}>
          <AudioLines size={16} />
          <div>
            <strong>{v.name}</strong>
            <small>
              Cloned from {v.seconds} s of speech · added {v.created_at.slice(0, 10)}
            </small>
          </div>
          <Button variant="ghost" size="sm" disabled={!!busy} onClick={() => void hear(v.id)}>
            <Play size={14} /> {busy === `hear:${v.id}` ? "Speaking…" : "Hear it"}
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="size-8"
            aria-label={`Delete ${v.name}`}
            disabled={!!busy}
            onClick={() =>
              void run("Deleting", async () => {
                await voiceApi.deleteVoice(v.id);
                refresh();
              })
            }
          >
            <Trash2 size={14} />
          </Button>
        </div>
      ))}
      <section className="settings-custom-voice" aria-label="Add a custom voice">
        <h3>Add a custom voice</h3>
        <p className="ai-library-intro">
          10 to 30 seconds of clear speech by one person, without music or noise. Everything it says
          is marked as AI-generated with an inaudible watermark.
        </p>
        <label className="ai-field">
          Name
          <input
            aria-label="Voice name"
            value={name}
            maxLength={60}
            placeholder="My voice"
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <label className="settings-consent">
          <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
          <span>
            This is my own voice, or I have the speaker’s permission to use it. I understand the
            speech it produces is AI-generated.
          </span>
        </label>
        <div className="settings-voice-actions">
          <input
            ref={picker}
            type="file"
            hidden
            accept={ACCEPT}
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = "";
              if (file) void add(file, file.name);
            }}
          />
          <Button
            variant="outline"
            size="sm"
            disabled={!consent || !!busy}
            onClick={() => picker.current?.click()}
          >
            <Upload size={14} />{" "}
            {busy === "Adding the voice" ? "Adding the voice…" : "Upload a recording"}
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={!consent || !!busy}
            onClick={() => setRecording((old) => !old)}
          >
            {recording ? "Cancel recording" : "Record now"}
          </Button>
        </div>
        {recording && consent && (
          <Recorder
            onSave={async (blob, filename) => {
              await add(blob, filename);
            }}
          />
        )}
      </section>
    </section>
  );
}
