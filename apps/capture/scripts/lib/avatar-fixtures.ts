/**
 * Deterministic avatar fixtures for the "Standard avatar formats" feature.
 *
 * Every fixture is derived from the shipped Ready Player Me `avatar.glb` with
 * `@gltf-transform/core`, so no avatar binaries are committed: the files are
 * written to an ignored `output/` directory at test time. Textures are
 * stripped (materials stay, untextured) to keep each file small.
 *
 * Node order is preserved: every original node keeps its glTF index, and
 * nodes the generator adds are appended after them. `origIndex` on each
 * fixture maps an output node index back to the shipped node index (-1 for an
 * added node), which is how the bindings check compares bone identity.
 *
 * Unknown glTF extensions (`VRMC_vrm`, `VRM`) are not modelled by
 * gltf-transform, so they are added by rewriting the GLB JSON chunk after
 * writing (re-padded to 4 bytes); the binary chunk is left untouched.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Accessor, Document, Node, NodeIO, Skin } from '@gltf-transform/core';
import { Matrix4, Quaternion, Vector3 } from 'three';
import {
  VRM_HUMANOID_BONES,
  readHumanoidDeclaration,
  resolveHumanoidRig,
  type HumanoidDeclarationFormat,
  type HumanoidMapping,
  type HumanoidNodeCandidate,
  type HumanoidStandard,
  type VrmHumanoidBone
} from '@holoim/meaning';

export const SHIPPED_AVATAR = fileURLToPath(new URL('../../public/gltf/models/avatar.glb', import.meta.url));

export type FixtureKind = 'renamed' | 'declared' | 'geometric' | 'negative';

export interface FixtureExpect {
  /** Every required VRM bone and all 30 finger bones resolve. */
  readonly resolvesAll: boolean;
  /** Bone → shipped node identity matches the shipped avatar's mapping (except `bonesByName`). */
  readonly identity: boolean;
  /** Bones that must resolve to these node names (overrides `identity` for those bones). */
  readonly bonesByName?: Partial<Record<VrmHumanoidBone, string>>;
  readonly source?: HumanoidMapping['source'];
  readonly declarationFormat?: HumanoidDeclarationFormat;
  readonly standard?: HumanoidStandard;
  /** Skinned bind-pose vertices equal the shipped avatar's (after `vertexTransform`) to 1e-5 m. */
  readonly vertexExact: boolean;
  /** Extra world transform the shipped vertices need to match this fixture (column-major 4×4). */
  readonly vertexTransform?: readonly number[];
  /** Every skin joint's bind world × IBM is the same matrix (false only for the cheap A-pose). */
  readonly bindConsistent: boolean;
  /** World direction the avatar faces; the facing correction should undo the difference from +Z. */
  readonly facing: '+Z' | '-Z';
  /** Upper arms point this many degrees below horizontal (in the world XY plane) in the node TRS rest pose. */
  readonly armBelowHorizontalDegrees?: number;
  readonly notes: string;
}

export interface FixtureInfo {
  readonly name: string;
  readonly file: string;
  readonly kind: FixtureKind;
  readonly expect: FixtureExpect;
  /** Output node index → shipped node index, or -1 for a node the generator added. */
  readonly origIndex: readonly number[];
}

// ---------------------------------------------------------------------------
// GLB JSON helpers (shared with the bindings check)
// ---------------------------------------------------------------------------

export interface GltfNodeJson {
  name?: string;
  children?: number[];
  translation?: number[];
  rotation?: number[];
  scale?: number[];
  matrix?: number[];
  mesh?: number;
  skin?: number;
}
export interface GltfJson {
  nodes?: GltfNodeJson[];
  skins?: { joints: number[]; inverseBindMatrices?: number }[];
  scenes?: { nodes?: number[] }[];
  scene?: number;
  extensions?: Record<string, unknown>;
  extensionsUsed?: string[];
  [key: string]: unknown;
}

const GLB_MAGIC = 0x46546c67;
const CHUNK_JSON = 0x4e4f534a;
const CHUNK_BIN = 0x004e4942;

export function readGlb(glb: Uint8Array): { json: GltfJson; bin: Uint8Array } {
  const view = new DataView(glb.buffer, glb.byteOffset, glb.byteLength);
  if (view.getUint32(0, true) !== GLB_MAGIC) throw new Error('not a GLB');
  const jsonLength = view.getUint32(12, true);
  if (view.getUint32(16, true) !== CHUNK_JSON) throw new Error('GLB chunk 0 is not JSON');
  const json = JSON.parse(new TextDecoder().decode(glb.subarray(20, 20 + jsonLength))) as GltfJson;
  let bin: Uint8Array = new Uint8Array(0);
  const binStart = 20 + jsonLength;
  if (binStart + 8 <= glb.byteLength && view.getUint32(binStart + 4, true) === CHUNK_BIN) {
    bin = glb.subarray(binStart + 8, binStart + 8 + view.getUint32(binStart, true));
  }
  return { json, bin };
}

