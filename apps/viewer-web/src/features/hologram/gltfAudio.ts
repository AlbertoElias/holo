import { Matrix4, Quaternion, Vector3 } from "three";
import type { Object3D } from "three";

// A hologram's sound (KHR_audio, the draft extension capture writes): clips,
// sources that play them, and emitters that place them. A `global` emitter is
// heard the same from everywhere; a `positional` one sits on every node that
// names it (`nodes[i].extensions.KHR_audio.emitter`) and is heard from there,
// through a PannerNode the player moves to the node's world position each
// frame. Every source runs on the hologram's clip clock: all start together
// at the motion's time and restart with it.
//
// The context's listener never moves. Each frame the player hands `place()`
// the ear (the portal's on flat screens, the head in XR) and every panner is
// set to its object's position as seen from that ear, so one shared listener
// is never fought over, and browsers without listener AudioParams need no
// fallback.
//
// Compatibility with files made before positional sound (all of them):
// - global emitters play whether or not the scene lists them (older fixtures
//   leave the scene's list out);
// - a file with clips and sources but no emitters plays its first source;
// - a single global source at gain 1 builds the graph it always has: one
//   buffer source into one gain (the mute) into the destination. The node a
//   source connects to is always that voice's gain, set by `.value` to its
//   level or 0 (camera-take.pipeline.spec reads it);
// - `autoPlay` is ignored (capture writes false and the take still plays),
//   and `loop` defaults to true (the draft's default is false; old files
//   leave it out and loop).

/** Minimal GLTF result shape needed for audio extraction. */
export interface GltfAudioSource {
  parser: { json?: GltfJson; loadBufferView: (index: number) => Promise<ArrayBuffer> };
  userData: Record<string, unknown>;
}

type DistanceModel = "linear" | "inverse" | "exponential";

interface KhrPositional {
  distanceModel?: string;
  refDistance?: number;
  maxDistance?: number;
  rolloffFactor?: number;
}

interface KhrAudioData {
  audio?: Array<{ bufferView?: number; mimeType?: string }>;
  sources?: Array<{ audio?: number; autoPlay?: boolean; loop?: boolean; gain?: number }>;
  emitters?: Array<{ type?: string; sources?: number[]; gain?: number; name?: string; positional?: KhrPositional }>;
}

interface GltfJson {
  extensions?: Record<string, unknown>;
  nodes?: Array<{ extensions?: Record<string, unknown> }>;
}

/** Distance settings of a positional emitter, in the file's metres (the draft's defaults are Web Audio's). */
export interface EmitterDistance {
  model: DistanceModel;
  ref: number;
  max: number;
  rolloff: number;
}

export interface DecodedVoice {
  buffer: AudioBuffer;
  loop: boolean;
  /** Source gain times emitter gain. */
  gain: number;
}

export interface DecodedEmitter {
  /** Index in `KHR_audio.emitters`; -1 for a file without emitters. */
  index: number;
  kind: "global" | "positional";
  name: string | null;
  distance: EmitterDistance | null;
  voices: DecodedVoice[];
}

export interface DecodedGltfAudio {
  emitters: DecodedEmitter[];
}

/** Placed sounds per hologram that pan by the player's model (HRTF costs a convolution each); further ones pan equal-power. */
export const MAX_MODEL_PANNERS = 16;
/** Placed sounds per hologram at most; further ones are not played. */
export const MAX_PANNERS = 64;

/** Node index → the emitter it names, as three's GLTFLoader keeps unknown node extensions (and clones copy them). */
export function nodeEmitter(object: Object3D): number | null {
  const extensions = object.userData?.gltfExtensions as Record<string, { emitter?: unknown } | undefined> | undefined;
  const emitter = extensions?.KHR_audio?.emitter;
  return typeof emitter === "number" && Number.isInteger(emitter) ? emitter : null;
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
  const fromJson = gltf.parser.json?.extensions?.["KHR_audio"] as KhrAudioData | undefined;
  const extensions = gltf.userData?.gltfExtensions as Record<string, unknown> | undefined;
  const khrAudio = fromJson ?? (extensions?.["KHR_audio"] as KhrAudioData | undefined);
  if (!khrAudio?.audio?.length) return null;
  return khrAudio;
}

