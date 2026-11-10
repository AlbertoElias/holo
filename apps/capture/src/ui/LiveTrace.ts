import * as THREE from 'three';
import { pathExtent, STILL_EXTENT_METERS, type VrmHumanoidBone } from '@holoim/meaning';
import { markChromeTree } from '@holoim/xr-ui-core';

import type { VrHandSide } from '../types/contracts';
import { collectHumanoidBones } from '../recording/PointResolver';

// The live trace (PRD-023 v1): while the author traces, a thin ribbon behind
// each moving fingertip of the capture avatar, in the viewer's trace style.
// It is chrome (it hangs under the chrome root), so it is never recorded,
// exported or a pointing referent. Buffers are preallocated and grow by
// doubling; a step appends one point and rewrites two vertices at most, and
// the taper is a per-vertex time against a head-time uniform.

/** The viewer's trace hue (styleguide 1.1, 4), ribbon width and opacity. */
const TRACE_COLOR = '#7fe4ff';
const WIDTH_M = 0.008;
const OLDEST_WIDTH = 0.5;
const NEWEST_OPACITY = 0.95;
const OLDEST_OPACITY = 0.55;
const INITIAL_POINTS = 512;
const SIDES: readonly VrHandSide[] = ['left', 'right'];

const vertexShader = /* glsl */ `
  uniform float uHead;
  uniform float uWidth;
  uniform float uOldestWidth;
  attribute vec3 prev;
  attribute vec3 next;
  attribute float side;
  attribute float time;
  varying float vAge;
  void main() {
    vec3 p = (modelViewMatrix * vec4(position, 1.0)).xyz;
    vec3 a = (modelViewMatrix * vec4(prev, 1.0)).xyz;
    vec3 b = (modelViewMatrix * vec4(next, 1.0)).xyz;
    vec3 t = b - a;
    float len = length(t);
    t = len > 1e-6 ? t / len : vec3(1.0, 0.0, 0.0);
    vec3 n = cross(t, normalize(p));
    float nl = length(n);
    n = nl > 1e-5 ? n / nl : vec3(0.0, 1.0, 0.0);
    float age = clamp((uHead - time) / max(uHead, 1e-3), 0.0, 1.0);
    p += n * side * 0.5 * uWidth * mix(1.0, uOldestWidth, age);
    vAge = age;
    gl_Position = projectionMatrix * vec4(p, 1.0);
  }
`;

const fragmentShader = /* glsl */ `
  uniform vec3 uColor;
  uniform float uNewestOpacity;
  uniform float uOldestOpacity;
  varying float vAge;
  void main() {
    gl_FragColor = vec4(uColor, mix(uNewestOpacity, uOldestOpacity, vAge));
    #include <colorspace_fragment>
  }
`;

export interface LiveTraceHandProbe {
  /** Points appended since the trace began. */
  points: number;
  /** Drawn segments (a gap leaves none). */
  segments: number;
  /** The extent has passed the still threshold, so the ribbon shows. */
  drawn: boolean;
  /** Largest distance of any point from the newest, metres (stops growing once drawn). */
  extent: number;
}

export interface LiveTraceProbe {
  tracing: boolean;
  startSec: number | null;
  hands: Record<VrHandSide, LiveTraceHandProbe>;
}

/** What one step knows. */
export interface LiveTraceStep {
  /** When the open trace began (simulation seconds), or null when none is open. */
  startSec: number | null;
  elapsedSec: number;
  /** The capture avatar's root; its fingertips are followed. */
  avatarRoot: THREE.Object3D | null;
  /** Whether tracked hands, not controllers, drive this side now. */
  tracked: (side: VrHandSide) => boolean;
}

class Trail {
  readonly mesh: THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>;
  private capacity = 0;
  private count = 0;
  private segments = 0;
  private broken = true;
  private drawn = false;
  private extent = 0;
  /** Points as plain objects, for the extent rule, until the ribbon is drawn. */
  private measured: Array<{ x: number; y: number; z: number }> | null = [];

