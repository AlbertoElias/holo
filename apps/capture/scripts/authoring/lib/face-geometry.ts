/**
 * The audition's geometry tier: what the face shapes do to the mesh, read in
 * Node from the avatar alone. Regions come from the shapes and the eye bones,
 * never from landmarks or names: the brow region is what the brow shapes
 * move, the lids are what `eyeBlink*` moves around each eye bone, the chin is
 * what `jawOpen` moves most, and each eye is what its eye bone carries; its
 * opening is how much of it a ray from the card's side reaches first. So an
 * outside avatar needs nothing marked up, holes in the face or not.
 *
 * Everything is measured in the avatar's body frame (+Y up, +Z the way it
 * faces), in metres, at bind pose.
 */
import * as THREE from 'three';
import { ARKIT_BLENDSHAPES, type FaceChannel } from '@holoim/avatar-face';

import type { LoadedAvatar, Side } from './avatar.ts';
import { resetPose } from './avatar.ts';
import { meshesOf, skin } from './skin.ts';

/** A vertex moves "with" a shape when the shape moves it this far (m). */
export const MOVED = 0.001;
/** Travel is this percentile of the vertices a shape moves, so one stray vertex cannot pass a row. */
export const TRAVEL_PERCENTILE = 0.9;

const NEUTRAL = { left: { yaw: 0, pitch: 0 }, right: { yaw: 0, pitch: 0 } };

/** The ARKit channels a face shape carries: all but the 8 `eyeLook*`, which turn eye bones. */
export const SHAPE_CHANNELS: readonly FaceChannel[] = ARKIT_BLENDSHAPES.filter((c) => !c.startsWith('eyeLook'));

export const BROW_CHANNELS: readonly FaceChannel[] = ['browInnerUp', 'browDownLeft', 'browDownRight', 'browOuterUpLeft', 'browOuterUpRight'];

/** Vertices of one mesh, by index; `count` lets the viewer check it found the same mesh. */
export interface MeshSet { readonly mesh: string; readonly count: number; readonly idx: number[] }
/** A point on a surface: a triangle's three vertices on one mesh and barycentric weights (of the second and third). */
export interface SurfacePoint { readonly mesh: string; readonly count: number; readonly tri: [number, number, number]; readonly uv: [number, number] }
/** The ends of the widest visible column of an eye at neutral, as points on the eye's surface. */
export interface EyeOpening { readonly top: SurfacePoint; readonly bottom: SurfacePoint }

/** What the viewer needs to find the face regions again in a take. */
export interface FaceRegions {
  /** The vertices the brow shapes move by 1 mm or more. */
  readonly brow: MeshSet[];
  /** The brow line: the brow vertices that move most (at or above the travel percentile). The face box's top. */
  readonly browLine: MeshSet[];
  /** The chin: the vertices `jawOpen` moves most. The face box's bottom is their lowest. */
  readonly chin: MeshSet[];
  readonly eyes: Partial<Record<Side, EyeOpening>>;
}

export interface ChannelTravel {
  readonly channel: FaceChannel;
  /** The travel percentile of the vertices it moves by 1 mm or more, mm (0 when it moves none). */
  readonly mm: number;
  /** The single largest vertex, mm (what the audition reported before 2a). */
  readonly maxMm: number;
  readonly vertices: number;
}

export interface EyeGeometry {
  readonly side: Side;
  /** The tallest column of eye seen from the card's direction at neutral, mm; null when no eye shows (or no eye bone). */
  readonly openMm: number | null;
  /** The same at `eyeBlink<Side>` 1: 0 when the lids close over the eye. */
  readonly blinkGapMm: number | null;
  readonly lidVertices: number;
}

export interface BrowVisibility {
  readonly state: 'neutral' | 'browInnerUp';
  readonly vertices: number;
  readonly visibleShare: number;
  /** Mesh name → share of the brow vertices it hides. */
  readonly occluders: Record<string, number>;
}

export interface AccessoryHit { readonly channel: FaceChannel; readonly vertices: number; readonly maxDepthMm: number; readonly accessories: string[] }

