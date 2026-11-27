/**
 * Objects a sheet declares: primitives composed into parts, or a sourced GLB
 * (a local file or a Poly Haven model packed by the API), each in its own
 * frame (origin at the bottom centre, +Y up, +Z its front), with the anchors,
 * grip and tool axis the solver uses. Geometry for the writer comes from
 * three's primitives; a source keeps its own file.
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

import { NodeIO } from '@gltf-transform/core';
import { getBounds } from '@gltf-transform/functions';
import { HOLOIM_CREDIT_EXTRAS_KEY, objectCreditSchema, type ObjectCredit } from '@holoim/objects';
import * as THREE from 'three';

import type { Color, ObjectSpec, Shape, Vec3Measure } from './beats.ts';
import { resolveMeasure, type Body } from './stage.ts';

const DEG = Math.PI / 180;
const DEFAULT_COLOR: readonly [number, number, number] = [0.5, 0.5, 0.5];
const DEFAULT_GRIP_RADIUS = 0.015;
/** Where `polyhaven:<id>` sources are packed (the API's own packer: CC0 credit and real-world size). */
export const OBJECTS_API = process.env.HOLOIM_OBJECTS_API ?? 'https://holoim-api.fly.dev';

export interface LoadedSource {
  /** What the sheet named: a path or `polyhaven:<id>`. */
  readonly name: string;
  readonly bytes: Uint8Array;
  readonly sha256: string;
  /** Model-space bounds of its default scene. */
  readonly min: readonly [number, number, number];
  readonly max: readonly [number, number, number];
  readonly credit?: ObjectCredit;
  /** The API origin a packed model came from. */
  readonly fetchedFrom?: string;
}

export interface Part {
  readonly name?: string;
  readonly shape: Shape;
  readonly size: THREE.Vector3;
  /** Bottom centre in the object frame. */
  readonly at: THREE.Vector3;
  readonly rotation: THREE.Quaternion;
  /** Linear RGB. */
  readonly color: readonly [number, number, number];
}

export interface Prop {
  readonly id: string;
  readonly name: string;
  readonly spec: ObjectSpec;
  readonly parts: readonly Part[];
  /** A sourced model: object = scale × model + offset. */
  readonly source?: { readonly loaded: LoadedSource; readonly scale: number; readonly offset: THREE.Vector3 };
  readonly credit?: ObjectCredit;
  /** In the object frame. */
  readonly bounds: THREE.Box3;
  readonly anchors: ReadonlyMap<string, THREE.Vector3>;
  /** Set once from the object's surface when a `contact` with `fit: grip` names an object with no grip of its own. */
  grip?: { readonly center: THREE.Vector3; readonly axis: THREE.Vector3; readonly radius: number };
  readonly tool?: { readonly tip: THREE.Vector3; readonly axis: THREE.Vector3 };
  /** Half the smaller of its width and depth: how far a holding hand hangs out from the thigh. */
  readonly halfWidth: number;
  /** Where it is now (world). */
  readonly position: THREE.Vector3;
  readonly quaternion: THREE.Quaternion;
  /** Its parts as a world change has moved them now (a door swung open), in the object frame; undefined when no change moves it. */
  changed?: readonly Part[];
  /** The world change's pose now, kept so an anchor moves with the parts (a hand on a door's handle follows the door). */
  changePose?: ChangePose;
}

/** A world change's pose of an object's shape, in the object frame: the take's change node (B-104). */
export interface ChangePose { readonly quaternion: THREE.Quaternion; readonly lift: number; readonly scale: THREE.Vector3 }

/**
 * Moves a prop's parts by a world change's pose, as the take's change node does
 * (scale, then turn, then lift), so collisions and the arm meter see the shape
 * the viewer sees: an oven door that has swung open no longer stands in the
 * oven mouth (B-104). A scale that is not even is applied along the part's own
 * axes, which is exact for a part that the change does not turn against.
 */
export function setChange(prop: Prop, pose: ChangePose | undefined): void {
  if (!pose) { delete prop.changed; delete prop.changePose; return; }
  prop.changePose = pose;
  const lift = new THREE.Vector3(0, pose.lift, 0);
  prop.changed = prop.parts.map((part) => ({
    ...part,
    size: part.size.clone().multiply(pose.scale),
    at: part.at.clone().multiply(pose.scale).applyQuaternion(pose.quaternion).add(lift),
    rotation: pose.quaternion.clone().multiply(part.rotation),
  }));
}

