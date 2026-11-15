/**
 * Measures, landmarks and places: how a sheet says "a step in front of her,
 * at her hanging hand's height" instead of stage metres. Measures and
 * landmarks are read once from each performer's solved rest pose (not the
 * bind pose, where a T-posed hand sits at shoulder height).
 */
import * as THREE from 'three';
import type { VrmHumanoidBone } from '@holoim/meaning';

import type { LoadedAvatar } from './avatar.ts';
import type { Measure, Place } from './beats.ts';

export const MEASURES = ['step', 'arm', 'hand-length', 'stature'] as const;
export const LANDMARKS = ['knee', 'hip', 'waist', 'elbow', 'chest', 'shoulder', 'hanging-hand', 'chin', 'eye', 'crown'] as const;
export type MeasureName = (typeof MEASURES)[number];
export type LandmarkName = (typeof LANDMARKS)[number];

/** A step as a share of stature: about a comfortable pace. */
const STEP_SHARE = 0.35;
/** The palm's offset from the wrist, added to the arm (as `direct.ts` reaches). */
const PALM_OFFSET = 0.07;

export interface Body {
  readonly measures: Readonly<Record<MeasureName, number>>;
  /** Heights above the floor at rest. */
  readonly landmarks: Readonly<Record<LandmarkName, number>>;
}

export interface ParsedMeasure {
  readonly factor: number;
  readonly performer?: string;
  readonly name: MeasureName | LandmarkName;
}

const MEASURE_RE = /^\s*(-?(?:\d+\.?\d*|\.\d+))?\s*(?:([A-Za-z0-9_-]+):)?([a-z-]+)\s*$/;

/** Metres, a parsed measure, or undefined when the text names nothing. */
export function parseMeasure(m: Measure): number | ParsedMeasure | undefined {
  if (typeof m === 'number') return Number.isFinite(m) ? m : undefined;
  const hit = MEASURE_RE.exec(m);
  if (!hit) return undefined;
  const name = hit[3] as MeasureName | LandmarkName;
  if (!(MEASURES as readonly string[]).includes(name) && !(LANDMARKS as readonly string[]).includes(name)) return undefined;
  return { factor: hit[1] === undefined ? 1 : Number(hit[1]), ...(hit[2] ? { performer: hit[2] } : {}), name };
}

/** The problem with a measure, for validation; `performers` are the ids a `q:` prefix may name. */
export function measureProblem(m: Measure | undefined, performers: ReadonlySet<string>): string | undefined {
  if (m === undefined) return undefined;
  const p = parseMeasure(m);
  if (p === undefined) return `"${String(m)}" is not metres or a measure (${[...MEASURES, ...LANDMARKS].join(', ')}, with an optional factor and "<performer>:")`;
  if (typeof p !== 'number' && p.performer && !performers.has(p.performer)) return `"${String(m)}": no performer ${p.performer}`;
  return undefined;
}

export function resolveMeasure(m: Measure, bodies: ReadonlyMap<string, Body>, performer: string): number {
  const p = parseMeasure(m);
  if (p === undefined) throw new Error(`not a measure: ${String(m)}`);
  if (typeof p === 'number') return p;
  const body = bodies.get(p.performer ?? performer);
  if (!body) throw new Error(`no performer ${p.performer ?? performer} for "${String(m)}"`);
  const base = (MEASURES as readonly string[]).includes(p.name) ? body.measures[p.name as MeasureName] : body.landmarks[p.name as LandmarkName];
  return p.factor * base;
}

/** Reads a performer's measures and landmarks; the avatar must be posed at rest (stood, arms hanging). */
export function measureBody(a: LoadedAvatar): Body {
  a.frame.updateMatrixWorld(true);
  const floor = a.frame.getWorldPosition(new THREE.Vector3()).y;
  const y = (...names: VrmHumanoidBone[]): number | undefined => {
    const ys = names.map((n) => a.humanoid.bone(n)).filter((b): b is THREE.Bone => !!b).map((b) => b.getWorldPosition(new THREE.Vector3()).y - floor);
    return ys.length ? ys.reduce((s, v) => s + v, 0) / ys.length : undefined;
  };
  const stature = a.height;
  const head = y('head')!;
  const palms = (['left', 'right'] as const).map((s) => a.hands[s]?.palmCenter(new THREE.Vector3()).y ?? a.arms[s].hand.getWorldPosition(new THREE.Vector3()).y).map((v) => v - floor);
  const arm = a.arms.left;
  return {
    measures: {
      step: STEP_SHARE * stature,
      arm: arm.upperLength + arm.lowerLength + PALM_OFFSET,
      'hand-length': a.hands.left?.length ?? a.hands.right?.length ?? 0.18,
      stature
    },
    landmarks: {
      knee: y('leftLowerLeg', 'rightLowerLeg')!,
      hip: y('leftUpperLeg', 'rightUpperLeg')!,
      waist: y('spine')!,
      elbow: y('leftLowerArm', 'rightLowerArm')!,
      chest: y('chest') ?? y('spine')!,
      shoulder: y('leftUpperArm', 'rightUpperArm')!,
      'hanging-hand': (palms[0]! + palms[1]!) / 2,
      chin: head,
      eye: y('leftEye', 'rightEye') ?? head + 0.45 * (stature - head),
      crown: stature
    }
  };
}

/** A frame places are measured in: an origin on (or above) the floor and a yaw. */
export interface PlaceFrame {
  readonly origin: THREE.Vector3;
  /** Degrees about +Y; 0 faces +Z. */
  readonly yaw: number;
}

/** A place in stage metres: forward is the frame's +Z, right its −X; `height` above the floor, or `up` from the origin. */
export function resolvePlace(p: Place, frame: PlaceFrame, bodies: ReadonlyMap<string, Body>, performer: string): THREE.Vector3 {
  const m = (v: Measure | undefined): number => (v === undefined ? 0 : resolveMeasure(v, bodies, performer));
  const local = new THREE.Vector3(-m(p.right), 0, m(p.forward)).applyAxisAngle(new THREE.Vector3(0, 1, 0), (frame.yaw * Math.PI) / 180);
  const out = frame.origin.clone().add(local);
  out.y = p.height !== undefined ? m(p.height) : frame.origin.y + m(p.up);
  return out;
}

export function placeProblem(p: Place, ids: { performers: ReadonlySet<string>; objects: ReadonlySet<string> }): string | undefined {
  if (p.of !== undefined && !ids.performers.has(p.of) && !ids.objects.has(p.of)) return `place of "${p.of}": no performer or object`;
  if (p.height !== undefined && p.up !== undefined) return 'a place takes height (above the floor) or up (from its origin), not both';
  for (const k of ['forward', 'right', 'up', 'height'] as const) {
    const problem = measureProblem(p[k], ids.performers);
    if (problem) return `${k}: ${problem}`;
  }
  return undefined;
}

export const isPlace = (p: unknown): p is Place => typeof p === 'object' && p !== null && !Array.isArray(p);