/** Rewrites the JSON chunk, keeping the BIN chunk byte for byte. */
function patchGlbJson(glb: Uint8Array, patch: (json: GltfJson) => void): Uint8Array {
  const view = new DataView(glb.buffer, glb.byteOffset, glb.byteLength);
  const jsonLength = view.getUint32(12, true);
  const json = JSON.parse(new TextDecoder().decode(glb.subarray(20, 20 + jsonLength))) as GltfJson;
  patch(json);
  const text = JSON.stringify(json);
  const padded = text + ' '.repeat((4 - (Buffer.byteLength(text) % 4)) % 4);
  const jsonBytes = new TextEncoder().encode(padded);
  const rest = glb.subarray(20 + jsonLength);
  const out = new Uint8Array(20 + jsonBytes.byteLength + rest.byteLength);
  const outView = new DataView(out.buffer);
  outView.setUint32(0, GLB_MAGIC, true);
  outView.setUint32(4, 2, true);
  outView.setUint32(8, out.byteLength, true);
  outView.setUint32(12, jsonBytes.byteLength, true);
  outView.setUint32(16, CHUNK_JSON, true);
  out.set(jsonBytes, 20);
  out.set(rest, 20 + jsonBytes.byteLength);
  return out;
}

/**
 * Resolver candidates from glTF JSON: joints of the skin with the most joints
 * first (the avatar body), then other skins' joints, then every other node.
 */
export function buildCandidates(json: GltfJson): HumanoidNodeCandidate[] {
  const nodes = json.nodes ?? [];
  const skins = [...(json.skins ?? [])].sort((a, b) => b.joints.length - a.joints.length);
  const seen = new Set<number>();
  const out: HumanoidNodeCandidate[] = [];
  for (const skin of skins) {
    for (const index of skin.joints) {
      if (seen.has(index)) continue;
      seen.add(index);
      out.push({ name: nodes[index]?.name ?? '', index, isJoint: true });
    }
  }
  nodes.forEach((node, index) => {
    if (!seen.has(index)) out.push({ name: node.name ?? '', index, isJoint: false });
  });
  return out;
}

export function resolveGltf(json: GltfJson, rename?: (name: string) => string): HumanoidMapping {
  const candidates = buildCandidates(json).map((c) => (rename ? { ...c, name: rename(c.name) } : c));
  return resolveHumanoidRig(candidates, readHumanoidDeclaration(json));
}

// ---------------------------------------------------------------------------
// Math helpers
// ---------------------------------------------------------------------------

const quat = (q: readonly number[]): Quaternion => new Quaternion(q[0], q[1], q[2], q[3]);
const quatArr = (q: Quaternion): [number, number, number, number] => [q.x, q.y, q.z, q.w];
const axisAngle = (axis: [number, number, number], degrees: number): Quaternion =>
  new Quaternion().setFromAxisAngle(new Vector3(...axis), (degrees * Math.PI) / 180);
const vec = (v: readonly number[]): Vector3 => new Vector3(v[0], v[1], v[2]);
const vecArr = (v: Vector3): [number, number, number] => [v.x, v.y, v.z];

function readMat(accessor: Accessor, i: number): Matrix4 {
  return new Matrix4().fromArray(accessor.getElement(i, new Array<number>(16)));
}

// ---------------------------------------------------------------------------
// Document context
// ---------------------------------------------------------------------------

interface Ctx {
  readonly doc: Document;
  readonly skin: Skin;
  readonly armature: Node;
  readonly joints: Node[];
  readonly jointSet: Set<Node>;
  readonly orig: Map<Node, number>;
  readonly shipped: HumanoidMapping;
}

const io = new NodeIO();

async function loadCtx(source: Uint8Array, shipped: HumanoidMapping): Promise<Ctx> {
  const doc = await io.readBinary(source);
  const root = doc.getRoot();
  for (const texture of root.listTextures()) texture.dispose();
  const skin = root.listSkins()[0]!;
  const joints = skin.listJoints();
  const orig = new Map(root.listNodes().map((node, index) => [node, index]));
  const armature = root.listNodes().find((n) => n.getName() === 'Armature');
  if (!armature) throw new Error('shipped avatar has no Armature node');
  return { doc, skin, armature, joints, jointSet: new Set(joints), orig, shipped };
}

function jointByName(ctx: Ctx, name: string): Node {
  const node = ctx.joints.find((j) => j.getName() === name);
  if (!node) throw new Error(`shipped avatar has no joint ${name}`);
  return node;
}

/** Appends a joint to the skin with the given inverse bind matrix; it carries no weights. */
function addSkinJoint(ctx: Ctx, node: Node, ibm: Matrix4): void {
  const accessor = ctx.skin.getInverseBindMatrices()!;
  const old = accessor.getArray()!;
  const next = new Float32Array(old.length + 16);
  next.set(old);
  next.set(ibm.toArray(), old.length);
  accessor.setArray(next);
  ctx.skin.addJoint(node);
  ctx.joints.push(node);
  ctx.jointSet.add(node);
}

function ibmOf(ctx: Ctx, node: Node): Matrix4 {
  return readMat(ctx.skin.getInverseBindMatrices()!, ctx.skin.listJoints().indexOf(node));
}

/**
 * Inserts a chain of identity-rotation joints between `child` and its parent,
 * splitting the child's translation evenly so world transforms are unchanged.
 */