export interface FaceGeometry {
  readonly channels: ChannelTravel[];
  readonly regions: FaceRegions;
  readonly eyes: EyeGeometry[];
  /** Face box from the brow line to the chin, mm at neutral. */
  readonly faceBoxMm: number | null;
  /** The card camera the visibility rays aim at, body frame. */
  readonly camera: [number, number, number];
  readonly browVisibility: BrowVisibility[];
  /** Meshes counted as accessories (glasses, hair), and the face vertices that go more than `depthMm` into one. */
  readonly accessories: { readonly meshes: string[]; readonly depthMm: number; readonly hits: AccessoryHit[] };
}

const mm = (m: number): number => Math.round(m * 10000) / 10;

function quantile(sorted: number[], q: number): number {
  if (!sorted.length) return 0;
  return sorted[Math.max(0, Math.ceil(q * sorted.length) - 1)]!;
}

/** The card's camera for a performer standing at the origin facing +Z, as `HologramCardCanvas` places it (no bubble). */
function cardCamera(head: THREE.Vector3, hips: THREE.Vector3): THREE.Vector3 {
  const focus = hips.clone().lerp(head, 0.5);
  const height = Math.max(head.distanceTo(hips) * 2.2, 1.45);
  const fov = THREE.MathUtils.degToRad(38);
  const distance = THREE.MathUtils.clamp(((height * 0.62) / Math.tan(fov / 2)) * 1.36, 2.8, 12);
  return focus.add(new THREE.Vector3(0, 0, distance));
}

interface Posed { readonly positions: Float32Array[] }

/** Triangles of a mesh from posed positions, 9 floats each, with their boxes. */
export interface Soup { readonly mesh: number; readonly tri: Float32Array; readonly box: Float32Array }

export function triangles(mesh: THREE.Mesh, positions: Float32Array, m: number): Soup {
  const index = mesh.geometry.index;
  const n = index ? index.count / 3 : positions.length / 9;
  const tri = new Float32Array(n * 9);
  const box = new Float32Array(n * 6);
  for (let t = 0; t < n; t += 1) {
    for (let k = 0; k < 3; k += 1) {
      const v = index ? index.getX(t * 3 + k) : t * 3 + k;
      for (let c = 0; c < 3; c += 1) tri[t * 9 + k * 3 + c] = positions[v * 3 + c]!;
    }
    for (let c = 0; c < 3; c += 1) {
      const a = tri[t * 9 + c]!, b = tri[t * 9 + 3 + c]!, d = tri[t * 9 + 6 + c]!;
      box[t * 6 + c] = Math.min(a, b, d);
      box[t * 6 + 3 + c] = Math.max(a, b, d);
    }
  }
  return { mesh: m, tri, box };
}

/** Möller–Trumbore: the ray parameter of the hit, or -1. */
function hit(tri: Float32Array, t: number, o: ArrayLike<number>, d: ArrayLike<number>): number {
  const b = t * 9;
  const e1x = tri[b + 3]! - tri[b]!, e1y = tri[b + 4]! - tri[b + 1]!, e1z = tri[b + 5]! - tri[b + 2]!;
  const e2x = tri[b + 6]! - tri[b]!, e2y = tri[b + 7]! - tri[b + 1]!, e2z = tri[b + 8]! - tri[b + 2]!;
  const px = d[1]! * e2z - d[2]! * e2y, py = d[2]! * e2x - d[0]! * e2z, pz = d[0]! * e2y - d[1]! * e2x;
  const det = e1x * px + e1y * py + e1z * pz;
  if (Math.abs(det) < 1e-14) return -1;
  const inv = 1 / det;
  const sx = o[0]! - tri[b]!, sy = o[1]! - tri[b + 1]!, sz = o[2]! - tri[b + 2]!;
  const u = (sx * px + sy * py + sz * pz) * inv;
  if (u < 0 || u > 1) return -1;
  const qx = sy * e1z - sz * e1y, qy = sz * e1x - sx * e1z, qz = sx * e1y - sy * e1x;
  const v = (d[0]! * qx + d[1]! * qy + d[2]! * qz) * inv;
  if (v < 0 || u + v > 1) return -1;
  return (e2x * qx + e2y * qy + e2z * qz) * inv;
}

