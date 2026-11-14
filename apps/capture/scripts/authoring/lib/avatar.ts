/**
 * An avatar loaded in Node for direction and the audition: three.js objects
 * from GLTFLoader, bound with capture's own `HumanoidSkeleton` (facing
 * normalized), `FaceRig`, and `AvatarRig`'s arm chains (with a stub renderer:
 * building a chain never touches it). Nothing here edits capture's modules.
 */
import { readFile } from 'node:fs/promises';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { VRM_HUMANOID_BONES, type VrmHumanoidBone } from '@holoim/meaning';

import { HumanoidSkeleton } from '../../../src/avatar/HumanoidSkeleton.ts';
import { AvatarRig, type ArmIkChain } from '../../../src/avatar/AvatarRig.ts';
import { FaceRig } from '../../../src/face/FaceRig.ts';
import { HandRig } from './hands.ts';
import { parseGlb } from './gltf-read.ts';

export type Side = 'left' | 'right';

export interface BindBone {
  readonly bone: THREE.Bone;
  readonly local: THREE.Quaternion;
  readonly localPosition: THREE.Vector3;
  /** Bind position and rotation in the body frame (+Z forward, +Y up). */
  readonly rootPosition: THREE.Vector3;
  readonly rootQuaternion: THREE.Quaternion;
}

export interface LegRig {
  readonly side: Side;
  readonly upLeg: BindBone;
  readonly leg: BindBone;
  readonly foot: BindBone;
  readonly toes: BindBone | undefined;
  readonly thighLength: number;
  readonly shinLength: number;
}

export interface LoadedAvatar {
  readonly file: string;
  readonly bytes: Uint8Array;
  /** Stage placement: position and yaw of the performer. The avatar's scene is its only child. */
  readonly frame: THREE.Group;
  readonly scene: THREE.Group;
  /** The facing-normalized frame: `HumanoidFacing` when capture had to add it, else the scene. */
  readonly body: THREE.Object3D;
  readonly facingCorrection: THREE.Quaternion | null;
  readonly humanoid: HumanoidSkeleton;
  readonly face: FaceRig;
  readonly arms: Readonly<Record<Side, ArmIkChain>>;
  readonly hands: Readonly<Record<Side, HandRig | undefined>>;
  readonly legs: Readonly<Record<Side, LegRig>>;
  readonly bind: ReadonlyMap<VrmHumanoidBone, BindBone>;
  /** Every node object of the loaded scene → its glTF node index. */
  readonly nodeIndex: ReadonlyMap<THREE.Object3D, number>;
  /** Every bone's bind local transform, to reset before each frame. */
  readonly rest: ReadonlyMap<THREE.Object3D, { q: THREE.Quaternion; p: THREE.Vector3 }>;
  /** Standing height (head top or eye line over the feet), metres. */
  readonly height: number;
}

/**
 * GLTFLoader decodes textures with the DOM, which Node lacks; direction needs
 * only geometry, skins and morph targets, so images are dropped before parsing.
 */
export function withoutTextures(bytes: Uint8Array): ArrayBuffer {
  const { json, bin } = parseGlb(bytes);
  const j = structuredClone(json) as Record<string, unknown> & { materials?: Record<string, unknown>[]; buffers?: { byteLength: number }[] };
  delete j.images; delete j.textures; delete j.samplers;
  const strip = (o: unknown): void => {
    if (!o || typeof o !== 'object') return;
    for (const [k, v] of Object.entries(o as Record<string, unknown>)) {
      if (/Texture$/.test(k) && v && typeof v === 'object' && 'index' in (v as object)) delete (o as Record<string, unknown>)[k];
      else strip(v);
    }
  };
  for (const m of j.materials ?? []) strip(m);
  const text = new TextEncoder().encode(JSON.stringify(j));
  const jsonLen = Math.ceil(text.length / 4) * 4;
  const binLen = Math.ceil(bin.length / 4) * 4;
  const out = new Uint8Array(12 + 8 + jsonLen + (bin.length ? 8 + binLen : 0));
  const view = new DataView(out.buffer);
  view.setUint32(0, 0x46546c67, true); view.setUint32(4, 2, true); view.setUint32(8, out.length, true);
  view.setUint32(12, jsonLen, true); view.setUint32(16, 0x4e4f534a, true);
  out.set(text, 20); out.fill(0x20, 20 + text.length, 20 + jsonLen);
  if (bin.length) {
    const at = 20 + jsonLen;
    view.setUint32(at, binLen, true); view.setUint32(at + 4, 0x004e4942, true);
    out.set(bin, at + 8);
  }
  return out.buffer;
}

const silence = <T>(fn: () => Promise<T>): Promise<T> => {
  const warn = console.warn;
  const error = console.error;
  console.warn = () => {};
  console.error = () => {};
  return fn().finally(() => { console.warn = warn; console.error = error; });
};

