import { createSystem, Grabbed, type Entity } from "@iwsdk/core";
import { metresPerApx, FOOT_REFERENCE_DISTANCE_M, SHELF_CLEAR_YAW_DEG } from "@holoim/xr-ui-iwsdk";
import { Plane, Quaternion, Vector3 } from "three";
import type { Matrix4, Object3D, Ray } from "three";

import { computeFloorPlacement } from "../ar/arPlacement";
import { focusedRecord, viewerContext, type PlacedHologram, type PlacementMode, type Stage, type ViewerContext } from "./viewerContext";

// VR: the first hologram stands on the floor 1.5 m ahead of the viewer, facing
// them, and fixes the stage's front; each next one takes the first free place
// beside it on an arc at the same distance (step 4). AR: a viewer-space hit
// test finds the surface ahead for the first hologram and an anchor holds it;
// without a hit in time it falls back to the floor estimate from
// arPlacement.ts. Each next one goes to its free place on the stage, on the
// floor point a hit test straight down finds there, and is anchored. A
// screen tap on the floor moves the focused hologram there. Recenter puts a
// hologram back in front of the viewer, as the first placement does.

const VR_PLACEMENT_DISTANCE_M = 1.5;
const AR_HIT_TEST_TIMEOUT_MS = 3500;
const AR_TAP_MAX_DISTANCE_M = 8;
// As the R3F view (ARHologramModel.tsx): aim the hit test slightly down so it
// finds the floor ahead, and keep only surfaces that face up.
const AR_HIT_TEST_RAY_DIRECTION = { x: 0, y: -0.35, z: -1, w: 0 };
const AR_MIN_SURFACE_UP_DOT = 0.8;
// A recorded person at true scale stands on the floor, not on furniture:
// surfaces higher than this above the local floor are skipped.
const AR_MAX_STANDING_SURFACE_M = 0.5;
// After a two-hand move, or for a place beside the first hologram, the
// surface under it is found by a ray straight down from this far above its
// base, within this long.
const AR_REGROUND_RAY_HEIGHT_M = 1;
const AR_REGROUND_TIMEOUT_MS = 1000;
// Without a usable hit, stand it on the local floor (y = 0) this far ahead,
// the R3F view's minimum, so the whole figure fits in view.
const AR_FLOOR_FALLBACK_DISTANCE_M = 1.8;
/** Neighbours keep the chip width plus a 30 apx gap between them (brief). */
const PLACEMENT_GAP_M = 30 * metresPerApx(FOOT_REFERENCE_DISTANCE_M);
/** Free places tried beside the first: right, left, then further out. */
/** Free places are searched on arcs this far apart, outward from the stage's distance. */
const STAGE_RING_STEP_M = 0.25;
const STAGE_RINGS = 12;
const STAGE_YAW_STEP_DEG = 0.5;

const headPosition = new Vector3();
const headQuaternion = new Quaternion();

function facePoint(object: Object3D, target: Vector3): void {
  const dx = target.x - object.position.x;
  const dz = target.z - object.position.z;
  object.rotation.set(0, Math.atan2(dx, dz), 0);
}

function placeRecord(record: PlacedHologram, head: Vector3, position: Vector3, mode: PlacementMode, anchored: boolean): void {
  const object = record.entity.object3D!;
  object.position.copy(position);
  facePoint(object, head);
  // Hidden until first placed, so it never pops in at the origin.
  object.visible = true;
  record.placement = {
    stage: anchored ? "anchored" : "placed",
    mode,
    sequence: record.placement.sequence + 1,
    position: [position.x, position.y, position.z]
  };
}

function readHead(system: { player: { head: Object3D } }): boolean {
  const head = system.player.head;
  head.getWorldPosition(headPosition);
  head.getWorldQuaternion(headQuaternion);
  return Number.isFinite(headPosition.x) && headPosition.lengthSq() > 0;
}

function horizontalForward(): Vector3 {
  const forward = new Vector3(0, 0, -1).applyQuaternion(headQuaternion).setY(0);
  return forward.lengthSq() > 1e-6 ? forward.normalize() : new Vector3(0, 0, -1);
}

