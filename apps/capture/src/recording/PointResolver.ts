import * as THREE from 'three';
import * as SkeletonUtils from 'three/examples/jsm/utils/SkeletonUtils.js';
import { type MeaningMotionSpan, type MeaningLinkProvenance, type MeaningSpan, resolveHumanoidBone, type VrmHumanoidBone } from '@holoim/meaning';

import { HOLD_DELAY_MS } from '@holoim/xr-ui-core';

import { humanoidTagOf } from '../avatar/HumanoidSkeleton';
import { isThreeBone, isThreeMesh } from '../shared/threeTypeGuards';
import type { RecordingFrame, VrHandSide } from '../types/contracts';
import type { AimHold, AimInput, AimPointSample, HandPointSample, PointSampleStore } from './PointSampleStore';
import { POINT_DWELL_SEC, type PoseSegment, type ReferentRun, type ReferentSample, segmentPoses, splitByReferent } from './pointSegments';

/** A link whose nodes are still objects; `GLTFMeaningPlugin` swaps them for node indices. */
export interface MeaningLinkDraft {
  /** A performer's bone, or the author's camera node (a camera take). */
  from: { bone: VrmHumanoidBone; object: THREE.Object3D } | { camera: true; object: THREE.Object3D };
  to: { object: THREE.Object3D; bone?: VrmHumanoidBone; point: [number, number, number]; radius?: number };
  span: MeaningSpan;
  provenance: MeaningLinkProvenance;
}

export interface MeaningDraft {
  marks: MeaningLinkDraft[];
  spans: MeaningMotionSpan[];
}

/** What resolution decided, in take seconds, for checks and debugging. */
export interface PointResolutionReport {
  poseSegments: Array<{ side: VrHandSide; start: number; end: number; samples: number }>;
  aimHolds: Array<{ side: VrHandSide; input: AimInput; start: number; end: number; samples: number }>;
  runs: Array<{
    source: 'hand' | 'aim';
    /** For held marks: what held it. */
    input?: AimInput;
    side: VrHandSide;
    start: number;
    end: number;
    referent: string | null;
    agreement: number;
    confidence?: number;
    linked: boolean;
    reason?: string;
  }>;
}

export interface PointResolutionInput {
  frames: readonly RecordingFrame[];
  store: PointSampleStore;
  /** The live avatar the frames were recorded from; cloned and posed per frame for capsules. */
  avatar: THREE.Object3D;
  /** The avatar clone being exported: `from` and body `to` anchors point at its bones. */
  exportAvatar: THREE.Object3D;
  /** Clipped bubble meshes as exported, in world space; empty when the take has no world model. */
  sceneMeshes: readonly THREE.Mesh[];
}

/** What a camera take's holds resolve against (docs/features/archive/ar-recording.md), all in the take's exported scene. */
export interface CameraResolutionInput {
  store: PointSampleStore;
  /** The take's first and last camera sample, in the store's seconds. */
  startSec: number;
  endSec: number;
  /** `RecordedAuthorCamera`: the `from` of every link. */
  camera: THREE.Object3D;
  /** The clipped set's meshes as exported. */
  sceneMeshes: readonly THREE.Mesh[];
  /** The exported `RecordedObject` wrappers; a hit on any mesh below one names the wrapper. */
  objects: readonly THREE.Object3D[];
}

/** Links at or above this confidence are written; below it nothing lights up. */
export const POINT_MIN_CONFIDENCE = 0.5;
/** Angular tolerance around the ray when choosing the referent. */
export const POINT_ANGULAR_TOLERANCE_DEG = 3.5;
const CONE_RINGS: ReadonlyArray<{ angleDeg: number; rays: number; quality: number }> = [
  { angleDeg: 0, rays: 1, quality: 1 },
  { angleDeg: 1.5, rays: 6, quality: 0.9 },
  { angleDeg: POINT_ANGULAR_TOLERANCE_DEG, rays: 8, quality: 0.75 }
];
const MAX_RAY_DISTANCE = 12;
// Rays start a little past the fingertip so the tip's own capsule margin never counts.
const RAY_NEAR = 0.01;
/** Undivided geometry this large (floor, walls) gets a `radius` around the hit. */
const LARGE_SURFACE_RADIUS = 1.5;
const LARGE_SURFACE_HIGHLIGHT_RADIUS = 0.15;
const MAX_RESOLVE_RATE_HZ = 20;
/** A hold shorter than this is a tap, not a point; it neither links nor suppresses. */
const MIN_HOLD_SEC = 0.2;
/**
 * A held mark's span reaches this far either side when it overrides inferred
 * links: the holding pinch's onset and release can themselves score as a point.
 */
