import { useCallback, useEffect, useRef, useState } from "react";
import { platform } from "@/lib/platform";
import { startCapture, type Capture } from "@/lib/platform/audio-capture";
import { cancelsEcho } from "@/lib/platform/recording";
import { PcmPlayer } from "@/lib/pcm-player";
import { VoiceSocket, type VoiceServerEvent } from "@/lib/voice";

export type VoicePhase =
  "idle" | "connecting" | "loading" | "listening" | "transcribing" | "thinking" | "speaking";

export interface VoiceLine {
  role: "user" | "assistant";
  text: string;
}

const BARGE_IN_KEY = "graite.voice.bargeIn";

/** Interrupting by speaking is on unless this device switched it off. */
function bargeInPreference(): boolean {
  try {
    return localStorage.getItem(BARGE_IN_KEY) !== "off";
  } catch {
    return true;
  }
}

/** What the talk bar says while a tool runs; the daemon speaks a matching filler. */
export function toolStatus(name: string): string {
  if (name.startsWith("search_") || name === "run_query_ro") return "Searching your pages…";
  if (name === "list_children") return "Looking through your pages…";
  if (name.startsWith("read_") || name === "load_skill") return "Reading a page…";
  if (name.startsWith("propose_") || name === "schedule") return "Preparing a change…";
  return "Working on it…";
}

/** Once the daemon says the microphone delivers nothing, how long before the call ends. A
 * dead capture pipeline in WebKitGTK is fragile; streaming silence into it does not help. */
const SILENT_STOP_MS = 10_000;
const MIC_LOST =
  "The microphone stopped working, so the conversation ended. Check the input in your computer’s Sound settings, then press Talk again.";
const MIC_SILENT =
  "No sound reached Graite from your microphone, so the conversation ended. Check the input in your computer’s Sound settings or in Settings → Voice, then press Talk again.";

const CLOSE_REASONS: Record<number, string> = {
  4401: "The voice connection was refused.",
  4409: "A voice conversation is already running.",
};

/** A live voice conversation: microphone up, the assistant's speech down, and the state in
 * between. The daemon saves the turns; `onTurnSaved` tells the page to reload them. */