function finite(value: unknown, fallback: number, min = 0): number {
  return typeof value === "number" && Number.isFinite(value) && value >= min ? value : fallback;
}

function distanceOf(positional: KhrPositional | undefined): EmitterDistance {
  const model = positional?.distanceModel;
  return {
    model: model === "linear" || model === "exponential" ? model : "inverse",
    ref: finite(positional?.refDistance, 1),
    max: Math.max(finite(positional?.maxDistance, 10000), 1e-3),
    rolloff: finite(positional?.rolloffFactor, 1)
  };
}

interface PlannedVoice {
  audio: number;
  loop: boolean;
  gain: number;
}

interface PlannedEmitter {
  index: number;
  kind: "global" | "positional";
  name: string | null;
  distance: EmitterDistance | null;
  voices: PlannedVoice[];
}

/** Which clips play, from which emitters: the reference walk, before anything is decoded. */
function planEmitters(khrAudio: KhrAudioData, json: GltfJson | undefined): PlannedEmitter[] {
  const clips = khrAudio.audio ?? [];
  const sources = khrAudio.sources ?? [];
  const emitters = khrAudio.emitters ?? [];
  const voiceOf = (sourceIndex: number, emitterGain: number): PlannedVoice | null => {
    const source = sources[sourceIndex];
    const audio = source?.audio;
    if (!source || typeof audio !== "number" || !clips[audio]) {
      console.warn(`[KHR_audio] source ${sourceIndex} names no clip; skipped`);
      return null;
    }
    return { audio, loop: source.loop !== false, gain: finite(source.gain, 1) * emitterGain };
  };

  if (emitters.length === 0) {
    // Clips and sources only: the first source, or the first clip, as one global voice.
    const voice = sources.length > 0 ? voiceOf(0, 1) : { audio: 0, loop: true, gain: 1 };
    return voice ? [{ index: -1, kind: "global", name: null, distance: null, voices: [voice] }] : [];
  }

  const onNodes = new Set<number>();
  for (const node of json?.nodes ?? []) {
    const emitter = (node.extensions?.["KHR_audio"] as { emitter?: unknown } | undefined)?.emitter;
    if (typeof emitter === "number") onNodes.add(emitter);
  }
  const planned: PlannedEmitter[] = [];
  emitters.forEach((emitter, index) => {
    const kind = emitter.type === "positional" ? "positional" : "global";
    // A positional emitter no node names has no place in the scene: not played (the draft's rule).
    if (kind === "positional" && !onNodes.has(index)) return;
    const gain = finite(emitter.gain, 1);
    const voices = (emitter.sources ?? []).map((source) => voiceOf(source, gain)).filter((voice): voice is PlannedVoice => voice !== null);
    if (voices.length === 0) return;
    planned.push({ index, kind, name: emitter.name ?? null, distance: kind === "positional" ? distanceOf(emitter.positional) : null, voices });
  });
  return planned;
}

/** Decodes every clip an emitter plays (each once); null when the GLB carries none that decode. */
export async function decodeGltfAudio(gltf: GltfAudioSource): Promise<DecodedGltfAudio | null> {
  const khrAudio = extractKhrAudio(gltf);
  if (!khrAudio) return null;
  const planned = planEmitters(khrAudio, gltf.parser.json);
  const clips = khrAudio.audio ?? [];
  const wanted = [...new Set(planned.flatMap((emitter) => emitter.voices.map((voice) => voice.audio)))];
  const decoded = new Map<number, AudioBuffer>();
  const results = await Promise.allSettled(
    wanted.map(async (index) => {
      const bufferView = clips[index]?.bufferView;
      if (typeof bufferView !== "number") throw new Error(`clip ${index} is not embedded`);
      const raw = await gltf.parser.loadBufferView(bufferView);
      // decodeAudioData may detach the buffer, so pass a copy
      decoded.set(index, await getAudioContext().decodeAudioData(raw.slice(0)));
    })
  );
  const failed = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
  // One clip failing silences only its sources; none decoding is a failed decode, as before.
  if (failed.length === wanted.length && failed.length > 0) throw failed[0]!.reason;
  for (const failure of failed) console.warn("[KHR_audio] a clip failed to decode; its sources are skipped:", failure.reason);
  const emitters = planned
    .map((emitter) => ({
      index: emitter.index,
      kind: emitter.kind,
      name: emitter.name,
      distance: emitter.distance,
      voices: emitter.voices.flatMap((voice) => {
        const buffer = decoded.get(voice.audio);
        return buffer ? [{ buffer, loop: voice.loop, gain: voice.gain }] : [];
      })
    }))
    .filter((emitter) => emitter.voices.length > 0);
  return emitters.length > 0 ? { emitters } : null;
}

