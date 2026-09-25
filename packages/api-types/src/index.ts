/**
 * Types shared between the daemon and its clients.
 * `schema.d.ts` is generated from the daemon's OpenAPI (`pnpm generate`) and checked in.
 * Hand-written types below cover what OpenAPI cannot express (WebSocket events).
 */
export type { paths, components } from "./schema";

export interface DaemonEvent<T extends string = string, D = Record<string, unknown>> {
  type: T;
  data: D;
}

export type PingEvent = DaemonEvent<"ping", Record<string, never>>;

/** The Graite Cloud sign-in changed (browser sign-in finished, or signed out). */
export type CloudStatusEvent = DaemonEvent<"cloud_status", { signed_in: boolean }>;

/** A run row or one of its steps changed (agent runs, chat turns, live notes). */
export type RunUpdateEvent = DaemonEvent<
  "run_update",
  {
    id: string;
    kind: string;
    agent: string | null;
    job_id: string | null;
    status: string;
    step: {
      ord: number;
      kind: string;
      name: string | null;
      status: string;
      input?: Record<string, unknown>;
      output?: Record<string, unknown>;
    } | null;
  }
>;

/** States of a voice conversation with the assistant (`/api/v1/voice/session`). */
export type VoiceState = "loading" | "listening" | "transcribing" | "thinking" | "speaking";

/** JSON events the voice socket sends. Binary frames between `audio_start` and `audio_end`
 * are 16-bit little-endian mono PCM at `sample_rate`. */
export type VoiceServerEvent =
  | { type: "ready"; sample_rate: number; mode?: "talk" | "test" }
  /** Once a second: microphone frames received and their loudest level (0..1). */
  | { type: "input"; frames: number; level: number }
  /** Three seconds of nothing, or of digital silence, while listening: a dead microphone. */
  | { type: "input_silent"; reason: "no_audio" | "silence" }
  | { type: "input_ok" }
  /** Test bench only, ~10 per second. */
  | { type: "meter"; level: number; vad: number }
  | { type: "state"; state: VoiceState }
  | { type: "vad"; speaking: boolean }
  | { type: "turn"; state: "incomplete" | "complete"; probability: number | null }
  | {
      type: "transcript";
      text: string;
      language: string | null;
      confidence?: number | null;
      seconds?: number | null;
      audio_seconds?: number;
    }
  | { type: "status"; text: string }
  | { type: "tool_start"; id?: string; round?: number; name: string; arguments: string }
  | { type: "tool_end"; id?: string; round?: number; name: string; result: unknown }
  | { type: "proposal"; proposal: Record<string, unknown> }
  | { type: "clarify"; question: string }
  | { type: "answer"; text: string; run_id: string | null }
  | {
      type: "audio_start";
      utterance: number;
      text: string;
      sample_rate: number;
      greeting?: boolean;
    }
  | { type: "audio_end"; utterance: number; ms: number }
  | { type: "speech_end"; ms: number }
  | { type: "interrupted" }
  /** The daemon thinks the user may be interrupting: turn playback down (or back up). */
  | { type: "duck"; on: boolean }
  | {
      type: "barge_in";
      state: "checking" | "rejected" | "confirmed";
      reason?: string;
      heard?: string;
    }
  | { type: "error"; text: string }
  | { type: "run"; run_id: string }
  | { type: "limits"; items: string[] };

/** JSON controls a client sends on the voice socket; microphone audio goes up as binary
 * 16 kHz mono 16-bit PCM in any chunking. */
export type VoiceClientControl =
  | { type: "interrupt"; ms: number }
  | { type: "played"; ms: number; done?: boolean }
  | { type: "mute"; on: boolean }
  | { type: "barge_in"; on: boolean }
  | { type: "end" };
