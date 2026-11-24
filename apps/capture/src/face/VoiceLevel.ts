import { VOICE_BANDS, type VoiceSound } from './VoiceMouth';

const SILENT: VoiceSound = { level: 0, low: 0, mid: 0, high: 0 };

/**
 * The microphone for the mouth of a face nothing tracks: speech loudness,
 * 0..1, for the jaw, and the power in three bands for the lips. Opens its
 * own analysis stream once microphone permission is granted (the recorder's
 * stream is opened and released per recording).
 */
export class VoiceLevel {
  private analyser: AnalyserNode | null = null;
  private context: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private buffer: Float32Array<ArrayBuffer> | null = null;
  private spectrum: Float32Array<ArrayBuffer> | null = null;
  private starting = false;
  /** A refused stream is not asked for again each frame; `retry` clears it. */
  private failed = false;
  /** 0: not asked in this state; 1: asked before the page had a user action; 2: asked after one. */
  private resumeAsked = 0;

  async start(): Promise<void> {
    if (this.starting || this.failed || this.stream || !navigator.mediaDevices?.getUserMedia) return;
    this.starting = true;
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
      this.context = new AudioContext();
      this.context.addEventListener('statechange', () => {
        this.resumeAsked = 0;
      });
      this.listen();
    } catch {
      this.stop();
      this.failed = true;
    } finally {
      this.starting = false;
    }
  }

  /**
   * Connects the stream to the analyser, only in a running context. A source
   * node made in a suspended context can stay silent after the context
   * resumes (seen in Chromium with a stream from another audio context).
   */
  private listen(): void {
    if (this.analyser || !this.context || !this.stream || this.context.state !== 'running') return;
    const source = this.context.createMediaStreamSource(this.stream);
    const analyser = this.context.createAnalyser();
    analyser.fftSize = 1024;
    // The mouth smooths in its own time; an averaged spectrum would lag the sound.
    analyser.smoothingTimeConstant = 0;
    source.connect(analyser);
    this.buffer = new Float32Array(analyser.fftSize);
    this.spectrum = new Float32Array(analyser.frequencyBinCount);
    this.analyser = analyser;
  }

  /** Allows a new request after a refused one: the microphone state changed. */
  retry(): void {
    this.failed = false;
  }

  /** Reads the current level; cheap enough to call every step. */
  read(): number {
    // A context made before the page counted a user action waits suspended and reads silence. The app asks for
    // the microphone when it loads, so that is the usual case. Ask once, and once more after the first action
    // (a browser can leave the first request without an answer); not on every frame.
    const asked = navigator.userActivation?.hasBeenActive === false ? 1 : 2;
    if (this.context?.state === 'suspended' && this.resumeAsked < asked) {
      this.resumeAsked = asked;
      void this.context.resume().catch(() => undefined);
    }
    this.listen();
    if (!this.analyser || !this.buffer) return 0;
    this.analyser.getFloatTimeDomainData(this.buffer);
    let sum = 0;
    for (const sample of this.buffer) sum += sample * sample;
    const rms = Math.sqrt(sum / this.buffer.length);
    // Speech RMS sits around 0.02-0.2; below 0.01 is room noise.
    return Math.min(1, Math.max(0, (rms - 0.01) / 0.12));
  }

  /** The level and, above the noise threshold, the power in the lips' three bands. */
  sound(): VoiceSound {
    const level = this.read();
    if (level <= 0 || !this.analyser || !this.spectrum || !this.context) return SILENT;
    this.analyser.getFloatFrequencyData(this.spectrum);
    const hzPerBin = this.context.sampleRate / this.analyser.fftSize;
    const power = ([from, to]: readonly [number, number]): number => {
      let total = 0;
      const last = Math.min(this.spectrum!.length - 1, Math.floor(to / hzPerBin));
      for (let bin = Math.ceil(from / hzPerBin); bin <= last; bin += 1) {
        const db = this.spectrum![bin]!;
        // An empty bin reads -Infinity dB.
        if (Number.isFinite(db)) total += 10 ** (db / 10);
      }
      return total;
    };
    return { level, low: power(VOICE_BANDS.low), mid: power(VOICE_BANDS.mid), high: power(VOICE_BANDS.high) };
  }

  stop(): void {
    for (const track of this.stream?.getTracks() ?? []) track.stop();
    void this.context?.close().catch(() => undefined);
    this.stream = null;
    this.context = null;
    this.analyser = null;
    this.buffer = null;
    this.spectrum = null;
  }
}