const HELD_OVERRIDE_PAD_SEC = 0.25;
/** A touch becomes a hold only after the hold delay, inside the slop: the finger was on the referent from touchdown. */
const TOUCH_HOLD_DELAY_SEC = HOLD_DELAY_MS / 1000;
/** Holds made in a headset point with a tracked hand or ray and can land on the body, as inferred points do. */
const BODY_HOLD_INPUTS: ReadonlySet<AimInput> = new Set(['hands', 'controllers']);

interface CapsuleSpec {
  bone: VrmHumanoidBone;
  start: VrmHumanoidBone;
  end: VrmHumanoidBone;
  radius: number;
  /** Excluded when this side points: its own arm and hand. */
  side?: VrHandSide;
}

// Body capsules between humanoid joints, each labelled with the bone it
// belongs to. A hand capsule runs to the middle fingertip so fingers resolve
// to the hand bone.
const CAPSULES: readonly CapsuleSpec[] = [
  { bone: 'hips', start: 'hips', end: 'spine', radius: 0.14 },
  { bone: 'spine', start: 'spine', end: 'chest', radius: 0.14 },
  { bone: 'chest', start: 'chest', end: 'upperChest', radius: 0.15 },
  { bone: 'upperChest', start: 'upperChest', end: 'neck', radius: 0.15 },
  { bone: 'neck', start: 'neck', end: 'head', radius: 0.06 },
  ...(['left', 'right'] as const).flatMap((side): CapsuleSpec[] => [
    { bone: `${side}UpperArm`, start: `${side}UpperArm`, end: `${side}LowerArm`, radius: 0.055, side },
    { bone: `${side}LowerArm`, start: `${side}LowerArm`, end: `${side}Hand`, radius: 0.045, side },
    { bone: `${side}Hand`, start: `${side}Hand`, end: `${side}MiddleDistal`, radius: 0.045, side },
    { bone: `${side}UpperLeg`, start: `${side}UpperLeg`, end: `${side}LowerLeg`, radius: 0.08 },
    { bone: `${side}LowerLeg`, start: `${side}LowerLeg`, end: `${side}Foot`, radius: 0.06 },
    { bone: `${side}Foot`, start: `${side}Foot`, end: `${side}Toes`, radius: 0.05 }
  ])
];
const HEAD_RADIUS = 0.11;
const HEAD_CENTER_ABOVE_JOINT = 0.09;

interface Capsule {
  bone: VrmHumanoidBone;
  a: THREE.Vector3;
  b: THREE.Vector3;
  radius: number;
}

interface Target {
  key: string;
  /** Exported node the hit point is local to. */
  object: THREE.Object3D;
  bone?: VrmHumanoidBone;
  large: boolean;
}

interface Resolved extends ReferentSample {
  target?: Target;
  /** Hit point local to the target's node at this frame. */
  localPoint?: THREE.Vector3;
  quality: number;
  score: number;
}

/**
 * Turns a take's point evidence into `HOLOIM_meaning` drafts: headset hand
 * samples are segmented, cast per frame against the clipped bubble meshes
 * and the avatar's body capsules (never the pointing arm), split where the
 * referent changes, and kept above POINT_MIN_CONFIDENCE as `inferred` links;
 * held marks (aim holds) become `recorded` links, cast against the scene
 * (desktop and phone) or the scene and the body (headset), and an inferred
 * link whose span overlaps a hold's span is dropped: the held mark says what
 * was meant there. Inferred motion runs become motion spans. Times are take
 * seconds (from the first frame), clamped to the take.
 */
