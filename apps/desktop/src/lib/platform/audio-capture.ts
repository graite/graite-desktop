// Streaming microphone capture for a voice conversation: 16 kHz mono 16-bit frames as they
// are spoken. (AudioRecorder's PCM path only hands over audio when it stops.)

export const CAPTURE_RATE = 16000;
const FRAME_SAMPLES = 640; // 40 ms per message to the daemon

/** Averages each run of input samples that maps to one output sample: a cheap low-pass that
 * is enough for speech going into a VAD and Whisper. Carries its state across calls. */
export class Downsampler {
  private readonly ratio: number;
  private position = 0;
  private sum = 0;
  private count = 0;

  constructor(inputRate: number, outputRate = CAPTURE_RATE) {
    this.ratio = inputRate / outputRate;
  }

  push(input: Float32Array): Float32Array {
    if (this.ratio === 1) return input;
    const out = new Float32Array(Math.ceil((input.length + this.count) / this.ratio) + 1);
    let n = 0;
    for (let i = 0; i < input.length; i++) {
      this.sum += input[i];
      this.count++;
      this.position++;
      if (this.position >= this.ratio) {
        out[n++] = this.sum / this.count;
        this.position -= this.ratio;
        this.sum = 0;
        this.count = 0;
      }
    }
    return out.subarray(0, n);
  }
}

/** Float samples in, fixed-size little-endian Int16 frames out. */
export class Framer {
  private pending = new Int16Array(FRAME_SAMPLES);
  private filled = 0;

  push(samples: Float32Array, emit: (frame: Int16Array) => void): void {
    for (let i = 0; i < samples.length; i++) {
      const value = Math.max(-1, Math.min(1, samples[i]));
      this.pending[this.filled++] = value < 0 ? value * 0x8000 : value * 0x7fff;
      if (this.filled === FRAME_SAMPLES) {
        emit(this.pending);
        this.pending = new Int16Array(FRAME_SAMPLES);
        this.filled = 0;
      }
    }
  }
}

export function rms(samples: Float32Array): number {
  if (!samples.length) return 0;
  let total = 0;
  for (let i = 0; i < samples.length; i++) total += samples[i] * samples[i];
  return Math.sqrt(total / samples.length);
}

/** What the capture is actually doing, for the test bench and for bug reports. */
export interface CaptureInfo {
  sampleRate: number;
  path: "worklet" | "script";
  device: string;
  echoCancellation: boolean;
}

export interface Capture {
  info: CaptureInfo;
  stop(): void;
}

/** Served from `public/`, so it is same-origin: a bundled worklet becomes a `data:` URL, which
 * the app's content security policy refuses. */
const WORKLET_URL = "/capture-worklet.js";
const WORKLET_GRACE_MS = 1000;

/** Start streaming `stream`. `onFrame` gets 40 ms Int16 frames; `onLevel` the loudness (0..1). */
export async function startCapture(
  stream: MediaStream,
  onFrame: (frame: Int16Array) => void,
  onLevel?: (level: number) => void,
): Promise<Capture> {
  const AudioContextClass =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AudioContextClass) throw new Error("This webview cannot capture live audio.");
  let context: AudioContext;
  try {
    context = new AudioContextClass({ sampleRate: CAPTURE_RATE });
  } catch {
    context = new AudioContextClass();
  }
  await context.resume?.();
  const source = context.createMediaStreamSource(stream);
  const downsampler = new Downsampler(context.sampleRate);
  const framer = new Framer();
  let received = 0;
  const handle = (input: Float32Array) => {
    received++;
    onLevel?.(Math.min(1, rms(input) * 4));
    framer.push(downsampler.push(input), onFrame);
  };
  const silent = context.createGain();
  silent.gain.value = 0;
  silent.connect(context.destination); // some engines only pull nodes that reach the output
  let node: AudioNode | null = null;
  const useScriptProcessor = () => {
    node?.disconnect();
    const processor = context.createScriptProcessor(2048, 1, 1);
    processor.onaudioprocess = (event) => {
      handle(new Float32Array(event.inputBuffer.getChannelData(0)));
      event.outputBuffer.getChannelData(0).fill(0); // never play the microphone back
    };
    node = processor;
    source.connect(processor);
    processor.connect(silent);
    info.path = "script";
  };
  const track = stream.getAudioTracks()[0];
  const info: CaptureInfo = {
    sampleRate: context.sampleRate,
    path: "worklet",
    device: track?.label || "Default microphone",
    echoCancellation: track?.getSettings?.().echoCancellation === true,
  };
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  try {
    if (!context.audioWorklet) throw new Error("no worklet");
    await context.audioWorklet.addModule(WORKLET_URL);
    const worklet = new AudioWorkletNode(context, "graite-capture", {
      numberOfInputs: 1,
      numberOfOutputs: 1,
    });
    worklet.port.onmessage = (event: MessageEvent<Float32Array>) => handle(event.data);
    node = worklet;
    source.connect(worklet);
    worklet.connect(silent);
    // A worklet that loads but never delivers (seen on some WebKitGTK builds) must not leave
    // the conversation deaf: fall back to the older node.
    watchdog = setTimeout(() => {
      try {
        if (received === 0) useScriptProcessor();
      } catch {
        /* the context closed meanwhile: the call is over */
      }
    }, WORKLET_GRACE_MS);
  } catch {
    useScriptProcessor(); // older WebKitGTK builds ship without AudioWorklet
  }
  return {
    info,
    stop() {
      clearTimeout(watchdog);
      source.disconnect();
      node?.disconnect();
      silent.disconnect();
      stream.getTracks().forEach((t) => t.stop());
      context.close().catch(() => {});
    },
  };
}