function stageAt(origin: Vector3, position: Vector3): Stage {
  const toPosition = position.clone().sub(origin).setY(0);
  const distanceM = Math.max(toPosition.length(), 0.5);
  return { origin: new Vector3(origin.x, position.y, origin.z), forward: toPosition.lengthSq() > 1e-6 ? toPosition.normalize() : horizontalForward(), distanceM, floorY: position.y };
}

/** Centre-to-centre distance two placed holograms keep, so neither their bodies nor their chips overlap. */
function spacing(c: ViewerContext, a: PlacedHologram, b: PlacedHologram): number {
  const bodies = a.footprintRadius * a.entity.object3D!.scale.x + b.footprintRadius * b.entity.object3D!.scale.x;
  return Math.max(c.chipWidthM, bodies) + PLACEMENT_GAP_M;
}

/** The first free place on the stage's arc for `record`: in front, then alternately right and left. */
/**
 * The nearest free place on the stage (step 4, the lead 2026-10-25): seen from
 * the stage's origin, the newcomer is fully visible, hides no placed hologram,
 * and stays clear of the shelf's wings. Arcs at the stage's distance and then
 * further out are searched centre first, right before left; the viewer can
 * grab-move any hologram afterwards.
 */
function freeStagePlace(c: ViewerContext, stage: Stage, record: PlacedHologram): Vector3 {
  const others = c.placed
    .filter((other) => other !== record && other.placement.stage !== "searching")
    .map((other) => {
      const position = other.entity.object3D!.position;
      const offset = new Vector3(position.x - stage.origin.x, 0, position.z - stage.origin.z);
      const distance = Math.max(offset.length(), other.footprintRadius + 1e-3);
      return { record: other, position, yaw: yawFromForward(stage, offset), halfAngle: Math.asin(other.footprintRadius / distance) };
    });
  const clear = (SHELF_CLEAR_YAW_DEG * Math.PI) / 180;
  const stepAngle = (STAGE_YAW_STEP_DEG * Math.PI) / 180;
  for (let ring = 0; ring < STAGE_RINGS; ring++) {
    const distance = stage.distanceM + ring * STAGE_RING_STEP_M;
    const halfAngle = Math.asin(Math.min(1, record.footprintRadius / distance));
    for (let k = 0; k * stepAngle + halfAngle <= clear; k++) {
      for (const sign of k === 0 ? [1] : [1, -1]) {
        const yaw = sign * k * stepAngle;
        // A positive yaw turns toward the viewer's right.
        const direction = stage.forward.clone().applyAxisAngle(new Vector3(0, 1, 0), -yaw);
        const candidate = stage.origin.clone().addScaledVector(direction, distance).setY(stage.floorY);
        const fits = others.every((other) => {
          const apart = Math.hypot(other.position.x - candidate.x, other.position.z - candidate.z) >= spacing(c, record, other.record) - 1e-3;
          // Neither stands in front of the other from the viewer's spot.
          const unobstructed = Math.abs(yaw - other.yaw) >= halfAngle + other.halfAngle;
          return apart && unobstructed;
        });
        if (fits) return candidate;
      }
    }
  }
  return stage.origin.clone().addScaledVector(stage.forward, stage.distanceM).setY(stage.floorY);
}

/** Signed yaw of a horizontal offset from the stage's forward direction; positive is to the right. */
function yawFromForward(stage: Stage, offset: Vector3): number {
  const right = stage.forward.x * offset.z - stage.forward.z * offset.x;
  return Math.atan2(right, stage.forward.x * offset.x + stage.forward.z * offset.z);
}