export class PointResolver {
  private readonly raycaster = new THREE.Raycaster();
  private readonly posedBones = new Map<VrmHumanoidBone, THREE.Bone>();
  private readonly exportBones = new Map<VrmHumanoidBone, THREE.Bone>();
  private posedAvatar: THREE.Object3D | undefined;
  private posedBoneList: THREE.Bone[] = [];
  private posedFrameIndex = -1;
  private sceneTargets = new Map<THREE.Object3D, Target>();
  private readonly tmpDirection = new THREE.Vector3();
  private readonly tmpBasisU = new THREE.Vector3();
  private readonly tmpBasisV = new THREE.Vector3();
  private readonly tmpPoint = new THREE.Vector3();
  private readonly tmpMatrix = new THREE.Matrix4();

  resolve(input: PointResolutionInput): { draft: MeaningDraft; report: PointResolutionReport } {
    const report: PointResolutionReport = { poseSegments: [], aimHolds: [], runs: [] };
    const draft: MeaningDraft = { marks: [], spans: [] };
    const { frames, store } = input;
    if (frames.length === 0 || !store.hasSamples()) return { draft, report };

    const t0 = frames[0]!.timeSec;
    const toSpan = spanWithin(t0, frames.at(-1)!.timeSec);

    collectHumanoidBones(input.exportAvatar, this.exportBones);
    // Chrome is never a referent: the scene sampler leaves it out, and these
    // meshes are its clipped copies (GltfExportComposer), so none is chrome.
    this.sceneTargets = new Map(input.sceneMeshes.map((mesh) => [mesh, sceneTarget(mesh)]));
    this.raycaster.near = RAY_NEAR;
    this.raycaster.far = MAX_RAY_DISTANCE;

    // Every hold long enough to count, in take seconds, whether or not it lands on anything.
    const holds = store.getAimHolds()
      .map((hold) => ({ hold, start: holdStart(hold), end: hold.endSec ?? hold.samples.at(-1)!.timeSec }))
      .filter(({ start, end }) => end - start >= MIN_HOLD_SEC);
    const heldSpans = holds.map(({ start, end }) => ({ start: start - t0 - HELD_OVERRIDE_PAD_SEC, end: end - t0 + HELD_OVERRIDE_PAD_SEC }));

    try {
      const handSamples = store.getHandSamples();
      for (const side of ['left', 'right'] as const) {
        const samples = handSamples.filter((sample) => sample.side === side);
        for (const segment of segmentPoses(samples)) {
          report.poseSegments.push({ side, start: round(segment.startSec - t0), end: round(segment.endSec - t0), samples: segment.samples.length });
          this.resolveHandSegment(input, side, segment, toSpan, heldSpans, draft, report);
        }
      }

      for (const hold of store.getAimHolds()) {
        const start = holdStart(hold);
        const end = hold.endSec ?? hold.samples.at(-1)!.timeSec;
        report.aimHolds.push({ side: hold.side, input: hold.input, start: round(start - t0), end: round(end - t0), samples: hold.samples.length });
      }
      for (const { hold, start, end } of holds) this.resolveAimHold(input, hold, start, end, toSpan, draft, report);

      for (const run of store.getInferredMotionRuns()) {
        draft.spans.push({ kind: 'motion', bones: [...run.bones], span: toSpan(run.startSec, run.endSec), provenance: { value: 'inferred' } });
      }
    } finally {
      this.posedAvatar = undefined;
      this.posedBoneList = [];
      this.posedFrameIndex = -1;
      this.posedBones.clear();
    }

    draft.marks.sort((a, b) => a.span.start - b.span.start);
    draft.spans.sort((a, b) => a.span.start - b.span.start);
    return { draft, report };
  }

