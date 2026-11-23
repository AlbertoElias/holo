/**
 * Arm quality in a solved take, measured per frame: how far an arm or hand
 * goes into the body, the head or a prop, how far the forearm twists and the
 * wrist bends, and whether the elbow bends the way an elbow can.
 *
 * The body is the avatar's own posed skin: its vertices, thinned to one per
 * 1.5 cm cell, with their normals. A point is in the body when its depth
 * under the nearest skin planes is positive and the local winding number of
 * the skin around it says it is inside (a point near a fold or a waistband
 * is not counted as deep). The arm is the posed skin of the forearm and the
 * hand (and the outer upper arm).
 *
 * The joint angles are read in the upper arm's frame against bind (a T-pose
 * with the palm down, which is the neutral forearm: thumb forward):
 * - the elbow's flexion about its hinge, the axis square to the bind forearm
 *   and the body's forward (flexion brings the forearm forward);
 * - the forearm's angle off that hinge plane (an elbow cannot bend sideways);
 * - the hand's twist about the forearm with the flexion removed (pronation
 *   and supination), and the rest of its turn (the wrist's bend).
 */
import * as THREE from 'three';
import type { VrmHumanoidBone } from '@holoim/meaning';
import type { LoadedAvatar, Side } from './avatar.ts';
import { resetPose } from './avatar.ts';
import type { Part, Prop } from './props.ts';

/** The limits a take must keep (evidence: docs in the hologram-authoring skill). */
export const ARM_LIMITS = {
  /** An arm or hand into the torso, the legs or the head, metres past the skin. */
  bodyDepth: 0.02,
  /** An arm or hand into a prop's surface, metres. */
  propDepth: 0.01,
  /** The hand's skin into the object it holds, metres: fingers and palm rest on the surface, they do not sink into it. */
  heldDepth: 0.003,
  /** Forearm twist from neutral (thumb forward), degrees: pronation and supination are each about 80-90°. */
  twist: 90,
  /** The wrist's bend off the forearm, degrees (flexion about 80°, extension about 70°). */
  wristBend: 80,
  /** The elbow's flexion: past straight by at most this (hyperextension), degrees. */
  hyperextension: 10,
  /** The forearm off the elbow's hinge plane, degrees. */
  elbowSideways: 15
} as const;

const SIDES: readonly Side[] = ['left', 'right'];

/** One skin vertex, sampled at bind: which mesh and vertex, and the bone that moves it most. */
interface SkinSample { readonly mesh: THREE.SkinnedMesh; readonly i: number; readonly bone: THREE.Object3D; readonly part: string }

interface ArmBind {
  readonly d0: THREE.Vector3;
  readonly hinge: THREE.Vector3;
  readonly flexDir: THREE.Vector3;
  readonly handInUpper: THREE.Quaternion;
  readonly foreRadius: number;
  readonly upperRadius: number;
}

export interface ArmBody {
  /** How far out from the shoulder (the body's local x, metres, unsigned) a hanging wrist must sit so the hand clears the hip and thigh. */
  readonly restOut: Record<Side, number>;
  /** At bind, how far out the hip joint sits from the shoulder joint (body's local x, + is out). */
  readonly hipOut: Record<Side, number>;
  /** The body's skin (the torso, the legs, the head and the neck), one vertex per 1.5 cm cell. */
  readonly body: readonly SkinSample[];
  /** Each arm's skin from the elbow down (and the outer upper arm, `part` 'upper arm'), one vertex per 1.5 cm cell. */
  readonly arm: Readonly<Record<Side, readonly SkinSample[]>>;
  /** Each hand's skin (the palm, the fingers and the thumb), one vertex per 4 mm cell, `part` the bone's name. */
  readonly hand: Readonly<Record<Side, readonly SkinSample[]>>;
  readonly arms: Readonly<Record<Side, ArmBind>>;
}

const CELL = 0.015;

const tmp = { a: new THREE.Vector3(), b: new THREE.Vector3(), c: new THREE.Vector3(), q: new THREE.Quaternion(), q2: new THREE.Quaternion(), m: new THREE.Matrix4() };

const percentile = (values: number[], p: number): number => {
  if (!values.length) return 0;
  const s = [...values].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor(p * (s.length - 1)))]!;
};

