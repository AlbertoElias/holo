import { createSystem } from "@iwsdk/core";
import { Plane, Quaternion, Vector3 } from "three";
import type { Matrix4, Object3D, Ray } from "three";

import { computeFloorPlacement } from "../ar/arPlacement";
import { viewerContext, type PlacementMode, type ViewerContext } from "./viewerContext";

// VR: the hologram stands on the floor 1.5 m ahead of the viewer, facing them.
// AR: a viewer-space hit test finds the surface ahead and an anchor holds the
// hologram there; without a hit in time it falls back to the floor estimate
// from arPlacement.ts. A screen tap on the floor moves it there.

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
// Without a usable hit, stand it on the local floor (y = 0) this far ahead,
// the R3F view's minimum, so the whole figure fits in view.
const AR_FLOOR_FALLBACK_DISTANCE_M = 1.8;

const headPosition = new Vector3();
const headQuaternion = new Quaternion();

function facePoint(object: Object3D, target: Vector3): void {
  const dx = target.x - object.position.x;
  const dz = target.z - object.position.z;
  object.rotation.set(0, Math.atan2(dx, dz), 0);
}

function placeFocused(c: ViewerContext, head: Vector3, position: Vector3, mode: PlacementMode, anchored: boolean): void {
  const object = c.focused?.object3D;
  if (!object) return;
  object.position.copy(position);
  facePoint(object, head);
  // Hidden until first placed, so it never pops in at the origin.
  object.visible = true;
  c.placement = {
    stage: anchored ? "anchored" : "placed",
    mode,
    sequence: c.placement.sequence + 1,
    position: [position.x, position.y, position.z]
  };
}

function readHead(system: { player: { head: Object3D } }): boolean {
  const head = system.player.head;
  head.getWorldPosition(headPosition);
  head.getWorldQuaternion(headQuaternion);
  return Number.isFinite(headPosition.x) && headPosition.lengthSq() > 0;
}

export class VrPlacementSystem extends createSystem() {
  update(): void {
    const c = viewerContext(this.world);
    if (!c.focused || !this.xrFrame) return;
    if (c.placement.stage !== "searching" && !c.recenterRequested) return;
    if (!readHead(this)) return;
    c.recenterRequested = false;
    const floor = computeFloorPlacement(headPosition, headQuaternion, {
      distanceMeters: VR_PLACEMENT_DISTANCE_M,
      minFloorY: 0,
      eyeToFloorMeters: headPosition.y
    });
    floor.position.y = 0;
    placeFocused(c, headPosition, floor.position, "vr-default", false);
  }
}

export class ArPlacementSystem extends createSystem() {
  private hitTestSource: XRHitTestSource | null = null;
  private anchor: XRAnchor | null = null;
  private searchStartedAt = 0;
  private pendingAnchorPose: Matrix4 | null = null;
  private session: XRSession | null = null;

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
    const c = viewerContext(this.world);
    const object = c.focused?.object3D;
    if (!object || c.placement.stage === "searching") return false;
    const floor = new Plane(new Vector3(0, 1, 0), -object.position.y);
    const point = ray.intersectPlane(floor, new Vector3());
    if (!point || point.distanceTo(ray.origin) > AR_TAP_MAX_DISTANCE_M) return false;
    this.dropAnchor();
    readHead(this);
    placeFocused(c, headPosition, point, "tap", false);
    this.pendingAnchorPose = object.matrixWorld.clone().setPosition(point);
    return true;
  }

  update(): void {
    const c = viewerContext(this.world);
    const frame = this.xrFrame;
    const refSpace = this.xrManager.getReferenceSpace();
    if (!c.focused || !frame || !refSpace) return;

    if (c.recenterRequested) {
      c.recenterRequested = false;
      this.dropAnchor();
      c.placement = { ...c.placement, stage: "searching" };
      this.searchStartedAt = performance.now();
    }

    if (c.placement.stage === "searching") {
      this.search(c, frame, refSpace);
    } else if (this.pendingAnchorPose) {
      this.requestAnchor(frame, refSpace, this.pendingAnchorPose);
      this.pendingAnchorPose = null;
    } else if (this.anchor) {
      // Follow the anchor as the device refines its map.
      const pose = frame.getPose(this.anchor.anchorSpace, refSpace);
      if (pose && c.focused.object3D) {
        const p = pose.transform.position;
        c.focused.object3D.position.set(p.x, p.y, p.z).applyMatrix4(this.player.matrixWorld);
      }
    }
  }

  private async startSession(session: XRSession | null): Promise<void> {
    if (!session || this.session === session) return;
    this.session = session;
    this.searchStartedAt = performance.now();
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
    this.dropAnchor();
    this.session = null;
  }

  private search(c: ViewerContext, frame: XRFrame, refSpace: XRReferenceSpace): void {
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
      placeFocused(c, headPosition, position, "hit-test", false);
      void hit.createAnchor?.()?.then((anchor) => this.adoptAnchor(anchor), () => undefined);
      return;
    }
    if (performance.now() - this.searchStartedAt < AR_HIT_TEST_TIMEOUT_MS) return;
    const floor = computeFloorPlacement(headPosition, headQuaternion, {
      distanceMeters: AR_FLOOR_FALLBACK_DISTANCE_M,
      minFloorY: 0,
      eyeToFloorMeters: headPosition.y
    });
    floor.position.y = 0;
    placeFocused(c, headPosition, floor.position, "floor", false);
    this.pendingAnchorPose = c.focused?.object3D?.matrixWorld.clone().setPosition(floor.position) ?? null;
  }

  private requestAnchor(frame: XRFrame, refSpace: XRReferenceSpace, worldPose: Matrix4): void {
    if (typeof frame.createAnchor !== "function") return;
    const local = worldPose.clone().premultiply(this.player.matrixWorld.clone().invert());
    const position = new Vector3().setFromMatrixPosition(local);
    const transform = new XRRigidTransform({ x: position.x, y: position.y, z: position.z });
    void frame.createAnchor(transform, refSpace)?.then((anchor) => this.adoptAnchor(anchor), () => undefined);
  }

  private adoptAnchor(anchor: XRAnchor): void {
    const c = viewerContext(this.world);
    if (c.placement.stage === "searching") {
      anchor.delete();
      return;
    }
    this.dropAnchor();
    this.anchor = anchor;
    c.placement = { ...c.placement, stage: "anchored" };
  }

  private dropAnchor(): void {
    this.anchor?.delete();
    this.anchor = null;
  }
}
