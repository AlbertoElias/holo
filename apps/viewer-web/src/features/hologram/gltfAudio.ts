/** Minimal GLTF result shape needed for audio extraction. */
export interface GltfAudioSource {
  parser: { loadBufferView: (index: number) => Promise<ArrayBuffer> };
  userData: Record<string, unknown>;
}

interface KhrAudioData {
  audio: Array<{ bufferView: number; mimeType: string }>;
  sources: Array<{ audio: number; autoPlay?: boolean; loop?: boolean }>;
  emitters: Array<{ type: string; sources: number[]; gain?: number }>;
}

export interface DecodedGltfAudio {
  buffer: AudioBuffer;
  loop: boolean;
}

let sharedAudioContext: AudioContext | null = null;

export function getAudioContext(): AudioContext {
  if (!sharedAudioContext) {
    sharedAudioContext = new AudioContext();
  }
  return sharedAudioContext;
}

/** Resume AudioContext after a user gesture (browser autoplay policy). */
export function resumeAudioContext(): void {
  const ctx = getAudioContext();
  if (ctx.state === "suspended") {
    void ctx.resume();
  }
}

function extractKhrAudio(gltf: GltfAudioSource): KhrAudioData | null {
  const userData = gltf.userData as Record<string, unknown> | undefined;
  const extensions = userData?.gltfExtensions as
    | Record<string, unknown>
    | undefined;
  if (!extensions) return null;

  const khrAudio = extensions["KHR_audio"] as KhrAudioData | undefined;
  if (!khrAudio?.audio?.length) return null;

  return khrAudio;
}

/** Decodes the first KHR_audio clip, or null when the GLB carries none. */
export async function decodeGltfAudio(gltf: GltfAudioSource): Promise<DecodedGltfAudio | null> {
  const khrAudio = extractKhrAudio(gltf);
  const audioEntry = khrAudio?.audio[0];
  if (!khrAudio || audioEntry === undefined) return null;
  const rawBuffer = await gltf.parser.loadBufferView(audioEntry.bufferView);
  // decodeAudioData may detach the buffer, so pass a copy
  const buffer = await getAudioContext().decodeAudioData(rawBuffer.slice(0));
  return { buffer, loop: khrAudio.sources?.[0]?.loop !== false };
}

/**
 * One hologram's audio, started at a clip time so it lands where the motion
 * is. `scheduledOffset` reports where the playing source is now
 * (`ctx.currentTime - startedAt + offset`).
 */
export class ScheduledGltfAudio {
  private source: AudioBufferSourceNode | null = null;
  private readonly gain: GainNode;
  private startedAt = 0;
  private startOffset = 0;

  constructor(private readonly audio: DecodedGltfAudio) {
    const ctx = getAudioContext();
    this.gain = ctx.createGain();
    this.gain.connect(ctx.destination);
  }

  get playing(): boolean {
    return this.source !== null;
  }

  get duration(): number {
    return this.audio.buffer.duration;
  }

  setMuted(muted: boolean): void {
    this.gain.gain.value = muted ? 0 : 1;
  }

  start(clipTime: number): void {
    this.stop();
    const ctx = getAudioContext();
    const { buffer, loop } = this.audio;
    const time = Math.max(clipTime, 0);
    const offset = loop ? time % buffer.duration : time;
    if (offset >= buffer.duration) return;
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.loop = loop;
    source.connect(this.gain);
    source.start(0, offset);
    this.source = source;
    this.startedAt = ctx.currentTime;
    this.startOffset = offset;
  }

  stop(): void {
    if (!this.source) return;
    try {
      this.source.stop();
    } catch {
      // already stopped
    }
    this.source.disconnect();
    this.source = null;
  }

  /** Clip time the playing source is at, or null when stopped. */
  scheduledOffset(): number | null {
    if (!this.source) return null;
    const elapsed = getAudioContext().currentTime - this.startedAt + this.startOffset;
    return this.audio.loop ? elapsed % this.audio.buffer.duration : elapsed;
  }

  dispose(): void {
    this.stop();
    this.gain.disconnect();
  }
}
