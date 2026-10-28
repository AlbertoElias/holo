import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';

import type { HumanoidBoneRef } from '../src/avatar/HumanoidSkeleton';
import type { SceneObject } from '../src/objects/SceneObjectRegistry';
import { ObjectPhysics } from '../src/physics/ObjectPhysics';

// The prop world's frame cost, in Node with capture's own ObjectPhysics: a
// 12,800-triangle trimesh and four 128-vertex hulls dropped into a pile, with
// and without the avatar's 14 parts walking through the pile and swinging its
// arms. Reports median and p95 of one frame's `ObjectPhysics.step` (avatar
// sync, overlap tests and the substepped world.step) over 240 frames after
// the first, which builds the acceleration structure. Report only: the
// Quest's frame cost is a device check. Writes output/bench-object-physics.json.

const FRAMES = 240;
const DT = 1 / 60;
const GRID = 80;

function terrain(): { vertices: Float32Array; indices: Uint32Array } {
  const vertices: number[] = [];
  const indices: number[] = [];
  for (let z = 0; z <= GRID; z += 1) {
    for (let x = 0; x <= GRID; x += 1) {
      const wx = (x / GRID - 0.5) * 16;
      const wz = (z / GRID - 0.5) * 16;
      vertices.push(wx, 0.02 * Math.sin(wx * 2) * Math.cos(wz * 2), wz);
    }
  }
  for (let z = 0; z < GRID; z += 1) {
    for (let x = 0; x < GRID; x += 1) {
      const i = z * (GRID + 1) + x;
      indices.push(i, i + GRID + 1, i + 1, i + 1, i + GRID + 1, i + GRID + 2);
    }
  }
  return { vertices: new Float32Array(vertices), indices: new Uint32Array(indices) };
}

function prop(i: number): SceneObject {
  const wrapper = new THREE.Group();
  // 128 vertices on a sphere of 9 cm, slightly squashed so the hull isn't a ball.
  const points: number[] = [];
  const golden = Math.PI * (3 - Math.sqrt(5));
  for (let k = 0; k < 128; k += 1) {
    const y = 1 - (2 * (k + 0.5)) / 128;
    const r = Math.sqrt(1 - y * y);
    points.push(Math.cos(golden * k) * r * 0.09, y * 0.06, Math.sin(golden * k) * r * 0.09);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(points, 3));
  const model = new THREE.Mesh(geometry);
  wrapper.add(model);
  wrapper.position.set(0.1 * (i % 2), 0.4 + 0.2 * i, -0.6 + 0.08 * i);
  wrapper.updateMatrixWorld(true);
  return { id: `p${i}`, name: `p${i}`, source: 'bench', origin: 'bench', layer: 'event', wrapper, model, placed: true, heldBy: null } as unknown as SceneObject;
}

/** A 1.75 m stick figure: a bone per joint, walking forward with swinging arms. */
class Walker {
  readonly root = new THREE.Group();
  readonly avatarHeight = 1.75;
  private readonly joints = new Map<string, THREE.Object3D>();

  constructor() {
    const at = (name: string, x: number, y: number, z = 0): void => {
      const node = new THREE.Object3D();
      node.position.set(x, y, z);
      this.root.add(node);
      this.joints.set(name, node);
    };
    at('hips', 0, 0.95);
    at('neck', 0, 1.45);
    at('head', 0, 1.55);
    at('headTip', 0, 1.75);
    for (const [side, sx] of [['left', 1], ['right', -1]] as const) {
      at(`${side}UpperArm`, 0.18 * sx, 1.42);
      at(`${side}LowerArm`, 0.2 * sx, 1.14);
      at(`${side}Hand`, 0.21 * sx, 0.88);
      at(`${side}MiddleProximal`, 0.21 * sx, 0.8);
      at(`${side}UpperLeg`, 0.09 * sx, 0.92);
      at(`${side}LowerLeg`, 0.09 * sx, 0.5);
      at(`${side}Foot`, 0.09 * sx, 0.08);
      at(`${side}Toes`, 0.09 * sx, 0.02, -0.14);
    }
  }

  bone(ref: HumanoidBoneRef): THREE.Object3D | undefined {
    return this.joints.get(ref);
  }

  /** Walks along -z through the pile and back at 1.4 m/s, the arms swinging ±0.4 m. */
  pose(t: number): void {
    const z = 1.5 - 1.4 * ((t % 4) < 2 ? t % 4 : 4 - (t % 4));
    this.root.position.set(0, 0, z);
    const swing = 0.4 * Math.sin(t * 2 * Math.PI);
    for (const [side, sign] of [['left', 1], ['right', -1]] as const) {
      this.joints.get(`${side}LowerArm`)!.position.z = -0.5 * swing * sign;
      this.joints.get(`${side}Hand`)!.position.z = -swing * sign;
      this.joints.get(`${side}MiddleProximal`)!.position.z = -swing * sign - 0.03;
    }
    this.root.updateMatrixWorld(true);
  }
}

async function run(withAvatar: boolean): Promise<{ medianMs: number; p95Ms: number; maxMs: number; asleep: number; shovedM: number; knockdowns: number; avatarParts: number }> {
  const physics = new ObjectPhysics(terrain(), -9.81);
  const walker = new Walker();
  if (withAvatar) physics.setAvatar(walker);
  const props = [0, 1, 2, 3].map(prop);
  for (const p of props) {
    physics.ensure(p);
    physics.release(p, false);
  }
  const write = (object: SceneObject, world: THREE.Matrix4): void => {
    world.decompose(object.wrapper.position, object.wrapper.quaternion, object.wrapper.scale);
    object.wrapper.updateMatrixWorld(true);
  };
  const times: number[] = [];
  // Where each prop came to rest in the pile, before the avatar reaches it (frame 60).
  let start: THREE.Vector3[] = [];
  for (let frame = 0; frame <= FRAMES; frame += 1) {
    walker.pose(frame * DT);
    const started = performance.now();
    physics.step(props, DT, write);
    if (frame > 0) times.push(performance.now() - started);
    if (frame === 45) start = props.map((p) => p.wrapper.position.clone());
  }
  times.sort((a, b) => a - b);
  const stats = physics.stats();
  const asleep = props.filter((p) => physics.bodyState(p).state === 'asleep').length;
  const shovedM = round(Math.max(...props.map((p, i) => p.wrapper.position.distanceTo(start[i]!))));
  return {
    medianMs: round(times[Math.floor(times.length / 2)] ?? 0),
    p95Ms: round(times[Math.floor(times.length * 0.95)] ?? 0),
    maxMs: round(times.at(-1) ?? 0),
    asleep,
    shovedM,
    knockdowns: stats.knockdowns,
    avatarParts: stats.avatarParts
  };
}

const round = (value: number): number => Number(value.toFixed(3));

await RAPIER.init();
// A warm-up pass so both runs see a compiled wasm module.
await run(true);
const baseline = await run(false);
const avatar = await run(true);
const report = { frames: FRAMES, triangles: GRID * GRID * 2, props: 4, baseline, avatar };
const out = path.resolve('output/bench-object-physics.json');
await mkdir(path.dirname(out), { recursive: true });
await writeFile(out, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