// ------------------------------------------------------------------ the ear

/** Where the ear is and which way it faces, in world space. */
export interface EarPose {
  position: Vector3;
  forward: Vector3;
  up: Vector3;
}

export function createEarPose(): EarPose {
  return { position: new Vector3(), forward: new Vector3(0, 0, -1), up: new Vector3(0, 1, 0) };
}

const earQuaternion = new Quaternion();
const earScale = new Vector3();

/** An ear at an object (a camera, the XR head): its world position, looking down its -Z with its +Y up. Its world matrix must be current. */
export function earFromObject(object: Object3D, out: EarPose): EarPose {
  object.matrixWorld.decompose(out.position, earQuaternion, earScale);
  out.forward.set(0, 0, -1).applyQuaternion(earQuaternion);
  out.up.set(0, 1, 0).applyQuaternion(earQuaternion);
  return out;
}

// ----------------------------------------------------------------- playback

/** How long a moved panner ramps to its new place: about a frame, so motion is continuous and nothing lags. */
const MIN_RAMP_S = 0.005;
const MAX_RAMP_S = 0.1;

interface Voice {
  decoded: DecodedVoice;
  emitter: DecodedEmitter;
  gain: GainNode;
  source: AudioBufferSourceNode | null;
  /** Where in its buffer the source began, at `startedAt` on the context's clock. */
  offset: number;
}

interface Placement {
  emitter: DecodedEmitter;
  node: Object3D;
  /**
   * The emitter's sum, before its panner: what a probe compares the
   * panner's output with. Silent until the first `place()`, so nothing is
   * heard from the panner's default spot (the ear itself) before then.
   */
  input: GainNode;
  /** Its layer's share of the sound (deep zoom), between the emitter's sum and this panner; 1 without layers. */
  level: GainNode;
  /** The layer its object belongs to (0 = the hologram itself), read once per set of layers. */
  layer: number;
  layersRead: SoundLayers | null;
  panner: PannerNode;
  placed: boolean;
  scale: number;
  /** The object's world position at the last `place()`. */
  world: Vector3;
  /** Where the panner was last sent: the object as the ear sees it (ear at the origin, looking down -Z). */
  sent: Vector3;
}

/**
 * A hologram's nested layers as its sound hears them (deep zoom,
 * docs/features/deep-zoom.md): which layer an object belongs to (0 = the
 * hologram itself), that layer's size against the hologram, and how loud it
 * is at the viewer's depth now. A layer's distances shrink with its size, so
 * it sounds from inside as the hologram does from its inside end.
 */
export interface SoundLayers {
  of(node: Object3D): number;
  size(layer: number): number;
  gain(layer: number): number;
}

export interface ScheduledAudioOptions {
  panningModel?: PanningModelType;
}

/** A probe's tap on one placed emitter: its level before the panner and at each ear after it. */
export interface PlacementTap {
  emitter: number;
  name: string | null;
  node: string;
  read(): { preRms: number; leftRms: number; rightRms: number; leftDb: number; rightDb: number };
}

type Vec3Tuple = [number, number, number];

const earBasis = new Matrix4();
const earInverse = new Matrix4();
const earRight = new Vector3();
const earUp = new Vector3();
const earBack = new Vector3();
const rootScale = new Vector3();