export class VrPlacementSystem extends createSystem() {
  update(): void {
    const c = viewerContext(this.world);
    if (!this.xrFrame) return;
    for (const record of c.placed) {
      if (record.placement.stage !== "searching" && !record.recenterRequested) continue;
      if (!readHead(this)) return;
      const recenter = record.recenterRequested;
      record.recenterRequested = false;
      const ahead = (): Vector3 => {
        const floor = computeFloorPlacement(headPosition, headQuaternion, {
          distanceMeters: VR_PLACEMENT_DISTANCE_M,
          minFloorY: 0,
          eyeToFloorMeters: headPosition.y
        });
        return floor.position.setY(0);
      };
      let position: Vector3;
      if (recenter || !c.stage) {
        position = ahead();
        c.stage ??= stageAt(headPosition, position);
      } else {
        position = freeStagePlace(c, c.stage, record);
      }
      placeRecord(record, headPosition, position, "vr-default", false);
    }
  }
}

interface ArRecordState {
  anchor: XRAnchor | null;
  pendingAnchorPose: Matrix4 | null;
  /** A two-hand grab moved the hologram off its anchor; re-anchor where it is let go. */
  grabbed: boolean;
  /** Hit test straight down under the hologram, when it gives up, and what to call the result. */
  reground: { source: XRHitTestSource | null; until: number; place: boolean } | null;
  /** Searching with the viewer's ray (first placement, recenter) rather than at a stage place. */
  ahead: boolean;
  searchStartedAt: number;
}

export class ArPlacementSystem extends createSystem() {
  private hitTestSource: XRHitTestSource | null = null;
  private session: XRSession | null = null;
  private readonly states = new Map<Entity, ArRecordState>();

  init(): void {
    const onSessionStart = (): void => void this.startSession(this.xrManager.getSession());
    const onSessionEnd = (): void => this.stopSession();
    this.xrManager.addEventListener("sessionstart", onSessionStart);
    this.xrManager.addEventListener("sessionend", onSessionEnd);
    void this.startSession(this.xrManager.getSession());
    this.cleanupFuncs.push(
      () => this.xrManager.removeEventListener("sessionstart", onSessionStart),
      () => this.xrManager.removeEventListener("sessionend", onSessionEnd),
      () => this.stopSession()
    );
  }

  /** Moves the focused hologram to where a tap ray meets its floor. */
  placeAtTap(ray: Ray): boolean {
    const record = focusedRecord(viewerContext(this.world));
    const object = record?.entity.object3D;
    if (!record || !object || record.placement.stage === "searching") return false;
    const floor = new Plane(new Vector3(0, 1, 0), -object.position.y);
    const point = ray.intersectPlane(floor, new Vector3());
    if (!point || point.distanceTo(ray.origin) > AR_TAP_MAX_DISTANCE_M) return false;
    const state = this.state(record.entity);
    this.dropAnchor(state);
    readHead(this);
    placeRecord(record, headPosition, point, "tap", false);
    state.pendingAnchorPose = object.matrixWorld.clone().setPosition(point);
    return true;
  }

  /** A hologram left the space: let go of its anchor and hit tests. */
  forget(entity: Entity): void {
    const state = this.states.get(entity);
    if (!state) return;
    this.cancelReground(state);
    this.dropAnchor(state);
    this.states.delete(entity);
  }

  update(): void {
    const c = viewerContext(this.world);
    const frame = this.xrFrame;
    const refSpace = this.xrManager.getReferenceSpace();
    if (!frame || !refSpace) return;
    for (const record of c.placed) this.updateRecord(c, record, frame, refSpace);
  }

  private state(entity: Entity): ArRecordState {
    let state = this.states.get(entity);
    if (!state) {
      state = { anchor: null, pendingAnchorPose: null, grabbed: false, reground: null, ahead: false, searchStartedAt: performance.now() };
      this.states.set(entity, state);
    }
    return state;
  }

