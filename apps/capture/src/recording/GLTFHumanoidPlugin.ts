import type * as THREE from 'three';
import type { GLTFExporterPlugin } from 'three/examples/jsm/exporters/GLTFExporter.js';
import type { VrmHumanoidBone } from '@holoim/meaning';

import { HUMANOID_BONE_TAG, HUMANOID_TIP_TAG, humanoidTagOf } from '../avatar/HumanoidSkeleton';

export const HOLOIM_HUMANOID_EXTENSION = 'HOLOIM_humanoid';

/** Internal GLTFWriter fields not exposed in the public type declarations. */
interface GLTFWriterInternal {
  json: { extensions?: Record<string, unknown> };
  extensionsUsed: Record<string, boolean>;
  nodeMap: Map<THREE.Object3D, number>;
}

interface NodeDef {
  extras?: Record<string, unknown>;
}

/**
 * GLTFExporter plugin that writes the recorded avatar's canonical bones as the
 * root `HOLOIM_humanoid` extension, in VRM's shape
 * (`{ humanBones: { hips: { node } } }`, listed in `extensionsUsed` only), so
 * viewers find the hips and head on any rig, even one with arbitrary bone
 * names. Source bone names are left as they are. The load-time tags that
 * mark canonical bones are removed from node extras.
 */
export class GLTFHumanoidPlugin implements GLTFExporterPlugin {
  private readonly writer: GLTFWriterInternal;
  private readonly tagged = new Map<VrmHumanoidBone, THREE.Object3D>();

  constructor(writer: unknown) {
    this.writer = writer as GLTFWriterInternal;
  }

  writeNode(object: THREE.Object3D, nodeDef: NodeDef): void {
    const { bone } = humanoidTagOf(object);
    if (bone && !this.tagged.has(bone)) this.tagged.set(bone, object);
    if (!nodeDef.extras) return;
    delete nodeDef.extras[HUMANOID_BONE_TAG];
    delete nodeDef.extras[HUMANOID_TIP_TAG];
    if (Object.keys(nodeDef.extras).length === 0) delete nodeDef.extras;
  }

  afterParse(): void {
    const humanBones: Partial<Record<VrmHumanoidBone, { node: number }>> = {};
    for (const [bone, object] of this.tagged) {
      const node = this.writer.nodeMap.get(object);
      if (node !== undefined) humanBones[bone] = { node };
    }
    if (Object.keys(humanBones).length === 0) return;
    const json = this.writer.json;
    if (!json.extensions) json.extensions = {};
    json.extensions[HOLOIM_HUMANOID_EXTENSION] = { humanBones };
    this.writer.extensionsUsed[HOLOIM_HUMANOID_EXTENSION] = true;
  }
}
