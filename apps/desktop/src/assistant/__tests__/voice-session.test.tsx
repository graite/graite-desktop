import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { VoiceServerEvent, VoiceSocketHandlers } from "@/lib/voice";

const io = vi.hoisted(() => ({
  handlers: null as VoiceSocketHandlers | null,
  sent: [] as Record<string, unknown>[],
  audio: 0,
  closed: 0,
  onFrame: null as ((frame: Int16Array) => void) | null,
  captureStopped: 0,
  played: 0,
  flushed: 0,
  ducked: [] as boolean[],
  opened: [] as boolean[],
  enqueued: 0,
  drained: null as (() => void) | null,
  microphone: vi.fn(),
  track: null as (EventTarget & { readyState: string; stop: () => void }) | null,
  tracksStopped: 0,
}));

/** A stream with one live track, which a test can end as if the microphone were unplugged. */
function fakeStream() {
  const track = Object.assign(new EventTarget(), {
    readyState: "live",
    stop: () => {
      io.tracksStopped++;
    },
  });
  io.track = track;
  return { getAudioTracks: () => [track], getTracks: () => [track] };
}

vi.mock("@/lib/voice", () => ({
  VoiceSocket: class {
    async open(_id: string, barge: boolean, handlers: VoiceSocketHandlers) {
      io.handlers = handlers;
      io.opened.push(barge);
    }
    sendAudio() {
      io.audio++;
    }
    send(control: Record<string, unknown>) {
      io.sent.push(control);
    }
    close() {
      io.closed++;
    }
  },
}));
vi.mock("@/lib/platform", () => ({ platform: { microphone: io.microphone } }));
vi.mock("@/lib/platform/recording", () => ({ cancelsEcho: () => false }));
vi.mock("@/lib/platform/audio-capture", () => ({
  startCapture: async (_stream: unknown, onFrame: (frame: Int16Array) => void) => {
    io.onFrame = onFrame;
    return {
      info: { sampleRate: 16000, path: "worklet", device: "Test mic", echoCancellation: false },
      stop: () => {
        io.captureStopped++;
      },
    };
  },
}));
vi.mock("@/lib/pcm-player", () => ({
  PcmPlayer: class {
    unlock() {}
    reset() {
      io.played = 0;
    }
    enqueue() {
      io.enqueued++;
    }
    playedMs() {
      return io.played;
    }
    drain(done: () => void) {
      io.drained = done;
    }
    flush() {
      io.flushed++;
      return io.played;
    }
    duck(on: boolean) {
      io.ducked.push(on);
    }
    close() {}
  },
}));

import { useVoiceSession } from "../useVoiceSession";

const emit = (event: VoiceServerEvent) => act(() => io.handlers!.onEvent(event));

beforeEach(() => {
  Object.assign(io, {
    handlers: null,
    sent: [],
    audio: 0,
    closed: 0,
    onFrame: null,
    captureStopped: 0,
    played: 0,
    flushed: 0,
    enqueued: 0,
    drained: null,
    ducked: [],
    opened: [],
    tracksStopped: 0,
  });
  localStorage.clear();
  io.microphone.mockReset().mockImplementation(async () => fakeStream());
  vi.useFakeTimers({ shouldAdvanceTime: true });
});
afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

async function started(onTurnSaved = vi.fn()) {
  const hook = renderHook(() => useVoiceSession({ onTurnSaved }));
  await act(() => hook.result.current.start("c1"));
  emit({ type: "state", state: "loading" });
  emit({ type: "ready", sample_rate: 24000 });
  emit({ type: "state", state: "listening" });
  return { hook, onTurnSaved };
}

it("streams the microphone, follows the turn and reports playback until it is done", async () => {
  const { hook, onTurnSaved } = await started();
  expect(io.microphone).toHaveBeenCalledWith({ voice: true, deviceId: undefined });
  expect(hook.result.current.phase).toBe("listening");
  act(() => io.onFrame!(new Int16Array(640)));
  expect(io.audio).toBe(1);

  emit({ type: "vad", speaking: true });
  expect(hook.result.current.userSpeaking).toBe(true);
  emit({ type: "transcript", text: "What about Atlas?", language: "en" });
  emit({ type: "state", state: "thinking" });
  emit({ type: "audio_start", utterance: 0, text: "Three notes.", sample_rate: 24000 });
  act(() => io.handlers!.onAudio(new ArrayBuffer(960)));
  emit({ type: "audio_start", utterance: 1, text: "Deadline Friday.", sample_rate: 24000 });
  expect(io.enqueued).toBe(1);
  expect(hook.result.current.lines).toEqual([
    { role: "user", text: "What about Atlas?" },
    { role: "assistant", text: "Three notes. Deadline Friday." },
  ]);
  io.played = 700;
  await act(() => vi.advanceTimersByTimeAsync(120));
  expect(io.sent).toContainEqual({ type: "played", ms: 700 });

  emit({ type: "speech_end", ms: 1800 });
  io.played = 1800;
  act(() => io.drained!());
  expect(io.sent[io.sent.length - 1]).toEqual({ type: "played", ms: 1800, done: true });
  const before = onTurnSaved.mock.calls.length;
  emit({ type: "state", state: "listening" });
  expect(onTurnSaved.mock.calls.length).toBe(before + 1);
});