export async function loadAvatar(file: string): Promise<LoadedAvatar> {
  const bytes = new Uint8Array(await readFile(file));
  const gltf = await silence(() => new GLTFLoader().parseAsync(withoutTextures(bytes), ''));
  const scene = gltf.scene;
  const nodeIndex = new Map<THREE.Object3D, number>();
  for (const [object, entry] of gltf.parser.associations as Map<THREE.Object3D, { nodes?: number } | undefined>) {
    if (entry?.nodes !== undefined && (object as THREE.Object3D).isObject3D) nodeIndex.set(object, entry.nodes);
  }
  const frame = new THREE.Group();
  frame.name = 'PerformerFrame';
  frame.add(scene);
  frame.updateMatrixWorld(true);
  const humanoid = HumanoidSkeleton.bind(scene, { json: gltf.parser.json, associations: gltf.parser.associations as never });
  humanoid.normalizeFacing(scene);
  const facingNode = scene.children.find((c) => c.name === 'HumanoidFacing' && !nodeIndex.has(c));
  const body = facingNode ?? scene;
  frame.updateMatrixWorld(true);
  const missing = (['hips', 'spine', 'head', 'leftUpperArm', 'leftLowerArm', 'leftHand', 'rightUpperArm', 'rightLowerArm', 'rightHand',
    'leftUpperLeg', 'leftLowerLeg', 'leftFoot', 'rightUpperLeg', 'rightLowerLeg', 'rightFoot'] as const).filter((b) => !humanoid.bone(b));
  if (missing.length) throw new Error(`${file}: cannot direct an avatar without ${missing.join(', ')}`);

  const rest = new Map<THREE.Object3D, { q: THREE.Quaternion; p: THREE.Vector3 }>();
  scene.traverse((o) => { if ((o as THREE.Bone).isBone || nodeIndex.has(o)) rest.set(o, { q: o.quaternion.clone(), p: o.position.clone() }); });

  const bodyInv = body.getWorldQuaternion(new THREE.Quaternion()).invert();
  const bind = new Map<VrmHumanoidBone, BindBone>();
  for (const name of VRM_HUMANOID_BONES) {
    const bone = humanoid.bone(name);
    if (!bone) continue;
    bind.set(name, {
      bone,
      local: bone.quaternion.clone(),
      localPosition: bone.position.clone(),
      rootPosition: body.worldToLocal(bone.getWorldPosition(new THREE.Vector3())),
      rootQuaternion: bodyInv.clone().multiply(bone.getWorldQuaternion(new THREE.Quaternion()))
    });
  }

  const rig = new AvatarRig(new THREE.Group(), {} as THREE.WebGLRenderer);
  rig.avatar = scene;
  rig.humanoid = humanoid;
  const arm = (side: Side): ArmIkChain => {
    const chain = rig.createArmIkChain(side);
    if (!chain) throw new Error(`${file}: no ${side} arm chain`);
    return chain;
  };
  const leg = (side: Side): LegRig => {
    const upLeg = bind.get(`${side}UpperLeg`)!;
    const lower = bind.get(`${side}LowerLeg`)!;
    const foot = bind.get(`${side}Foot`)!;
    return {
      side, upLeg, leg: lower, foot, toes: bind.get(`${side}Toes`),
      thighLength: upLeg.rootPosition.distanceTo(lower.rootPosition),
      shinLength: lower.rootPosition.distanceTo(foot.rootPosition)
    };
  };
  const face = new FaceRig(body, { head: humanoid.bone('head'), leftEye: humanoid.bone('leftEye'), rightEye: humanoid.bone('rightEye') });
  const headTop = humanoid.tip('head');
  const footY = Math.min(bind.get('leftFoot')!.rootPosition.y, bind.get('rightFoot')!.rootPosition.y);
  const top = headTop ? body.worldToLocal(headTop.getWorldPosition(new THREE.Vector3())).y : bind.get('head')!.rootPosition.y + 0.15;
  return {
    file, bytes, frame, scene, body,
    facingCorrection: facingNode ? facingNode.quaternion.clone() : null,
    humanoid, face,
    arms: { left: arm('left'), right: arm('right') },
    hands: { left: HandRig.create(humanoid, 'left', body), right: HandRig.create(humanoid, 'right', body) },
    legs: { left: leg('left'), right: leg('right') },
    bind, nodeIndex, rest,
    height: top - footY + Math.max(0, footY)
  };
}

/** Puts every bone and node back at its bind transform. */
export function resetPose(avatar: LoadedAvatar): void {
  for (const [o, t] of avatar.rest) { o.quaternion.copy(t.q); o.position.copy(t.p); }
  avatar.frame.updateMatrixWorld(true);
}