export function useVoiceSession(options: { onTurnSaved: () => void }) {
  const [phase, setPhase] = useState<VoicePhase>("idle");
  const [lines, setLines] = useState<VoiceLine[]>([]);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [level, setLevel] = useState(0);
  const [userSpeaking, setUserSpeaking] = useState(false);
  const [muted, setMuted] = useState(false);
  const [bargeIn, setBargeInState] = useState(bargeInPreference);
  const [checking, setChecking] = useState(false);
  const [echoSafe, setEchoSafe] = useState(false);
  /** The daemon gets no sound from the microphone (nothing at all, or digital silence). */
  const [silent, setSilent] = useState<"no_audio" | "silence" | null>(null);
  const socket = useRef<VoiceSocket | null>(null);
  const capture = useRef<Capture | null>(null);
  const player = useRef<PcmPlayer | null>(null);
  const progress = useRef<ReturnType<typeof setInterval> | undefined>(undefined);
  const silentStop = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  /** Removes the microphone watchers added for this call. */
  const unwatch = useRef<(() => void) | null>(null);
  /** Ends the call from inside an event handler; set once `stop` exists. */
  const endWith = useRef<(message: string) => void>(() => {});
  const lastLevel = useRef(0);
  /** Tool calls started and not yet finished: the status line clears when none are left. */
  const tools = useRef(new Set<string>());
  const saved = useRef(options.onTurnSaved);
  saved.current = options.onTurnSaved;

  const teardown = useCallback(() => {
    clearInterval(progress.current);
    clearTimeout(silentStop.current);
    unwatch.current?.();
    unwatch.current = null;
    capture.current?.stop();
    capture.current = null;
    player.current?.close();
    player.current = null;
    socket.current?.close();
    socket.current = null;
    setPhase("idle");
    setUserSpeaking(false);
    setSilent(null);
    setChecking(false);
    setLevel(0);
    setStatus("");
  }, []);

  const handle = useCallback((event: VoiceServerEvent) => {
    switch (event.type) {
      case "ready":
        player.current?.close();
        player.current = new PcmPlayer(event.sample_rate);
        player.current.unlock();
        break;
      case "state":
        setPhase(event.state);
        if (event.state === "listening") {
          tools.current.clear();
          setStatus("");
          saved.current();
        }
        break;
      case "vad":
        setUserSpeaking(event.speaking);
        break;
      case "transcript":
        setLines((old) => [...old.slice(-5), { role: "user", text: event.text }]);
        break;
      case "status":
        setStatus(event.text);
        break;
      case "tool_start":
        tools.current.add(event.id ?? event.name);
        setStatus(toolStatus(event.name));
        break;
      case "tool_end":
        tools.current.delete(event.id ?? event.name);
        if (!tools.current.size) setStatus("");
        break;
      case "audio_start":
        if (event.utterance === 0) {
          player.current?.reset();
          clearInterval(progress.current);
          progress.current = setInterval(() => {
            socket.current?.send({ type: "played", ms: player.current?.playedMs() ?? 0 });
          }, 100);
        }
        setLines((old) => {
          const last = old[old.length - 1];
          if (event.utterance > 0 && last?.role === "assistant") {
            return [...old.slice(0, -1), { role: "assistant", text: `${last.text} ${event.text}` }];
          }
          return [...old.slice(-5), { role: "assistant", text: event.text }];
        });
        break;
      case "speech_end":
        player.current?.drain(() => {
          clearInterval(progress.current);
          socket.current?.send({
            type: "played",
            ms: player.current?.playedMs() ?? event.ms,
            done: true,
          });
        });
        break;
      case "interrupted":
        clearInterval(progress.current);
        player.current?.flush();
        setChecking(false);
        break;
      case "input_silent":
        setSilent(event.reason);
        clearTimeout(silentStop.current);
        silentStop.current = setTimeout(() => endWith.current(MIC_SILENT), SILENT_STOP_MS);
        break;
      case "input_ok":
        setSilent(null);
        clearTimeout(silentStop.current);
        break;
      case "duck":
        player.current?.duck(event.on);
        break;
      case "barge_in":
        setChecking(event.state === "checking");
        break;
      case "error":
        setError(event.text);
        break;
      default:
        break;
    }
  }, []);

  const start = useCallback(
    async (conversationId: string, wantBargeIn = bargeInPreference()) => {
      if (socket.current) return;
      setError("");
      setLines([]);
      setPhase("connecting");
      let stream: MediaStream | null = null;
      try {
        stream = await platform.microphone({ voice: true });
        const track = stream.getAudioTracks()[0];
        if (!track || track.readyState === "ended") throw new Error(MIC_LOST);
        const safe = cancelsEcho(stream);
        setEchoSafe(safe);
        const next = new VoiceSocket();
        socket.current = next;
        await next.open(conversationId, wantBargeIn, {
          onEvent: handle,
          onAudio: (data) => player.current?.enqueue(data),
          onClose: (code) => {
            if (CLOSE_REASONS[code]) setError((old) => old || CLOSE_REASONS[code]);
            if (socket.current === next) {
              socket.current = null;
              teardown();
              saved.current();
            }
          },
        });
        setBargeInState(wantBargeIn);
        const opened = stream;
        capture.current = await startCapture(
          opened,
          (frame) => next.sendAudio(frame),
          (value) => {
            // Re-render for the meter a few times a second, not on every audio callback.
            if (Math.abs(value - lastLevel.current) > 0.04) {
              lastLevel.current = value;
              setLevel(value);
            }
          },
        );
        unwatch.current = watchMicrophone(track, () => endWith.current(MIC_LOST));
      } catch (e) {
        const denied = (e as DOMException).name === "NotAllowedError";
        setError(
          denied
            ? "Graite needs microphone access to talk. Allow it and try again."
            : (e as Error).message,
        );
        // Setup failed before the capture owned the stream: release the microphone here.
        if (!capture.current) stream?.getTracks().forEach((t) => t.stop());
        teardown();
      }
    },
    [handle, teardown],
  );

  const stop = useCallback(() => {
    teardown();
    saved.current();
  }, [teardown]);
  endWith.current = (message: string) => {
    setError(message);
    stop();
  };

  const interrupt = useCallback(() => {
    const ms = player.current?.flush() ?? 0;
    clearInterval(progress.current);
    socket.current?.send({ type: "interrupt", ms });
  }, []);

  const toggleMute = useCallback(() => {
    setMuted((old) => {
      socket.current?.send({ type: "mute", on: !old });
      return !old;
    });
  }, []);

  const setBargeIn = useCallback((on: boolean) => {
    setBargeInState(on);
    try {
      localStorage.setItem(BARGE_IN_KEY, on ? "on" : "off");
    } catch {
      /* private mode: the choice lasts for this session */
    }
    socket.current?.send({ type: "barge_in", on });
  }, []);

  useEffect(() => teardown, [teardown]);

  return {
    phase,
    active: phase !== "idle",
    lines,
    status,
    error,
    setError,
    level,
    userSpeaking,
    checking,
    silent,
    muted,
    bargeIn,
    echoSafe,
    start,
    stop,
    interrupt,
    toggleMute,
    setBargeIn,
  };
}

/** Call `onLost` when the microphone goes away mid-call: the track ends (unplugged, taken by
 * another app) or the system no longer lists any input. Returns the cleanup. */
export function watchMicrophone(track: MediaStreamTrack, onLost: () => void): () => void {
  let done = false;
  const lost = () => {
    if (done) return;
    done = true;
    onLost();
  };
  const devices = navigator.mediaDevices;
  const changed = () => {
    if (!devices?.enumerateDevices) return;
    devices
      .enumerateDevices()
      .then((list) => {
        if (!list.some((d) => d.kind === "audioinput")) lost();
      })
      .catch(() => {});
  };
  track.addEventListener("ended", lost);
  devices?.addEventListener?.("devicechange", changed);
  return () => {
    done = true;
    track.removeEventListener("ended", lost);
    devices?.removeEventListener?.("devicechange", changed);
  };
}
