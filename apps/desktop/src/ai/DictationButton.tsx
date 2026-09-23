import { useEffect, useRef, useState } from "react";
import { Loader2, Mic, Square } from "lucide-react";
import { toast } from "sonner";
import { request } from "@/lib/api";
import { platform } from "@/lib/platform";
import { AudioRecorder } from "@/lib/platform/audio-recorder";

export const WHISPER_UNAVAILABLE =
  "Whisper is not loaded. Download the Whisper speech model in Settings → Voice to use dictation.";

export function DictationButton({
  available,
  busy,
  value,
  onChange,
  onWorking,
}: {
  available: boolean;
  busy: boolean;
  value: string;
  onChange: (text: string) => void;
  onWorking: (working: boolean) => void;
}) {
  const [state, setState] = useState<"idle" | "starting" | "recording" | "transcribing">("idle");
  const recording = useRef<AudioRecorder | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const alive = useRef(true);
  const latest = useRef({ value, onChange, onWorking });
  latest.current = { value, onChange, onWorking };
  const abort = useRef<AbortController | null>(null);
  const release = () => {
    stream.current?.getTracks().forEach((t) => t.stop());
    stream.current = null;
    if (timer.current) clearTimeout(timer.current);
  };
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      if (recording.current) {
        recording.current.onstop = null;
        recording.current.stop();
      }
      release();
      abort.current?.abort();
      latest.current.onWorking(false);
    };
  }, []);
  const start = async () => {
    if (!available) {
      toast.error(WHISPER_UNAVAILABLE, { position: "bottom-right" });
      return;
    }
    if (busy || state !== "idle") return;
    setState("starting");
    latest.current.onWorking(true);
    try {
      const input = await platform.microphone();
      if (!alive.current) {
        input.getTracks().forEach((t) => t.stop());
        return;
      }
      stream.current = input;
      const recorder = new AudioRecorder(input, true);
      recording.current = recorder;
      const chunks: Blob[] = [];
      recorder.ondataavailable = (event) => {
        if (event.data.size) chunks.push(event.data);
      };
      recorder.onerror = () => {
        recorder.onstop = null;
        recorder.stop();
        release();
        setState("idle");
        latest.current.onWorking(false);
        toast.error("Could not record your microphone. Try again.", { position: "bottom-right" });
      };
      recorder.onstop = () => {
        release();
        if (!alive.current) return;
        setState("transcribing");
        const controller = new AbortController();
        abort.current = controller;
        void request<{ text: string }>("/api/v1/ai/speech/check", {
          method: "POST",
          body: new Blob(chunks, { type: "audio/wav" }),
          headers: { "Content-Type": "audio/wav" },
          signal: controller.signal,
        })
          .then((result) => {
            if (!alive.current) return;
            if (result.text.trim())
              latest.current.onChange(
                [latest.current.value.trimEnd(), result.text.trim()].filter(Boolean).join(" "),
              );
            else
              toast.info("No speech detected. Try recording again.", { position: "bottom-right" });
          })
          .catch((error: Error) => {
            if (alive.current) toast.error(error.message, { position: "bottom-right" });
          })
          .finally(() => {
            if (alive.current) {
              setState("idle");
              latest.current.onWorking(false);
            }
          });
      };
      await recorder.start();
      if (!alive.current) {
        recorder.onstop = null;
        recorder.stop();
        release();
        return;
      }
      setState("recording");
      timer.current = setTimeout(() => recorder.stop(), 295_000);
    } catch (error) {
      release();
      if (alive.current) {
        setState("idle");
        latest.current.onWorking(false);
        toast.error((error as Error).message, { position: "bottom-right" });
      }
    }
  };
  const label =
    state === "recording"
      ? "Stop dictation"
      : state === "transcribing"
        ? "Transcribing…"
        : state === "starting"
          ? "Opening microphone…"
          : "Dictate";
  return (
    <button
      type="button"
      className="ai-composer-icon ai-dictation"
      data-recording={state === "recording" || undefined}
      aria-label={label}
      title={!available ? WHISPER_UNAVAILABLE : label}
      aria-disabled={!available || busy || state === "starting" || state === "transcribing"}
      disabled={busy || state === "starting" || state === "transcribing"}
      onClick={() => (state === "recording" ? recording.current?.stop() : void start())}
    >
      {state === "recording" ? (
        <Square size={14} />
      ) : state === "transcribing" || state === "starting" ? (
        <Loader2 size={16} className="ai-spin" />
      ) : (
        <Mic size={17} />
      )}
    </button>
  );
}