function normalOf(tri: Float32Array, t: number): [number, number, number] {
  const b = t * 9;
  const e1 = [tri[b + 3]! - tri[b]!, tri[b + 4]! - tri[b + 1]!, tri[b + 5]! - tri[b + 2]!];
  const e2 = [tri[b + 6]! - tri[b]!, tri[b + 7]! - tri[b + 1]!, tri[b + 8]! - tri[b + 2]!];
  const n = [e1[1]! * e2[2]! - e1[2]! * e2[1]!, e1[2]! * e2[0]! - e1[0]! * e2[2]!, e1[0]! * e2[1]! - e1[1]! * e2[0]!];
  const l = Math.hypot(n[0]!, n[1]!, n[2]!) || 1;
  return [n[0]! / l, n[1]! / l, n[2]! / l];
}

export interface GeometryOptions {
  /** Meshes to treat as accessories, by name; default: head-skinned meshes with no face shapes, not eyes, teeth or tongue. */
  readonly accessories?: RegExp;
  /** How deep a face vertex may go into an accessory, m. */
  readonly depth?: number;
}

export function faceGeometry(a: LoadedAvatar, options: GeometryOptions = {}): FaceGeometry {
  const depthLimit = options.depth ?? 0.002;
  resetPose(a);
  a.face.apply({}, NEUTRAL);
  a.frame.updateMatrixWorld(true);
  const meshes = meshesOf(a.scene);
  // The frame the avatar faces +Z in: a `HumanoidFacing` node turns its content to face +Z, so its parent's frame.
  const frameOf = a.body.name === 'HumanoidFacing' && a.body.parent ? a.body.parent : a.body;
  const bodyQ = frameOf.getWorldQuaternion(new THREE.Quaternion()).invert();
  const bodyO = frameOf.getWorldPosition(new THREE.Vector3());
  const v = new THREE.Vector3();
  const toBody = (src: Float32Array): Float32Array => {
    const out = new Float32Array(src.length);
    for (let i = 0; i < src.length; i += 3) {
      v.set(src[i]! - bodyO.x, src[i + 1]! - bodyO.y, src[i + 2]! - bodyO.z).applyQuaternion(bodyQ);
      out[i] = v.x; out[i + 1] = v.y; out[i + 2] = v.z;
    }
    return out;
  };
  const neutralSkin = meshes.map((m) => skin(m));
  const neutral: Posed = { positions: neutralSkin.map((s) => toBody(s.positions)) };
  const morphMeshes = meshes.map((m, k) => (m.morphTargetInfluences?.length ? k : -1)).filter((k) => k >= 0);
  const pose = (weights: Partial<Record<FaceChannel, number>>): Posed => {
    a.face.apply(weights, NEUTRAL);
    a.frame.updateMatrixWorld(true);
    const positions = [...neutral.positions];
    for (const k of morphMeshes) positions[k] = toBody(skin(meshes[k]!).positions);
    a.face.apply({}, NEUTRAL);
    return { positions };
  };
  const bone = (name: 'head' | 'hips' | 'leftEye' | 'rightEye'): THREE.Vector3 | null => {
    const b = a.humanoid.bone(name);
    if (!b) return null;
    return b.getWorldPosition(new THREE.Vector3()).sub(bodyO).applyQuaternion(bodyQ);
  };
  const camera = cardCamera(bone('head')!, bone('hips')!);

  // Accessories: head-skinned meshes with no face shapes (glasses, hair, a hat).
  const headBone = a.humanoid.bone('head');
  const underHead = (o: THREE.Object3D): boolean => { for (let x: THREE.Object3D | null = o; x; x = x.parent) if (x === headBone) return true; return false; };
  const eyeBones = new Set([a.humanoid.bone('leftEye'), a.humanoid.bone('rightEye')].filter(Boolean));
  const accessoryIdx = meshes.map((m, k) => {
    if (options.accessories) return options.accessories.test(m.name) ? k : -1;
    if (m.morphTargetInfluences?.length || /eye|teeth|tongue/i.test(m.name)) return -1;
    const s = neutralSkin[k]!;
    let head = 0, eye = 0;
    for (const d of s.dominant) { if (eyeBones.has(d as THREE.Bone)) eye += 1; else if (underHead(d)) head += 1; }
    return head > 0.5 * s.count && eye < 0.5 * s.count ? k : -1;
  }).filter((k) => k >= 0);
  const accessorySoups = accessoryIdx.map((k) => triangles(meshes[k]!, neutral.positions[k]!, k));

  // Per channel: how far each vertex moves; accessories checked against the same pose.
  const moved = new Map<FaceChannel, { m: number; i: number; d: number }[]>();
  const channels: ChannelTravel[] = [];
  const hits: AccessoryHit[] = [];
  const seg = new Float64Array(3);
  for (const channel of SHAPE_CHANNELS) {
    const posed = pose({ [channel]: 1 });
    const list: { m: number; i: number; d: number }[] = [];
    for (const k of morphMeshes) {
      const now = posed.positions[k]!, was = neutral.positions[k]!;
      for (let i = 0; i < now.length; i += 3) {
        const d = Math.hypot(now[i]! - was[i]!, now[i + 1]! - was[i + 1]!, now[i + 2]! - was[i + 2]!);
        if (d >= MOVED) list.push({ m: k, i: i / 3, d });
      }
    }
    moved.set(channel, list);
    const sorted = list.map((x) => x.d).sort((x, y) => x - y);
    channels.push({ channel, mm: mm(quantile(sorted, TRAVEL_PERCENTILE)), maxMm: mm(sorted.at(-1) ?? 0), vertices: list.length });

    // A face vertex that crosses an accessory's surface on its way from neutral, and ends more than the limit past it.
    let count = 0, deepest = 0;
    const names = new Set<string>();
    for (const x of list) {
      if (x.d <= depthLimit || accessoryIdx.includes(x.m)) continue;
      const was = neutral.positions[x.m]!, now = posed.positions[x.m]!;
      const o = [was[x.i * 3]!, was[x.i * 3 + 1]!, was[x.i * 3 + 2]!];
      const e = [now[x.i * 3]!, now[x.i * 3 + 1]!, now[x.i * 3 + 2]!];
      seg[0] = e[0]! - o[0]!; seg[1] = e[1]! - o[1]!; seg[2] = e[2]! - o[2]!;
      const lo = [Math.min(o[0]!, e[0]!), Math.min(o[1]!, e[1]!), Math.min(o[2]!, e[2]!)];
      const hiB = [Math.max(o[0]!, e[0]!), Math.max(o[1]!, e[1]!), Math.max(o[2]!, e[2]!)];
      let worst = 0, by = -1;
      for (const s of accessorySoups) {
        const n = s.box.length / 6;
        for (let t = 0; t < n; t += 1) {
          const b = t * 6;
          if (s.box[b]! > hiB[0]! || s.box[b + 3]! < lo[0]! || s.box[b + 1]! > hiB[1]! || s.box[b + 4]! < lo[1]! || s.box[b + 2]! > hiB[2]! || s.box[b + 5]! < lo[2]!) continue;
          const u = hit(s.tri, t, o, seg);
          if (u < 0 || u > 1) continue;
          const nrm = normalOf(s.tri, t);
          const past = Math.abs((1 - u) * (seg[0] * nrm[0] + seg[1] * nrm[1] + seg[2] * nrm[2]));
          if (past > worst) { worst = past; by = s.mesh; }
        }
      }
      if (worst > depthLimit) { count += 1; deepest = Math.max(deepest, worst); names.add(meshes[by]!.name); }
    }
    if (count) hits.push({ channel, vertices: count, maxDepthMm: mm(deepest), accessories: [...names] });
  }

  const setOf = (verts: { m: number; i: number }[]): MeshSet[] => {
    const by = new Map<number, Set<number>>();
    for (const x of verts) { let s = by.get(x.m); if (!s) by.set(x.m, (s = new Set())); s.add(x.i); }
    return [...by].map(([m, s]) => ({ mesh: meshes[m]!.name, count: neutral.positions[m]!.length / 3, idx: [...s].sort((p, q) => p - q) }));
  };
  const union = (chs: readonly FaceChannel[]): { m: number; i: number; d: number }[] => {
    const best = new Map<string, { m: number; i: number; d: number }>();
    for (const c of chs) for (const x of moved.get(c) ?? []) { const k = `${x.m}:${x.i}`; const was = best.get(k); if (!was || was.d < x.d) best.set(k, x); }
    return [...best.values()];
  };
  const top = (xs: { m: number; i: number; d: number }[]): { m: number; i: number; d: number }[] => {
    const cut = quantile(xs.map((x) => x.d).sort((p, q) => p - q), TRAVEL_PERCENTILE);
    return xs.filter((x) => x.d >= cut);
  };
  const browAll = union(BROW_CHANNELS);
  const browLine = top(browAll);
  const chin = top(moved.get('jawOpen') ?? []);
  const yOf = (x: { m: number; i: number }) => neutral.positions[x.m]![x.i * 3 + 1]!;
  const faceBoxMm = browLine.length && chin.length ? mm(Math.max(...browLine.map(yOf)) - Math.min(...chin.map(yOf))) : null;

  // Eyes: rays along the card camera's direction on a 0.5 mm grid over each eye; the eye shows where the first
  // surface a ray meets belongs to the eye bone. The opening is the longest visible run in a column.
  const eyes: EyeGeometry[] = [];
  const eyeOpenings: Partial<Record<Side, EyeOpening>> = {};
  for (const side of ['left', 'right'] as const) {
    const blink: FaceChannel = side === 'left' ? 'eyeBlinkLeft' : 'eyeBlinkRight';
    const lids = moved.get(blink)?.length ?? 0;
    const eyeBone = a.humanoid.bone(side === 'left' ? 'leftEye' : 'rightEye');
    const centre = bone(side === 'left' ? 'leftEye' : 'rightEye');
    if (!eyeBone || !centre) { eyes.push({ side, openMm: null, blinkGapMm: null, lidVertices: lids }); continue; }
    // The eye's radius from everything its bone carries, across meshes (an eye split by material into sclera,
    // iris and pupil primitives is one eye); else a human eye's.
    let radius = 0.012;
    const xs: number[] = [];
    meshes.forEach((_, k) => {
      const s = neutralSkin[k]!;
      for (let i = 0; i < s.count; i += 1) if (s.dominant[i] === eyeBone) xs.push(neutral.positions[k]![i * 3]!);
    });
    if (xs.length > 8) radius = Math.max(0.004, (Math.max(...xs) - Math.min(...xs)) / 2);
    const isEye = meshes.map((m, k) => {
      const index = m.geometry.index;
      const dom = neutralSkin[k]!.dominant;
      const n = index ? index.count / 3 : dom.length / 3;
      const out = new Uint8Array(n);
      for (let t = 0; t < n; t += 1) out[t] = dom[index ? index.getX(t * 3) : t * 3] === eyeBone ? 1 : 0;
      return out;
    });
    const open = eyeRun(meshes, neutral, isEye, centre, radius, camera);
    const shut = eyeRun(meshes, pose({ [blink]: 1 }), isEye, centre, radius, process.env.EYECAM ? centre.clone().add(new THREE.Vector3(0, 0, 3)) : camera);
    eyes.push({ side, openMm: open ? mm(open.length) : null, blinkGapMm: shut ? mm(shut.length) : 0, lidVertices: lids });
    if (open) eyeOpenings[side] = { top: open.top, bottom: open.bottom };
  }

  // Brow visibility: a ray from each brow vertex to the card camera; every mesh the brow shapes do not move is an occluder.
  const visibility = (state: BrowVisibility['state']): BrowVisibility => {
    const posed = state === 'neutral' ? neutral : pose({ browInnerUp: 1 });
    const soups = meshes.map((m, k) => triangles(m, posed.positions[k]!, k));
    const hidden = new Map<number, number>();
    let visible = 0;
    const d = new Float64Array(3);
    // A mesh the brow shapes move nearly all of is the brow itself (a brow ribbon or brow cards on their own
    // primitive), not something in front of it. A fringe or glasses a brow shape nudges stay occluders.
    const moved = new Map<number, number>();
    for (const x of browAll) moved.set(x.m, (moved.get(x.m) ?? 0) + 1);
    const browMeshes = new Set([...moved].filter(([m, n]) => n >= 0.9 * (neutral.positions[m]!.length / 3)).map(([m]) => m));
    for (const x of browAll) {
      const p = posed.positions[x.m]!;
      const o = [p[x.i * 3]!, p[x.i * 3 + 1]!, p[x.i * 3 + 2]!];
      d[0] = camera.x - o[0]!; d[1] = camera.y - o[1]!; d[2] = camera.z - o[2]!;
      let by = -1;
      for (const s of soups) {
        if (browMeshes.has(s.mesh)) continue;
        const n = s.box.length / 6;
        for (let t = 0; t < n && by < 0; t += 1) {
          // The ray runs toward +Z (the camera is in front): skip triangles wholly behind the vertex.
          if (s.box[t * 6 + 5]! < o[2]!) continue;
          const u = hit(s.tri, t, o, d);
          if (u > 1e-4 && u < 1) by = s.mesh;
        }
        if (by >= 0) break;
      }
      if (by < 0) visible += 1; else hidden.set(by, (hidden.get(by) ?? 0) + 1);
    }
    const n = browAll.length;
    return { state, vertices: n, visibleShare: n ? Math.round((visible / n) * 1000) / 1000 : 0, occluders: Object.fromEntries([...hidden].map(([m, c]) => [meshes[m]!.name, Math.round((c / n) * 1000) / 1000])) };
  };
  const browVisibility = [visibility('neutral'), visibility('browInnerUp')];
  resetPose(a);
  a.face.apply({}, NEUTRAL);

  return {
    channels,
    regions: { brow: setOf(browAll), browLine: setOf(browLine), chin: setOf(chin), eyes: eyeOpenings },
    eyes, faceBoxMm, camera: [camera.x, camera.y, camera.z].map((c) => Math.round(c * 1000) / 1000) as [number, number, number],
    browVisibility,
    accessories: { meshes: accessoryIdx.map((k) => meshes[k]!.name), depthMm: depthLimit * 1000, hits }
  };
}