  /**
   * Resolves a camera take's holds: each `screen` hold is cast against the
   * set's meshes and the event objects, never the bubble sphere, the hidden
   * avatar or chrome (none is a target), and becomes a `recorded` link from
   * the camera node. A hold that hits nothing makes no link and the report
   * says "no referent". Times are take seconds from the first camera sample.
   */
  resolveCamera(input: CameraResolutionInput): { draft: MeaningDraft; report: PointResolutionReport } {
    const report: PointResolutionReport = { poseSegments: [], aimHolds: [], runs: [] };
    const draft: MeaningDraft = { marks: [], spans: [] };
    const toSpan = spanWithin(input.startSec, input.endSec);
    const t0 = input.startSec;
    const screenHolds = input.store.getAimHolds().filter((hold) => hold.input === 'screen');
    if (screenHolds.length === 0) return { draft, report };

    this.sceneTargets = new Map(input.sceneMeshes.map((mesh) => [mesh, sceneTarget(mesh)]));
    for (const wrapper of input.objects) {
      const target = objectTarget(wrapper);
      wrapper.traverse((obj) => {
        if (isThreeMesh(obj)) this.sceneTargets.set(obj, target);
      });
    }
    this.raycaster.near = RAY_NEAR;
    this.raycaster.far = MAX_RAY_DISTANCE;
    const from = { camera: true as const, object: input.camera };
    for (const hold of screenHolds) {
      const start = holdStart(hold);
      const end = hold.endSec ?? hold.samples.at(-1)!.timeSec;
      report.aimHolds.push({ side: hold.side, input: hold.input, start: round(start - t0), end: round(end - t0), samples: hold.samples.length });
      if (end - start < MIN_HOLD_SEC) continue;
      this.resolveHeld(hold, start, end, from, () => [], toSpan, draft, report);
    }
    this.sceneTargets = new Map();
    draft.marks.sort((a, b) => a.span.start - b.span.start);
    return { draft, report };
  }

  private resolveHandSegment(
    input: PointResolutionInput,
    side: VrHandSide,
    segment: PoseSegment,
    toSpan: (start: number, end: number) => MeaningSpan,
    heldSpans: readonly MeaningSpan[],
    draft: MeaningDraft,
    report: PointResolutionReport
  ): void {
    const from = this.fromAnchor(side);
    const resolved: Resolved[] = [];
    for (const sample of throttle(segment.samples)) {
      const frameIndex = nearestFrameIndex(input.frames, sample.timeSec);
      const capsules = this.poseCapsules(input, frameIndex, side);
      resolved.push({ ...this.cast(sample, capsules), score: sample.score });
    }

    const runs = splitByReferent(resolved);
    runs.forEach((run, i) => {
      const start = i === 0 ? segment.startSec : resolved[run.first]!.timeSec;
      const end = i === runs.length - 1 ? segment.endSec : resolved[run.last]!.timeSec;
      const majority = resolved.slice(run.first, run.last + 1).filter((r) => r.key === run.key);
      const meanScore = mean(resolved.slice(run.first, run.last + 1).map((r) => r.score));
      const meanQuality = mean(majority.map((r) => r.quality));
      const confidence = round(run.agreement * meanScore * meanQuality);
      const span = toSpan(start, end);
      const entry = { source: 'hand' as const, side, start: span.start, end: span.end, referent: run.key, agreement: round(run.agreement), confidence };
      const reason = rejectReason(run, end - start, from, confidence);
      if (reason) {
        report.runs.push({ ...entry, linked: false, reason });
        return;
      }
      // A held mark says what was meant over its span: the inferred link keeps only what lies outside it.
      const kept = subtractSpans(span, heldSpans).filter((piece) => piece.end - piece.start >= POINT_DWELL_SEC);
      if (kept.length === 0) {
        report.runs.push({ ...entry, linked: false, reason: 'suppressed by hold' });
        return;
      }
      for (const piece of kept) {
        draft.marks.push(this.link(from!, majority, { start: round(piece.start), end: round(piece.end) }, { value: 'inferred', confidence: Math.max(confidence, 0.001) }));
      }
      report.runs.push({ ...entry, linked: true, ...(kept.length !== 1 || kept[0]!.start !== span.start || kept[0]!.end !== span.end ? { reason: 'trimmed by hold' } : {}) });
    });
  }

