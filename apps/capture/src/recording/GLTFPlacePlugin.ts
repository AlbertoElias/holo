import type * as THREE from 'three';
import { PLACE_EXTENSION, PLACE_EXTENSION_VERSION, type PlaceExtension } from '@holoim/contracts';
import type { GLTFExporterPlugin } from 'three/examples/jsm/exporters/GLTFExporter.js';

interface GLTFWriterInternal {
  json: {
    nodes?: Array<{ name?: string; extensions?: Record<string, unknown> }>;
    bufferViews?: Array<{ buffer: number; byteOffset: number; byteLength: number }>;
    buffers?: Array<{ byteLength: number }>;
  };
  nodeMap: Map<THREE.Object3D, number>;
  extensionsUsed: Record<string, boolean>;
  byteOffset: number;
  processBuffer(buffer: ArrayBuffer): number;
}

/**
 * Writes the take's stored place (docs/features/splat-capture.md, Q4):
 * the SPZ bytes in a buffer view no mesh references, and `HOLOIM_place` v1 on
 * the `RecordedPlace` node, whose TRS the exporter has already written.
 * Optional, never required, like `KHR_audio`.
 */
export class GLTFPlacePlugin implements GLTFExporterPlugin {
  private readonly writer: GLTFWriterInternal;

  constructor(writer: unknown, private readonly place: { node: THREE.Object3D; spz: Uint8Array; splatCount: number; maxSh: number }) {
    this.writer = writer as GLTFWriterInternal;
  }

  afterParse(): void {
    const writer = this.writer;
    const json = writer.json;
    const nodeIndex = writer.nodeMap.get(this.place.node);
    const node = nodeIndex === undefined ? undefined : json.nodes?.[nodeIndex];
    if (!node) throw new Error('The place node was not exported.');
    json.bufferViews ??= [];
    json.buffers ??= [{ byteLength: 0 }];
    const { spz } = this.place;
    // GLB chunks align to 4 bytes; the view keeps the SPZ's own length, so a gzip reader never meets the padding.
    const padded = new Uint8Array(Math.ceil(spz.byteLength / 4) * 4);
    padded.set(spz);
    const buffer = writer.processBuffer(padded.buffer);
    const bufferView = json.bufferViews.push({ buffer, byteOffset: writer.byteOffset, byteLength: spz.byteLength }) - 1;
    writer.byteOffset += padded.byteLength;
    const extension: PlaceExtension = {
      version: PLACE_EXTENSION_VERSION,
      bufferView,
      splatCount: this.place.splatCount,
      maxSh: this.place.maxSh,
      // Not aligned with the real room (Q2 *here* is slice 2e): the scan is the take's set, never its site.
      provenance: { kind: 'reconstruction', relation: 'set' }
    };
    node.extensions = { ...node.extensions, [PLACE_EXTENSION]: extension };
    writer.extensionsUsed[PLACE_EXTENSION] = true;
  }
}
