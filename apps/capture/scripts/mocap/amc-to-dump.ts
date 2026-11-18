/**
 * Converts an original CMU take (the subject's `.asf` skeleton and the take's
 * `.amc` motion, mocap.cs.cmu.edu) into the dump `build-mocap-clips.ts` reads:
 * per bone, its world rotation (quaternion w x y z) and head position, in
 * Blender's z-up centimetres, at 30 fps, plus the rest pose.
 *
 * The originals, not an FBX conversion: the `gbionics/cmu-fbx` files put every
 * subject on one shared skeleton whose legs are too short for its hips, which
 * bends every knee about 20° more than the subject did (its "standing still"
 * stands at 24-32° of knee flexion; the AMC take stands straight).
 *
 *   node --import tsx scripts/mocap/amc-to-dump.ts <subject.asf> <take.amc> <out.json>
 *
 * Forward kinematics as the ASF/AMC spec (and every CMU reader) defines it:
 * a bone's frame is parent · C · M · C⁻¹, C from its `axis` (Euler XYZ, degrees)
 * and M from the frame's dof values; its end is its head plus length × frame ·
 * direction. Lengths are in units of 1/0.45 inch.
 *
 * Straight rest legs: a CMU skeleton rests with each leg chain (femur, tibia,
 * foot, toes) turned out about the forward axis by its femur's `axis` (20°),
 * and the retarget carries the legs' world rotations relative to rest onto a
 * rig standing straight (it corrects only the arms' rest). So the chain's
 * rotations are written relative to that turn undone (frame · C_femur) and its
 * rest is laid out straight; otherwise every stance foot lands 20° inward and
 * the avatar walks cross-legged.
 */
import { readFile, writeFile } from 'node:fs/promises';
import * as THREE from 'three';

type AsfBone = { name: string; direction: THREE.Vector3; length: number; axis: THREE.Matrix4; dof: string[] };

const UNIT_CM = (1 / 0.45) * 2.54;
const OUT_FPS = 30;

// CMU bone → the dump's (FBX-era) bone name; its rotation, and the joint its head sits on.
// A dump bone takes the deepest CMU bone of its chain for its rotation (the hand turns by
// the wrist's twist and the hand's own bend) and the chain's first joint for its head.
const MAP: Array<{ name: string; rotation: string; head: string; parent: string | null }> = [
  { name: 'hip', rotation: 'root', head: 'root', parent: null },
  { name: 'abdomen', rotation: 'lowerback', head: 'root', parent: 'hip' },
  { name: 'chest', rotation: 'thorax', head: 'upperback', parent: 'abdomen' },
  { name: 'neck', rotation: 'lowerneck', head: 'thorax', parent: 'chest' },
  { name: 'head', rotation: 'head', head: 'upperneck', parent: 'neck' },
  ...(['l', 'r'] as const).flatMap((s) => [
    { name: `${s}Collar`, rotation: `${s}clavicle`, head: 'thorax', parent: 'chest' },
    { name: `${s}Shldr`, rotation: `${s}humerus`, head: `${s}clavicle`, parent: `${s}Collar` },
    { name: `${s}ForeArm`, rotation: `${s}radius`, head: `${s}humerus`, parent: `${s}Shldr` },
    { name: `${s}Hand`, rotation: `${s}hand`, head: `${s}radius`, parent: `${s}ForeArm` },
    { name: `${s}Thigh`, rotation: `${s}femur`, head: `${s}hipjoint`, parent: 'hip' },
    { name: `${s}Shin`, rotation: `${s}tibia`, head: `${s}femur`, parent: `${s}Thigh` },
    { name: `${s}Foot`, rotation: `${s}foot`, head: `${s}tibia`, parent: `${s}Shin` },
    { name: `${s}Toe`, rotation: `${s}toes`, head: `${s}foot`, parent: `${s}Foot` }
  ])
];
// Knuckles for the palm's roll: on the line where the hand bone ends, across the palm toward the thumb (index) and away (little).
const KNUCKLES: Array<{ name: string; across: number }> = [
  { name: 'Index1', across: 0.35 },
  { name: 'Mid1', across: 0 },
  { name: 'Pinky1', across: -0.45 }
];

const euler = (x: number, y: number, z: number) => {
  const d = THREE.MathUtils.degToRad;
  // XYZ order applied as Rz · Ry · Rx (x first), the ASF convention.
  return new THREE.Matrix4().makeRotationZ(d(z)).multiply(new THREE.Matrix4().makeRotationY(d(y))).multiply(new THREE.Matrix4().makeRotationX(d(x)));
};

function parseAsf(text: string) {
  const bones = new Map<string, AsfBone>();
  const children = new Map<string, string[]>();
  const blocks = text.split(':bonedata')[1]!.split(':hierarchy');
  for (const block of blocks[0]!.split('begin').slice(1)) {
    const line = (key: string) => block.split('\n').find((l) => l.trim().startsWith(key))?.trim().split(/\s+/).slice(1);
    const name = line('name')![0]!;
    const [dx, dy, dz] = line('direction')!.map(Number);
    const [ax, ay, az] = line('axis')!.slice(0, 3).map(Number);
    bones.set(name, { name, direction: new THREE.Vector3(dx, dy, dz), length: Number(line('length')![0]) * UNIT_CM, axis: euler(ax!, ay!, az!), dof: line('dof') ?? [] });
  }
  for (const l of blocks[1]!.split('\n')) {
    const parts = l.trim().split(/\s+/);
    if (parts.length < 2 || parts[0] === 'begin' || parts[0] === 'end') continue;
    children.set(parts[0]!, parts.slice(1));
  }
  return { bones, children };
}