/** A point of the object frame where a world change has moved it now (unmoved when no change moves the object). */
export function changedPoint(prop: Prop, local: THREE.Vector3): THREE.Vector3 {
  const pose = prop.changePose;
  return pose ? local.clone().multiply(pose.scale).applyQuaternion(pose.quaternion).add(new THREE.Vector3(0, pose.lift, 0)) : local;
}

/** Loads every sourced object of a sheet: local GLBs relative to the sheet, Poly Haven models from the API (cached under `cacheDir`). */
export async function loadSources(objects: Readonly<Record<string, ObjectSpec>>, sheetFile: string, cacheDir: string): Promise<Map<string, LoadedSource>> {
  const out = new Map<string, LoadedSource>();
  for (const spec of Object.values(objects)) {
    const name = spec.source;
    if (!name || out.has(name)) continue;
    let bytes: Uint8Array;
    let fetchedFrom: string | undefined;
    if (name.startsWith('polyhaven:')) {
      const id = name.slice('polyhaven:'.length);
      if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error(`source ${name}: not a Poly Haven id`);
      // Cached per origin, so the bytes are always credited to where they came from.
      const cached = join(cacheDir, 'polyhaven', new URL(OBJECTS_API).host.replace(/[^A-Za-z0-9.-]/g, '_'), `${id}.glb`);
      fetchedFrom = OBJECTS_API;
      try { bytes = new Uint8Array(await readFile(cached)); } catch {
        const res = await fetch(`${OBJECTS_API}/api/objects/polyhaven/${id}.glb`);
        if (!res.ok) throw new Error(`source ${name}: ${OBJECTS_API} answered ${res.status}`);
        bytes = new Uint8Array(await res.arrayBuffer());
        await mkdir(dirname(cached), { recursive: true });
        await writeFile(cached, bytes);
      }
    } else bytes = new Uint8Array(await readFile(resolve(dirname(sheetFile), name)));
    const doc = await new NodeIO().readBinary(bytes);
    const scene = doc.getRoot().getDefaultScene() ?? doc.getRoot().listScenes()[0];
    if (!scene) throw new Error(`source ${name}: no scene`);
    const { min, max } = getBounds(scene);
    const credit = objectCreditSchema.safeParse((doc.getRoot().getAsset().extras as Record<string, unknown> | undefined)?.[HOLOIM_CREDIT_EXTRAS_KEY]);
    out.set(name, {
      name, bytes, sha256: createHash('sha256').update(bytes).digest('hex'),
      min: min as [number, number, number], max: max as [number, number, number],
      ...(credit.success ? { credit: credit.data } : {}), ...(fetchedFrom ? { fetchedFrom } : {})
    });
  }
  return out;
}

export function parseColor(c: Color | undefined): readonly [number, number, number] {
  if (c === undefined) return DEFAULT_COLOR;
  if (typeof c !== 'string') return c;
  const color = new THREE.Color();
  color.setStyle(c, THREE.SRGBColorSpace);
  return [color.r, color.g, color.b];
}

