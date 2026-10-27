import * as THREE from 'three';
import {
  type HumanoidMapping,
  type HumanoidNodeCandidate,
  type VrmHumanoidBone,
  readHumanoidDeclaration,
  resolveHumanoidRig
} from '@holoim/meaning';

import { isThreeBone, isThreeSkinnedMesh } from '../shared/threeTypeGuards';

/** A canonical bone, or its end site (`leftIndexDistalTip`, `headTip`). */
export type HumanoidBoneRef = VrmHumanoidBone | `${VrmHumanoidBone}Tip`;

/** What GLTFLoader keeps per loaded object: `parser.associations`. */
export type GltfAssociations = ReadonlyMap<unknown, { nodes?: number }>;

export interface HumanoidSource {
  /** The glTF JSON (`gltf.parser.json`), for VRMC_vrm / VRM / HOLOIM_humanoid declarations. */
  readonly json?: unknown;
  readonly associations?: GltfAssociations;
}

export interface HumanoidFacingReport {
  /** Avatar-space forward and up measured from the skeleton, before correction. */
  readonly detectedForward: readonly [number, number, number] | null;
  readonly detectedUp: readonly [number, number, number] | null;
  /** Euler XYZ degrees applied on the `HumanoidFacing` node; null when none was needed or it was refused. */
  readonly correctionDeg: readonly [number, number, number] | null;
  readonly note?: string;
}

export interface HumanoidBindingReport {
  readonly source: HumanoidMapping['source'];
  readonly declarationFormat?: HumanoidMapping['declarationFormat'];
  readonly standard?: HumanoidMapping['standard'];
  /** Canonical bone → source node name. */
  readonly bones: Readonly<Partial<Record<VrmHumanoidBone, string>>>;
  readonly missingRequired: readonly VrmHumanoidBone[];
  readonly unmatched: readonly VrmHumanoidBone[];
  readonly ambiguities: readonly { bone: VrmHumanoidBone; chosen: string; rejected: readonly string[] }[];
  readonly declarationErrors: readonly string[];
  readonly facing: HumanoidFacingReport;
  /** Feature → reason, registered by each system that turned itself off. */
  readonly disabledFeatures: Readonly<Record<string, string>>;
  readonly notes: readonly string[];
}

const FACING_NODE = 'HumanoidFacing';

/**
 * `userData` keys that tag canonical bones and finger end sites. Clones
 * (export, point resolution) carry them; the export plugin turns them into
 * `HOLOIM_humanoid` and strips them from node extras.
 */
export const HUMANOID_BONE_TAG = 'holoimHumanoidBone';
export const HUMANOID_TIP_TAG = 'holoimHumanoidTipOf';

/** The canonical bone a (possibly cloned) object was tagged with at load. */
export function humanoidTagOf(obj: THREE.Object3D): { bone?: VrmHumanoidBone; tipOf?: VrmHumanoidBone } {
  const bone = obj.userData[HUMANOID_BONE_TAG] as unknown;
  const tipOf = obj.userData[HUMANOID_TIP_TAG] as unknown;
  return {
    ...(typeof bone === 'string' ? { bone: bone as VrmHumanoidBone } : {}),
    ...(typeof tipOf === 'string' ? { tipOf: tipOf as VrmHumanoidBone } : {})
  };
}
const AXES = [
  new THREE.Vector3(1, 0, 0), new THREE.Vector3(-1, 0, 0),
  new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, -1, 0),
  new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 0, -1)
];

function nearestAxis(v: THREE.Vector3, perpendicularTo?: THREE.Vector3): THREE.Vector3 {
  let best = AXES[0]!;
  let bestDot = -Infinity;
  for (const axis of AXES) {
    if (perpendicularTo && Math.abs(axis.dot(perpendicularTo)) > 0.5) continue;
    const d = axis.dot(v);
    if (d > bestDot) { bestDot = d; best = axis; }
  }
  return best.clone();
}

const round = (v: THREE.Vector3): [number, number, number] =>
  [v.x, v.y, v.z].map((n) => Math.round(n * 1000) / 1000) as [number, number, number];

/**
 * The avatar's canonical humanoid skeleton: VRM 1.0 bones resolved once at
 * load from the file's declaration or its bone names, plus the facing
 * correction that turns the skeleton to face +Z with +Y up. Every capture
 * system finds bones here instead of by name.
 */
export class HumanoidSkeleton {
  private readonly disabled: Record<string, string> = {};
  private readonly notes: string[] = [];
  private facing: HumanoidFacingReport = { detectedForward: null, detectedUp: null, correctionDeg: null };
  private warned = false;

