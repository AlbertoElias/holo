import type * as THREE from 'three';
import type { GLTFExporterPlugin } from 'three/examples/jsm/exporters/GLTFExporter.js';

import { humanoidTagOf } from '../avatar/HumanoidSkeleton';

/**
 * Internal GLTFWriter fields not exposed in the public type declarations.
 * These are stable internals used by all built-in Three.js exporter plugins.
 */
interface GLTFWriterInternal {
  json: {
    bufferViews?: Array<{ buffer: number; byteOffset: number; byteLength: number }>;
    buffers?: Array<{ byteLength: number }>;
    scenes?: Array<{ extensions?: Record<string, unknown> }>;
    nodes?: Array<{ extensions?: Record<string, unknown> }>;
    extensions?: Record<string, unknown>;
    extensionsUsed?: string[];
  };
  extensionsUsed: Record<string, boolean>;
  byteOffset: number;
  nodeMap: Map<THREE.Object3D, number>;
  processBuffer(buffer: ArrayBuffer): number;
}

/**
 * How the voice placed on the head fades with distance
 * (docs/features/archive/positional-audio.md). Within `refDistance` it plays at the
 * level a take plays at today; beyond, it falls off with inverse distance.
 * Two metres keeps the feed's first view within about 2 dB of today.
 */
export const VOICE_DISTANCE = { distanceModel: 'inverse', refDistance: 2, maxDistance: 10000, rolloffFactor: 1 } as const;

function getPaddedArrayBuffer(arrayBuffer: ArrayBuffer): ArrayBuffer {
  const paddedLength = Math.ceil(arrayBuffer.byteLength / 4) * 4;
  if (paddedLength === arrayBuffer.byteLength) return arrayBuffer;

  const padded = new Uint8Array(paddedLength);
  padded.set(new Uint8Array(arrayBuffer));
  return padded.buffer;
}

/**
 * GLTFExporter plugin that embeds the recorded microphone audio using the
 * KHR_audio extension.
 *
 * On an avatar take the voice is a positional emitter on the avatar's head
 * node, so it is heard from where the author spoke. A take without a tagged
 * head (a camera take) keeps one global emitter listed by the scene, as
 * every take did before positional audio.
 *
 * Spec: https://github.com/KhronosGroup/glTF/tree/main/extensions/2.0/Khronos/KHR_audio
 */
export class GLTFAudioPlugin implements GLTFExporterPlugin {
  private readonly writer: GLTFWriterInternal;
  private readonly audioBuffer: ArrayBuffer;
  private readonly mimeType: string;
  private head: THREE.Object3D | null = null;

  constructor(writer: unknown, audioBuffer: ArrayBuffer, mimeType: string) {
    this.writer = writer as GLTFWriterInternal;
    this.audioBuffer = audioBuffer;
    this.mimeType = mimeType;
  }

  writeNode(object: THREE.Object3D): void {
    if (!this.head && humanoidTagOf(object).bone === 'head') this.head = object;
  }

  afterParse(): void {
    const writer = this.writer;
    const json = writer.json;

    if (!json.bufferViews) json.bufferViews = [];
    if (!json.buffers) json.buffers = [{ byteLength: 0 }];

    // Pad audio data to 4-byte alignment (GLB requirement)
    const paddedBuffer = getPaddedArrayBuffer(this.audioBuffer);

    // Append audio bytes to the binary buffer
    const bufferIndex = writer.processBuffer(paddedBuffer);
    const bufferViewDef = {
      buffer: bufferIndex,
      byteOffset: writer.byteOffset,
      byteLength: paddedBuffer.byteLength
    };
    writer.byteOffset += paddedBuffer.byteLength;
    const bufferViewIndex = json.bufferViews.push(bufferViewDef) - 1;

    const headIndex = this.head ? writer.nodeMap.get(this.head) : undefined;
    const head = headIndex !== undefined ? json.nodes?.[headIndex] : undefined;

    // Build KHR_audio extension data
    const khrAudio = {
      audio: [
        {
          bufferView: bufferViewIndex,
          mimeType: this.mimeType
        }
      ],
      sources: [
        {
          audio: 0,
          autoPlay: false,
          loop: true
        }
      ],
      emitters: [
        head
          ? { name: 'voice', type: 'positional', sources: [0], gain: 1.0, positional: { ...VOICE_DISTANCE } }
          : { type: 'global', sources: [0], gain: 1.0 }
      ]
    };

    // Attach to root extensions
    if (!json.extensions) json.extensions = {};
    json.extensions['KHR_audio'] = khrAudio;

    if (head) {
      // The head node carries the voice.
      if (!head.extensions) head.extensions = {};
      head.extensions['KHR_audio'] = { emitter: 0 };
    } else if (json.scenes && json.scenes.length > 0) {
      // Attach the global emitter reference to the scene
      const scene = json.scenes[0]!;
      if (!scene.extensions) scene.extensions = {};
      scene.extensions['KHR_audio'] = { emitters: [0] };
    }

    // Register extension as used
    writer.extensionsUsed['KHR_audio'] = true;
  }
}
