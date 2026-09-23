import { afterEach, expect, it, vi } from "vitest";
import { AudioRecorder } from "./audio-recorder";

afterEach(() => vi.unstubAllGlobals());
it.each(["missing", "constructor", "start"])(
  "saves valid mono WAV when MediaRecorder is unavailable at %s",
  async (failure) => {
    const processor = {
      connect: vi.fn(),
      disconnect: vi.fn(),
      onaudioprocess: null as null | ((event: unknown) => void),
    };
    const source = { connect: vi.fn(), disconnect: vi.fn() };
    const close = vi.fn(async () => {});
    vi.stubGlobal(
      "AudioContext",
      class {
        sampleRate = 48000;
        destination = {};
        createMediaStreamSource = () => source;
        createScriptProcessor = () => processor;
        resume = async () => {};
        close = close;
      },
    );
    vi.stubGlobal(
      "MediaRecorder",
      failure === "missing"
        ? undefined
        : class {
            static isTypeSupported = () => true;
            constructor() {
              if (failure === "constructor")
                throw new DOMException(
                  "MediaRecorder is unsupported on this platform",
                  "NotSupportedError",
                );
            }
            start() {
              throw new DOMException("Unsupported", "NotSupportedError");
            }
          },
    );
    const recorder = new AudioRecorder({} as MediaStream);
    let result: Blob | undefined;
    recorder.ondataavailable = (event) => {
      result = event.data;
    };
    recorder.onstop = vi.fn();
    await recorder.start();
    processor.onaudioprocess?.({
      inputBuffer: { getChannelData: () => new Float32Array([-1, 0, 1]) },
    });
    recorder.stop();
    expect(result?.type).toBe("audio/wav");
    const data = new DataView(await result!.arrayBuffer());
    expect(new TextDecoder().decode(new Uint8Array(data.buffer, 0, 4))).toBe("RIFF");
    expect(data.getUint32(24, true)).toBe(48000);
    expect(data.getUint32(40, true)).toBe(6);
    expect([44, 46, 48].map((i) => data.getInt16(i, true))).toEqual([-32768, 0, 32767]);
    expect(source.disconnect).toHaveBeenCalled();
    expect(processor.disconnect).toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
    recorder.stop();
    expect(recorder.onstop).toHaveBeenCalledOnce();
  },
);

it("records PCM directly for dictation even when MediaRecorder is available", async () => {
  const native = vi.fn();
  vi.stubGlobal("MediaRecorder", native);
  const close = vi.fn(async () => {});
  vi.stubGlobal(
    "AudioContext",
    class {
      sampleRate = 16000;
      destination = {};
      createMediaStreamSource = () => ({ connect: vi.fn(), disconnect: vi.fn() });
      createScriptProcessor = () => ({
        connect: vi.fn(),
        disconnect: vi.fn(),
        onaudioprocess: null,
      });
      resume = async () => {};
      close = close;
    },
  );
  const recorder = new AudioRecorder({} as MediaStream, true);
  await recorder.start();
  expect(native).not.toHaveBeenCalled();
  expect(recorder.mimeType).toBe("audio/wav");
  recorder.stop();
  expect(close).toHaveBeenCalled();
});
