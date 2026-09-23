const DUCKED_GAIN = 0.25;

/** Gapless playback of streamed 16-bit PCM: chunks are scheduled back to back on an
 * AudioContext, can be dropped at once (interruption) and report how much was heard. */
export class PcmPlayer {
  private context: AudioContext | null = null;
  private output: GainNode | null = null;
  private nextStart = 0;
  private scheduled: { start: number; duration: number; source: AudioBufferSourceNode }[] = [];
  private pending = 0;
  private draining = false;
  private onDrained: (() => void) | null = null;

  constructor(private readonly sampleRate: number) {}

  private ensure(): AudioContext {
    if (!this.context) {
      const AudioContextClass =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      this.context = new AudioContextClass();
      this.output = this.context.createGain();
      this.output.connect(this.context.destination);
    }
    void this.context.resume?.();
    return this.context;
  }

  /** Turn the assistant down while the daemon checks whether the user is interrupting: the
   * user hears at once that they were noticed, and their voice dominates the microphone. */
  duck(on: boolean): void {
    if (!this.context || !this.output) return;
    const now = this.context.currentTime;
    this.output.gain.cancelScheduledValues(now);
    this.output.gain.setValueAtTime(this.output.gain.value, now);
    this.output.gain.linearRampToValueAtTime(on ? DUCKED_GAIN : 1, now + 0.06);
  }

  /** Call from the click that starts the conversation: audio may only start on a gesture. */
  unlock(): void {
    this.ensure();
  }

  enqueue(data: ArrayBuffer): void {
    const pcm = new Int16Array(data, 0, Math.floor(data.byteLength / 2));
    if (!pcm.length) return;
    const context = this.ensure();
    const buffer = context.createBuffer(1, pcm.length, this.sampleRate);
    const channel = buffer.getChannelData(0);
    for (let i = 0; i < pcm.length; i++) channel[i] = pcm[i] / 0x8000;
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(this.output ?? context.destination);
    const start = Math.max(context.currentTime + 0.04, this.nextStart);
    this.nextStart = start + buffer.duration;
    const entry = { start, duration: buffer.duration, source };
    this.scheduled.push(entry);
    this.pending++;
    source.onended = () => {
      this.pending--;
      if (this.pending === 0 && this.draining) this.finish();
    };
    source.start(start);
  }

  /** Milliseconds of this answer that have actually been played. */
  playedMs(): number {
    const now = this.context?.currentTime ?? 0;
    let total = 0;
    for (const { start, duration } of this.scheduled)
      total += Math.max(0, Math.min(duration, now - start));
    return Math.round(total * 1000);
  }

  /** Everything has been sent: call `done` once the last chunk finished playing. */
  drain(done: () => void): void {
    this.onDrained = done;
    this.draining = true;
    if (this.pending === 0) this.finish();
  }

  private finish(): void {
    const done = this.onDrained;
    this.draining = false;
    this.onDrained = null;
    done?.();
  }

  /** Stop now and forget what was queued. Returns how much had been played. */
  flush(): number {
    const played = this.playedMs();
    for (const { source } of this.scheduled) {
      source.onended = null;
      try {
        source.stop();
      } catch {
        /* not started yet */
      }
    }
    this.reset();
    return played;
  }

  /** A new answer starts: playback position counts from zero again. */
  reset(): void {
    this.duck(false);
    this.scheduled = [];
    this.pending = 0;
    this.nextStart = 0;
    this.draining = false;
    this.onDrained = null;
  }

  close(): void {
    this.flush();
    void this.context?.close();
    this.context = null;
    this.output = null;
  }
}