/** Every skinned vertex at bind in the world, with the bone that moves it most. */
function bindVertices(a: LoadedAvatar): { p: THREE.Vector3; bone: THREE.Object3D; w: number; mesh: THREE.SkinnedMesh; i: number }[] {
  const out: { p: THREE.Vector3; bone: THREE.Object3D; w: number; mesh: THREE.SkinnedMesh; i: number }[] = [];
  a.scene.updateMatrixWorld(true);
  a.scene.traverse((o) => {
    const m = o as THREE.SkinnedMesh;
    if (!m.isSkinnedMesh || !m.visible) return;
    const pos = m.geometry.getAttribute('position');
    const si = m.geometry.getAttribute('skinIndex');
    const sw = m.geometry.getAttribute('skinWeight');
    if (!pos || !si || !sw || !m.geometry.getAttribute('normal')) return;
    for (let i = 0; i < pos.count; i += 1) {
      let best = 0;
      let bone = 0;
      for (let k = 0; k < 4; k += 1) {
        const w = sw.getComponent(i, k);
        if (w > best) { best = w; bone = si.getComponent(i, k); }
      }
      const p = new THREE.Vector3().fromBufferAttribute(pos, i);
      m.applyBoneTransform(i, p);
      p.applyMatrix4(m.matrixWorld);
      out.push({ p, bone: m.skeleton.bones[bone]!, w: best, mesh: m, i });
    }
  });
  return out;
}

