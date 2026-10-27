import type * as THREE from 'three';
import type { GLTFExporterPlugin } from 'three/examples/jsm/exporters/GLTFExporter.js';
import { encodeHoloimMeaning, HOLOIM_MEANING_EXTENSION, type MeaningLinkMark } from '@holoim/meaning';

import { AUTHOR_CAMERA_NODE_NAME } from './CameraTrackStore';
import type { MeaningDraft } from './PointResolver';

/** Internal GLTFWriter fields not exposed in the public type declarations. */
interface GLTFWriterInternal {
  json: { extensions?: Record<string, unknown>; nodes?: Array<{ name?: string }> };
  extensionsUsed: Record<string, boolean>;
  nodeMap: Map<THREE.Object3D, number>;
}

/**
 * GLTFExporter plugin that writes the take's meaning layer as the root
 * `HOLOIM_meaning` extension (listed in `extensionsUsed` only). Node indices
 * exist only once the writer has processed the scene, so drafts carry
 * objects and are mapped through the writer's `nodeMap` here. A link whose
 * node was not exported is dropped; nothing is written when nothing is left.
 * The version is chosen by `encodeHoloimMeaning` (lowest that accepts the
 * record): performer drafts carry bone froms and keep writing v0; a camera
 * take's links come from its camera node and write v1. The schema checks the
 * extension alone, so this writer asserts a camera `from` names the author
 * camera node.
 */
export class GLTFMeaningPlugin implements GLTFExporterPlugin {
  private readonly writer: GLTFWriterInternal;

  constructor(writer: unknown, private readonly draft: MeaningDraft) {
    this.writer = writer as GLTFWriterInternal;
  }

  afterParse(): void {
    const { nodeMap } = this.writer;
    const marks: MeaningLinkMark[] = [];
    for (const mark of this.draft.marks) {
      const fromNode = nodeMap.get(mark.from.object);
      const toNode = nodeMap.get(mark.to.object);
      if (fromNode === undefined || toNode === undefined) continue;
      const to: MeaningLinkMark['anchor']['to'] = { node: toNode };
      if (mark.to.bone) to.bone = mark.to.bone;
      to.point = mark.to.point;
      if (mark.to.radius !== undefined) to.radius = mark.to.radius;
      let from: MeaningLinkMark['anchor']['from'];
      if ('camera' in mark.from) {
        const name = this.writer.json.nodes?.[fromNode]?.name;
        if (name !== AUTHOR_CAMERA_NODE_NAME) throw new Error(`A camera link must come from ${AUTHOR_CAMERA_NODE_NAME}, not node ${fromNode} (${name ?? 'unnamed'}).`);
        from = { camera: true, node: fromNode };
      } else {
        from = { bone: mark.from.bone, node: fromNode };
      }
      marks.push({
        kind: 'link',
        anchor: { from, to },
        span: mark.span,
        provenance: mark.provenance
      });
    }
    if (marks.length === 0 && this.draft.spans.length === 0) return;

    const meaning = encodeHoloimMeaning({ marks, spans: this.draft.spans });
    const json = this.writer.json;
    if (!json.extensions) json.extensions = {};
    json.extensions[HOLOIM_MEANING_EXTENSION] = meaning;
    this.writer.extensionsUsed[HOLOIM_MEANING_EXTENSION] = true;
  }
}