/** Builds an object's shape, frame features and credit; its pose is set by the solver. */
export function buildProp(id: string, spec: ObjectSpec, bodies: ReadonlyMap<string, Body>, performer: string, sources: ReadonlyMap<string, LoadedSource>): Prop {
  const m = (v: Vec3Measure): THREE.Vector3 => new THREE.Vector3(...v.map((x) => resolveMeasure(x, bodies, performer)) as [number, number, number]);
  const parts: Part[] = [];
  const bounds = new THREE.Box3();
  let source: Prop['source'];
  let credit: ObjectCredit | undefined;
  if (spec.source) {
    const loaded = sources.get(spec.source)!;
    const lo = new THREE.Vector3(...loaded.min);
    const hi = new THREE.Vector3(...loaded.max);
    const scale = spec.height !== undefined ? resolveMeasure(spec.height, bodies, performer) / Math.max(1e-6, hi.y - lo.y) : 1;
    // The model's bottom centre to the object's origin.
    const offset = new THREE.Vector3(-(lo.x + hi.x) / 2, -lo.y, -(lo.z + hi.z) / 2).multiplyScalar(scale);
    source = { loaded, scale, offset };
    bounds.set(lo.clone().multiplyScalar(scale).add(offset), hi.clone().multiplyScalar(scale).add(offset));
    credit = spec.credit && spec.credit !== 'own' ? objectCreditSchema.parse(spec.credit) : loaded.credit;
    // Someone else's model is never used uncredited: a packed source must bring its credit.
    if (!credit && spec.credit !== 'own') throw new Error(`object ${id}: ${spec.source} carries no credit; give one in the sheet`);
  } else {
    const specs = spec.parts ?? [{ shape: spec.shape!, size: spec.size!, ...(spec.color !== undefined ? { color: spec.color } : {}) }];
    for (const p of specs) {
      const r = p.rotate ?? [0, 0, 0];
      const part: Part = {
        ...(p.name !== undefined ? { name: p.name } : {}),
        shape: p.shape, size: m(p.size), at: p.at ? m(p.at) : new THREE.Vector3(),
        rotation: new THREE.Quaternion().setFromEuler(new THREE.Euler(r[0] * DEG, r[1] * DEG, r[2] * DEG, 'XYZ')),
        color: parseColor(p.color ?? spec.color)
      };
      parts.push(part);
      for (const c of partCorners(part)) bounds.expandByPoint(c);
    }
  }
  const centre = bounds.getCenter(new THREE.Vector3());
  const anchors = new Map<string, THREE.Vector3>([
    ['top', new THREE.Vector3(centre.x, bounds.max.y, centre.z)],
    ['center', centre.clone()],
    ['bottom', new THREE.Vector3(centre.x, bounds.min.y, centre.z)],
    ['front', new THREE.Vector3(centre.x, centre.y, bounds.max.z)]
  ]);
  for (const p of parts) if (p.name) anchors.set(p.name, partPoint(p, 1));
  for (const [k, v] of Object.entries(spec.anchors ?? {})) anchors.set(k, m(v));

  const partNamed = (name: string): Part => {
    const p = parts.find((x) => x.name === name);
    if (!p) throw new Error(`object ${id}: no part ${name}`);
    return p;
  };
  let grip: Prop['grip'];
  if (typeof spec.grip === 'string') {
    const p = partNamed(spec.grip);
    const dims = [p.size.x, p.size.y, p.size.z];
    const long = dims.indexOf(Math.max(...dims));
    const others = dims.filter((_, i) => i !== long);
    grip = { center: partPoint(p, 0.5), axis: new THREE.Vector3().setComponent(long, 1).applyQuaternion(p.rotation), radius: Math.min(...others) / 2 };
  } else if (spec.grip) grip = { center: m(spec.grip.at), axis: new THREE.Vector3(...spec.grip.axis).normalize(), radius: spec.grip.radius ?? DEFAULT_GRIP_RADIUS };
  let tool: Prop['tool'];
  if (typeof spec.tool === 'string') {
    const p = partNamed(spec.tool);
    tool = { tip: partPoint(p, 1), axis: new THREE.Vector3(0, 1, 0).applyQuaternion(p.rotation) };
  } else if (spec.tool) tool = { tip: m(spec.tool.tip), axis: new THREE.Vector3(...spec.tool.axis).normalize() };

  const size = bounds.getSize(new THREE.Vector3());
  return {
    id, name: spec.name ?? id, spec, parts, ...(source ? { source } : {}), ...(credit ? { credit } : {}),
    bounds, anchors, ...(grip ? { grip } : {}), ...(tool ? { tool } : {}),
    halfWidth: Math.min(size.x, size.z) / 2,
    position: new THREE.Vector3(), quaternion: new THREE.Quaternion()
  };
}

/** A point on a part's +Y axis, `k` of the way from its bottom centre to its far end. */
function partPoint(p: Part, k: number): THREE.Vector3 {
  return new THREE.Vector3(0, p.size.y * k, 0).applyQuaternion(p.rotation).add(p.at);
}

function partCorners(p: Part): THREE.Vector3[] {
  const out: THREE.Vector3[] = [];
  for (const x of [-0.5, 0.5]) for (const y of [0, 1]) for (const z of [-0.5, 0.5]) {
    out.push(new THREE.Vector3(x * p.size.x, y * p.size.y, z * p.size.z).applyQuaternion(p.rotation).add(p.at));
  }
  return out;
}