  constructor(name: string) {
    const material = new THREE.ShaderMaterial({
      vertexShader,
      fragmentShader,
      uniforms: {
        uHead: { value: 0 },
        uWidth: { value: WIDTH_M },
        uOldestWidth: { value: OLDEST_WIDTH },
        uColor: { value: new THREE.Color(TRACE_COLOR) },
        uNewestOpacity: { value: NEWEST_OPACITY },
        uOldestOpacity: { value: OLDEST_OPACITY }
      },
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      toneMapped: false
    });
    this.mesh = new THREE.Mesh(new THREE.BufferGeometry(), material);
    this.mesh.name = name;
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = false;
    this.mesh.renderOrder = 997;
    this.mesh.visible = false;
    this.mesh.raycast = () => {};
    this.allocate(INITIAL_POINTS);
  }

  /** A gap in tracking: the next point starts a new run. */
  breakLine(): void {
    this.broken = true;
  }

  /** `at` is local to the ribbon's parent; `time` is seconds since the trace began. */
  append(at: THREE.Vector3, time: number): void {
    if (this.count >= this.capacity) this.allocate(this.capacity * 2);
    const geometry = this.mesh.geometry;
    const position = geometry.getAttribute('position') as THREE.BufferAttribute;
    const prev = geometry.getAttribute('prev') as THREE.BufferAttribute;
    const next = geometry.getAttribute('next') as THREE.BufferAttribute;
    const side = geometry.getAttribute('side') as THREE.BufferAttribute;
    const timeAttr = geometry.getAttribute('time') as THREE.BufferAttribute;
    const index = geometry.getIndex()!;
    const i = this.count;
    const joined = !this.broken && i > 0;
    for (let k = 0; k < 2; k += 1) {
      const v = i * 2 + k;
      position.setXYZ(v, at.x, at.y, at.z);
      // A run's first point looks at itself; its tangent comes from the neighbour that arrives.
      prev.setXYZ(v, joined ? position.getX((i - 1) * 2) : at.x, joined ? position.getY((i - 1) * 2) : at.y, joined ? position.getZ((i - 1) * 2) : at.z);
      next.setXYZ(v, at.x, at.y, at.z);
      side.setX(v, k === 0 ? -1 : 1);
      timeAttr.setX(v, time);
    }
    let from = i * 2;
    if (joined) {
      // The previous point now has a successor: its direction improves.
      for (let k = 0; k < 2; k += 1) next.setXYZ((i - 1) * 2 + k, at.x, at.y, at.z);
      from = (i - 1) * 2;
      const a = (i - 1) * 2;
      const b = i * 2;
      const n = this.segments * 6;
      index.setX(n, a);
      index.setX(n + 1, a + 1);
      index.setX(n + 2, b);
      index.setX(n + 3, b);
      index.setX(n + 4, a + 1);
      index.setX(n + 5, b + 1);
      index.clearUpdateRanges();
      index.addUpdateRange(n, 6);
      index.needsUpdate = true;
      this.segments += 1;
      geometry.setDrawRange(0, this.segments * 6);
    }
    for (const attribute of [position, prev, next, side, timeAttr]) {
      attribute.clearUpdateRanges();
      attribute.addUpdateRange(from * attribute.itemSize, (i * 2 + 2 - from) * attribute.itemSize);
      attribute.needsUpdate = true;
    }
    this.count += 1;
    this.broken = false;
    this.mesh.material.uniforms.uHead!.value = time;
    if (this.measured) {
      this.measured.push({ x: at.x, y: at.y, z: at.z });
      this.extent = pathExtent(this.measured);
      if (this.extent > STILL_EXTENT_METERS) {
        this.drawn = true;
        this.measured = null;
      }
    }
    this.mesh.visible = this.drawn && this.segments > 0;
  }

  reset(): void {
    this.count = 0;
    this.segments = 0;
    this.broken = true;
    this.drawn = false;
    this.extent = 0;
    this.measured = [];
    this.mesh.visible = false;
    this.mesh.geometry.setDrawRange(0, 0);
    this.mesh.material.uniforms.uHead!.value = 0;
  }