function parseAmc(text: string): Array<Map<string, number[]>> {
  const frames: Array<Map<string, number[]>> = [];
  let current: Map<string, number[]> | undefined;
  for (const raw of text.split('\n')) {
    const l = raw.trim();
    if (!l || l.startsWith('#') || l.startsWith(':')) continue;
    if (/^\d+$/.test(l)) { current = new Map(); frames.push(current); continue; }
    const [name, ...values] = l.split(/\s+/);
    current?.set(name!, values.map(Number));
  }
  return frames;
}

type Pose = Map<string, { matrix: THREE.Matrix4; head: THREE.Vector3; end: THREE.Vector3 }>;

const LEG_CHAIN = ['femur', 'tibia', 'foot', 'toes'];
const legTurn = (asf: ReturnType<typeof parseAsf>, bone: string) => {
  const side = bone[0];
  return LEG_CHAIN.some((b) => bone === `${side}${b}`) ? asf.bones.get(`${side}femur`)!.axis : undefined;
};

/** `straight`: lay the leg chains out without their rest turn (the rest pose written to the dump). */
function pose(asf: ReturnType<typeof parseAsf>, motion: Map<string, number[]> | undefined, straight = false): Pose {
  const out: Pose = new Map();
  const root = motion?.get('root') ?? [0, 0, 0, 0, 0, 0];
  const rootPos = new THREE.Vector3(root[0], root[1], root[2]).multiplyScalar(UNIT_CM);
  const rootMatrix = euler(root[3]!, root[4]!, root[5]!);
  out.set('root', { matrix: rootMatrix, head: rootPos.clone(), end: rootPos.clone() });
  const visit = (parent: string) => {
    for (const name of asf.children.get(parent) ?? []) {
      const bone = asf.bones.get(name)!;
      const values = motion?.get(name) ?? [];
      const dof = { rx: 0, ry: 0, rz: 0 } as Record<string, number>;
      bone.dof.forEach((d, i) => { dof[d] = values[i] ?? 0; });
      const local = bone.axis.clone().multiply(euler(dof.rx!, dof.ry!, dof.rz!)).multiply(bone.axis.clone().invert());
      const p = out.get(parent)!;
      const matrix = p.matrix.clone().multiply(local);
      const turn = straight ? legTurn(asf, name) : undefined;
      const direction = turn ? bone.direction.clone().applyMatrix4(turn.clone().invert()) : bone.direction.clone();
      const end = p.end.clone().addScaledVector(direction.applyMatrix4(matrix), bone.length);
      out.set(name, { matrix, head: p.end.clone(), end });
      visit(name);
    }
  };
  visit('root');
  return out;
}

// y-up (ASF) → Blender z-up: (x, y, z) → (x, -z, y); a rotation turns the same way.
const toZUp = (v: THREE.Vector3) => [v.x, -v.z, v.y];
const quatZUp = (m: THREE.Matrix4) => {
  const q = new THREE.Quaternion().setFromRotationMatrix(m);
  return [q.w, q.x, -q.z, q.y];
};
const round = (values: number[]) => values.map((v) => Math.round(v * 1e6) / 1e6);

function dumpFrame(asf: ReturnType<typeof parseAsf>, p: Pose): Record<string, number[]> {
  const frame: Record<string, number[]> = {};
  for (const m of MAP) {
    const turn = legTurn(asf, m.rotation);
    const matrix = turn ? p.get(m.rotation)!.matrix.clone().multiply(turn) : p.get(m.rotation)!.matrix;
    frame[m.name] = round([...quatZUp(matrix), ...toZUp(p.get(m.head)!.end)]);
  }
  for (const s of ['l', 'r'] as const) {
    const hand = p.get(`${s}hand`)!;
    // Across the palm toward the thumb, at rest; carried by the hand's frame.
    const thumbRest = asf.bones.get(`${s}thumb`)!.direction.clone();
    const along = asf.bones.get(`${s}hand`)!.direction.clone().normalize();
    const across = thumbRest.addScaledVector(along, -thumbRest.dot(along)).normalize().applyMatrix4(new THREE.Matrix4().extractRotation(hand.matrix));
    const width = asf.bones.get(`${s}hand`)!.length + asf.bones.get(`${s}wrist`)!.length;
    for (const k of KNUCKLES) frame[`${s}${k.name}`] = round([...quatZUp(hand.matrix), ...toZUp(hand.end.clone().addScaledVector(across, k.across * width * 0.5))]);
  }
  return frame;
}

const [asfPath, amcPath, outPath] = process.argv.slice(2);
if (!asfPath || !amcPath || !outPath) throw new Error('usage: amc-to-dump.ts <subject.asf> <take.amc> <out.json>');
const asf = parseAsf(await readFile(asfPath, 'utf8'));
const motion = parseAmc(await readFile(amcPath, 'utf8'));
const restPose = pose(asf, undefined, true);
const rest: Record<string, { parent: string | null; q: number[]; p: number[] }> = {};
const restFrame = dumpFrame(asf, restPose);
for (const [name, v] of Object.entries(restFrame)) {
  // At rest every bone is unturned (the leg chains' turn is laid out in the positions instead).
  v.splice(0, 4, 1, 0, 0, 0);
  const mapped = MAP.find((m) => m.name === name);
  const parent = mapped ? mapped.parent : `${name[0]}Hand`;
  rest[name] = { parent, q: v.slice(0, 4), p: v.slice(4) };
}
// CMU takes are 120 fps; every fourth frame.
const step = 120 / OUT_FPS;
const frames = motion.filter((_, i) => i % step === 0).map((m) => dumpFrame(asf, pose(asf, m)));
await writeFile(outPath, JSON.stringify({ fps: OUT_FPS, rest, frames }));
console.log(`${amcPath}: ${motion.length} frames at 120 fps -> ${frames.length} at ${OUT_FPS} -> ${outPath}`);
