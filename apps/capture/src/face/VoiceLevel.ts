/**
 * Speech loudness from the microphone, 0..1, for the liveness jaw. Opens its
 * own analysis stream once microphone permission is granted (the recorder's
 * stream is opened and released per recording).
 */
export class VoiceLevel {
  private analyser: AnalyserNode | null = null;
  private context: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private buffer: Float32Array<ArrayBuffer> | null = null;
  private starting = false;
  private level = 0;

  async start(): Promise<void> {
    if (this.starting || this.analyser || !navigator.mediaDevices?.getUserMedia) return;
    this.starting = true;
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
      this.context = new AudioContext();
      const source = this.context.createMediaStreamSource(this.stream);
      this.analyser = this.context.createAnalyser();
      this.analyser.fftSize = 1024;
      source.connect(this.analyser);
      this.buffer = new Float32Array(this.analyser.fftSize);
    } catch {
      this.stop();
    } finally {
      this.starting = false;
    }
  }

  /** Reads the current level; cheap enough to call every step. */
  read(): number {
    if (!this.analyser || !this.buffer) return 0;
    this.analyser.getFloatTimeDomainData(this.buffer);
    let sum = 0;
    for (const sample of this.buffer) sum += sample * sample;
    const rms = Math.sqrt(sum / this.buffer.length);
    // Speech RMS sits around 0.02-0.2; below 0.01 is room noise.
    this.level = Math.min(1, Math.max(0, (rms - 0.01) / 0.12));
    return this.level;
  }

  stop(): void {
    for (const track of this.stream?.getTracks() ?? []) track.stop();
    void this.context?.close().catch(() => undefined);
    this.stream = null;
    this.context = null;
    this.analyser = null;
    this.buffer = null;
  }
}