function rms(analyser: AnalyserNode, scratch: Float32Array<ArrayBuffer>): number {
  analyser.getFloatTimeDomainData(scratch);
  let sum = 0;
  for (const sample of scratch) sum += sample * sample;
  return Math.sqrt(sum / scratch.length);
}

/** Sets an AudioParam: a ramp of `seconds` on a running context, else at once (a suspended context's clock stands still, so ramps would only pile up). */
function moveParam(param: AudioParam, value: number, ctx: BaseAudioContext, seconds: number, jump: boolean): void {
  if (jump || ctx.state !== "running") {
    param.cancelScheduledValues(0);
    param.setValueAtTime(value, ctx.currentTime);
  } else {
    param.linearRampToValueAtTime(value, ctx.currentTime + Math.min(Math.max(seconds, MIN_RAMP_S), MAX_RAMP_S));
  }
}

/**
 * One hologram's sound, started at a clip time so it lands where the motion
 * is. Positional emitters are bound to the objects of `root` (the
 * hologram's clone) that name them, one panner per object; `place()` moves
 * each panner to its object as an ear sees it. `scheduledOffset`, `duration`
 * and `loop` report the lead voice: the longest looping source (the one the
 * XR player's drift check can always hear), else the first.
 */
export class ScheduledGltfAudio {
  private readonly voices: Voice[] = [];
  private readonly placements: Placement[] = [];
  private readonly lead: Voice | null;
  private readonly ear = createEarPose();
  private startedAt = 0;
  private leadOffset = 0;
  private started = false;

  constructor(
    audio: DecodedGltfAudio,
    private readonly root: Object3D | null,
    options: ScheduledAudioOptions = {}
  ) {
    const ctx = getAudioContext();
    const nodes = new Map<number, Object3D[]>();
    root?.traverse((object) => {
      const emitter = nodeEmitter(object);
      if (emitter === null) return;
      const list = nodes.get(emitter) ?? [];
      list.push(object);
      nodes.set(emitter, list);
    });
    for (const emitter of audio.emitters) {
      let outputs: AudioNode[] = [ctx.destination];
      if (emitter.kind === "positional" && emitter.distance) {
        const found = nodes.get(emitter.index) ?? [];
        const room = MAX_PANNERS - this.placements.length;
        if (found.length === 0) console.warn(`[KHR_audio] emitter ${emitter.index} names a node the scene does not have; heard unplaced`);
        if (found.length > room) console.warn(`[KHR_audio] more than ${MAX_PANNERS} placed sounds; the rest are not played`);
        const bound = found.slice(0, Math.max(room, 0));
        if (found.length > 0) {
          const input = ctx.createGain();
          input.gain.value = 0;
          outputs = [input];
          for (const node of bound) {
            const level = ctx.createGain();
            const panner = ctx.createPanner();
            panner.panningModel = this.placements.length < MAX_MODEL_PANNERS ? options.panningModel ?? "equalpower" : "equalpower";
            panner.distanceModel = emitter.distance.model;
            panner.refDistance = emitter.distance.ref;
            panner.maxDistance = emitter.distance.max;
            panner.rolloffFactor = emitter.distance.rolloff;
            input.connect(level);
            level.connect(panner);
            panner.connect(ctx.destination);
            this.placements.push({ emitter, node, input, level, layer: 0, layersRead: null, panner, placed: false, scale: 1, world: new Vector3(), sent: new Vector3() });
          }
        }
      }
      for (const decoded of emitter.voices) {
        const gain = ctx.createGain();
        gain.gain.value = decoded.gain;
        for (const output of outputs) gain.connect(output);
        this.voices.push({ decoded, emitter, gain, source: null, offset: 0 });
      }
    }
    const looping = this.voices.filter((voice) => voice.decoded.loop);
    this.lead = looping.reduce<Voice | null>((longest, voice) => (!longest || voice.decoded.buffer.duration > longest.decoded.buffer.duration ? voice : longest), null) ?? this.voices[0] ?? null;
  }

  get playing(): boolean {
    return this.started;
  }

  get duration(): number {
    return this.lead?.decoded.buffer.duration ?? 0;
  }