function insertChain(ctx: Ctx, child: Node, names: readonly string[]): Node[] {
  const parent = child.getParentNode()!;
  const step = vec(child.getTranslation()).multiplyScalar(1 / (names.length + 1));
  const parentIbm = ibmOf(ctx, parent);
  const inserted: Node[] = [];
  let at = parent;
  names.forEach((name, i) => {
    const node = ctx.doc.createNode(name).setTranslation(vecArr(step));
    at.addChild(node);
    const offset = step.clone().multiplyScalar(i + 1);
    addSkinJoint(ctx, node, new Matrix4().makeTranslation(offset.clone().negate()).multiply(parentIbm));
    inserted.push(node);
    at = node;
  });
  at.addChild(child);
  child.setTranslation(vecArr(step));
  return inserted;
}

/** Adds an unweighted leaf joint under `parent`, halfway towards `towards`. */
function addLeafJoint(ctx: Ctx, parent: Node, towards: Node, name: string): Node {
  const t = vec(towards.getTranslation()).multiplyScalar(0.5);
  const node = ctx.doc.createNode(name).setTranslation(vecArr(t));
  parent.addChild(node);
  addSkinJoint(ctx, node, new Matrix4().makeTranslation(t.clone().negate()).multiply(ibmOf(ctx, parent)));
  return node;
}

function renameJoints(ctx: Ctx, rename: (name: string) => string): void {
  for (const joint of ctx.joints) joint.setName(rename(joint.getName()));
}

/** Rotation/translation keyframe outputs per joint, refusing shared outputs between different targets. */
function jointChannels(ctx: Ctx): { node: Node; path: string; output: Accessor }[] {
  const owner = new Map<Accessor, string>();
  const out: { node: Node; path: string; output: Accessor }[] = [];
  for (const animation of ctx.doc.getRoot().listAnimations()) {
    for (const channel of animation.listChannels()) {
      const node = channel.getTargetNode();
      const path = channel.getTargetPath();
      const output = channel.getSampler()?.getOutput();
      if (!node || !path || !output) continue;
      const key = `${ctx.orig.get(node) ?? node.getName()}/${path}`;
      const prev = owner.get(output);
      if (prev !== undefined && prev !== key) throw new Error(`keyframe output shared by ${prev} and ${key}`);
      if (prev !== undefined) continue;
      owner.set(output, key);
      out.push({ node, path, output });
    }
  }
  return out;
}

function mapElements(accessor: Accessor, fn: (value: number[]) => number[]): void {
  const size = accessor.getElementSize();
  for (let i = 0; i < accessor.getCount(); i += 1) {
    accessor.setElement(i, fn(accessor.getElement(i, new Array<number>(size))));
  }
}

/** Skinned mesh nodes move to the scene root, so a transform on the armature applies to the skeleton only. */
function detachMeshes(ctx: Ctx): void {
  const scene = ctx.doc.getRoot().listScenes()[0]!;
  for (const child of ctx.armature.listChildren()) {
    if (child.getMesh()) scene.addChild(child);
  }
}

/**
 * Bakes a content transform M = R·S(s) into the rig (joint translations,
 * root-joint rotation, IBMs, vertices, normals and morph deltas) and puts
 * M⁻¹ on the armature node, so the avatar renders exactly as shipped while
 * its own frame is rotated and/or scaled.
 *   non-root joints: t' = s·t
 *   root joint:      t' = s·R·t, r' = R·r (and the same on its keyframes)
 *   IBM' = S·IBM·S⁻¹·R⁻¹, v' = s·R·v, n' = R·n
 */
function bakeContentTransform(ctx: Ctx, rotation: Quaternion, s: number): void {
  const isRoot = (node: Node): boolean => !ctx.jointSet.has(node.getParentNode()!);
  for (const joint of ctx.joints) {
    const t = vec(joint.getTranslation()).multiplyScalar(s);
    if (isRoot(joint)) {
      joint.setTranslation(vecArr(t.applyQuaternion(rotation)));
      joint.setRotation(quatArr(rotation.clone().multiply(quat(joint.getRotation()))));
    } else {
      joint.setTranslation(vecArr(t));
    }
  }
  for (const { node, path, output } of jointChannels(ctx)) {
    if (!ctx.jointSet.has(node)) continue;
    if (path === 'translation') {
      mapElements(output, (v) => {
        const t = vec(v).multiplyScalar(s);
        return vecArr(isRoot(node) ? t.applyQuaternion(rotation) : t);
      });
    } else if (path === 'rotation' && isRoot(node)) {
      mapElements(output, (q) => quatArr(rotation.clone().multiply(quat(q))));
    }
  }
  const S = new Matrix4().makeScale(s, s, s);
  const Sinv = new Matrix4().makeScale(1 / s, 1 / s, 1 / s);
  const Rinv = new Matrix4().makeRotationFromQuaternion(rotation.clone().invert());
  const ibm = ctx.skin.getInverseBindMatrices()!;
  for (let i = 0; i < ibm.getCount(); i += 1) {
    ibm.setElement(i, S.clone().multiply(readMat(ibm, i)).multiply(Sinv).multiply(Rinv).toArray());
  }
  const done = new Set<Accessor>();
  const transform = (accessor: Accessor | null, scale: number): void => {
    if (!accessor || done.has(accessor)) return;
    done.add(accessor);
    mapElements(accessor, (v) => vecArr(vec(v).applyQuaternion(rotation).multiplyScalar(scale)));
  };
  for (const mesh of ctx.doc.getRoot().listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      transform(prim.getAttribute('POSITION'), s);
      transform(prim.getAttribute('NORMAL'), 1);
      for (const target of prim.listTargets()) {
        transform(target.getAttribute('POSITION'), s);
        transform(target.getAttribute('NORMAL'), 1);
      }
    }
  }
  detachMeshes(ctx);
  ctx.armature.setRotation(quatArr(rotation.clone().invert())).setScale([1 / s, 1 / s, 1 / s]);
}