  private resolveAimHold(
    input: PointResolutionInput,
    hold: AimHold,
    start: number,
    end: number,
    toSpan: (start: number, end: number) => MeaningSpan,
    draft: MeaningDraft,
    report: PointResolutionReport
  ): void {
    const body = BODY_HOLD_INPUTS.has(hold.input);
    const capsulesAt = (sample: AimPointSample): Capsule[] => (body ? this.poseCapsules(input, nearestFrameIndex(input.frames, sample.timeSec), hold.side) : []);
    this.resolveHeld(hold, start, end, this.fromAnchor(hold.side), capsulesAt, toSpan, draft, report);
  }

  private resolveHeld(
    hold: AimHold,
    start: number,
    end: number,
    from: MeaningLinkDraft['from'] | undefined,
    capsulesAt: (sample: AimPointSample) => readonly Capsule[],
    toSpan: (start: number, end: number) => MeaningSpan,
    draft: MeaningDraft,
    report: PointResolutionReport
  ): void {
    const resolved: Resolved[] = throttle(hold.samples).map((sample) => ({ ...this.cast(sample, capsulesAt(sample)), score: 1 }));
    const runs = splitByReferent(resolved);
    runs.forEach((run, i) => {
      const runStart = i === 0 ? start : resolved[run.first]!.timeSec;
      const runEnd = i === runs.length - 1 ? end : resolved[run.last]!.timeSec;
      const span = toSpan(runStart, runEnd);
      const entry = { source: 'aim' as const, input: hold.input, side: hold.side, start: span.start, end: span.end, referent: run.key, agreement: round(run.agreement) };
      const reason = rejectReason(run, runEnd - runStart, from, undefined);
      if (reason) {
        report.runs.push({ ...entry, linked: false, reason });
        return;
      }
      const majority = resolved.slice(run.first, run.last + 1).filter((r) => r.key === run.key);
      draft.marks.push(this.link(from!, majority, span, { value: 'recorded' }));
      report.runs.push({ ...entry, linked: true });
    });
  }

  private link(from: MeaningLinkDraft['from'], majority: Resolved[], span: MeaningSpan, provenance: MeaningLinkProvenance): MeaningLinkDraft {
    const target = majority[0]!.target!;
    const point = new THREE.Vector3();
    for (const r of majority) point.add(r.localPoint!);
    point.multiplyScalar(1 / majority.length);
    const to: MeaningLinkDraft['to'] = { object: target.object, point: [round(point.x), round(point.y), round(point.z)] };
    if (target.bone) to.bone = target.bone;
    if (target.large) to.radius = LARGE_SURFACE_HIGHLIGHT_RADIUS;
    return { from, to, span, provenance };
  }

  // The pointing fingertip's bone on the exported avatar, or the hand on rigs without fingers.
  private fromAnchor(side: VrHandSide): MeaningLinkDraft['from'] | undefined {
    for (const bone of [`${side}IndexDistal`, `${side}Hand`] as const) {
      const object = this.exportBones.get(bone);
      if (object) return { bone, object };
    }
    return undefined;
  }

  private cast(sample: Pick<HandPointSample, 'timeSec' | 'origin' | 'direction'>, capsules: readonly Capsule[]): Omit<Resolved, 'score'> {
    const origin = new THREE.Vector3(sample.origin.x, sample.origin.y, sample.origin.z);
    const direction = this.tmpDirection.set(sample.direction.x, sample.direction.y, sample.direction.z).normalize();
    perpendicularBasis(direction, this.tmpBasisU, this.tmpBasisV);

    interface Candidate { target: Target; quality: number; distance: number; localPoint: THREE.Vector3 }
    const candidates = new Map<string, Candidate>();
    let center: Candidate | undefined;
    const ray = new THREE.Vector3();
    for (const ring of CONE_RINGS) {
      const tan = Math.tan(THREE.MathUtils.degToRad(ring.angleDeg));
      for (let k = 0; k < ring.rays; k += 1) {
        const phi = (k / ring.rays) * Math.PI * 2;
        ray.copy(direction)
          .addScaledVector(this.tmpBasisU, Math.cos(phi) * tan)
          .addScaledVector(this.tmpBasisV, Math.sin(phi) * tan)
          .normalize();
        const hit = this.nearestHit(origin, ray, capsules);
        if (!hit) continue;
        const existing = candidates.get(hit.target.key);
        if (!existing || ring.quality > existing.quality || (ring.quality === existing.quality && hit.distance < existing.distance)) {
          candidates.set(hit.target.key, { target: hit.target, quality: ring.quality, distance: hit.distance, localPoint: hit.localPoint });
        }
        if (ring.angleDeg === 0) center = candidates.get(hit.target.key);
      }
    }

    let chosen: Candidate | undefined = center;
    // A thin object in front of the floor or a wall wins over the surface
    // behind it when it falls within the tolerance.
    if (!chosen || chosen.target.large) {
      const nearer = [...candidates.values()]
        .filter((c) => !c.target.large && (!chosen || c.distance < chosen.distance))
        .sort((a, b) => b.quality - a.quality || a.distance - b.distance)[0];
      if (nearer) chosen = nearer;
    }
    if (!chosen) {
      chosen = [...candidates.values()].sort((a, b) => b.quality - a.quality || a.distance - b.distance)[0];
    }
    if (!chosen) return { timeSec: sample.timeSec, key: null, quality: 1 };
    return { timeSec: sample.timeSec, key: chosen.target.key, target: chosen.target, localPoint: chosen.localPoint, quality: chosen.quality };
  }