  get loop(): boolean {
    return this.lead?.decoded.loop ?? true;
  }

  /** Whether any sound has a place (and so wants `place()` each frame). */
  get spatial(): boolean {
    return this.placements.length > 0;
  }

  setMuted(muted: boolean): void {
    for (const voice of this.voices) voice.gain.gain.value = muted ? 0 : voice.decoded.gain;
  }

  start(clipTime: number): void {
    this.stop();
    const ctx = getAudioContext();
    const time = Math.max(clipTime, 0);
    for (const voice of this.voices) {
      const { buffer, loop } = voice.decoded;
      const offset = loop ? time % buffer.duration : time;
      if (voice === this.lead) this.leadOffset = offset;
      voice.offset = offset;
      if (offset >= buffer.duration) continue;
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.loop = loop;
      source.connect(voice.gain);
      source.start(0, offset);
      voice.source = source;
      this.started = true;
    }
    this.startedAt = ctx.currentTime;
  }

  stop(): void {
    for (const voice of this.voices) {
      const source = voice.source;
      if (!source) continue;
      try {
        source.stop();
      } catch {
        // already stopped
      }
      source.disconnect();
      voice.source = null;
    }
    this.started = false;
  }

  /** Clip time the lead voice is at, or null when stopped. */
  scheduledOffset(): number | null {
    if (!this.started || !this.lead) return null;
    const elapsed = getAudioContext().currentTime - this.startedAt + this.leadOffset;
    return this.lead.decoded.loop ? elapsed % this.lead.decoded.buffer.duration : elapsed;
  }

  /**
   * Sends every panner to its object as `ear` sees it. Distances scale with
   * the hologram's placement (its root's world scale: 1 at recorded scale),
   * so a shrunk hologram sounds like the same scene from proportionally
   * further away; an object's own scale is the author's and is left out.
   * With `layers` (a hologram that declares nesting), each object's
   * distances shrink further with its layer's size and it sounds at its
   * layer's gain. Call after the frame's motion is applied; `seconds` is the
   * frame's length.
   */
  place(ear: EarPose, seconds: number, layers: SoundLayers | null = null): void {
    if (this.placements.length === 0) return;
    const ctx = getAudioContext();
    this.ear.position.copy(ear.position);
    this.ear.forward.copy(ear.forward);
    this.ear.up.copy(ear.up);
    earBack.copy(ear.forward).normalize().negate();
    earRight.crossVectors(ear.up, earBack).normalize();
    earUp.crossVectors(earBack, earRight);
    earInverse.copy(earBasis.makeBasis(earRight, earUp, earBack).setPosition(ear.position)).invert();
    let scale = 1;
    if (this.root) {
      this.root.updateWorldMatrix(true, false);
      rootScale.setFromMatrixScale(this.root.matrixWorld);
      scale = Math.max(Math.abs(rootScale.x), Math.abs(rootScale.y), Math.abs(rootScale.z)) || 1;
    }
    for (const placement of this.placements) {
      const { node, panner, emitter } = placement;
      node.updateWorldMatrix(true, false);
      placement.world.setFromMatrixPosition(node.matrixWorld);
      placement.sent.copy(placement.world).applyMatrix4(earInverse);
      if (placement.layersRead !== layers) {
        placement.layersRead = layers;
        placement.layer = layers ? layers.of(node) : 0;
      }
      const placedScale = layers ? scale * layers.size(placement.layer) : scale;
      if (Math.abs(placedScale - placement.scale) > placedScale * 1e-6 || !placement.placed) {
        placement.scale = placedScale;
        panner.refDistance = emitter.distance!.ref * placedScale;
        panner.maxDistance = emitter.distance!.max * placedScale;
      }
      const jump = !placement.placed;
      // Without layers the level stays at its default 1, with no automation each frame.
      if (layers) moveParam(placement.level.gain, layers.gain(placement.layer), ctx, seconds, jump);
      const p = placement.sent;
      if (panner.positionX) {
        moveParam(panner.positionX, p.x, ctx, seconds, jump);
        moveParam(panner.positionY, p.y, ctx, seconds, jump);
        moveParam(panner.positionZ, p.z, ctx, seconds, jump);
      } else {
        panner.setPosition(p.x, p.y, p.z);
      }
      if (jump) placement.input.gain.value = 1;
      placement.placed = true;
    }
  }