// ---------------------------------------------------------------------------
// Naming schemes (from the shipped Mixamo-style names)
// ---------------------------------------------------------------------------

type SideName = 'Left' | 'Right';
interface SideScheme {
  readonly center: Readonly<Record<string, string>>;
  readonly part: (side: SideName, part: string) => string;
  /** finger: Thumb|Index|Middle|Ring|Pinky; n: 1..4 (4 is the end site). */
  readonly finger: (side: SideName, finger: string, n: number) => string;
}

function schemeRenamer(scheme: SideScheme): (name: string) => string {
  return (name) => {
    if (Object.hasOwn(scheme.center, name)) return scheme.center[name]!;
    const sided = /^(Left|Right)(.+)$/.exec(name);
    if (!sided) throw new Error(`unexpected shipped joint ${name}`);
    const side = sided[1] as SideName;
    const finger = /^Hand(Thumb|Index|Middle|Ring|Pinky)([1-4])$/.exec(sided[2]!);
    return finger ? scheme.finger(side, finger[1]!, Number(finger[2])) : scheme.part(side, sided[2]!);
  };
}

function partTable(table: Readonly<Record<string, string>>, side: SideName, part: string, fmt: (s: string) => string): string {
  const mapped = table[part];
  if (mapped === undefined) throw new Error(`no mapping for ${side}${part}`);
  return fmt(mapped);
}

const UNREAL: SideScheme = {
  center: { Hips: 'pelvis', Spine: 'spine_01', Spine1: 'spine_02', Spine2: 'spine_05', Neck: 'neck_01', Head: 'head', HeadTop_End: 'head_end' },
  part: (side, part) => {
    const s = side === 'Left' ? 'l' : 'r';
    return partTable({
      Shoulder: 'clavicle', Arm: 'upperarm', ForeArm: 'lowerarm', Hand: 'hand', UpLeg: 'thigh', Leg: 'calf',
      Foot: 'foot', ToeBase: 'ball', Toe_End: 'ball_#_end', Eye: 'eye'
    }, side, part, (m) => (m.includes('#') ? m.replace('#', s) : `${m}_${s}`));
  },
  finger: (side, finger, n) => {
    const s = side === 'Left' ? 'l' : 'r';
    const f = finger.toLowerCase();
    return n <= 3 ? `${f}_0${n}_${s}` : `${f}_03_${s}_end`;
  }
};

const VROID: SideScheme = {
  center: {
    Hips: 'J_Bip_C_Hips', Spine: 'J_Bip_C_Spine', Spine1: 'J_Bip_C_Chest', Spine2: 'J_Bip_C_UpperChest',
    Neck: 'J_Bip_C_Neck', Head: 'J_Bip_C_Head', HeadTop_End: 'J_Bip_C_HeadTop_End'
  },
  part: (side, part) => {
    const L = side === 'Left' ? 'L' : 'R';
    if (part === 'Eye') return `J_Adj_${L}_FaceEye`;
    return partTable({
      Shoulder: 'Shoulder', Arm: 'UpperArm', ForeArm: 'LowerArm', Hand: 'Hand', UpLeg: 'UpperLeg', Leg: 'LowerLeg',
      Foot: 'Foot', ToeBase: 'ToeBase', Toe_End: 'ToeBase_end'
    }, side, part, (m) => `J_Bip_${L}_${m}`);
  },
  finger: (side, finger, n) => {
    const L = side === 'Left' ? 'L' : 'R';
    const f = finger === 'Pinky' ? 'Little' : finger;
    return n <= 3 ? `J_Bip_${L}_${f}${n}` : `J_Bip_${L}_${f}3_end`;
  }
};

const CC4: SideScheme = {
  center: {
    Hips: 'CC_Base_Hip', Spine: 'CC_Base_Waist', Spine1: 'CC_Base_Spine01', Spine2: 'CC_Base_Spine02',
    Neck: 'CC_Base_NeckTwist01', Head: 'CC_Base_Head', HeadTop_End: 'CC_Base_HeadTop_End'
  },
  part: (side, part) => {
    const L = side === 'Left' ? 'L' : 'R';
    return partTable({
      Shoulder: 'Clavicle', Arm: 'Upperarm', ForeArm: 'Forearm', Hand: 'Hand', UpLeg: 'Thigh', Leg: 'Calf',
      Foot: 'Foot', ToeBase: 'ToeBase', Toe_End: 'ToeBase_End', Eye: 'Eye'
    }, side, part, (m) => `CC_Base_${L}_${m}`);
  },
  finger: (side, finger, n) => {
    const L = side === 'Left' ? 'L' : 'R';
    const f = finger === 'Middle' ? 'Mid' : finger;
    return n <= 3 ? `CC_Base_${L}_${f}${n}` : `CC_Base_${L}_${f}3_End`;
  }
};

