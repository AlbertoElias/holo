import type { GLTFExporterPlugin } from 'three/examples/jsm/exporters/GLTFExporter.js';

/**
 * Internal GLTFWriter fields not exposed in the public type declarations.
 * These are stable internals used by all built-in Three.js exporter plugins.
 */
interface GLTFWriterInternal {
  json: {
    bufferViews?: Array<{ buffer: number; byteOffset: number; byteLength: number }>;
    buffers?: Array<{ byteLength: number }>;
    scenes?: Array<{ extensions?: Record<string, unknown> }>;
    extensions?: Record<string, unknown>;
    extensionsUsed?: string[];
  };
  extensionsUsed: Record<string, boolean>;
  byteOffset: number;
  processBuffer(buffer: ArrayBuffer): number;
}

function getPaddedArrayBuffer(arrayBuffer: ArrayBuffer): ArrayBuffer {
  const paddedLength = Math.ceil(arrayBuffer.byteLength / 4) * 4;
  if (paddedLength === arrayBuffer.byteLength) return arrayBuffer;

  const padded = new Uint8Array(paddedLength);
  padded.set(new Uint8Array(arrayBuffer));
  return padded.buffer;
}

/**
 * GLTFExporter plugin that embeds audio data using the KHR_audio extension.
 *
 * Spec: https://github.com/KhronosGroup/glTF/tree/main/extensions/2.0/Khronos/KHR_audio
 */
export class GLTFAudioPlugin implements GLTFExporterPlugin {
  private readonly writer: GLTFWriterInternal;
  private readonly audioBuffer: ArrayBuffer;
  private readonly mimeType: string;

  constructor(writer: unknown, audioBuffer: ArrayBuffer, mimeType: string) {
    this.writer = writer as GLTFWriterInternal;
    this.audioBuffer = audioBuffer;
    this.mimeType = mimeType;
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
        {
          type: 'global',
          sources: [0],
          gain: 1.0
        }
      ]
    };

    // Attach to root extensions
    if (!json.extensions) json.extensions = {};
    json.extensions['KHR_audio'] = khrAudio;

    // Attach emitter reference to scene
    if (json.scenes && json.scenes.length > 0) {
      const scene = json.scenes[0];
      if (!scene.extensions) scene.extensions = {};
      scene.extensions['KHR_audio'] = { emitters: [0] };
    }

    // Register extension as used
    writer.extensionsUsed['KHR_audio'] = true;
  }
}
