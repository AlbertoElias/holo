import * as THREE from 'three';
import { apxToMeters, tokens } from '@holoim/design-tokens';
import { isInChrome, markChromeTree } from '@holoim/xr-ui-core';
import { dashedRingGeometry, ringGeometry, ringMaterial } from '../ui/trayRings';
import type { SceneObject } from './SceneObjectRegistry';

// Placing a tray item from the phone's camera (docs/features/archive/tray-everywhere.md,
// "Phone AR placement"; reverses ar-recording.md's exclusion of summoning).

/** The cast runs on every third step: a reticle needs no more, and the set can be large. */
const CAST_EVERY_STEPS = 3;
const MAX_DISTANCE_M = 30;
const NEAR_M = 0.05;
/** The reticle's drawn size on the screen (apx), whatever its distance. */
const RETICLE_APX = 36;
const RETICLE_STROKE_APX = tokens.glyph.stroke;
/** The no-hit marker at the screen's centre, hung on the camera at the dock's plane. */
const CENTRE_APX = 24;
const CENTRE_DEPTH_M = 0.3;
/** Lifted off the surface so the ring never z-fights it. */
const RETICLE_LIFT_M = 0.01;

export interface ArPlacementHit {
  /** World space. */
  point: [number, number, number];
  /** The surface it landed on: the set's mesh, or its y = 0 floor plane. */
  surface: 'mesh' | 'floor';
  distanceM: number;
}

export interface ArPlacementProbe {
  open: boolean;
  /** The throttled live cast: where the centre ray meets the set or the floor. */
  reticle: { hit: boolean; point: number[] | null; surface: 'mesh' | 'floor' | null; casts: number };
  /** The last placement, in the set's frame: where its base rests and the yaw it was turned to. */
  lastPlaced: { slot: number; objectId: string; point: number[]; yaw: number; timeSec: number } | null;
  /** Taps refused for want of a hit. */
  refused: number;
  /** The placed object under the reticle (docs/features/tray-remove.md): what Put back takes; null when none. */
  target: { objectId: string; name: string } | null;
  /** Objects put back from here. */
  putBacks: number;
}

export interface ArPlacementDeps {
  /** Where the reticle is drawn (the live scene). */
  scene: THREE.Object3D;
  /** The set's frame (the AR world group): y = 0 is its floor, and what a placed object is positioned in. */
  setFrame: THREE.Object3D;
  /** The set's own meshes, never the objects, avatar or chrome. */
  targets: () => THREE.Object3D[];
  /** The XR camera: its forward is the screen's centre ray. The no-hit marker hangs on it. */
  camera: THREE.Object3D;
  /** Pixel metres at the dock's plane, for the no-hit marker. */
  metresPerApx: number;
  /** Summons `slot` with its base on `point` (set frame), turned to `yaw`; null when the slot holds nothing. */
  place: (slot: number, point: THREE.Vector3, yaw: number, timeSec: number) => SceneObject | null;
  /** A placement landed, so the row closes. */
  onPlaced?: (object: SceneObject) => void;
  /** The scene's placed event objects: the reticle also finds them, for Put back. */
  objects?: () => readonly SceneObject[];
  /** Puts `object` back into the tray; false when it is no longer in the scene. */
  putBack?: (object: SceneObject, timeSec: number) => boolean;
}

const origin = new THREE.Vector3();
const direction = new THREE.Vector3();
const quat = new THREE.Quaternion();
const normalOut = new THREE.Vector3();
const floorPoint = new THREE.Vector3();
const local = new THREE.Vector3();
const cameraLocal = new THREE.Vector3();

/**
 * The camera author's placement: while the tray row is open, a ray from the
 * screen's centre is cast against the set's meshes and its floor plane, and a
 * tap on a filled slot summons that item with its base on the hit. Runs in
 * `ObjectSystem`'s AR path, before the camera records that step, so the object
 * is present from the frame it appears. There is no physics in AR: it stands
 * where it is put.
 */
export class ArPlacement {
  private open = false;
  private steps = 0;
  private casts = 0;
  private refused = 0;
  private hit: ArPlacementHit | null = null;
  private pending: number | null = null;
  private lastPlaced: ArPlacementProbe['lastPlaced'] = null;
  /** The placed object nearest along the centre ray, nearer than the set's hit. */
  private target: SceneObject | null = null;
  private putBackPending: SceneObject | null = null;
  private putBacks = 0;
  private readonly objectBox = new THREE.Box3();
  private readonly boxHit = new THREE.Vector3();
  private readonly raycaster = new THREE.Raycaster();
  private readonly plane = new THREE.Plane();
  private readonly reticle = new THREE.Group();
  private readonly centreMarker: THREE.Mesh;