const BIPED: SideScheme = {
  center: {
    Hips: 'Bip01 Pelvis', Spine: 'Bip01 Spine', Spine1: 'Bip01 Spine1', Spine2: 'Bip01 Spine2',
    Neck: 'Bip01 Neck', Head: 'Bip01 Head', HeadTop_End: 'Bip01 HeadNub'
  },
  part: (side, part) => {
    const L = side === 'Left' ? 'L' : 'R';
    return partTable({
      Shoulder: 'Clavicle', Arm: 'UpperArm', ForeArm: 'Forearm', Hand: 'Hand', UpLeg: 'Thigh', Leg: 'Calf',
      Foot: 'Foot', ToeBase: 'Toe0', Toe_End: 'Toe0Nub', Eye: 'Eye'
    }, side, part, (m) => `Bip01 ${L} ${m}`);
  },
  finger: (side, finger, n) => {
    const L = side === 'Left' ? 'L' : 'R';
    const digit = ['Thumb', 'Index', 'Middle', 'Ring', 'Pinky'].indexOf(finger);
    return n === 4 ? `Bip01 ${L} Finger${digit}Nub` : `Bip01 ${L} Finger${digit}${n === 1 ? '' : n - 1}`;
  }
};

const META: SideScheme = {
  center: { Hips: 'Hips', Spine: 'SpineLower', Spine1: 'SpineUpper', Spine2: 'Chest', Neck: 'Neck', Head: 'Head', HeadTop_End: 'HeadTop_End' },
  part: (side, part) =>
    partTable({
      Shoulder: 'Scapula', Arm: 'ArmUpper', ForeArm: 'ArmLower', Hand: 'HandWrist', UpLeg: 'UpperLeg', Leg: 'LowerLeg',
      Foot: 'FootAnkle', ToeBase: 'FootBall', Toe_End: 'FootBallTip', Eye: 'EyeJoint'
    }, side, part, (m) => `${side}${m}`),
  finger: (side, finger, n) => {
    const f = finger === 'Pinky' ? 'Little' : finger;
    const joints = finger === 'Thumb' ? ['Metacarpal', 'Proximal', 'Distal', 'Tip'] : ['Proximal', 'Intermediate', 'Distal', 'Tip'];
    return `${side}Hand${f}${joints[n - 1]}`;
  }
};

const ARKIT: SideScheme = {
  center: {
    Hips: 'hips_joint', Spine: 'spine_1_joint', Spine1: 'spine_4_joint', Spine2: 'spine_7_joint',
    Neck: 'neck_1_joint', Head: 'head_joint', HeadTop_End: 'head_end_joint'
  },
  part: (side, part) =>
    partTable({
      Shoulder: 'shoulder_1', Arm: 'arm', ForeArm: 'forearm', Hand: 'hand', UpLeg: 'upLeg', Leg: 'leg',
      Foot: 'foot', ToeBase: 'toes', Toe_End: 'toesEnd', Eye: 'eye'
    }, side, part, (m) => `${side.toLowerCase()}_${m}_joint`),
  finger: (side, finger, n) => {
    const s = side.toLowerCase();
    if (finger === 'Thumb') return `${s}_${['handThumbStart', 'handThumb_1', 'handThumb_2', 'handThumbEnd'][n - 1]}_joint`;
    const f = finger === 'Middle' ? 'Mid' : finger;
    return n <= 3 ? `${s}_hand${f}_${n}_joint` : `${s}_hand${f}End_joint`;
  }
};

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

interface Built {
  readonly kind: FixtureKind;
  readonly expect: FixtureExpect;
  readonly patch?: (json: GltfJson) => void;
}

const IDENTITY_EXPECT = { resolvesAll: true, identity: true, vertexExact: false, bindConsistent: true, facing: '+Z' } as const;

function renamed(scheme: (name: string) => string, notes: string, standard: HumanoidStandard): (ctx: Ctx) => Built {
  return (ctx) => {
    renameJoints(ctx, scheme);
    return { kind: 'renamed', expect: { ...IDENTITY_EXPECT, vertexExact: true, source: 'names', standard, notes } };
  };
}

const VRM0_THUMB_NAMES: Partial<Record<VrmHumanoidBone, string>> = {
  leftThumbMetacarpal: 'leftThumbProximal', leftThumbProximal: 'leftThumbIntermediate', leftThumbDistal: 'leftThumbDistal',
  rightThumbMetacarpal: 'rightThumbProximal', rightThumbProximal: 'rightThumbIntermediate', rightThumbDistal: 'rightThumbDistal'
};