  probe(): LiveTraceHandProbe {
    return { points: this.count, segments: this.segments, drawn: this.drawn, extent: Math.round(this.extent * 10000) / 10000 };
  }

  isDrawn(): boolean {
    return this.drawn;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
  }

  private allocate(points: number): void {
    const old = this.mesh.geometry;
    const geometry = new THREE.BufferGeometry();
    const copy = (name: string, size: number, used: number): void => {
      const fresh = new Float32Array(points * 2 * size);
      const source = old.getAttribute(name) as THREE.BufferAttribute | undefined;
      if (source) fresh.set((source.array as Float32Array).subarray(0, used * 2 * size));
      geometry.setAttribute(name, new THREE.BufferAttribute(fresh, size));
    };
    for (const [name, size] of [['position', 3], ['prev', 3], ['next', 3], ['side', 1], ['time', 1]] as const) copy(name, size, this.count);
    const indices = new Uint32Array(points * 6);
    const oldIndex = old.getIndex();
    if (oldIndex) indices.set((oldIndex.array as Uint32Array).subarray(0, this.segments * 6));
    geometry.setIndex(new THREE.BufferAttribute(indices, 1));
    geometry.setDrawRange(0, this.segments * 6);
    this.mesh.geometry = geometry;
    old.dispose();
    this.capacity = points;
  }
}

/**
 * One ribbon per hand behind the avatar's index fingertip, the point the
 * export anchors a trace to (`<side>IndexDistal`, its end site when the rig
 * has one, else the hand). A trace's start identifies it: a different start,
 * or none, clears both ribbons.
 */
export class LiveTrace {
  readonly group = new THREE.Group();
  private readonly trails: Record<VrHandSide, Trail>;
  private readonly bones = new Map<VrmHumanoidBone, THREE.Bone>();
  private bonesRoot: THREE.Object3D | null = null;
  private startSec: number | null = null;
  private readonly tmp = new THREE.Vector3();

  constructor() {
    this.group.name = 'live-trace';
    this.trails = { left: new Trail('live-trace-left'), right: new Trail('live-trace-right') };
    for (const side of SIDES) this.group.add(this.trails[side].mesh);
    markChromeTree(this.group);
  }

  update(step: LiveTraceStep): void {
    if (step.startSec === null || !step.avatarRoot) {
      this.clear();
      return;
    }
    if (this.startSec !== step.startSec) {
      this.clear();
      this.startSec = step.startSec;
    }
    if (this.bonesRoot !== step.avatarRoot) {
      this.bonesRoot = step.avatarRoot;
      collectHumanoidBones(step.avatarRoot, this.bones);
    }
    this.group.updateWorldMatrix(true, false);
    for (const side of SIDES) {
      const trail = this.trails[side];
      const bone = this.bones.get(`${side}IndexDistal`) ?? this.bones.get(`${side}Hand`);
      if (!bone || !step.tracked(side)) {
        trail.breakLine();
        continue;
      }
      bone.getWorldPosition(this.tmp);
      this.group.worldToLocal(this.tmp);
      trail.append(this.tmp, Math.max(0, step.elapsedSec - step.startSec));
    }
  }

  /** Whether any hand has drawn: the trace has something to keep. */
  anyDrawn(): boolean {
    return SIDES.some((side) => this.trails[side].isDrawn());
  }

  clear(): void {
    if (this.startSec === null && !this.anyPoints()) return;
    this.startSec = null;
    for (const side of SIDES) this.trails[side].reset();
  }

  probe(): LiveTraceProbe {
    return { tracing: this.startSec !== null, startSec: this.startSec, hands: { left: this.trails.left.probe(), right: this.trails.right.probe() } };
  }

  dispose(): void {
    for (const side of SIDES) this.trails[side].dispose();
  }

  private anyPoints(): boolean {
    return SIDES.some((side) => this.trails[side].probe().points > 0);
  }
}