  private updateRecord(c: ViewerContext, record: PlacedHologram, frame: XRFrame, refSpace: XRReferenceSpace): void {
    const state = this.state(record.entity);
    const object = record.entity.object3D!;
    if (record.recenterRequested) {
      record.recenterRequested = false;
      this.dropAnchor(state);
      this.cancelReground(state);
      record.placement = { ...record.placement, stage: "searching" };
      state.ahead = true;
      state.searchStartedAt = performance.now();
    }

    if (record.entity.hasComponent(Grabbed)) {
      // The hands hold it: the anchor lets go until it is released.
      if (!state.grabbed) {
        this.dropAnchor(state);
        this.cancelReground(state);
      }
      state.grabbed = true;
      return;
    }
    if (state.grabbed) {
      state.grabbed = false;
      record.placement = { ...record.placement, stage: "placed" };
      this.startReground(state, object, refSpace, false);
    }
    if (state.reground && !this.regroundStep(state, record, frame, refSpace)) return;

    if (record.placement.stage === "searching") {
      if (!c.stage || state.ahead) this.searchAhead(c, record, state, frame, refSpace);
      else this.placeOnStage(c, c.stage, record, state, refSpace);
    } else if (state.pendingAnchorPose) {
      this.requestAnchor(record, frame, refSpace, state.pendingAnchorPose);
      state.pendingAnchorPose = null;
    } else if (state.anchor) {
      // Follow the anchor as the device refines its map.
      const pose = frame.getPose(state.anchor.anchorSpace, refSpace);
      if (pose) {
        const p = pose.transform.position;
        object.position.set(p.x, p.y, p.z).applyMatrix4(this.player.matrixWorld);
      }
    }
  }

  /** A place beside the others on the stage, then the floor a hit test finds straight down there. */
  private placeOnStage(c: ViewerContext, stage: Stage, record: PlacedHologram, state: ArRecordState, refSpace: XRReferenceSpace): void {
    if (!readHead(this)) return;
    placeRecord(record, headPosition, freeStagePlace(c, stage, record), "floor", false);
    this.startReground(state, record.entity.object3D!, refSpace, true);
  }

  /** Looks for the surface under a hologram's base, from just above it. */
  private startReground(state: ArRecordState, object: Object3D, refSpace: XRReferenceSpace, place: boolean): void {
    const reground: NonNullable<ArRecordState["reground"]> = { source: null, until: performance.now() + AR_REGROUND_TIMEOUT_MS, place };
    state.reground = reground;
    const base = object.getWorldPosition(new Vector3()).applyMatrix4(this.player.matrixWorld.clone().invert());
    if (typeof XRRay !== "function" || !this.session?.requestHitTestSource) return;
    const ray = new XRRay({ x: base.x, y: base.y + AR_REGROUND_RAY_HEIGHT_M, z: base.z, w: 1 }, { x: 0, y: -1, z: 0, w: 0 });
    void this.session.requestHitTestSource({ space: refSpace, offsetRay: ray, entityTypes: ["plane", "mesh"] })?.then(
      (source) => {
        if (state.reground === reground) reground.source = source;
        else source.cancel();
      },
      () => undefined
    );
  }

  /** True once regrounding is done: the hologram stands on the surface found, or where it was. */
  private regroundStep(state: ArRecordState, record: PlacedHologram, frame: XRFrame, refSpace: XRReferenceSpace): boolean {
    const reground = state.reground!;
    const object = record.entity.object3D!;
    let found = false;
    for (const result of reground.source ? frame.getHitTestResults(reground.source) : []) {
      const pose = result.getPose(refSpace);
      if (!pose || (pose.transform.matrix[5] ?? 0) < AR_MIN_SURFACE_UP_DOT) continue;
      const p = pose.transform.position;
      object.position.copy(new Vector3(p.x, p.y, p.z).applyMatrix4(this.player.matrixWorld));
      object.updateMatrixWorld();
      found = true;
      break;
    }
    if (!found && performance.now() < reground.until) return false;
    this.cancelReground(state);
    if (reground.place) {
      const at = object.position;
      record.placement = { ...record.placement, mode: found ? "hit-test" : "floor", position: [at.x, at.y, at.z] };
    }
    state.pendingAnchorPose = object.matrixWorld.clone();
    return true;
  }

  private cancelReground(state: ArRecordState): void {
    state.reground?.source?.cancel();
    state.reground = null;
  }