const BUILDERS: Record<string, (ctx: Ctx) => Built> = {
  'mixamo-prefixed': renamed((n) => `mixamorig1:${n}`, 'every joint `mixamorig1:<name>`', 'mixamo'),

  'unreal-cm': (ctx) => {
    renameJoints(ctx, schemeRenamer(UNREAL));
    insertChain(ctx, jointByName(ctx, 'spine_05'), ['spine_03', 'spine_04']);
    for (const s of ['l', 'r']) {
      addLeafJoint(ctx, jointByName(ctx, `upperarm_${s}`), jointByName(ctx, `lowerarm_${s}`), `upperarm_twist_01_${s}`);
      addLeafJoint(ctx, jointByName(ctx, `thigh_${s}`), jointByName(ctx, `calf_${s}`), `thigh_twist_01_${s}`);
    }
    bakeContentTransform(ctx, new Quaternion(), 100);
    return {
      kind: 'renamed',
      expect: {
        ...IDENTITY_EXPECT, vertexExact: true, source: 'names', standard: 'unreal',
        bonesByName: { spine: 'spine_01', chest: 'spine_03', upperChest: 'spine_05' },
        notes: 'UE5 names; spine_03/spine_04 inserted between spine_02 (Spine1) and spine_05 (Spine2); ' +
          'unweighted upperarm/thigh twist leaves; rig baked to cm (translations, IBMs, vertices ×100) under an ' +
          'Armature scaled 0.01, with skinned meshes moved to the scene root'
      }
    };
  },

  vroid: renamed(schemeRenamer(VROID), 'J_Bip_* / J_Adj_*_FaceEye', 'vroid'),
  cc4: renamed(schemeRenamer(CC4), 'CC_Base_*', 'cc4'),
  biped: renamed(schemeRenamer(BIPED), '`Bip01 L UpperArm` style, spaces in names', 'biped'),

  meta: (ctx) => {
    renameJoints(ctx, schemeRenamer(META));
    insertChain(ctx, jointByName(ctx, 'SpineUpper'), ['SpineMiddle']);
    return {
      kind: 'renamed',
      expect: {
        ...IDENTITY_EXPECT, vertexExact: true, source: 'names', standard: 'meta',
        notes: 'Meta Movement names; SpineMiddle inserted between SpineLower and SpineUpper (chest must stay SpineUpper)'
      }
    };
  },

  arkit: renamed(schemeRenamer(ARKIT), 'ARKit *_joint names', 'arkit'),

  'vrm1-declared': (ctx) => {
    const declared: Record<string, { node: number }> = {};
    for (const bone of VRM_HUMANOID_BONES) {
      const index = ctx.shipped.bones[bone];
      if (index !== undefined) declared[bone] = { node: index };
    }
    for (const joint of ctx.joints) joint.setName(`bone_${ctx.orig.get(joint)}`);
    return {
      kind: 'declared',
      expect: { ...IDENTITY_EXPECT, vertexExact: true, source: 'declaration', declarationFormat: 'vrm1', notes: 'joints `bone_<n>`; only VRMC_vrm maps them' },
      patch: (json) => {
        json.extensionsUsed = [...(json.extensionsUsed ?? []), 'VRMC_vrm'];
        json.extensions = { ...json.extensions, VRMC_vrm: { specVersion: '1.0', humanoid: { humanBones: declared } } };
      }
    };
  },

  'reoriented-axes': (ctx) => {
    // C_j: 90° about X at even depth, −90° about Z at odd depth (both move the +Y along-bone axis).
    const depth = (node: Node): number => (ctx.jointSet.has(node.getParentNode()!) ? depth(node.getParentNode()!) + 1 : 0);
    const correction = new Map<Node, Quaternion>(
      ctx.joints.map((j) => [j, depth(j) % 2 === 0 ? axisAngle([1, 0, 0], 90) : axisAngle([0, 0, 1], -90)])
    );
    const cOf = (node: Node | null): Quaternion => (node && correction.get(node)) || new Quaternion();
    // Every node whose parent or self is a joint: r' = C_p⁻¹·r·C_j, t' = C_p⁻¹·t, S' = C_j⁻¹·S·C_j.
    const affected = ctx.doc.getRoot().listNodes().filter((n) => ctx.jointSet.has(n) || ctx.jointSet.has(n.getParentNode()!));
    const updates = affected.map((node) => {
      const cp = cOf(node.getParentNode()).clone().invert();
      const cj = cOf(node);
      const t = vec(node.getTranslation()).applyQuaternion(cp);
      const r = cp.clone().multiply(quat(node.getRotation())).multiply(cj);
      const sm = new Matrix4().makeRotationFromQuaternion(cj.clone().invert())
        .multiply(new Matrix4().makeScale(...(node.getScale() as [number, number, number])))
        .multiply(new Matrix4().makeRotationFromQuaternion(cj)).elements;
      return { node, t, r, s: [Math.abs(sm[0]!), Math.abs(sm[5]!), Math.abs(sm[10]!)] as [number, number, number] };
    });
    for (const { node, path, output } of jointChannels(ctx)) {
      if (!affected.includes(node)) continue;
      const cp = cOf(node.getParentNode()).clone().invert();
      const cj = cOf(node);
      if (path === 'rotation') mapElements(output, (q) => quatArr(cp.clone().multiply(quat(q)).multiply(cj)));
      else if (path === 'translation') mapElements(output, (v) => vecArr(vec(v).applyQuaternion(cp)));
      else throw new Error(`reoriented-axes cannot transform ${path} keys`);
    }
    for (const { node, t, r, s } of updates) {
      node.setTranslation(vecArr(t)).setRotation(quatArr(r.normalize()));
      if (node.getScale().some((v) => v !== 1)) node.setScale(s);
    }
    const ibm = ctx.skin.getInverseBindMatrices()!;
    ctx.skin.listJoints().forEach((joint, i) => {
      const cInv = new Matrix4().makeRotationFromQuaternion(cOf(joint).clone().invert());
      ibm.setElement(i, cInv.multiply(readMat(ibm, i)).toArray());
    });
    return {
      kind: 'geometric',
      expect: {
        ...IDENTITY_EXPECT, vertexExact: true, source: 'names', standard: 'mixamo',
        notes: 'shipped names; local axes rotated per joint (90° X at even depth, −90° Z at odd); exact, no re-skinning'
      }
    };
  },

  'a-pose': armPose(45, 'A-pose'),
  't-pose': armPose(0, 'T-pose'),

  'vrm0-minus-z': (ctx) => {
    const humanBones = VRM_HUMANOID_BONES.flatMap((bone) => {
      const node = ctx.shipped.bones[bone];
      return node === undefined ? [] : [{ bone: VRM0_THUMB_NAMES[bone] ?? bone, node }];
    });
    detachMeshes(ctx);
    ctx.armature.setRotation([0, 1, 0, 0]);
    return {
      kind: 'geometric',
      expect: {
        ...IDENTITY_EXPECT, vertexExact: true, source: 'declaration', declarationFormat: 'vrm0', facing: '-Z',
        vertexTransform: new Matrix4().makeRotationY(Math.PI).toArray(),
        notes: 'shipped names; Armature rotated 180° about Y (faces −Z, facing correction 180°); VRM 0.x humanBones array with VRM0 thumb names'
      },
      patch: (json) => {
        json.extensionsUsed = [...(json.extensionsUsed ?? []), 'VRM'];
        json.extensions = { ...json.extensions, VRM: { specVersion: '0.0', humanoid: { humanBones } } };
      }
    };
  },

  'z-up': (ctx) => {
    // Content is Z-up (forward −Y, Blender convention) in cm; the Armature carries R_x(−90°)·S(0.01).
    bakeContentTransform(ctx, axisAngle([1, 0, 0], 90), 100);
    return {
      kind: 'geometric',
      expect: {
        ...IDENTITY_EXPECT, vertexExact: true, source: 'names', standard: 'mixamo',
        notes: 'shipped names; rig baked Z-up/−Y-forward at cm scale under an Armature with rotation −90° X and scale 0.01; ' +
          'renders upright facing +Z in world, so the world-space facing correction is 0 (a correction measured in the ' +
          'armature-local frame would see up +Z, forward −Y)'
      }
    };
  },

  unmappable: (ctx) => {
    for (const joint of ctx.joints) joint.setName(`j${ctx.orig.get(joint)}`);
    return {
      kind: 'negative',
      expect: { ...IDENTITY_EXPECT, resolvesAll: false, identity: false, vertexExact: true, source: 'none', notes: 'every joint `j<n>`, no declaration' }
    };
  },

  'duplicate-names': (ctx) => {
    addDuplicateNameProp(ctx);
    return {
      kind: 'negative',
      expect: {
        ...IDENTITY_EXPECT, vertexExact: true, source: 'names', standard: 'mixamo',
        notes: 'shipped rig plus a skinned cube prop whose 2 joints are named Hips and Head (after the avatar in node order)'
      }
    };
  }
};