it("interrupting stops playback at once and tells the daemon how much was heard", async () => {
  const { hook } = await started();
  emit({ type: "audio_start", utterance: 0, text: "A long answer.", sample_rate: 24000 });
  io.played = 420;
  act(() => hook.result.current.interrupt());
  expect(io.flushed).toBe(1);
  expect(io.sent).toContainEqual({ type: "interrupt", ms: 420 });
  emit({ type: "interrupted" }); // the daemon's own barge-in also silences the player
  expect(io.flushed).toBe(2);
});

it("cleans up when the daemon closes the socket and explains why", async () => {
  const { hook, onTurnSaved } = await started();
  emit({ type: "error", text: "Download the voice model first." });
  act(() => io.handlers!.onClose(4412));
  await waitFor(() => expect(hook.result.current.phase).toBe("idle"));
  expect(hook.result.current.error).toBe("Download the voice model first.");
  expect(io.captureStopped).toBe(1);
  expect(onTurnSaved).toHaveBeenCalled();
});

it("explains a denied microphone", async () => {
  io.microphone.mockRejectedValue(new DOMException("Denied", "NotAllowedError"));
  const hook = renderHook(() => useVoiceSession({ onTurnSaved: vi.fn() }));
  await act(() => hook.result.current.start("c1"));
  expect(hook.result.current.phase).toBe("idle");
  expect(hook.result.current.error).toMatch(/microphone access/);
});

it("interrupting by speaking is on by default, ducks while the daemon checks, and remembers being switched off", async () => {
  const { hook } = await started();
  expect(io.opened).toEqual([true]);
  expect(hook.result.current.bargeIn).toBe(true);
  emit({ type: "audio_start", utterance: 0, text: "A long answer.", sample_rate: 24000 });
  emit({ type: "duck", on: true });
  emit({ type: "barge_in", state: "checking" });
  expect(io.ducked).toEqual([true]);
  expect(hook.result.current.checking).toBe(true);
  emit({ type: "duck", on: false });
  emit({ type: "barge_in", state: "rejected", reason: "backchannel" });
  expect(io.ducked).toEqual([true, false]);
  expect(hook.result.current.checking).toBe(false);

  act(() => hook.result.current.setBargeIn(false));
  expect(io.sent).toContainEqual({ type: "barge_in", on: false });
  act(() => hook.result.current.stop());
  const again = renderHook(() => useVoiceSession({ onTurnSaved: vi.fn() }));
  await act(() => again.result.current.start("c1"));
  expect(io.opened).toEqual([true, false]);
});

it("says so when the daemon hears nothing from the microphone, and recovers", async () => {
  const { hook } = await started();
  emit({ type: "input", frames: 31, level: 0 });
  emit({ type: "input_silent", reason: "silence" });
  expect(hook.result.current.silent).toBe("silence");
  emit({ type: "input_ok" });
  expect(hook.result.current.silent).toBeNull();
});

it("ends the call with an explanation when no sound arrives for a while", async () => {
  const { hook } = await started();
  emit({ type: "input_silent", reason: "no_audio" });
  await act(() => vi.advanceTimersByTimeAsync(9_000));
  expect(hook.result.current.active).toBe(true);
  await act(() => vi.advanceTimersByTimeAsync(2_000));
  expect(hook.result.current.active).toBe(false);
  expect(io.captureStopped).toBe(1);
  expect(hook.result.current.error).toMatch(/No sound reached Graite/);
});

it("ends the call cleanly when the microphone goes away mid-call", async () => {
  const { hook } = await started();
  act(() => {
    io.track!.dispatchEvent(new Event("ended"));
  });
  expect(hook.result.current.active).toBe(false);
  expect(io.captureStopped).toBe(1);
  expect(hook.result.current.error).toMatch(/microphone stopped working/);
});

it("releases the microphone when setting up the call fails", async () => {
  const hook = renderHook(() => useVoiceSession({ onTurnSaved: vi.fn() }));
  const { VoiceSocket } = await import("@/lib/voice");
  const open = vi
    .spyOn(VoiceSocket.prototype, "open")
    .mockRejectedValueOnce(new Error("Daemon unreachable"));
  await act(() => hook.result.current.start("c1"));
  expect(hook.result.current.error).toBe("Daemon unreachable");
  expect(io.tracksStopped).toBe(1);
  open.mockRestore();
});

it("plays the greeting like any other speech", async () => {
  const { hook } = await started();
  emit({ type: "state", state: "speaking" });
  emit({ type: "audio_start", utterance: 0, text: "Hi Sam.", sample_rate: 24000, greeting: true });
  act(() => io.handlers!.onAudio(new ArrayBuffer(960)));
  expect(io.enqueued).toBe(1);
  expect(hook.result.current.lines).toEqual([{ role: "assistant", text: "Hi Sam." }]);
});

it("shows what a tool is doing and clears it when the last one finishes", async () => {
  const { hook } = await started();
  emit({ type: "state", state: "thinking" });
  emit({ type: "tool_start", id: "a", name: "search_vault", arguments: "{}" });
  expect(hook.result.current.status).toBe("Searching your pages…");
  emit({ type: "tool_start", id: "b", name: "read_page", arguments: "{}" });
  expect(hook.result.current.status).toBe("Reading a page…");
  emit({ type: "tool_end", id: "a", name: "search_vault", result: {} });
  expect(hook.result.current.status).toBe("Reading a page…"); // one is still running
  emit({ type: "tool_end", id: "b", name: "read_page", result: {} });
  expect(hook.result.current.status).toBe("");
});
