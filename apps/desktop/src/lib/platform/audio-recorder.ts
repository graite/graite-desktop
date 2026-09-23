/** WebKitGTK may expose MediaRecorder without a working encoder. In that case,
 * capture mono PCM through Web Audio and save a standard, locally playable WAV. */
export class AudioRecorder {
  state: "inactive" | "recording" = "inactive";
  mimeType = "audio/wav";
  ondataavailable: ((event: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  onerror: (() => void) | null = null;
  private native?: MediaRecorder;
  private context?: AudioContext;
  private source?: MediaStreamAudioSourceNode;
  private processor?: ScriptProcessorNode;
  private samples: ArrayBuffer[] = [];
  private bytes = 0;
  constructor(
    private input: MediaStream,
    private pcmOnly = false,
  ) {}

  async start(timeslice = 1000) {
    if (!this.pcmOnly && typeof MediaRecorder !== "undefined") {
      try {
        const mimeType = ["audio/webm;codecs=opus", "audio/ogg;codecs=opus", "audio/mp4"].find(
          (m) => MediaRecorder.isTypeSupported(m),
        );
        const native = new MediaRecorder(this.input, mimeType ? { mimeType } : undefined);
        native.ondataavailable = (e) => this.ondataavailable?.(e);
        native.onstop = () => {
          this.state = "inactive";
          this.onstop?.();
        };
        native.onerror = () => this.onerror?.();
        native.start(timeslice);
        this.native = native;
        this.mimeType = native.mimeType;
        this.state = "recording";
        return;
      } catch (error) {
        const detail = error as { name?: string; message?: string };
        if (
          detail?.name !== "NotSupportedError" &&
          !/unsupported|not supported/i.test(detail?.message ?? "")
        )
          throw error;
      }
    }
    const context = new AudioContext(this.pcmOnly ? { sampleRate: 16000 } : undefined);
    this.context = context;
    try {
      // ScriptProcessor is used for older WebKitGTK builds without AudioWorklet.
      this.source = context.createMediaStreamSource(this.input);
      this.processor = context.createScriptProcessor(4096, 1, 1);
      this.processor.onaudioprocess = (event) => {
        if (this.state !== "recording") return;
        const input = event.inputBuffer.getChannelData(0);
        const pcm = new ArrayBuffer(input.length * 2);
        const view = new DataView(pcm);
        input.forEach((value, i) =>
          view.setInt16(
            i * 2,
            Math.round(Math.max(-1, Math.min(1, value)) * (value < 0 ? 32768 : 32767)),
            true,
          ),
        );
        this.samples.push(pcm);
        this.bytes += pcm.byteLength;
        // Output remains silent: never play the microphone back through speakers.
        if (this.bytes >= Math.min(180 * 1024 * 1024, context.sampleRate * 2 * 3590)) this.stop();
      };
      this.source.connect(this.processor);
      this.processor.connect(context.destination);
      await context.resume();
      this.state = "recording";
    } catch (error) {
      this.release();
      throw error;
    }
  }

  private release() {
    this.source?.disconnect();
    if (this.processor) {
      this.processor.onaudioprocess = null;
      this.processor.disconnect();
    }
    void this.context?.close().catch(() => {});
  }

  stop() {
    if (this.state !== "recording") return;
    this.state = "inactive";
    if (this.native) {
      this.native.stop();
      return;
    }
    const rate = this.context!.sampleRate;
    this.release();
    if (this.bytes) {
      const header = new ArrayBuffer(44);
      const view = new DataView(header);
      const text = (offset: number, value: string) =>
        [...value].forEach((char, i) => view.setUint8(offset + i, char.charCodeAt(0)));
      text(0, "RIFF");
      view.setUint32(4, 36 + this.bytes, true);
      text(8, "WAVE");
      text(12, "fmt ");
      view.setUint32(16, 16, true);
      view.setUint16(20, 1, true);
      view.setUint16(22, 1, true);
      view.setUint32(24, rate, true);
      view.setUint32(28, rate * 2, true);
      view.setUint16(32, 2, true);
      view.setUint16(34, 16, true);
      text(36, "data");
      view.setUint32(40, this.bytes, true);
      this.ondataavailable?.({
        data: new Blob([header, ...this.samples], { type: this.mimeType }),
      });
    }
    this.samples = [];
    this.onstop?.();
  }
}