  private constructor(
    private readonly bones: ReadonlyMap<VrmHumanoidBone, THREE.Bone>,
    private readonly mapping: HumanoidMapping,
    private readonly names: ReadonlyMap<number, string>
  ) {}

  /** Resolves the avatar's bones. Call at bind pose, before any animation writes the skeleton. */
  static bind(avatar: THREE.Object3D, source: HumanoidSource = {}): HumanoidSkeleton {
    // Candidates in preference order: joints of the largest skin, then other bones, then everything else.
    const ids = new Map<THREE.Object3D, number>();
    let synthetic = -1;
    const idOf = (obj: THREE.Object3D): number => {
      let id = ids.get(obj);
      if (id === undefined) {
        id = source.associations?.get(obj)?.nodes ?? synthetic--;
        ids.set(obj, id);
      }
      return id;
    };
    const skins: THREE.Bone[][] = [];
    avatar.traverse((obj) => {
      if (isThreeSkinnedMesh(obj)) skins.push(obj.skeleton.bones);
    });
    skins.sort((a, b) => b.length - a.length);
    const ordered: THREE.Object3D[] = [];
    const seen = new Set<THREE.Object3D>();
    const push = (obj: THREE.Object3D): void => {
      if (seen.has(obj)) return;
      seen.add(obj);
      ordered.push(obj);
    };
    for (const skin of skins) skin.forEach(push);
    avatar.traverse((obj) => { if (isThreeBone(obj)) push(obj); });
    avatar.traverse(push);

    const byId = new Map<number, THREE.Object3D>();
    const candidates: HumanoidNodeCandidate[] = ordered.map((obj) => {
      const index = idOf(obj);
      byId.set(index, obj);
      return { name: obj.name, index, isJoint: isThreeBone(obj) };
    });
    const mapping = resolveHumanoidRig(candidates, readHumanoidDeclaration(source.json));
    const bones = new Map<VrmHumanoidBone, THREE.Bone>();
    for (const [bone, index] of Object.entries(mapping.bones) as [VrmHumanoidBone, number][]) {
      const obj = byId.get(index);
      if (obj && isThreeBone(obj)) bones.set(bone, obj);
    }
    const names = new Map(candidates.map((c) => [c.index, c.name]));
    const skeleton = new HumanoidSkeleton(bones, mapping, names);
    for (const [bone, obj] of bones) obj.userData[HUMANOID_BONE_TAG] = bone;
    for (const bone of bones.keys()) {
      if (!/(Thumb|Index|Middle|Ring|Little)Distal$/.test(bone)) continue;
      const tip = skeleton.tip(bone);
      if (tip) tip.userData[HUMANOID_TIP_TAG] = bone;
    }
    return skeleton;
  }

  bone(name: VrmHumanoidBone): THREE.Bone | undefined {
    return this.bones.get(name);
  }

  resolve(ref: HumanoidBoneRef): THREE.Bone | undefined {
    return ref.endsWith('Tip') ? this.tip(ref.slice(0, -3) as VrmHumanoidBone) : this.bones.get(ref as VrmHumanoidBone);
  }

  has(...names: VrmHumanoidBone[]): boolean {
    return names.every((n) => this.bones.has(n));
  }

  /** The first child bone that is not itself a canonical bone: a fingertip or head-top end site. */
  tip(name: VrmHumanoidBone): THREE.Bone | undefined {
    const bone = this.bones.get(name);
    if (!bone) return undefined;
    const canonical = new Set<THREE.Object3D>(this.bones.values());
    return bone.children.find((c): c is THREE.Bone => isThreeBone(c) && !canonical.has(c));
  }

  /** Records that a feature turned itself off because of the rig, for the report and the one warning. */
  disableFeature(feature: string, reason: string): void {
    this.disabled[feature] = reason;
  }

  note(text: string): void {
    if (!this.notes.includes(text)) this.notes.push(text);
  }