/** Upper arm (arm → forearm) angle below horizontal in the world XY plane, from node TRS. */
function armBelowHorizontal(arm: Node, forearm: Node): number {
  const a = new Vector3().setFromMatrixPosition(new Matrix4().fromArray(arm.getWorldMatrix()));
  const b = new Vector3().setFromMatrixPosition(new Matrix4().fromArray(forearm.getWorldMatrix()));
  return (Math.atan2(a.y - b.y, Math.abs(b.x - a.x)) * 180) / Math.PI;
}

/**
 * Sets both upper-arm rest rotations so the arms point `targetDegrees` below
 * horizontal, rotating about the world forward axis (+Z) expressed in the
 * parent's frame: r' = (R_wp⁻¹·Q_w·R_wp)·r. IBMs stay as shipped (the cheap
 * route), so the mesh renders in the new rest pose and bind must be measured
 * from node transforms.
 */
function armPose(targetDegrees: number, label: string): (ctx: Ctx) => Built {
  return (ctx) => {
    const before: string[] = [];
    for (const side of ['Left', 'Right'] as const) {
      const arm = jointByName(ctx, `${side}Arm`);
      const current = armBelowHorizontal(arm, jointByName(ctx, `${side}ForeArm`));
      before.push(current.toFixed(1));
      // Left arm points +X: lowering it is a negative rotation about +Z; the right arm mirrors.
      const degrees = (side === 'Left' ? -1 : 1) * (targetDegrees - current);
      const parentWorld = new Quaternion();
      new Matrix4().fromArray(arm.getParentNode()!.getWorldMatrix()).decompose(new Vector3(), parentWorld, new Vector3());
      const inParent = parentWorld.clone().invert().multiply(axisAngle([0, 0, 1], degrees)).multiply(parentWorld);
      arm.setRotation(quatArr(inParent.multiply(quat(arm.getRotation())).normalize()));
    }
    return {
      kind: 'geometric',
      expect: {
        ...IDENTITY_EXPECT, bindConsistent: false, source: 'names', standard: 'mixamo', armBelowHorizontalDegrees: targetDegrees,
        notes: `shipped names; ${label}: upper-arm rest rotations set to ${targetDegrees}° below horizontal about world Z ` +
          `(shipped rest is ${before.join('°/')}° L/R); IBMs unchanged (cheap route)`
      }
    };
  };
}