  private async startSession(session: XRSession | null): Promise<void> {
    if (!session || this.session === session) return;
    this.session = session;
    for (const state of this.states.values()) state.searchStartedAt = performance.now();
    try {
      const viewerSpace = await session.requestReferenceSpace("viewer");
      const offsetRay = typeof XRRay === "function" ? new XRRay({ x: 0, y: 0, z: 0, w: 1 }, AR_HIT_TEST_RAY_DIRECTION) : undefined;
      this.hitTestSource = (await session.requestHitTestSource?.({
        space: viewerSpace,
        entityTypes: ["plane", "mesh"],
        ...(offsetRay ? { offsetRay } : {})
      })) ?? null;
    } catch (error) {
      console.warn("[xr-viewer] hit test unavailable; placing on the floor estimate.", error);
      this.hitTestSource = null;
    }
  }

  private stopSession(): void {
    this.hitTestSource?.cancel();
    this.hitTestSource = null;
    for (const entity of [...this.states.keys()]) this.forget(entity);
    this.session = null;
  }

  private searchAhead(c: ViewerContext, record: PlacedHologram, state: ArRecordState, frame: XRFrame, refSpace: XRReferenceSpace): void {
    if (!readHead(this)) return;
    let hit: XRHitTestResult | undefined;
    let hitPose: XRPose | undefined;
    for (const result of this.hitTestSource ? frame.getHitTestResults(this.hitTestSource) : []) {
      const pose = result.getPose(refSpace);
      // Column 1 of the pose matrix is the surface normal; walls fail this.
      if (pose && (pose.transform.matrix[5] ?? 0) >= AR_MIN_SURFACE_UP_DOT && pose.transform.position.y <= AR_MAX_STANDING_SURFACE_M) {
        hit = result;
        hitPose = pose;
        break;
      }
    }
    if (hit && hitPose) {
      const p = hitPose.transform.position;
      const position = new Vector3(p.x, p.y, p.z).applyMatrix4(this.player.matrixWorld);
      placeRecord(record, headPosition, position, "hit-test", false);
      state.ahead = false;
      c.stage ??= stageAt(headPosition, position);
      void hit.createAnchor?.()?.then((anchor) => this.adoptAnchor(record, anchor), () => undefined);
      return;
    }
    if (performance.now() - state.searchStartedAt < AR_HIT_TEST_TIMEOUT_MS) return;
    const floor = computeFloorPlacement(headPosition, headQuaternion, {
      distanceMeters: AR_FLOOR_FALLBACK_DISTANCE_M,
      minFloorY: 0,
      eyeToFloorMeters: headPosition.y
    });
    floor.position.y = 0;
    placeRecord(record, headPosition, floor.position, "floor", false);
    state.ahead = false;
    c.stage ??= stageAt(headPosition, floor.position);
    state.pendingAnchorPose = record.entity.object3D!.matrixWorld.clone().setPosition(floor.position);
  }

  private requestAnchor(record: PlacedHologram, frame: XRFrame, refSpace: XRReferenceSpace, worldPose: Matrix4): void {
    if (typeof frame.createAnchor !== "function") return;
    const local = worldPose.clone().premultiply(this.player.matrixWorld.clone().invert());
    const position = new Vector3().setFromMatrixPosition(local);
    const transform = new XRRigidTransform({ x: position.x, y: position.y, z: position.z });
    void frame.createAnchor(transform, refSpace)?.then((anchor) => this.adoptAnchor(record, anchor), () => undefined);
  }

  private adoptAnchor(record: PlacedHologram, anchor: XRAnchor): void {
    const state = this.states.get(record.entity);
    // Removed, or re-placing meanwhile: this anchor is stale.
    if (!state || record.placement.stage === "searching" || !viewerContext(this.world).placed.includes(record)) {
      anchor.delete();
      return;
    }
    this.dropAnchor(state);
    state.anchor = anchor;
    record.placement = { ...record.placement, stage: "anchored" };
  }

  private dropAnchor(state: ArRecordState): void {
    state.anchor?.delete();
    state.anchor = null;
  }
}