const STEP = 0.0005;

/**
 * Parallel rays from the card camera's side through a grid 2.4 eye radii
 * tall and one radius wide around the eye centre (the iris, not the corners,
 * where a lid never wraps the ball). Per column, the longest run of cells
 * whose first hit is an eye triangle, and the surface points at its ends.
 */
function eyeRun(meshes: THREE.Mesh[], posed: Posed, isEye: Uint8Array[], centre: THREE.Vector3, radius: number, camera: THREE.Vector3): { length: number; top: SurfacePoint; bottom: SurfacePoint } | null {
  const d = centre.clone().sub(camera).normalize();
  const right = new THREE.Vector3(0, 1, 0).cross(d).normalize().negate();
  const up = d.clone().cross(right).normalize().negate();
  const half = 1.2 * radius;
  const n = Math.ceil((2 * half) / STEP);
  const origin = centre.clone().addScaledVector(d, -0.3);
  // Triangles that fall in the grid's square, in grid coordinates.
  const kept: { mesh: number; t: number; tri: Float32Array; eye: boolean; v: [number, number, number] }[] = [];
  const soups = meshes.map((m, k) => triangles(m, posed.positions[k]!, k));
  const w = new THREE.Vector3();
  for (const s of soups) {
    const index = meshes[s.mesh]!.geometry.index;
    const count = s.tri.length / 9;
    for (let t = 0; t < count; t += 1) {
      let lo0 = Infinity, hi0 = -Infinity, lo1 = Infinity, hi1 = -Infinity;
      for (let k = 0; k < 3; k += 1) {
        w.set(s.tri[t * 9 + k * 3]!, s.tri[t * 9 + k * 3 + 1]!, s.tri[t * 9 + k * 3 + 2]!).sub(centre);
        const x = w.dot(right), y = w.dot(up);
        lo0 = Math.min(lo0, x); hi0 = Math.max(hi0, x); lo1 = Math.min(lo1, y); hi1 = Math.max(hi1, y);
      }
      if (hi0 < -half || lo0 > half || hi1 < -half || lo1 > half) continue;
      const vi = [0, 1, 2].map((k) => (index ? index.getX(t * 3 + k) : t * 3 + k)) as [number, number, number];
      kept.push({ mesh: s.mesh, t, tri: s.tri, eye: isEye[s.mesh]![t] === 1, v: vi });
    }
  }
  if (!kept.some((k) => k.eye)) return null;
  const o = new Float64Array(3);
  const dir = [d.x, d.y, d.z];
  let best: { length: number; top: SurfacePoint; bottom: SurfacePoint } | null = null;
  const pointOf = (k: (typeof kept)[number], u: number, v: number): SurfacePoint => ({ mesh: meshes[k.mesh]!.name, count: posed.positions[k.mesh]!.length / 3, tri: k.v, uv: [u, v] });
  for (let i = 0; i <= n; i += 1) {
    const x = -half + i * STEP;
    if (Math.abs(x) > 0.5 * radius) continue; // the columns over the iris, not the corners where the ball turns away
    let run = 0, start: SurfacePoint | null = null, last: SurfacePoint | null = null;
    for (let j = n; j >= 0; j -= 1) { // top to bottom
      const y = -half + j * STEP;
      o[0] = origin.x + right.x * x + up.x * y; o[1] = origin.y + right.y * x + up.y * y; o[2] = origin.z + right.z * x + up.z * y;
      let near = Infinity, first: (typeof kept)[number] | null = null, fu = 0, fv = 0;
      for (const k of kept) {
        const r = hitUv(k.tri, k.t, o, dir);
        if (r && r[0] > 0 && r[0] < near) { near = r[0]; first = k; fu = r[1]; fv = r[2]; }
      }
      if (first?.eye) {
        const p = pointOf(first, fu, fv);
        if (!run) start = p;
        run += 1; last = p;
        if (!best || run * STEP > best.length) best = { length: run * STEP, top: start!, bottom: last };
      } else run = 0;
    }
  }
  return best ?? { length: 0, top: pointOf(kept.find((k) => k.eye)!, 0, 0), bottom: pointOf(kept.find((k) => k.eye)!, 0, 0) };
}