/**
 * A cube skinned to its own two-joint skeleton named `Hips` → `Head`, inside the
 * avatar's torso, so the avatar's bounds (and its centering) stay as shipped and
 * only the names differ.
 */
function addDuplicateNameProp(ctx: Ctx): void {
  const { doc } = ctx;
  const buffer = doc.getRoot().listBuffers()[0]!;
  const scene = doc.getRoot().listScenes()[0]!;
  const prop = doc.createNode('Prop').setTranslation([0, 0.9, 0]);
  const hips = doc.createNode('Hips').setTranslation([0, 0.05, 0]);
  const head = doc.createNode('Head').setTranslation([0, 0.1, 0]);
  prop.addChild(hips);
  hips.addChild(head);
  const ibm = new Float32Array([
    ...new Matrix4().makeTranslation(0, -0.95, 0).toArray(),
    ...new Matrix4().makeTranslation(0, -1.05, 0).toArray()
  ]);
  const skin = doc.createSkin('PropSkin').addJoint(hips).addJoint(head)
    .setInverseBindMatrices(doc.createAccessor().setType('MAT4').setArray(ibm).setBuffer(buffer));
  const positions: number[] = [];
  const joints: number[] = [];
  const weights: number[] = [];
  for (let i = 0; i < 8; i += 1) {
    const top = (i >> 1) & 1;
    positions.push(i & 1 ? 0.05 : -0.05, top ? 1.1 : 0.9, (i >> 2) & 1 ? 0.05 : -0.05);
    joints.push(top, 0, 0, 0);
    weights.push(1, 0, 0, 0);
  }
  const faces = [0, 2, 1, 1, 2, 3, 4, 5, 6, 5, 7, 6, 0, 1, 4, 1, 5, 4, 2, 6, 3, 3, 6, 7, 0, 4, 2, 2, 4, 6, 1, 3, 5, 3, 7, 5];
  const prim = doc.createPrimitive()
    .setAttribute('POSITION', doc.createAccessor().setType('VEC3').setArray(new Float32Array(positions)).setBuffer(buffer))
    .setAttribute('JOINTS_0', doc.createAccessor().setType('VEC4').setArray(new Uint8Array(joints)).setBuffer(buffer))
    .setAttribute('WEIGHTS_0', doc.createAccessor().setType('VEC4').setArray(new Float32Array(weights)).setBuffer(buffer))
    .setIndices(doc.createAccessor().setType('SCALAR').setArray(new Uint16Array(faces)).setBuffer(buffer));
  const material = doc.getRoot().listMaterials()[0];
  if (material) prim.setMaterial(material);
  const meshNode = doc.createNode('PropMesh').setMesh(doc.createMesh('PropMesh').addPrimitive(prim)).setSkin(skin);
  scene.addChild(prop);
  scene.addChild(meshNode);
}

export const FIXTURE_NAMES: readonly string[] = Object.keys(BUILDERS);

/** Resolver mapping of the shipped avatar (glTF node indices). */
export function shippedMapping(source: Uint8Array): HumanoidMapping {
  return resolveGltf(readGlb(source).json);
}

/**
 * Writes every fixture to `outDir` and describes it. Deterministic: the same
 * shipped avatar always produces byte-identical files.
 */
export async function generateAvatarFixtures(
  outDir: string,
  source?: Uint8Array
): Promise<FixtureInfo[]> {
  source ??= new Uint8Array(await readFile(SHIPPED_AVATAR));
  await mkdir(outDir, { recursive: true });
  const shipped = shippedMapping(source);
  const out: FixtureInfo[] = [];
  for (const [name, build] of Object.entries(BUILDERS)) {
    const ctx = await loadCtx(source, shipped);
    const built = build(ctx);
    const origIndex = ctx.doc.getRoot().listNodes().map((node) => ctx.orig.get(node) ?? -1);
    let glb: Uint8Array = await io.writeBinary(ctx.doc);
    if (built.patch) glb = patchGlbJson(glb, built.patch);
    const file = join(outDir, `${name}.glb`);
    await writeFile(file, glb);
    out.push({ name, file, kind: built.kind, expect: built.expect, origIndex });
  }
  return out;
}