  private nearestHit(origin: THREE.Vector3, ray: THREE.Vector3, capsules: readonly Capsule[]): { target: Target; distance: number; localPoint: THREE.Vector3 } | undefined {
    let best: { target: Target; distance: number; localPoint: THREE.Vector3 } | undefined;
    if (this.sceneTargets.size > 0) {
      this.raycaster.set(origin, ray);
      const hit = this.raycaster.intersectObjects([...this.sceneTargets.keys()], false)[0];
      if (hit) {
        const target = this.sceneTargets.get(hit.object)!;
        best = { target, distance: hit.distance, localPoint: target.object.worldToLocal(hit.point.clone()) };
      }
    }
    for (const capsule of capsules) {
      const distance = rayCapsule(origin, ray, capsule.a, capsule.b, capsule.radius);
      if (distance === undefined || distance < RAY_NEAR || distance > MAX_RAY_DISTANCE) continue;
      if (best && distance >= best.distance) continue;
      const exported = this.exportBones.get(capsule.bone);
      const posed = this.posedBones.get(capsule.bone);
      if (!exported || !posed) continue;
      const world = this.tmpPoint.copy(origin).addScaledVector(ray, distance);
      const local = world.clone().applyMatrix4(this.tmpMatrix.copy(posed.matrixWorld).invert());
      best = { target: { key: `bone:${capsule.bone}`, object: exported, bone: capsule.bone, large: false }, distance, localPoint: local };
    }
    return best;
  }

  // Poses the avatar clone as the export will show `frameIndex` and returns
  // its body capsules without the pointing side's arm and hand.
  private poseCapsules(input: PointResolutionInput, frameIndex: number, pointingSide: VrHandSide): Capsule[] {
    if (!this.posedAvatar) {
      this.posedAvatar = SkeletonUtils.clone(input.avatar);
      this.posedBoneList = [];
      this.posedAvatar.traverse((obj) => {
        if (isThreeBone(obj)) this.posedBoneList.push(obj);
      });
      collectHumanoidBones(this.posedAvatar, this.posedBones);
    }
    if (frameIndex !== this.posedFrameIndex) {
      applyFrame(this.posedAvatar, this.posedBoneList, input.frames[frameIndex]!);
      this.posedFrameIndex = frameIndex;
    }
    const capsules: Capsule[] = [];
    const position = (bone: VrmHumanoidBone): THREE.Vector3 | undefined => {
      const object = this.posedBones.get(bone);
      return object ? object.getWorldPosition(new THREE.Vector3()) : undefined;
    };
    for (const spec of CAPSULES) {
      if (spec.side === pointingSide) continue;
      const a = position(spec.start);
      const b = position(spec.end);
      if (a && b) capsules.push({ bone: spec.bone, a, b, radius: spec.radius });
    }
    const head = this.posedBones.get('head');
    if (head) {
      const a = head.getWorldPosition(new THREE.Vector3());
      const up = new THREE.Vector3(0, 1, 0).applyQuaternion(head.getWorldQuaternion(new THREE.Quaternion()));
      const b = a.clone().addScaledVector(up, HEAD_CENTER_ABOVE_JOINT);
      capsules.push({ bone: 'head', a: b, b: b.clone(), radius: HEAD_RADIUS });
    }
    return capsules;
  }
}

