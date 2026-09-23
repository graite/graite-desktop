import { afterEach, expect, it, vi } from "vitest";
import { microphone } from "./recording";

afterEach(() => vi.unstubAllGlobals());
it("opens the microphone without optional processing constraints", async () => {
  const stream = {} as MediaStream;
  const getUserMedia = vi.fn(async (constraints: MediaStreamConstraints) => {
    if (constraints.audio !== true)
      throw new DOMException("Invalid constraint", "OverconstrainedError");
    return stream;
  });
  vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
  vi.stubGlobal("MediaRecorder", class {});
  expect(await microphone()).toBe(stream);
  expect(getUserMedia).toHaveBeenCalledWith({ audio: true, video: false });
});
it("preserves permission failures without repeatedly requesting access", async () => {
  const denied = new DOMException("Denied", "NotAllowedError");
  const getUserMedia = vi.fn().mockRejectedValue(denied);
  vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
  vi.stubGlobal("MediaRecorder", class {});
  await expect(microphone()).rejects.toBe(denied);
  expect(getUserMedia).toHaveBeenCalledTimes(1);
});
it("asks for echo cancellation in a voice conversation and falls back where it is refused", async () => {
  const stream = {
    getAudioTracks: () => [{ getSettings: () => ({ echoCancellation: false }) }],
  } as unknown as MediaStream;
  const getUserMedia = vi.fn(async (constraints: MediaStreamConstraints) => {
    if (constraints.audio !== true)
      throw new DOMException("Invalid constraint", "OverconstrainedError");
    return stream;
  });
  vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
  const rearm = vi.fn(async () => {});
  expect(await microphone({ voice: true, rearm })).toBe(stream);
  expect(getUserMedia).toHaveBeenCalledTimes(2);
  expect((getUserMedia.mock.calls[0][0].audio as MediaTrackConstraints).echoCancellation).toBe(
    true,
  );
  expect(rearm).toHaveBeenCalledTimes(1);
  const { cancelsEcho } = await import("./recording");
  expect(cancelsEcho(stream)).toBe(false);
});
it("does not ask twice when the user denied the microphone on the web", async () => {
  const denied = new DOMException("Denied", "NotAllowedError");
  const getUserMedia = vi.fn().mockRejectedValue(denied);
  vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
  await expect(microphone({ voice: true })).rejects.toBe(denied);
  expect(getUserMedia).toHaveBeenCalledTimes(1);
});

it("explains WebKit's invalid constraint error when Bluetooth exposes no input", async () => {
  const getUserMedia = vi
    .fn()
    .mockRejectedValue(new DOMException("Invalid constraint", "OverconstrainedError"));
  vi.stubGlobal("navigator", {
    mediaDevices: {
      getUserMedia,
      enumerateDevices: vi.fn().mockResolvedValue([{ kind: "audiooutput" }]),
    },
  });
  await expect(microphone({ voice: true })).rejects.toThrow(
    /No microphone input.*Headset \/ Hands-Free/,
  );
  expect(getUserMedia).toHaveBeenLastCalledWith({ audio: true, video: false });
});

it("does not claim the microphone is missing when an input exists", async () => {
  vi.stubGlobal("navigator", {
    mediaDevices: {
      getUserMedia: vi
        .fn()
        .mockRejectedValue(new DOMException("Invalid constraint", "OverconstrainedError")),
      enumerateDevices: vi.fn().mockResolvedValue([{ kind: "audioinput" }]),
    },
  });
  await expect(microphone()).rejects.toThrow(/^The microphone could not be opened/);
});

it("drops the device preference as well as audio processing for the final fallback", async () => {
  const stream = {} as MediaStream;
  const getUserMedia = vi
    .fn()
    .mockRejectedValueOnce(new DOMException("Invalid constraint", "OverconstrainedError"))
    .mockResolvedValueOnce(stream);
  vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
  const rearm = vi.fn(async () => {});
  expect(await microphone({ voice: true, deviceId: "disconnected", rearm })).toBe(stream);
  expect(getUserMedia).toHaveBeenLastCalledWith({ audio: true, video: false });
  expect(rearm).toHaveBeenCalledTimes(1);
});

it("preserves permission denial even if enumeration would report no inputs", async () => {
  const denied = new DOMException("Denied", "NotAllowedError");
  const enumerateDevices = vi.fn().mockResolvedValue([]);
  vi.stubGlobal("navigator", {
    mediaDevices: { getUserMedia: vi.fn().mockRejectedValue(denied), enumerateDevices },
  });
  await expect(microphone({ voice: true, rearm: async () => {} })).rejects.toBe(denied);
  expect(enumerateDevices).not.toHaveBeenCalled();
});