  constructor(private readonly deps: ArPlacementDeps) {
    this.raycaster.near = NEAR_M;
    this.raycaster.far = MAX_DISTANCE_M;
    this.reticle.name = 'ar-placement-reticle';
    const stroke = RETICLE_STROKE_APX / RETICLE_APX;
    const ring = new THREE.Mesh(ringGeometry(0.5, stroke * 2), ringMaterial(tokens.color.gold));
    ring.rotation.x = -Math.PI / 2;
    ring.renderOrder = 992;
    ring.raycast = () => undefined;
    this.reticle.add(ring);
    this.reticle.visible = false;
    deps.scene.add(this.reticle);
    // The no-hit marker: dashed, at the screen's centre, so a tap that would do nothing reads as such.
    const apx = deps.metresPerApx;
    this.centreMarker = new THREE.Mesh(dashedRingGeometry((CENTRE_APX / 2) * apx, RETICLE_STROKE_APX * apx), ringMaterial(tokens.color.textMuted));
    this.centreMarker.position.set(0, 0, -CENTRE_DEPTH_M);
    this.centreMarker.renderOrder = 992;
    this.centreMarker.raycast = () => undefined;
    this.centreMarker.visible = false;
    deps.camera.add(this.centreMarker);
    markChromeTree(this.reticle);
    markChromeTree(this.centreMarker);
  }

  setOpen(open: boolean): void {
    if (this.open === open) return;
    this.open = open;
    this.pending = null;
    this.putBackPending = null;
    if (open) this.steps = 0;
    else {
      this.hit = null;
      this.target = null;
    }
    this.draw();
  }

  /** The tray's slots were renumbered: a queued tap named an item that has moved. */
  cancelPending(): void {
    this.pending = null;
  }

  /** The placed object under the reticle now, if any. */
  currentTarget(): SceneObject | null {
    return this.open ? this.target : null;
  }

  /** Put back: queues the object under the reticle at the moment of the tap; `step` removes it, in the take's own step. */
  requestPutBack(): void {
    if (this.open && this.target) this.putBackPending = this.target;
  }

  /** Queues a tap on `slot`; `step` places it, in the take's own step. */
  request(slot: number): void {
    if (this.open) this.pending = slot;
  }

  /** One simulation step, in `ObjectSystem`, before the camera is recorded. */
  step(timeSec: number): void {
    if (!this.open) return;
    // The first step after opening casts at once; after that every third.
    if (this.steps % CAST_EVERY_STEPS === 0) this.cast();
    this.steps += 1;
    const back = this.putBackPending;
    this.putBackPending = null;
    if (back && this.deps.putBack?.(back, timeSec)) {
      this.putBacks += 1;
      if (this.target === back) this.target = null;
      this.draw();
    }
    const slot = this.pending;
    this.pending = null;
    if (slot === null) return;
    // A tap placed on the freshest ray there is, not a stale reticle.
    if (this.steps % CAST_EVERY_STEPS !== 1) this.cast();
    if (!this.hit) {
      this.refused += 1;
      return;
    }
    this.placeAt(slot, timeSec);
  }

  probe(): ArPlacementProbe {
    return {
      open: this.open,
      reticle: { hit: this.hit !== null, point: this.hit ? [...this.hit.point] : null, surface: this.hit?.surface ?? null, casts: this.casts },
      lastPlaced: this.lastPlaced ? { ...this.lastPlaced, point: [...this.lastPlaced.point] } : null,
      refused: this.refused,
      target: this.open && this.target ? { objectId: this.target.id, name: this.target.name } : null,
      putBacks: this.putBacks
    };
  }

  dispose(): void {
    this.reticle.removeFromParent();
    this.centreMarker.removeFromParent();
  }