function rejectReason(run: ReferentRun, durationSec: number, from: unknown, confidence: number | undefined): string | undefined {
  if (!from) return 'avatar has no hand bone for from';
  if (run.key === null) return 'no referent';
  if (durationSec < POINT_DWELL_SEC) return 'too brief';
  if (confidence !== undefined && confidence < POINT_MIN_CONFIDENCE) return 'low confidence';
  return undefined;
}

function sceneTarget(mesh: THREE.Mesh): Target {
  mesh.updateWorldMatrix(true, false);
  const geometry = mesh.geometry;
  if (!geometry.boundingSphere) geometry.computeBoundingSphere();
  const scale = mesh.getWorldScale(new THREE.Vector3());
  const radius = (geometry.boundingSphere?.radius ?? 0) * Math.max(Math.abs(scale.x), Math.abs(scale.y), Math.abs(scale.z));
  // Readable in reports, unique by uuid.
  return { key: `mesh:${mesh.name || 'unnamed'}#${mesh.uuid.slice(0, 8)}`, object: mesh, large: radius > LARGE_SURFACE_RADIUS };
}

/** A `RecordedObject` wrapper is one referent whatever mesh of it a ray meets; hits are local to the wrapper node. */
function objectTarget(wrapper: THREE.Object3D): Target {
  return { key: `object:${wrapper.children[0]?.name || wrapper.name}#${wrapper.uuid.slice(0, 8)}`, object: wrapper, large: false };
}

/** Seconds since `t0`, clamped to the take (`t0` to `tEnd`) and rounded: a link's span. */
function spanWithin(t0: number, tEnd: number): (start: number, end: number) => MeaningSpan {
  return (start, end) => {
    const s = clamp(start - t0, 0, tEnd - t0);
    const e = clamp(end - t0, s, tEnd - t0);
    return { start: round(s), end: round(e) };
  };
}

/**
 * VRM humanoid bone → bone, from the canonical tags the avatar's humanoid
 * skeleton set at load (clones carry them). A finger's distal bone resolves to
 * its end site, the fingertip, when the rig has one. Untagged rigs fall back
 * to bone names.
 */
function collectHumanoidBones(root: THREE.Object3D, out: Map<VrmHumanoidBone, THREE.Bone>): void {
  out.clear();
  const tips = new Map<VrmHumanoidBone, THREE.Bone>();
  root.traverse((obj) => {
    if (!isThreeBone(obj)) return;
    const tag = humanoidTagOf(obj);
    if (tag.bone) out.set(tag.bone, obj);
    if (tag.tipOf) tips.set(tag.tipOf, obj);
  });
  if (out.size === 0) {
    root.traverse((obj) => {
      if (!isThreeBone(obj)) return;
      const bone = resolveHumanoidBone(obj.name);
      if (bone) out.set(bone, obj);
    });
  }
  for (const [bone, tip] of tips) out.set(bone, tip);
}

// Mirrors GltfExportComposer: the frame's root transform on the clone, its
// local bone transforms by traversal order (names may repeat).
function applyFrame(avatar: THREE.Object3D, bones: readonly THREE.Bone[], frame: RecordingFrame): void {
  avatar.position.set(frame.rootPosition.x, frame.rootPosition.y, frame.rootPosition.z);
  avatar.quaternion.set(frame.rootQuaternion.x, frame.rootQuaternion.y, frame.rootQuaternion.z, frame.rootQuaternion.w);
  const byIndex = frame.bones.length === bones.length;
  const byName = byIndex ? undefined : new Map(frame.bones.map((b) => [b.name, b]));
  bones.forEach((bone, i) => {
    const recorded = byIndex ? frame.bones[i] : byName!.get(bone.name);
    if (!recorded) return;
    bone.position.set(recorded.position.x, recorded.position.y, recorded.position.z);
    bone.quaternion.set(recorded.quaternion.x, recorded.quaternion.y, recorded.quaternion.z, recorded.quaternion.w);
  });
  avatar.updateMatrixWorld(true);
}

