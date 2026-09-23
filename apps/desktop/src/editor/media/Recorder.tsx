import { useEffect, useRef, useState } from "react";
import { Mic, Square, Download } from "lucide-react";
import { AudioRecorder } from "@/lib/platform/audio-recorder";
import { AudioPlayer } from "./AudioPlayer";
import { platform } from "@/lib/platform";
import { Button } from "@/components/ui/button";

export function Recorder({ onSave }: { onSave: (blob: Blob, name: string) => Promise<void> }) {
  const [recording, setRecording] = useState(false);
  const [starting, setStarting] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [error, setError] = useState("");
  const [take, setTake] = useState<{ blob: Blob; url: string; name: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const recorder = useRef<AudioRecorder | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
      if (recorder.current?.state === "recording") recorder.current.stop();
      stream.current?.getTracks().forEach((t) => t.stop());
    };
  }, []);
  useEffect(() => {
    if (!recording && !saving && !take) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [recording, saving, take]);
  useEffect(
    () => () => {
      if (take) URL.revokeObjectURL(take.url);
    },
    [take],
  );
  useEffect(() => {
    if (!recording) return;
    const timer = setInterval(() => setSeconds((n) => n + 1), 1000);
    return () => clearInterval(timer);
  }, [recording]);
  const stop = () => {
    if (recorder.current?.state === "recording") recorder.current.stop();
    stream.current?.getTracks().forEach((t) => t.stop());
    setRecording(false);
  };
  const save = async (value: NonNullable<typeof take>) => {
    setSaving(true);
    setError("");
    try {
      await onSave(value.blob, value.name);
    } catch (e) {
      if (live.current)
        setError(
          `Could not save: ${(e as Error).message}. Your recording is still here; retry or download it.`,
        );
    } finally {
      if (live.current) setSaving(false);
    }
  };
  const start = async () => {
    setError("");
    setStarting(true);
    try {
      const input = await platform.microphone();
      if (!live.current) {
        input.getTracks().forEach((t) => t.stop());
        return;
      }
      stream.current = input;
      const r = new AudioRecorder(input);
      recorder.current = r;
      const chunks: Blob[] = [];
      let size = 0;
      const started = Date.now();
      r.ondataavailable = (e) => {
        if (e.data.size) {
          chunks.push(e.data);
          size += e.data.size;
        }
        if (
          (size > 190 * 1024 * 1024 || Date.now() - started > 3590_000) &&
          r.state === "recording"
        )
          stop();
      };
      r.onerror = () => {
        setError("Recording interrupted. Any captured audio will be saved.");
        stop();
      };
      r.onstop = () => {
        input.getTracks().forEach((t) => t.stop());
        if (live.current) setRecording(false);
        const type = r.mimeType || chunks[0]?.type || "audio/webm";
        const blob = new Blob(chunks, { type });
        if (!blob.size) {
          setError("No audio was recorded. Try another microphone.");
          return;
        }
        const ext = type.includes("wav")
          ? "wav"
          : type.includes("mp4")
            ? "m4a"
            : type.includes("ogg")
              ? "ogg"
              : "webm";
        const value = {
          blob,
          url: URL.createObjectURL(blob),
          name: `Recording ${new Date().toISOString().replace(/[:.]/g, "-")}.${ext}`,
        };
        if (live.current) {
          setTake(value);
          void save(value);
        } else {
          URL.revokeObjectURL(value.url);
          void onSave(value.blob, value.name).catch(() => {});
        }
      };
      await r.start(1000);
      if (!live.current) {
        r.stop();
        return;
      }
      setSeconds(0);
      setRecording(true);
    } catch (e) {
      stream.current?.getTracks().forEach((t) => t.stop());
      setError(
        (e as Error).name === "NotAllowedError"
          ? "Microphone access was denied. Allow access in your system settings, then try again."
          : (e as Error).message,
      );
    } finally {
      if (live.current) setStarting(false);
    }
  };
  return (
    <div className="media-recorder">
      <p>Record a voice note. Stop to save it in this page’s local folder.</p>
      {recording ? (
        <Button onClick={stop}>
          <Square size={14} fill="currentColor" /> Stop & save · {Math.floor(seconds / 60)}:
          {String(seconds % 60).padStart(2, "0")}
        </Button>
      ) : (
        !take && (
          <Button onClick={() => void start()} disabled={starting}>
            <Mic size={15} />
            {starting ? "Opening microphone…" : "Start recording"}
          </Button>
        )
      )}
      {recording && (
        <small className="media-recording" role="status">
          Recording · stay on this page until you stop.
        </small>
      )}
      {take && (
        <>
          <AudioPlayer key={take.url} src={take.url} name={take.name} />
          <div className="media-actions">
            <Button disabled={saving} onClick={() => void save(take)}>
              {saving ? "Saving locally…" : "Retry saving"}
            </Button>
            <a href={take.url} download={take.name}>
              <Download size={14} /> Download recording
            </a>
          </div>
        </>
      )}
      {error && (
        <p role="alert" className="media-error">
          {error}
        </p>
      )}
    </div>
  );
}
