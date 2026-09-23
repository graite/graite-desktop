import { reportError } from "./clientLog";
import { request } from "./api";
import { platform } from "./platform";
import type { components } from "@graite/api-types";
import type { VoiceServerEvent } from "@graite/api-types";

export type VoiceStatus = components["schemas"]["VoiceStatus"];
export type VoiceInfo = components["schemas"]["VoiceInfo"];
export const BUILT_IN_VOICE = "built-in";

export interface SampleOptions {
  text?: string;
  language?: string;
  /** A voice from the library to try; omitted = the assistant's current voice. */
  voiceId?: string;
  exaggeration?: number;
  cfg?: number;
}

async function binary(path: string, init: RequestInit, failure: string): Promise<Response> {
  const { url, token } = await platform.getDaemonInfo();
  const response = await fetch(`${url}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
  });
  if (!response.ok) {
    const error = (await response.json().catch(() => ({}))) as { detail?: string };
    throw new Error(error.detail || `${failure} (${response.status})`);
  }
  return response;
}
export type { VoiceServerEvent };

export const voice = {
  status: () => request<VoiceStatus>("/api/v1/voice/status"),
  /** One sentence in a voice, as a WAV blob, with how long it took to make. */
  sample: async (options: SampleOptions = {}): Promise<{ blob: Blob; seconds: number }> => {
    const started = performance.now();
    const response = await binary(
      "/api/v1/voice/preview",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: options.text ?? "",
          language: options.language,
          voice_id: options.voiceId,
          exaggeration: options.exaggeration,
          cfg: options.cfg,
        }),
      },
      "The sample failed",
    );
    const blob = await response.blob();
    return { blob, seconds: (performance.now() - started) / 1000 };
  },
  voices: async () => (await request<{ voices: VoiceInfo[] }>("/api/v1/voice/voices")).voices,
  addVoice: async (file: Blob, name: string, filename: string, consent: boolean) => {
    const query = new URLSearchParams({ name, filename, consent: String(consent) });
    const response = await binary(
      `/api/v1/voice/voices?${query}`,
      { method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: file },
      "The voice could not be added",
    );
    return (await response.json()) as VoiceInfo;
  },
  renameVoice: (id: string, name: string) =>
    request<VoiceInfo>(`/api/v1/voice/voices/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify({ name }),
    }),
  deleteVoice: (id: string) =>
    request<{ ok: boolean }>(`/api/v1/voice/voices/${encodeURIComponent(id)}`, {
      method: "DELETE",
    }),
};

/** Seconds of audio in a 16-bit mono WAV blob made by the daemon (44-byte header). */
export function wavSeconds(blob: Blob, sampleRate = 24000): number {
  return Math.max(0, blob.size - 44) / 2 / sampleRate;
}

export interface VoiceSocketHandlers {
  onEvent: (event: VoiceServerEvent) => void;
  onAudio: (data: ArrayBuffer) => void;
  onClose: (code: number) => void;
}

/** The duplex voice socket: microphone frames up, events and the assistant's audio down. */
export class VoiceSocket {
  private socket: WebSocket | null = null;

  /** `conversationId === null` opens the test bench: microphone, turn-taking and Whisper
   * only, no assistant behind it. */
  async open(
    conversationId: string | null,
    bargeIn: boolean,
    handlers: VoiceSocketHandlers,
  ): Promise<void> {
    const { url, token } = await platform.getDaemonInfo();
    const query = new URLSearchParams(
      conversationId === null
        ? { token, mode: "test" }
        : { token, conversation_id: conversationId, barge_in: String(bargeIn) },
    );
    const socket = new WebSocket(`${url.replace(/^http/, "ws")}/api/v1/voice/session?${query}`);
    socket.binaryType = "arraybuffer";
    socket.onmessage = (message) => {
      try {
        if (typeof message.data === "string")
          handlers.onEvent(JSON.parse(message.data) as VoiceServerEvent);
        else handlers.onAudio(message.data as ArrayBuffer);
      } catch (error) {
        // One bad event or audio chunk must not take the conversation (or the page) down.
        reportError("voice event failed", error, "voice");
      }
    };
    // A failed connection is followed by `onclose`, which ends the call; nothing else to do.
    socket.onerror = () => {};
    socket.onclose = (event) => handlers.onClose(event.code);
    this.socket = socket;
  }

  sendAudio(frame: Int16Array): void {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(frame.buffer as ArrayBuffer);
  }

  send(control: Record<string, unknown>): void {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(control));
  }

  close(): void {
    this.send({ type: "end" });
    this.socket?.close();
    this.socket = null;
  }
}