  /**
   * Turns the skeleton to face +Z with +Y up when it does not already.
   * Lateral comes from the upper arms (else the upper legs), up from hips to
   * head, and both snap to the nearest axis so an asymmetric rest pose never
   * tilts the avatar. When the toes disagree with the derived forward (a
   * mirrored or mislabelled rig), nothing is applied and the report says so.
   * The correction sits on a `HumanoidFacing` node inside the avatar, so the
   * exported clone keeps it.
   */
  normalizeFacing(avatar: THREE.Object3D): void {
    avatar.updateMatrixWorld(true);
    const toAvatar = new THREE.Matrix4().copy(avatar.matrixWorld).invert();
    const at = (bone: VrmHumanoidBone): THREE.Vector3 | undefined => {
      const b = this.bones.get(bone);
      return b ? b.getWorldPosition(new THREE.Vector3()).applyMatrix4(toAvatar) : undefined;
    };
    const hips = at('hips');
    const head = at('head');
    const left = at('leftUpperArm') ?? at('leftUpperLeg');
    const right = at('rightUpperArm') ?? at('rightUpperLeg');
    if (!hips || !head || !left || !right) {
      this.facing = { ...this.facing, note: 'facing not measured: hips, head or left/right limbs missing' };
      return;
    }
    const up = head.clone().sub(hips).normalize();
    const lateral = left.clone().sub(right);
    lateral.addScaledVector(up, -lateral.dot(up)).normalize();
    const forward = new THREE.Vector3().crossVectors(lateral, up).normalize();
    this.facing = { detectedForward: round(forward), detectedUp: round(up), correctionDeg: null };

    const toes = (side: 'left' | 'right'): THREE.Vector3 | undefined => {
      const foot = at(`${side}Foot`);
      const toe = at(`${side}Toes`);
      return foot && toe ? toe.sub(foot) : undefined;
    };
    const toeDirs = [toes('left'), toes('right')].filter((v): v is THREE.Vector3 => v !== undefined);
    if (toeDirs.length > 0) {
      const toeForward = toeDirs.reduce((sum, v) => sum.add(v), new THREE.Vector3());
      toeForward.addScaledVector(up, -toeForward.dot(up));
      if (toeForward.lengthSq() > 1e-10 && toeForward.normalize().dot(forward) < 0) {
        this.facing = { ...this.facing, note: 'toes point backward relative to left/right: mirrored or mislabelled rig; facing left as loaded' };
        return;
      }
    }

    const snappedUp = nearestAxis(up);
    const snappedForward = nearestAxis(forward, snappedUp);
    const from = new THREE.Matrix4().makeBasis(
      new THREE.Vector3().crossVectors(snappedUp, snappedForward), snappedUp, snappedForward
    );
    const correction = new THREE.Quaternion().setFromRotationMatrix(from).invert();
    if (Math.abs(correction.w) > 0.9999) return;

    const node = new THREE.Group();
    node.name = FACING_NODE;
    node.quaternion.copy(correction);
    for (const child of [...avatar.children]) node.add(child);
    avatar.add(node);
    avatar.updateMatrixWorld(true);
    const euler = new THREE.Euler().setFromQuaternion(correction, 'XYZ');
    this.facing = {
      ...this.facing,
      correctionDeg: [euler.x, euler.y, euler.z].map((r) => Math.round(THREE.MathUtils.radToDeg(r))) as [number, number, number]
    };
  }

  report(): HumanoidBindingReport {
    const name = (index: number): string => this.names.get(index) ?? String(index);
    return {
      source: this.mapping.source,
      ...(this.mapping.declarationFormat ? { declarationFormat: this.mapping.declarationFormat } : {}),
      ...(this.mapping.standard ? { standard: this.mapping.standard } : {}),
      bones: Object.fromEntries(Object.entries(this.mapping.bones).map(([b, i]) => [b, name(i)])),
      missingRequired: this.mapping.missingRequired,
      unmatched: this.mapping.unmatched,
      ambiguities: this.mapping.ambiguities.map((a) => ({ bone: a.bone, chosen: name(a.chosen), rejected: a.rejected.map(name) })),
      declarationErrors: this.mapping.declarationErrors,
      facing: this.facing,
      disabledFeatures: { ...this.disabled },
      notes: [...this.notes]
    };
  }

  /** One console warning naming missing bones and disabled features, once, after every system attached. */
  warnOnce(): void {
    if (this.warned) return;
    this.warned = true;
    const missing = this.mapping.missingRequired;
    const disabled = Object.entries(this.disabled);
    const problems = [...this.mapping.declarationErrors];
    if (this.facing.note && this.facing.detectedForward) problems.push(this.facing.note);
    if (missing.length === 0 && disabled.length === 0 && problems.length === 0) return;
    console.warn(
      `[avatar] humanoid binding (${this.mapping.standard ?? this.mapping.source}): ` +
      [
        missing.length > 0 ? `missing required bones ${missing.join(', ')}` : '',
        disabled.length > 0 ? `disabled ${disabled.map(([f, r]) => `${f} (${r})`).join('; ')}` : '',
        ...problems
      ].filter(Boolean).join('; ')
    );
  }
}