  /** The nearer of the set's meshes and its floor plane, along the camera's forward. */
  private cast(): void {
    const { camera, setFrame } = this.deps;
    this.casts += 1;
    camera.updateWorldMatrix(true, false);
    if (!camera.matrixWorld.elements.every(Number.isFinite)) {
      this.hit = null;
      this.draw();
      return;
    }
    camera.getWorldPosition(origin);
    direction.set(0, 0, -1).applyQuaternion(camera.getWorldQuaternion(quat));
    this.raycaster.set(origin, direction);
    this.raycaster.near = NEAR_M;
    this.raycaster.far = MAX_DISTANCE_M;
    let best: ArPlacementHit | null = null;
    // Structural checks only: shared three values may come from another copy of the library.
    const hits = this.raycaster.intersectObjects(this.deps.targets(), true).filter((candidate) => isShown(candidate.object) && !isInChrome(candidate.object));
    const first = hits[0];
    if (first) best = { point: first.point.toArray() as [number, number, number], surface: 'mesh', distanceM: first.distance };
    // The set frame's y = 0: its origin and up, in world space.
    setFrame.updateWorldMatrix(true, false);
    normalOut.set(0, 1, 0).transformDirection(setFrame.matrixWorld);
    floorPoint.setFromMatrixPosition(setFrame.matrixWorld);
    this.plane.setFromNormalAndCoplanarPoint(normalOut, floorPoint);
    const onFloor = this.raycaster.ray.intersectPlane(this.plane, floorPoint);
    if (onFloor) {
      const distance = origin.distanceTo(floorPoint);
      if (distance >= NEAR_M && distance <= MAX_DISTANCE_M && (!best || distance < best.distanceM)) {
        best = { point: floorPoint.toArray() as [number, number, number], surface: 'floor', distanceM: distance };
      }
    }
    this.hit = best;
    this.target = this.castObjects(best?.distanceM ?? MAX_DISTANCE_M);
    this.draw();
  }

  /**
   * The placed object the centre ray meets first, nearer than `beyondM`: a
   * box test first, so a large model's triangles are cast only when its box is hit.
   */
  private castObjects(beyondM: number): SceneObject | null {
    let best: SceneObject | null = null;
    let bestM = beyondM;
    const ray = this.raycaster.ray;
    for (const object of this.deps.objects?.() ?? []) {
      if (!object.placed || !isShown(object.wrapper)) continue;
      object.wrapper.updateWorldMatrix(true, true);
      if (!ray.intersectBox(this.objectBox.setFromObject(object.model), this.boxHit)) continue;
      if (ray.origin.distanceTo(this.boxHit) >= bestM) continue;
      const hit = this.raycaster.intersectObject(object.model, true)[0];
      if (hit && hit.distance < bestM) {
        best = object;
        bestM = hit.distance;
      }
    }
    return best;
  }

  private draw(): void {
    // On a placed object the reticle turns to the cream highlight: Put back would take it.
    ((this.reticle.children[0] as THREE.Mesh).material as THREE.MeshBasicMaterial).color.set(this.open && this.target ? tokens.color.highlight : tokens.color.gold);
    const hit = this.open ? this.hit : null;
    this.reticle.visible = hit !== null;
    this.centreMarker.visible = this.open && hit === null;
    if (!hit) return;
    const { scene } = this.deps;
    scene.updateWorldMatrix(true, false);
    this.reticle.position.copy(scene.worldToLocal(local.set(...hit.point)));
    // Flat on the set's floor, a little above it; the same apparent size at any distance.
    this.reticle.position.y += RETICLE_LIFT_M;
    this.reticle.scale.setScalar(apxToMeters(RETICLE_APX, hit.distanceM, { headset: false }));
    markChromeTree(this.reticle);
  }

  /** Summons `slot` with its base on the hit, turned to the camera, in the set's frame. */
  private placeAt(slot: number, timeSec: number): void {
    const { setFrame, camera } = this.deps;
    const hit = this.hit!;
    setFrame.updateWorldMatrix(true, false);
    const point = setFrame.worldToLocal(local.set(...hit.point)).clone();
    camera.getWorldPosition(origin);
    setFrame.worldToLocal(cameraLocal.copy(origin));
    // Its front toward the camera, as the tray's miniatures turn toward the author.
    const yaw = Math.atan2(cameraLocal.x - point.x, cameraLocal.z - point.z);
    const object = this.deps.place(slot, point, yaw, timeSec);
    if (!object) {
      this.refused += 1;
      return;
    }
    this.lastPlaced = { slot, objectId: object.id, point: point.toArray(), yaw, timeSec };
    this.deps.onPlaced?.(object);
  }
}

/** Visible all the way up to the scene root. */
function isShown(object: THREE.Object3D): boolean {
  for (let node: THREE.Object3D | null = object; node; node = node.parent) if (!node.visible) return false;
  return true;
}