/** A part as three geometry in the object frame (positions, normals, indices). */
export function partGeometry(p: Part): THREE.BufferGeometry {
  const g = p.shape === 'box' ? new THREE.BoxGeometry(1, 1, 1)
    : p.shape === 'cylinder' ? new THREE.CylinderGeometry(0.5, 0.5, 1, 28)
      : p.shape === 'cone' ? new THREE.ConeGeometry(0.5, 1, 28)
        : new THREE.SphereGeometry(0.5, 28, 18);
  g.translate(0, 0.5, 0);
  g.applyMatrix4(new THREE.Matrix4().compose(p.at, p.rotation, p.size));
  return g;
}

/** True when a point in the object frame is inside the part. */
function insidePart(p: Part, local: THREE.Vector3): boolean {
  const u = local.clone().sub(p.at).applyQuaternion(p.rotation.clone().invert()).divide(p.size);
  u.y -= 0.5;
  const r2 = u.x * u.x + u.z * u.z;
  if (p.shape === 'box') return Math.abs(u.x) <= 0.5 && Math.abs(u.y) <= 0.5 && Math.abs(u.z) <= 0.5;
  if (p.shape === 'sphere') return r2 + u.y * u.y <= 0.25;
  if (Math.abs(u.y) > 0.5) return false;
  return p.shape === 'cylinder' ? r2 <= 0.25 : Math.sqrt(r2) <= (0.5 - u.y) / 2;
}

/** How deep a point of the object frame is in a part (metres; below 0 outside, about as far as the part). */
function partDepth(p: Part, local: THREE.Vector3): number {
  const u = local.clone().sub(p.at).applyQuaternion(p.rotation.clone().invert());
  u.y -= p.size.y / 2;
  const h = p.size.clone().multiplyScalar(0.5);
  if (p.shape === 'box') {
    const d = new THREE.Vector3(h.x - Math.abs(u.x), h.y - Math.abs(u.y), h.z - Math.abs(u.z));
    if (d.x > 0 && d.y > 0 && d.z > 0) return Math.min(d.x, d.y, d.z);
    return -new THREE.Vector3(Math.max(0, -d.x), Math.max(0, -d.y), Math.max(0, -d.z)).length();
  }
  // A round shape: how far in, as a fraction of its half sizes, times the least half size.
  const radial = Math.hypot(u.x / h.x, u.z / h.z);
  const m = p.shape === 'sphere' ? Math.hypot(radial, u.y / h.y)
    : Math.max(p.shape === 'cone' ? radial / Math.max(1e-6, 0.5 - u.y / p.size.y) : radial, Math.abs(u.y) / h.y);
  return (1 - m) * Math.min(h.x, h.y, h.z);
}

/** How deep a point of the object frame is in the object as a world change has moved it now (metres; below 0 outside). */
export function propDepth(prop: Prop, local: THREE.Vector3): number {
  let most = -Infinity;
  for (const part of prop.changed ?? prop.parts) most = Math.max(most, partDepth(part, local));
  return most;
}

/** The part of an object (unmoved by a change) whose surface is nearest a point of the object frame. */
export function nearestPart(prop: Prop, local: THREE.Vector3): Part {
  let best = prop.parts[0]!;
  for (const q of prop.parts) if (Math.abs(partDepth(q, local)) < Math.abs(partDepth(best, local))) best = q;
  return best;
}