  /** What a probe reads: the ear last used, and each placement's object, where its panner was sent (ear space) and where it is now. */
  readPlacements(): Array<{ emitter: number; name: string | null; node: string; nodeWorld: Vec3Tuple; placedWorld: Vec3Tuple; sent: Vec3Tuple; panner: Vec3Tuple; refDistance: number; panningModel: string; placed: boolean; layer: number; level: number }> {
    return this.placements.map((placement) => {
      const { panner } = placement;
      return {
        emitter: placement.emitter.index,
        name: placement.emitter.name,
        node: placement.node.name,
        nodeWorld: placement.node.getWorldPosition(new Vector3()).toArray() as Vec3Tuple,
        placedWorld: placement.world.toArray() as Vec3Tuple,
        sent: placement.sent.toArray() as Vec3Tuple,
        panner: panner.positionX ? [panner.positionX.value, panner.positionY.value, panner.positionZ.value] : [Number.NaN, Number.NaN, Number.NaN],
        refDistance: panner.refDistance,
        panningModel: panner.panningModel,
        placed: placement.placed,
        layer: placement.layer,
        level: placement.level.gain.value
      };
    });
  }

  /** The ear `place()` last used, in world space. */
  readEar(): { position: Vec3Tuple; forward: Vec3Tuple; up: Vec3Tuple } {
    return { position: this.ear.position.toArray() as Vec3Tuple, forward: this.ear.forward.toArray() as Vec3Tuple, up: this.ear.up.toArray() as Vec3Tuple };
  }

  /** Voices as a probe reads them: which emitter, whether a source runs, its gain now, and where in its buffer it is (null when stopped). */
  readVoices(): Array<{ emitter: number; kind: string; playing: boolean; gain: number; duration: number; loop: boolean; offset: number | null }> {
    const now = getAudioContext().currentTime;
    return this.voices.map((voice) => {
      const duration = voice.decoded.buffer.duration;
      const elapsed = now - this.startedAt + voice.offset;
      return {
        emitter: voice.emitter.index,
        kind: voice.emitter.kind,
        playing: voice.source !== null,
        gain: voice.gain.gain.value,
        duration,
        loop: voice.decoded.loop,
        offset: voice.source ? (voice.decoded.loop ? elapsed % duration : elapsed) : null
      };
    });
  }

  /** Test probes only: analysers on each placed emitter, before its panner and at each ear after it. */
  tap(fftSize = 16384): PlacementTap[] {
    const ctx = getAudioContext();
    return this.placements.map((placement) => {
      const pre = ctx.createAnalyser();
      pre.fftSize = fftSize;
      placement.input.connect(pre);
      const split = ctx.createChannelSplitter(2);
      placement.panner.connect(split);
      const left = ctx.createAnalyser();
      const right = ctx.createAnalyser();
      left.fftSize = fftSize;
      right.fftSize = fftSize;
      split.connect(left, 0);
      split.connect(right, 1);
      const scratch = new Float32Array(fftSize);
      return {
        emitter: placement.emitter.index,
        name: placement.emitter.name,
        node: placement.node.name,
        read: () => {
          const preRms = rms(pre, scratch);
          const leftRms = rms(left, scratch);
          const rightRms = rms(right, scratch);
          const db = (value: number) => (preRms > 0 && value > 0 ? 20 * Math.log10(value / preRms) : Number.NEGATIVE_INFINITY);
          return { preRms, leftRms, rightRms, leftDb: db(leftRms), rightDb: db(rightRms) };
        }
      };
    });
  }

  dispose(): void {
    this.stop();
    for (const voice of this.voices) voice.gain.disconnect();
    for (const placement of this.placements) {
      placement.input.disconnect();
      placement.level.disconnect();
      placement.panner.disconnect();
    }
  }
}
