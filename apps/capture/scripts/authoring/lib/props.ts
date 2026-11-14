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
  readonly grip?: { readonly center: THREE.Vector3; readonly axis: THREE.Vector3; readonly radius: number };
  readonly tool?: { readonly tip: THREE.Vector3; readonly axis: THREE.Vector3 };
  /** Half the smaller of its width and depth: how far a holding hand hangs out from the thigh. */
  readonly halfWidth: number;
  /** Where it is now (world). */
  readonly position: THREE.Vector3;
  readonly quaternion: THREE.Quaternion;
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

/** A point given in an object's frame, in the world, at its current pose. */
export const propWorld = (prop: Prop, local: THREE.Vector3, out = new THREE.Vector3()): THREE.Vector3 => out.copy(local).applyQuaternion(prop.quaternion).add(prop.position);