/** Points on the skin of an object's parts (not inside another part) with their outward normals, in the object frame, unmoved by a change. */
export function surfaceSamples(prop: Prop): { p: THREE.Vector3; n: THREE.Vector3; margin: number }[] {
  const out: { p: THREE.Vector3; n: THREE.Vector3; margin: number }[] = [];
  const probe = new THREE.Vector3();
  const add = (p: THREE.Vector3, n: THREE.Vector3, margin = Infinity): void => {
    probe.copy(p).addScaledVector(n, 0.001);
    if (!prop.parts.some((q) => insidePart(q, probe))) out.push({ p, n, margin });
  };
  const STEPS = 12;
  for (const part of prop.parts) {
    if (part.shape !== 'box') {
      const g = partGeometry(part);
      const pos = g.getAttribute('position');
      const nor = g.getAttribute('normal');
      for (let i = 0; i < pos.count; i += 1) add(new THREE.Vector3().fromBufferAttribute(pos, i), new THREE.Vector3().fromBufferAttribute(nor, i).normalize());
      g.dispose();
      continue;
    }
    // A box: a grid on each face (its eight corners alone say nothing of a face).
    for (let axis = 0; axis < 3; axis += 1) for (const sign of [-1, 1]) {
      const n = new THREE.Vector3().setComponent(axis, sign).applyQuaternion(part.rotation);
      const [a1, a2] = [0, 1, 2].filter((x) => x !== axis) as [number, number];
      for (let i = 0; i <= STEPS; i += 1) for (let j = 0; j <= STEPS; j += 1) {
        const u = new THREE.Vector3().setComponent(axis, sign * 0.5).setComponent(a1, i / STEPS - 0.5).setComponent(a2, j / STEPS - 0.5);
        u.y += 0.5;
        // How far the point is from the nearest edge of its face (a palm centred on an edge hangs half off).
        const margin = Math.min((0.5 - Math.abs(i / STEPS - 0.5)) * part.size.getComponent(a1), (0.5 - Math.abs(j / STEPS - 0.5)) * part.size.getComponent(a2));
        add(u.multiply(part.size).applyQuaternion(part.rotation).add(part.at), n.clone(), margin);
      }
    }
  }
  return out;
}

/** The step (metres) and the most depth the grip's thickness is read to, through the object. */
const GRIP_DEPTH_STEP = 0.002;
const GRIP_DEPTH_MAX = 0.4;

/**
 * A grip found on an object's surface (a `contact` with `fit: grip`), in the object frame. `toward` is a unit
 * direction to the hand's shoulder and `up` is the world's up, both in the object frame. The point is the surface
 * point that faces the shoulder most (the near side, on the line of reach). The axis (across the palm) is up made
 * square to the line of reach: the hand comes with the thumb up and the wrist straight, as
 * the authored grips of the regression pieces do (stone-sE: 0.4 mm, 4.7°).
 * The center is inside the object at half its thickness under the point, and that half thickness is the radius.
 */
export function surfaceGrip(prop: Prop, toward: THREE.Vector3, up: THREE.Vector3): { center: THREE.Vector3; axis: THREE.Vector3; radius: number } {
  let best: { p: THREE.Vector3; n: THREE.Vector3; score: number } | undefined;
  const over = up.clone().addScaledVector(toward, -up.dot(toward));
  if (over.length() < 1e-3) throw new Error(`object ${prop.id}: the hand is straight over it, so the grip has no direction`);
  over.normalize();
  const probe = new THREE.Vector3();
  for (const part of prop.parts) {
    const g = partGeometry(part);
    const pos = g.getAttribute('position');
    const nor = g.getAttribute('normal');
    for (let i = 0; i < pos.count; i += 1) {
      const p = new THREE.Vector3().fromBufferAttribute(pos, i);
      const n = new THREE.Vector3().fromBufferAttribute(nor, i).normalize();
      // Skin of the union only: a point a little out along its normal must be outside every part.
      probe.copy(p).addScaledVector(n, 0.001);
      if (prop.parts.some((q) => insidePart(q, probe))) continue;
      const score = n.dot(toward);
      if (!best || score > best.score) best = { p, n, score };
    }
    g.dispose();
  }
  if (!best) throw new Error(`object ${prop.id}: no surface to grip`);
  const { p, n } = best;
  let depth = 0;
  for (let s = GRIP_DEPTH_STEP; s <= GRIP_DEPTH_MAX; s += GRIP_DEPTH_STEP) {
    probe.copy(p).addScaledVector(n, -s);
    if (!prop.parts.some((q) => insidePart(q, probe))) break;
    depth = s;
  }
  const radius = Math.max(DEFAULT_GRIP_RADIUS, depth / 2);
  const axis = over.clone();
  return { center: p.clone().addScaledVector(n, -radius), axis: axis.normalize(), radius };
}

/** A point given in an object's frame, in the world, at its current pose. */
export const propWorld = (prop: Prop, local: THREE.Vector3, out = new THREE.Vector3()): THREE.Vector3 => out.copy(local).applyQuaternion(prop.quaternion).add(prop.position);