/** As `hit`, with the barycentrics of the hit. */
export function hitUv(tri: Float32Array, t: number, o: ArrayLike<number>, d: ArrayLike<number>): [number, number, number] | null {
  const b = t * 9;
  const e1x = tri[b + 3]! - tri[b]!, e1y = tri[b + 4]! - tri[b + 1]!, e1z = tri[b + 5]! - tri[b + 2]!;
  const e2x = tri[b + 6]! - tri[b]!, e2y = tri[b + 7]! - tri[b + 1]!, e2z = tri[b + 8]! - tri[b + 2]!;
  const px = d[1]! * e2z - d[2]! * e2y, py = d[2]! * e2x - d[0]! * e2z, pz = d[0]! * e2y - d[1]! * e2x;
  const det = e1x * px + e1y * py + e1z * pz;
  if (Math.abs(det) < 1e-14) return null;
  const inv = 1 / det;
  const sx = o[0]! - tri[b]!, sy = o[1]! - tri[b + 1]!, sz = o[2]! - tri[b + 2]!;
  const u = (sx * px + sy * py + sz * pz) * inv;
  if (u < 0 || u > 1) return null;
  const qx = sy * e1z - sz * e1y, qy = sz * e1x - sx * e1z, qz = sx * e1y - sy * e1x;
  const v = (d[0]! * qx + d[1]! * qy + d[2]! * qz) * inv;
  if (v < 0 || u + v > 1) return null;
  return [(e2x * qx + e2y * qy + e2z * qz) * inv, u, v];
}