/** One vertex per cell of `CELL` metres. */
function thin<T extends { p: THREE.Vector3 }>(verts: readonly T[], cell = CELL): T[] {
  const seen = new Set<string>();
  return verts.filter((v) => {
    const k = `${Math.floor(v.p.x / cell)},${Math.floor(v.p.y / cell)},${Math.floor(v.p.z / cell)}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** The body's skin samples and the arms' bind frames, from the avatar at bind. Leaves the avatar at bind. */
export function measureArmBody(a: LoadedAvatar): ArmBody {
  resetPose(a);
  const verts = bindVertices(a);
  const bodyQ = a.body.getWorldQuaternion(new THREE.Quaternion());
  const part = new Map<THREE.Object3D, string>();
  const name = (n: VrmHumanoidBone, label: string): void => { const b = a.humanoid.bone(n); if (b) part.set(b, label); };
  for (const n of ['hips', 'spine', 'chest', 'upperChest'] as const) name(n, 'torso');
  name('neck', 'neck'); name('head', 'head');
  for (const s of SIDES) {
    part.set(a.legs[s].upLeg.bone, `${s} thigh`); part.set(a.legs[s].leg.bone, `${s} shin`);
  }
  const armPart = new Map<THREE.Object3D, { side: Side; label: string }>();
  for (const s of SIDES) {
    const ch = a.arms[s];
    armPart.set(ch.upperArm, { side: s, label: `${s} upper arm` });
    armPart.set(ch.foreArm, { side: s, label: `${s} forearm` });
    ch.hand.traverse((o) => { if (!armPart.has(o)) armPart.set(o, { side: s, label: o === ch.hand ? `${s} hand` : `${s} fingers` }); });
  }
  // Inner faces (a lining, the inside of a waistband) face the bone, not out: they are not the body's outside.
  const n = new THREE.Vector3(); const at = new THREE.Vector3();
  const outward = (v: { mesh: THREE.SkinnedMesh; i: number; bone: THREE.Object3D }): boolean => {
    skinned({ mesh: v.mesh, i: v.i, bone: v.bone, part: '' }, at, n);
    return awayFrom(v.bone, at, n).dot(n) > -0.2;
  };
  const body = thin(verts.filter((v) => part.has(v.bone) && outward(v))).map((v) => ({ mesh: v.mesh, i: v.i, bone: v.bone, part: part.get(v.bone)! }));
  const armOf = (s: Side): SkinSample[] => {
    const ch = a.arms[s];
    const sh = ch.upperArm.getWorldPosition(new THREE.Vector3());
    const el = ch.foreArm.getWorldPosition(new THREE.Vector3());
    return thin(verts.filter((v) => {
      const ap = armPart.get(v.bone);
      if (!ap || ap.side !== s || v.w < 0.5) return false;
      // The upper arm only past its middle: its inner skin meets the chest at the armpit.
      if (v.bone === ch.upperArm) return v.p.clone().sub(sh).dot(el.clone().sub(sh).normalize()) > 0.5 * sh.distanceTo(el);
      return true;
    })).map((v) => ({ mesh: v.mesh, i: v.i, bone: v.bone, part: armPart.get(v.bone)!.label }));
  };
  const arm = { left: armOf('left'), right: armOf('right') };
  const handOf = (s: Side): SkinSample[] => {
    const bones = new Set<THREE.Object3D>();
    a.arms[s].hand.traverse((o) => bones.add(o));
    return thin(verts.filter((v) => bones.has(v.bone) && v.w >= 0.4), 0.004).map((v) => ({ mesh: v.mesh, i: v.i, bone: v.bone, part: v.bone.name || `${s} hand` }));
  };
  const hand = { left: handOf('left'), right: handOf('right') };
  const forward = new THREE.Vector3(0, 0, 1).applyQuaternion(bodyQ);
  const arms = {} as Record<Side, ArmBind>;
  for (const s of SIDES) {
    const ch = a.arms[s];
    const upperQ = ch.upperArm.getWorldQuaternion(new THREE.Quaternion());
    const inv = upperQ.clone().invert();
    const elbow = ch.foreArm.getWorldPosition(new THREE.Vector3());
    const wrist = ch.hand.getWorldPosition(new THREE.Vector3());
    const shoulder = ch.upperArm.getWorldPosition(new THREE.Vector3());
    const d0 = wrist.clone().sub(elbow).normalize().applyQuaternion(inv);
    const fwd = forward.clone().applyQuaternion(inv);
    const hinge = d0.clone().cross(fwd).normalize();
    const flexDir = hinge.clone().cross(d0).normalize();
    const handInUpper = inv.clone().multiply(ch.hand.getWorldQuaternion(new THREE.Quaternion()));
    const radiusOf = (b: THREE.Object3D, p0: THREE.Vector3, p1: THREE.Vector3): number => {
      const axis = p1.clone().sub(p0); const len = axis.length(); axis.normalize();
      const r: number[] = [];
      for (const v of verts) {
        if (v.bone !== b || v.w < 0.6) continue;
        const rel = v.p.clone().sub(p0); const along = rel.dot(axis);
        if (along < 0.2 * len || along > 0.8 * len) continue;
        r.push(rel.addScaledVector(axis, -along).length());
      }
      return r.length > 10 ? percentile(r, 0.5) : 0.035;
    };
    arms[s] = { d0, hinge, flexDir, handInUpper, foreRadius: radiusOf(ch.foreArm, elbow, wrist), upperRadius: radiusOf(ch.upperArm, shoulder, elbow) };
  }
  const hipOut = {} as Record<Side, number>;
  for (const s of SIDES) {
    const x = (o: THREE.Object3D): number => a.body.worldToLocal(o.getWorldPosition(new THREE.Vector3())).x;
    hipOut[s] = (s === 'left' ? 1 : -1) * (x(a.legs[s].upLeg.bone) - x(a.arms[s].upperArm));
  }
  return { body, arm, hand, arms, hipOut, restOut: { left: restOutOf(a, verts, part, 'left', arms.left.foreRadius), right: restOutOf(a, verts, part, 'right', arms.right.foreRadius) } };
}

/** The gap kept between a hanging hand's mid-line and the widest hip or thigh skin beside it: half a hand's thickness, a slightly curled finger and 1 cm. */
const REST_GAP = 0.035;

/**
 * How far out from the shoulder a hanging wrist must sit so the hand clears
 * the hip and the thigh. Shoulders and hips differ between avatars; a fixed
 * share of the reach hangs a wide-hipped avatar's hand inside its thigh.
 */
function restOutOf(a: LoadedAvatar, verts: readonly { p: THREE.Vector3; bone: THREE.Object3D }[], part: ReadonlyMap<THREE.Object3D, string>, s: Side, foreRadius: number): number {
  const ch = a.arms[s];
  const reach = ch.upperLength + ch.lowerLength;
  const local = (p: THREE.Vector3): THREE.Vector3 => a.body.worldToLocal(p.clone());
  const sh = local(ch.upperArm.getWorldPosition(new THREE.Vector3()));
  const drop = 0.965 * reach;
  const wristY = sh.y - drop;
  const elbowY = sh.y - ch.upperLength;
  const tip = 0.2 * reach;
  const sign = s === 'left' ? 1 : -1;
  let out = 0.18 * reach;
  for (const v of verts) {
    const label = part.get(v.bone);
    if (label !== 'torso' && label !== `${s} thigh`) continue;
    const q = local(v.p);
    const down = sh.y - q.y;
    // The arm hangs on a straight line from the shoulder; how far along it this height is.
    const k = Math.min(1, down / drop);
    if (q.y > elbowY || q.y < wristY - tip) continue;
    if (Math.abs(q.z - (sh.z + 0.05 * reach * k)) > 0.07) continue;
    const clear = sign * q.x + (q.y < wristY + 0.03 ? REST_GAP : foreRadius + 0.01) - sign * sh.x;
    out = Math.max(out, clear / k);
  }
  return out;
}

/** A sample's world position (and with `normal`, its outward normal) as the skin is posed now. */
export function skinned(x: SkinSample, out: THREE.Vector3, normal?: THREE.Vector3): THREE.Vector3 {
  const pos = x.mesh.geometry.getAttribute('position');
  out.fromBufferAttribute(pos, x.i);
  x.mesh.applyBoneTransform(x.i, out);
  out.applyMatrix4(x.mesh.matrixWorld);
  if (normal) {
    normal.fromBufferAttribute(x.mesh.geometry.getAttribute('normal'), x.i).multiplyScalar(0.01).add(tmp.a.fromBufferAttribute(pos, x.i));
    x.mesh.applyBoneTransform(x.i, normal);
    normal.applyMatrix4(x.mesh.matrixWorld).sub(out).normalize();
  }
  return out;
}

/** The posed body skin in a hash grid of 4 cm cells, for nearest-vertex lookups. */
/**
 * The way out of a body part from a point inside it: straight out from the
 * bone's line. Deep inside, the nearest skin vertex may be on any side; the
 * bone's line is not.
 */
function awayFrom(bone: THREE.Object3D, q: THREE.Vector3, fallback: THREE.Vector3): THREE.Vector3 {
  const a = bone.getWorldPosition(new THREE.Vector3());
  const child = bone.children.find((c) => (c as THREE.Bone).isBone);
  const out = q.clone().sub(a);
  if (child) {
    const axis = child.getWorldPosition(new THREE.Vector3()).sub(a);
    const len = axis.length();
    if (len > 1e-4) { axis.divideScalar(len); out.addScaledVector(axis, -THREE.MathUtils.clamp(out.dot(axis), 0, len)); }
  }
  return out.lengthSq() > 1e-8 ? out.normalize() : fallback.clone();
}

/** How many nearest skin vertices a depth reads. */
const NEAR = 8;
/** The skin area one sample stands for (one per 1.5 cm cell), m². */
const WIND_AREA = CELL * CELL;
/**
 * The local winding number a point inside must reach. Just under a broad
 * patch of skin it is near 0.5 (half the view); outside it is near 0 or below.
 */
const WIND_INSIDE = 0.2;

export class BodySkin {
  private readonly cells = new Map<string, number[]>();
  readonly p: THREE.Vector3[];
  readonly n: THREE.Vector3[];
  constructor(readonly samples: readonly SkinSample[]) {
    this.p = samples.map(() => new THREE.Vector3());
    this.n = samples.map(() => new THREE.Vector3());
  }
  pose(): void {
    this.cells.clear();
    this.samples.forEach((x, k) => {
      skinned(x, this.p[k]!, this.n[k]!);
      const key = BodySkin.key(this.p[k]!);
      const c = this.cells.get(key);
      if (c) c.push(k); else this.cells.set(key, [k]);
    });
  }
  private static key(p: THREE.Vector3, dx = 0, dy = 0, dz = 0): string {
    return `${Math.floor(p.x / 0.04) + dx},${Math.floor(p.y / 0.04) + dy},${Math.floor(p.z / 0.04) + dz}`;
  }
  /**
   * How far `q` is under the skin (metres, 0 or less is outside): the least
   * depth behind the nearest `NEAR` skin vertices' planes, within 4-8 cm. One
   * vertex alone is not enough: beside a convex edge of the skin, the nearest
   * vertex's plane can face away from a point that is outside. `skip` leaves
   * out some body parts.
   */
  depth(q: THREE.Vector3, skip?: (part: string) => boolean): { depth: number; part: string; normal: THREE.Vector3; away: THREE.Vector3 } {
    const near: { d: number; k: number }[] = [];
    for (let dx = -1; dx <= 1; dx += 1) for (let dy = -1; dy <= 1; dy += 1) for (let dz = -1; dz <= 1; dz += 1) {
      for (const k of this.cells.get(BodySkin.key(q, dx, dy, dz)) ?? []) {
        if (skip?.(this.samples[k]!.part)) continue;
        near.push({ d: this.p[k]!.distanceToSquared(q), k });
      }
    }
    if (near.length === 0) return { depth: -Infinity, part: '', normal: new THREE.Vector3(), away: new THREE.Vector3() };
    // Local winding number: the share of the view around `q` that the nearby skin covers from inside.
    let wind = 0;
    for (const { d, k } of near) {
      if (d < 1e-10) continue;
      wind += (WIND_AREA * tmp.b.copy(this.p[k]!).sub(q).dot(this.n[k]!)) / (4 * Math.PI * d * Math.sqrt(d));
    }
    near.sort((x, y) => x.d - y.d);
    let depth = Infinity; let bk = near[0]!.k;
    for (const { k } of near.slice(0, NEAR)) {
      const d = -tmp.b.copy(q).sub(this.p[k]!).dot(this.n[k]!);
      if (d < depth) { depth = d; bk = k; }
    }
    if (wind < WIND_INSIDE) depth = Math.min(depth, 0);
    const x = this.samples[near[0]!.k]!;
    return { depth, part: x.part, normal: this.n[bk]!.clone(), away: awayFrom(x.bone, q, this.n[bk]!) };
  }

}

/** How far a ball is into one part of a prop (in the prop's world pose), metres. */
export function partDepth(prop: Prop, part: Part, p: THREE.Vector3, r: number): number {
  const local = tmp.a.copy(p).sub(prop.position).applyQuaternion(tmp.q.copy(prop.quaternion).invert());
  const center = tmp.b.set(0, part.size.y / 2, 0).applyQuaternion(part.rotation).add(part.at);
  local.sub(center).applyQuaternion(tmp.q2.copy(part.rotation).invert());
  const hx = part.size.x / 2; const hy = part.size.y / 2; const hz = part.size.z / 2;
  if (part.shape === 'box') {
    const qx = Math.abs(local.x) - hx; const qy = Math.abs(local.y) - hy; const qz = Math.abs(local.z) - hz;
    const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0), Math.max(qz, 0));
    const sdf = outside + Math.min(Math.max(qx, qy, qz), 0);
    return r - sdf;
  }
  if (part.shape === 'sphere') {
    const k = Math.hypot(local.x / hx, local.y / hy, local.z / hz);
    const R = k > 1e-6 ? local.length() / k : Math.min(hx, hy, hz);
    return R + r - local.length();
  }
  // Cylinder and cone (as a cylinder of its mean radius).
  const rad = part.shape === 'cone' ? hx / 2 : hx;
  const dr = Math.hypot(local.x, local.z * (hx / Math.max(hz, 1e-6))) - rad;
  const dy = Math.abs(local.y) - hy;
  const sdf = Math.hypot(Math.max(dr, 0), Math.max(dy, 0)) + Math.min(Math.max(dr, dy), 0);
  return r - sdf;
}

/** The outward normal of a prop part's surface near `p` (the depth's falling direction). */
export function propNormal(prop: Prop, part: Part, p: THREE.Vector3, r: number): THREE.Vector3 {
  const h = 0.004; const q = new THREE.Vector3();
  const g = new THREE.Vector3(
    partDepth(prop, part, q.copy(p).setX(p.x + h), r) - partDepth(prop, part, q.copy(p).setX(p.x - h), r),
    partDepth(prop, part, q.copy(p).setY(p.y + h), r) - partDepth(prop, part, q.copy(p).setY(p.y - h), r),
    partDepth(prop, part, q.copy(p).setZ(p.z + h), r) - partDepth(prop, part, q.copy(p).setZ(p.z - h), r));
  return g.lengthSq() > 1e-12 ? g.negate().normalize() : new THREE.Vector3(0, 1, 0);
}

/** Points on a prop's parts as it stands now: each part's corners and face centres. */
export function propSurface(prop: Prop): THREE.Vector3[] {
  const out: THREE.Vector3[] = [];
  for (const part of propParts(prop)) {
    const hx = part.size.x / 2; const hy = part.size.y / 2; const hz = part.size.z / 2;
    const round = part.shape !== 'box' ? Math.SQRT1_2 : 1;
    const local: [number, number, number][] = [[hx, 0, 0], [-hx, 0, 0], [0, hy, 0], [0, -hy, 0], [0, 0, hz], [0, 0, -hz]];
    for (const x of [-1, 1]) for (const y of [-1, 1]) for (const z of [-1, 1]) local.push([x * hx * round, y * hy, z * hz * round]);
    for (const [x, y, z] of local) {
      const v = new THREE.Vector3(x, y + hy, z).applyQuaternion(part.rotation).add(part.at);
      out.push(v.applyQuaternion(prop.quaternion).add(prop.position));
    }
  }
  return out;
}

/** A sourced model is its bounds; a built one is its parts. */
export function propParts(prop: Prop): readonly Part[] {
  if (prop.parts.length) return prop.parts;
  const size = prop.bounds.getSize(new THREE.Vector3());
  const at = prop.bounds.getCenter(new THREE.Vector3()); at.y = prop.bounds.min.y;
  return [{ shape: 'box', size, at, rotation: new THREE.Quaternion(), color: [1, 1, 1] }];
}

export interface ArmFrameSample {
  /** Deepest arm-into-body overlap, metres, and where. */
  bodyDepth: number; bodyWhere: string;
  propDepth: number; propWhere: string;
  /** Per side: degrees. */
  twist: Record<Side, number>; wristBend: Record<Side, number>; flex: Record<Side, number>; sideways: Record<Side, number>;
}

export interface ArmPoint { readonly name: string; readonly p: THREE.Vector3; readonly r: number; readonly hand: boolean; readonly upper: boolean; /** 0 at the elbow (and on the upper arm) to 1 at the wrist and hand. */ readonly along: number }

/** Points along one arm, each with a radius: the outer upper arm, the forearm, the wrist, the palm and the fingers. */
export function armPoints(a: LoadedAvatar, body: ArmBody, s: Side): ArmPoint[] {
  const ch = a.arms[s];
  const sh = ch.upperArm.getWorldPosition(new THREE.Vector3());
  const el = ch.foreArm.getWorldPosition(new THREE.Vector3());
  const wr = ch.hand.getWorldPosition(new THREE.Vector3());
  const pts: ArmPoint[] = [];
  for (const k of [0.6, 0.8]) pts.push({ name: `${s} upper arm`, p: sh.clone().lerp(el, k), r: body.arms[s].upperRadius, hand: false, upper: true, along: 0 });
  for (const k of [0, 0.25, 0.5, 0.75]) pts.push({ name: `${s} forearm`, p: el.clone().lerp(wr, k), r: body.arms[s].foreRadius, hand: false, upper: false, along: k });
  pts.push({ name: `${s} wrist`, p: wr.clone(), r: body.arms[s].foreRadius * 0.8, hand: true, upper: false, along: 1 });
  const hand = a.hands[s];
  if (hand) {
    const palm = hand.palmCenter(new THREE.Vector3());
    pts.push({ name: `${s} palm`, p: palm, r: 0.015, hand: true, upper: false, along: 1 });
    for (const f of ['index', 'middle', 'little'] as const) {
      const tip = hand.tip(f, new THREE.Vector3());
      if (tip) pts.push({ name: `${s} ${f} finger`, p: tip.lerp(palm, 0.4), r: 0.009, hand: true, upper: false, along: 1 });
    }
  }
  return pts;
}

/** Where each sample of one arm's skin is now, with how far along the forearm it is (0 at the elbow, 1 at the wrist; 1 for the hand, 0 for the upper arm). */
export function armSkin(a: LoadedAvatar, body: ArmBody, s: Side): { x: SkinSample; p: THREE.Vector3; along: number; hand: boolean }[] {
  const ch = a.arms[s];
  const el = ch.foreArm.getWorldPosition(new THREE.Vector3());
  const wr = ch.hand.getWorldPosition(new THREE.Vector3());
  const axis = wr.clone().sub(el); const len = axis.length(); axis.normalize();
  return body.arm[s].map((x) => {
    const p = skinned(x, new THREE.Vector3());
    const hand = x.part.endsWith('hand') || x.part.endsWith('fingers');
    const along = hand ? 1 : x.part.endsWith('upper arm') ? 0 : THREE.MathUtils.clamp(p.clone().sub(el).dot(axis) / len, 0, 1);
    return { x, p, along, hand };
  });
}

/** The deepest point of one arm's skin under the body's skin, metres, and where. */
export function bodyOverlap(skin: BodySkin, body: ArmBody, s: Side): { depth: number; where: string } {
  let best = { depth: -Infinity, where: '' };
  const q = new THREE.Vector3();
  for (const x of body.arm[s]) {
    skinned(x, q);
    const d = skin.depth(q, x.part.endsWith('upper arm') ? (p) => p === 'torso' : undefined);
    if (d.depth > best.depth) best = { depth: d.depth, where: `${x.part} in the ${d.part}` };
  }
  return best;
}

/** The deepest overlap of these points with props; a hand does not count against what it holds or touches by direction. */
export function propOverlap(props: readonly Prop[], pts: readonly ArmPoint[], handFree: (prop: Prop) => boolean): { depth: number; where: string } {
  let best = { depth: -Infinity, where: '' };
  for (const prop of props) {
    const skipHand = handFree(prop);
    for (const part of propParts(prop)) {
      for (const pt of pts) {
        if (pt.hand && skipHand) continue;
        const d = partDepth(prop, part, pt.p, pt.r);
        if (d > best.depth) best = { depth: d, where: `${pt.name} in ${prop.id}${part.name ? `'s ${part.name}` : ''}` };
      }
    }
  }
  return best;
}

/** The elbow's flexion and sideways angle, the forearm's twist and the wrist's bend, degrees. */
export function armAngles(a: LoadedAvatar, body: ArmBody, s: Side): { flex: number; sideways: number; twist: number; wristBend: number } {
  const ch = a.arms[s];
  const b = body.arms[s];
  const inv = ch.upperArm.getWorldQuaternion(new THREE.Quaternion()).invert();
  const el = ch.foreArm.getWorldPosition(new THREE.Vector3());
  const d = ch.hand.getWorldPosition(new THREE.Vector3()).sub(el).normalize().applyQuaternion(inv);
  const sideways = Math.asin(THREE.MathUtils.clamp(d.dot(b.hinge), -1, 1));
  const flex = Math.atan2(d.dot(b.flexDir), d.dot(b.d0));
  const H = new THREE.Quaternion().setFromAxisAngle(b.hinge, flex);
  const R = inv.clone().multiply(ch.hand.getWorldQuaternion(new THREE.Quaternion()));
  const T = H.invert().multiply(R).multiply(b.handInUpper.clone().invert());
  const sign = T.w < 0 ? -1 : 1;
  const twist = 2 * Math.atan2(sign * (T.x * b.d0.x + T.y * b.d0.y + T.z * b.d0.z), sign * T.w);
  const twistQ = new THREE.Quaternion().setFromAxisAngle(b.d0, twist);
  const swing = T.multiply(twistQ.invert());
  const wristBend = 2 * Math.acos(Math.min(1, Math.abs(swing.w)));
  const deg = THREE.MathUtils.radToDeg;
  // Mirror the twist so + is the same turn on both sides: supination, the palm turning up from thumb-forward
  // (a right turn about the right forearm's line from elbow to wrist, a left turn about the left's).
  return { flex: deg(flex), sideways: deg(sideways), twist: deg(twist) * (s === 'left' ? -1 : 1), wristBend: deg(wristBend) };
}

export interface ArmReport {
  /** The worst frame of each measure: value, take time and what. */
  readonly bodyDepth: { value: number; t: number; where: string };
  readonly propDepth: { value: number; t: number; where: string };
  /** The hand's skin into what it holds. */
  readonly heldDepth: { value: number; t: number; where: string };
  /** Per held frame, the deepest skin point into the held object, metres. */
  readonly held: readonly { t: number; depth: number; where: string }[];
  readonly twist: { value: number; t: number; where: string };
  readonly wristBend: { value: number; t: number; where: string };
  readonly hyperextension: { value: number; t: number; where: string };
  readonly elbowSideways: { value: number; t: number; where: string };
  /** Frames over each limit. */
  readonly over: Record<'bodyDepth' | 'propDepth' | 'heldDepth' | 'twist' | 'wristBend' | 'hyperextension' | 'elbowSideways', number>;
  readonly frames: number;
}

export class ArmMeter {
  private readonly worst: { [K in keyof ArmReport['over']]: { value: number; t: number; where: string } } = {
    bodyDepth: { value: -Infinity, t: 0, where: '' }, propDepth: { value: -Infinity, t: 0, where: '' }, heldDepth: { value: -Infinity, t: 0, where: '' }, twist: { value: 0, t: 0, where: '' },
    wristBend: { value: 0, t: 0, where: '' }, hyperextension: { value: -Infinity, t: 0, where: '' }, elbowSideways: { value: 0, t: 0, where: '' }
  };
  private readonly over = { bodyDepth: 0, propDepth: 0, heldDepth: 0, twist: 0, wristBend: 0, hyperextension: 0, elbowSideways: 0 };
  private frames = 0;
  private readonly held: { t: number; depth: number; where: string }[] = [];
  private readonly skin: BodySkin;
  constructor(private readonly a: LoadedAvatar, readonly body: ArmBody) { this.skin = new BodySkin(body.body); }

  /** Measures the avatar as posed now; `props` are the stage's, `handFree(side, prop)` is true where that hand may touch the prop, `heldBy(side)` is what that hand holds. */
  sample(t: number, props: readonly Prop[], handFree: (s: Side, prop: Prop) => boolean, heldBy: (s: Side) => Prop | undefined = () => undefined): void {
    this.frames += 1;
    const note = (k: keyof ArmReport['over'], value: number, where: string, limit: number): void => {
      if (value > this.worst[k].value) this.worst[k] = { value, t, where };
      if (value > limit) this.over[k] += 1;
    };
    let bodyD = { depth: -Infinity, where: '' }; let propD = { depth: -Infinity, where: '' };
    this.skin.pose();
    for (const s of SIDES) {
      const pts = armPoints(this.a, this.body, s);
      const b = bodyOverlap(this.skin, this.body, s);
      if (b.depth > bodyD.depth) bodyD = b;
      const p = propOverlap(props, pts, (prop) => handFree(s, prop));
      if (p.depth > propD.depth) propD = p;
      const ang = armAngles(this.a, this.body, s);
      note('twist', Math.abs(ang.twist), `${s} forearm ${ang.twist >= 0 ? 'supinated' : 'pronated'}`, ARM_LIMITS.twist);
      note('wristBend', ang.wristBend, `${s} wrist`, ARM_LIMITS.wristBend);
      note('hyperextension', -ang.flex, `${s} elbow`, ARM_LIMITS.hyperextension);
      note('elbowSideways', Math.abs(ang.sideways), `${s} elbow`, ARM_LIMITS.elbowSideways);
    }
    // A held object: the hand's skin rests on it. Only a skin point that sinks into it counts.
    let heldD = { depth: -Infinity, where: '' };
    for (const s of SIDES) {
      const prop = heldBy(s);
      if (!prop) continue;
      for (const x of this.body.hand[s]) {
        const p = skinned(x, tmp.c);
        for (const part of propParts(prop)) {
          const d = partDepth(prop, part, p, 0);
          if (d > heldD.depth) heldD = { depth: d, where: `${x.part} in ${prop.id}` };
        }
      }
    }
    if (heldD.depth > -Infinity) {
      this.held.push({ t, depth: heldD.depth, where: heldD.where });
      note('heldDepth', heldD.depth, heldD.where, ARM_LIMITS.heldDepth);
    }
    // Per frame, the deepest overlap of either arm counts once.
    note('bodyDepth', bodyD.depth, bodyD.where, ARM_LIMITS.bodyDepth);
    note('propDepth', propD.depth, propD.where, ARM_LIMITS.propDepth);
  }

  report(): ArmReport {
    return { ...this.worst, held: [...this.held], over: { ...this.over }, frames: this.frames };
  }
}

/** Performer against performer: the deepest skin of one under the other's skin (evidence: B-094). */
export const PAIR_LIMITS = {
  /**
   * Any skin (torso, head, legs, arms, hands) or held object of one performer into another's skin, metres.
   * A hand that rests on the other's chest presses in up to about 2 cm (goodbye: 2.2 cm for one frame);
   * the goodbye draft v25, with one head in the other and a hand through his torso, goes 6.3 cm in.
   */
  bodyDepth: 0.03
} as const;

export interface PairReport {
  readonly a: string;
  readonly b: string;
  readonly worst: { value: number; t: number; where: string };
  /** Frames over the limit. */
  readonly over: number;
  readonly frames: number;
  /** The deepest overlap on each frame, metres (0 or less is apart). */
  readonly perFrame: readonly { t: number; depth: number; where: string }[];
}

/**
 * Two performers who stand or move into each other: each one's skin samples
 * (and the surface of what each one holds) against the other's skin, on
 * every frame. Touching is allowed; going in is not.
 */
export class PairMeter {
  private readonly skins: BodySkin[];
  private readonly pairs: { i: number; j: number; worst: { value: number; t: number; where: string }; over: number; perFrame: { t: number; depth: number; where: string }[] }[] = [];
  private frames = 0;
  constructor(private readonly ids: readonly string[], bodies: readonly ArmBody[]) {
    this.skins = bodies.map((b) => new BodySkin([...b.body, ...b.arm.left, ...b.arm.right]));
    for (let i = 0; i < ids.length; i += 1) for (let j = i + 1; j < ids.length; j += 1) this.pairs.push({ i, j, worst: { value: -Infinity, t: 0, where: '' }, over: 0, perFrame: [] });
  }

  /** Measures every performer as posed now; `held[k]` is what performer k holds. */
  sample(t: number, held: readonly (readonly Prop[])[]): void {
    if (this.pairs.length === 0) return;
    this.frames += 1;
    this.skins.forEach((sk) => sk.pose());
    const boxes = this.skins.map((sk) => new THREE.Box3().setFromPoints(sk.p).expandByScalar(0.03));
    for (const pair of this.pairs) {
      let best = { depth: -Infinity, where: '' };
      const into = (from: number, to: number): void => {
        const skin = this.skins[to]!; const box = boxes[to]!;
        const test = (q: THREE.Vector3, what: string): void => {
          if (!box.containsPoint(q)) return;
          const d = skin.depth(q);
          if (d.depth > best.depth) best = { depth: d.depth, where: `${what} of ${this.ids[from]} in the ${d.part} of ${this.ids[to]}` };
        };
        const own = this.skins[from]!;
        own.p.forEach((q, k) => test(q, own.samples[k]!.part));
        for (const prop of held[from] ?? []) for (const q of propSurface(prop)) test(q, prop.id);
      };
      into(pair.i, pair.j);
      into(pair.j, pair.i);
      const depth = Math.max(best.depth, 0);
      pair.perFrame.push({ t, depth, where: best.depth > 0 ? best.where : '' });
      if (best.depth > pair.worst.value) pair.worst = { value: best.depth, t, where: best.where };
      if (best.depth > PAIR_LIMITS.bodyDepth) pair.over += 1;
    }
  }

  report(): PairReport[] {
    return this.pairs.map((p) => ({ a: this.ids[p.i]!, b: this.ids[p.j]!, worst: { ...p.worst, value: Math.max(p.worst.value, 0) }, over: p.over, frames: this.frames, perFrame: [...p.perFrame] }));
  }
}