function nearestFrameIndex(frames: readonly RecordingFrame[], timeSec: number): number {
  let lo = 0;
  let hi = frames.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (frames[mid]!.timeSec < timeSec) lo = mid + 1;
    else hi = mid;
  }
  if (lo > 0 && Math.abs(frames[lo - 1]!.timeSec - timeSec) <= Math.abs(frames[lo]!.timeSec - timeSec)) return lo - 1;
  return lo;
}

// At most MAX_RESOLVE_RATE_HZ samples per second, always keeping the last.
function throttle<T extends { timeSec: number }>(samples: readonly T[]): T[] {
  const kept: T[] = [];
  const minInterval = 1 / MAX_RESOLVE_RATE_HZ - 1e-6;
  for (const sample of samples) {
    const last = kept.at(-1);
    if (!last || sample.timeSec - last.timeSec >= minInterval) kept.push(sample);
  }
  const tail = samples.at(-1);
  if (tail && kept.at(-1) !== tail) kept.push(tail);
  return kept;
}

function perpendicularBasis(direction: THREE.Vector3, u: THREE.Vector3, v: THREE.Vector3): void {
  const helper = Math.abs(direction.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
  u.crossVectors(direction, helper).normalize();
  v.crossVectors(direction, u).normalize();
}

/** Distance along a unit ray to a capsule (segment a–b, radius r), or undefined on a miss or when the origin is inside. */
export function rayCapsule(origin: THREE.Vector3, dir: THREE.Vector3, a: THREE.Vector3, b: THREE.Vector3, r: number): number | undefined {
  const ba = new THREE.Vector3().subVectors(b, a);
  const oa = new THREE.Vector3().subVectors(origin, a);
  const baba = ba.dot(ba);
  const bard = ba.dot(dir);
  const baoa = ba.dot(oa);
  const rdoa = dir.dot(oa);
  const oaoa = oa.dot(oa);
  if (baba > 1e-10) {
    const qa = baba - bard * bard;
    const qb = baba * rdoa - baoa * bard;
    const qc = baba * oaoa - baoa * baoa - r * r * baba;
    const h = qb * qb - qa * qc;
    if (h >= 0 && qa > 1e-12) {
      const t = (-qb - Math.sqrt(h)) / qa;
      const y = baoa + t * bard;
      if (y > 0 && y < baba) return t >= 0 ? t : undefined;
    }
  }
  // End caps: the nearer sphere hit.
  let best: number | undefined;
  for (const center of [a, b]) {
    const oc = new THREE.Vector3().subVectors(origin, center);
    const bq = oc.dot(dir);
    const cq = oc.dot(oc) - r * r;
    const hq = bq * bq - cq;
    if (hq < 0 || cq < 0) continue;
    const t = -bq - Math.sqrt(hq);
    if (t >= 0 && (best === undefined || t < best)) best = t;
  }
  return best;
}

/** What is left of `span` outside every one of `cuts`, in order. */
export function subtractSpans(span: MeaningSpan, cuts: readonly MeaningSpan[]): MeaningSpan[] {
  let pieces: MeaningSpan[] = [{ ...span }];
  for (const cut of cuts) {
    pieces = pieces.flatMap((piece) => {
      if (cut.end <= piece.start || cut.start >= piece.end) return [piece];
      const left = { start: piece.start, end: Math.min(piece.end, cut.start) };
      const right = { start: Math.max(piece.start, cut.end), end: piece.end };
      return [left, right].filter((part) => part.end > part.start);
    });
  }
  return pieces;
}

/** When a hold began: its first sample, or for a touch the touchdown, one hold delay earlier. */
function holdStart(hold: AimHold): number {
  const first = hold.samples[0]!.timeSec;
  return hold.input === 'touch' ? first - TOUCH_HOLD_DELAY_SEC : first;
}

function mean(values: readonly number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, v) => sum + v, 0) / values.length;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}
