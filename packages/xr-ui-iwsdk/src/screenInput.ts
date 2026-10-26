import { createSystem } from "@iwsdk/core";
import { createRayPointer, type Pointer } from "@pmndrs/pointer-events";
import { isInChrome } from "@holoim/xr-ui-core";
import { Matrix4, Object3D, Quaternion, Ray, Vector3, type Camera } from "three";

// Phone AR delivers screen taps as transient input sources (handedness
// 'none', targetRayMode 'screen' or 'transient-pointer'). IWSDK's input
// manager only drives pointers for 'left'/'right' sources and IWSDK requests
// no DOM overlay, so these taps reach nothing unless bridged. This system
// drives a @pmndrs/pointer-events ray pointer (the event system PanelUI and
// scene objects listen to) from the first screen source's target ray. A
// second finger turns the touch into a pinch: neither finger taps, and the
// spread between their rays reports a scale factor (viewer brief Q13).
//
// Every finger also has its own `ScreenTouch` record, for consumers that read
// holds (docs/features/ar-recording.md): it follows its own source whatever
// the other fingers do, and the pointer above is not involved.

// pointer-events treats a press longer than its click threshold as no click;
// phone taps run longer than mouse clicks.
const TAP_CLICK_THRESHOLD_MS = 500;

export interface ScreenTap {
  /** Target ray in world space where the finger went down. */
  ray: Ray;
  /** Whether the finger went down on a scene object that listens for pointer events. */
  hitObject: boolean;
}

/** One finger, from `selectstart` to `selectend`. */
export interface ScreenTouch {
  source: XRInputSource;
  /** `performance.now()` at `selectstart`. */
  downAt: number;
  /** Target ray in world space where the finger went down. */
  downRay: Ray;
  /**
   * The direction of the down ray in the viewer's own frame (where the finger
   * is on the screen), read from the touch event's own frame: it is the ray's
   * pose against the viewer, so a head that turned since the camera was last
   * updated reads no finger movement. Null when the viewer space was not ready
   * or the ray had no finite pose.
   */
  downViewDirection: Vector3 | null;
  /**
   * The viewer's world orientation, refreshed every animation frame while the
   * finger is down, in place (the same frame and composition as `ray`). It
   * turns `downViewDirection` back into a world direction without going
   * through a render view, which the spec lets sit rotated against the viewer.
   * Null before the first frame after the touchdown, and on a frame without a
   * finite viewer pose.
   */
  viewerQuaternion: Quaternion | null;
  /**
   * Target ray in world space, refreshed every frame while the finger is down,
   * in place (clone it to keep one). A frame without a finite pose leaves the
   * last finite ray.
   */
  ray: Ray;
  /**
   * The finger went down on chrome: the pointer's hit at down is an object
   * that is, or descends from, one flagged with `CHROME_FLAG`. A hit on a
   * hologram or on nothing is not chrome. False for a finger that was not the
   * first, which has no pointer hit.
   */
  beganOnChrome: boolean;
  /** Whether the finger went down on a scene object that listens for pointer events (as `ScreenTap.hitObject`). */
  hitObject: boolean;
  /** The finger is, or was, one of a pinch. */
  pinched: boolean;
}

export interface ScreenTouchEnd {
  /** The finger was part of a pinch, or the session ended while it was down. */
  cancelled: boolean;
}

function isScreenSource(source: XRInputSource): boolean {
  return source.targetRayMode === "screen" || source.targetRayMode === "transient-pointer";
}

/**
 * The distance in CSS px between where two world-space rays point, as seen
 * from a camera: each direction is projected through the camera into
 * normalised device coordinates and scaled by the viewport. Only directions
 * count, not origins, so a camera that walks while both rays keep following
 * the same finger reads no distance. Rays pointing behind the camera give no
 * meaningful value.
 */
export function screenDistancePx(a: Ray, b: Ray, camera: Camera, viewport: { width: number; height: number }): number {
  const inverse = new Matrix4().extractRotation(camera.matrixWorld).invert();
  const project = (ray: Ray): Vector3 => ray.direction.clone().applyMatrix4(inverse).applyMatrix4(camera.projectionMatrix);
  const from = project(a);
  const to = project(b);
  return Math.hypot(((to.x - from.x) * viewport.width) / 2, ((to.y - from.y) * viewport.height) / 2);
}

export class ScreenInputSystem extends createSystem() {
  /** Called after every tap, after the scene received its pointer events. */
  onTap: ((tap: ScreenTap) => void) | null = null;
  /** A pinch began (a second finger came down). */
  onPinchStart: (() => void) | null = null;
  /** Each frame of a pinch: the fingers' spread over their spread when the pinch began. */
  onPinch: ((factor: number) => void) | null = null;
  /** A finger came down (every finger, each with its own touch). */
  onTouchStart: ((touch: ScreenTouch) => void) | null = null;
  /** Each frame a finger is down, after its ray was refreshed. */
  onTouchMove: ((touch: ScreenTouch) => void) | null = null;
  /** A finger lifted or the session ended, before `onTap`. */
  onTouchEnd: ((touch: ScreenTouch, end: ScreenTouchEnd) => void) | null = null;
  /** Whether a pointer hit is chrome, for `beganOnChrome`. Defaults to the flag and its ancestors. */
  isChromeHit: (object: Object3D) => boolean = isInChrome;
  /** Set from a second finger down until every finger is up. */
  private pinch: { sources: [XRInputSource, XRInputSource]; startAngle: number } | null = null;
  private pinched = false;
  private readonly raySpace = new Object3D();
  private pointer!: Pointer;
  private readonly active = new Set<XRInputSource>();
  /** Fingers with a pose when they came down; a subset of `active`. */
  private readonly touches = new Map<XRInputSource, ScreenTouch>();
  private session: XRSession | null = null;
  /** The session's viewer reference space, for `viewDirection`; null until it resolves. */
  private viewerSpace: XRReferenceSpace | null = null;
  private downRay: Ray | null = null;
  private downHit = false;
  private readonly poseMatrix = new Matrix4();
  private readonly scratchPosition = new Vector3();
  private readonly scratchScale = new Vector3();

  init(): void {
    this.player.add(this.raySpace);
    this.pointer = createRayPointer(() => this.camera, { current: this.raySpace }, {}, { clickThresholdMs: TAP_CLICK_THRESHOLD_MS }, "touch");
    const onSessionStart = (): void => this.attach(this.xrManager.getSession());
    const onSessionEnd = (): void => this.attach(null);
    this.xrManager.addEventListener("sessionstart", onSessionStart);
    this.xrManager.addEventListener("sessionend", onSessionEnd);
    this.attach(this.xrManager.getSession());
    this.cleanupFuncs.push(
      () => this.xrManager.removeEventListener("sessionstart", onSessionStart),
      () => this.xrManager.removeEventListener("sessionend", onSessionEnd),
      () => this.attach(null),
      () => this.raySpace.removeFromParent()
    );
  }

  update(): void {
    if (this.active.size === 0 || !this.xrFrame) return;
    this.refreshTouches(this.xrFrame);
    this.updatePointer(this.xrFrame);
    for (const touch of [...this.touches.values()]) this.onTouchMove?.(touch);
  }

  /**
   * Refreshes every finger's `ray` from `frame`. `update` does this each step
   * inside an XR frame; a clock that steps outside XR frames (capture's manual
   * clock) calls it from the frame itself, so its steps read the latest ray.
   */
  refreshTouches(frame: XRFrame): void {
    for (const touch of this.touches.values()) {
      this.followTouch(frame, touch);
      this.followViewer(frame, touch);
    }
  }

  private updatePointer(frame: XRFrame): void {
    if (this.pinch) {
      const angle = this.spread(frame, this.pinch.sources);
      if (angle !== null && this.pinch.startAngle > 0) this.onPinch?.(angle / this.pinch.startAngle);
      return;
    }
    // A held finger keeps moving the pointer (drag, scrub).
    if (this.pinched) return;
    for (const source of this.active) this.aim(frame, source);
  }

  /** The angle between two fingers' target rays, which grows with their spread on the screen. */
  private spread(frame: XRFrame, sources: readonly XRInputSource[]): number | null {
    const refSpace = this.xrManager.getReferenceSpace();
    if (!refSpace) return null;
    const directions: Vector3[] = [];
    for (const source of sources) {
      const pose = frame.getPose(source.targetRaySpace, refSpace);
      if (!pose) return null;
      const { x, y, z, w } = pose.transform.orientation;
      directions.push(new Vector3(0, 0, -1).applyQuaternion({ x, y, z, w } as never));
    }
    return directions[0]!.angleTo(directions[1]!);
  }

  private attach(session: XRSession | null): void {
    if (this.session === session) return;
    this.session?.removeEventListener("selectstart", this.onSelectStart as EventListener);
    this.session?.removeEventListener("selectend", this.onSelectEnd as EventListener);
    const ended = [...this.touches.values()];
    this.active.clear();
    this.touches.clear();
    this.pinch = null;
    this.pinched = false;
    this.session = session;
    this.viewerSpace = null;
    session?.requestReferenceSpace("viewer").then(
      (space) => {
        if (this.session === session) this.viewerSpace = space;
      },
      () => {}
    );
    session?.addEventListener("selectstart", this.onSelectStart as EventListener);
    session?.addEventListener("selectend", this.onSelectEnd as EventListener);
    for (const touch of ended) this.onTouchEnd?.(touch, { cancelled: true });
  }

  private aim(frame: XRFrame, source: XRInputSource): boolean {
    const refSpace = this.xrManager.getReferenceSpace();
    const pose = refSpace ? frame.getPose(source.targetRaySpace, refSpace) : undefined;
    if (!pose || !isFiniteMatrix(pose.transform.matrix)) return false;
    this.raySpace.matrix.fromArray(pose.transform.matrix);
    this.raySpace.matrix.decompose(this.raySpace.position, this.raySpace.quaternion, this.raySpace.scale);
    this.raySpace.updateMatrixWorld(true);
    this.pointer.move(this.scene, { timeStamp: performance.now() });
    return true;
  }

  /** Writes a source's target ray in world space into `ray`; false when its pose is missing or not finite. */
  private worldRay(frame: XRFrame, source: XRInputSource, ray: Ray): boolean {
    const refSpace = this.xrManager.getReferenceSpace();
    const pose = refSpace ? frame.getPose(source.targetRaySpace, refSpace) : undefined;
    if (!pose || !isFiniteMatrix(pose.transform.matrix)) return false;
    // The ray space is a child of the player: the same transform `aim` gives it.
    this.poseMatrix.fromArray(pose.transform.matrix).premultiply(this.player.matrixWorld);
    ray.origin.setFromMatrixPosition(this.poseMatrix);
    ray.direction.set(0, 0, -1).transformDirection(this.poseMatrix);
    return true;
  }

  /**
   * A source's target ray direction in the viewer's own frame, from `frame`; null without a viewer space or a finite pose.
   * The ray is read against the viewer space, not through `getViewerPose`, which a touch event's frame refuses
   * (it is not an animation frame); both poses of the pair come from the one frame.
   */
  private viewDirection(frame: XRFrame, source: XRInputSource): Vector3 | null {
    const pose = this.viewerSpace ? frame.getPose(source.targetRaySpace, this.viewerSpace) : undefined;
    if (!pose || !isFiniteMatrix(pose.transform.matrix)) return null;
    return new Vector3(0, 0, -1).transformDirection(this.poseMatrix.fromArray(pose.transform.matrix));
  }

  private followTouch(frame: XRFrame, touch: ScreenTouch): void {
    this.worldRay(frame, touch.source, touch.ray);
  }

  /** Refreshes `viewerQuaternion` from an animation frame (`getViewerPose` is illegal on a touch event's frame, so only `refreshTouches` calls this). */
  private followViewer(frame: XRFrame, touch: ScreenTouch): void {
    const refSpace = this.xrManager.getReferenceSpace();
    let pose: XRViewerPose | null | undefined;
    try {
      pose = refSpace ? frame.getViewerPose(refSpace) : undefined;
    } catch {
      // Not an animation frame (InvalidStateError): no viewer pose to read.
    }
    if (!pose || !isFiniteMatrix(pose.transform.matrix)) {
      touch.viewerQuaternion = null;
      return;
    }
    // Composed as `worldRay` composes the target ray: the pose, premultiplied by the player.
    this.poseMatrix.fromArray(pose.transform.matrix).premultiply(this.player.matrixWorld);
    const quaternion = touch.viewerQuaternion ?? new Quaternion();
    this.poseMatrix.decompose(this.scratchPosition, quaternion, this.scratchScale);
    touch.viewerQuaternion = quaternion;
  }

  private beginTouch(frame: XRFrame, source: XRInputSource, extra: Pick<ScreenTouch, "downRay" | "beganOnChrome" | "hitObject">): void {
    const ray = extra.downRay.clone();
    const touch: ScreenTouch = { source, downAt: performance.now(), ray, downViewDirection: this.viewDirection(frame, source), viewerQuaternion: null, pinched: this.pinched, ...extra };
    this.touches.set(source, touch);
    this.followTouch(frame, touch);
    this.onTouchStart?.(touch);
  }

  private readonly onSelectStart = (event: XRInputSourceEvent): void => {
    if (!isScreenSource(event.inputSource)) return;
    if (this.active.size === 1 && !this.pinched) {
      // A second finger: the first one's press becomes a pinch, not a tap or a drag.
      const first = [...this.active][0]!;
      this.active.add(event.inputSource);
      this.pointer.cancel({ timeStamp: performance.now() });
      this.downRay = null;
      this.pinched = true;
      const sources: [XRInputSource, XRInputSource] = [first, event.inputSource];
      this.pinch = { sources, startAngle: this.spread(event.frame, sources) ?? 0 };
      const firstTouch = this.touches.get(first);
      if (firstTouch) firstTouch.pinched = true;
      this.beginFurtherTouch(event);
      this.onPinchStart?.();
      return;
    }
    if (this.pinched || !this.aim(event.frame, event.inputSource)) {
      if (this.pinched) {
        this.active.add(event.inputSource);
        this.beginFurtherTouch(event);
      }
      return;
    }
    this.active.add(event.inputSource);
    const origin = this.raySpace.getWorldPosition(new Vector3());
    this.downRay = new Ray(origin, new Vector3(0, 0, -1).transformDirection(this.raySpace.matrixWorld));
    // Rays that meet nothing end on pointer-events' void object.
    const hitObject = this.pointer.getIntersection()?.object as (Object3D & { isVoidObject?: boolean }) | undefined;
    this.downHit = Boolean(hitObject && !hitObject.isVoidObject);
    this.beginTouch(event.frame, event.inputSource, {
      downRay: this.downRay.clone(),
      beganOnChrome: Boolean(hitObject && !hitObject.isVoidObject && this.isChromeHit(hitObject)),
      hitObject: this.downHit
    });
    this.pointer.down({ timeStamp: performance.now(), button: 0 });
  };

  /** A finger that is not the pointer's: it has a touch of its own, but no pointer hit. */
  private beginFurtherTouch(event: XRInputSourceEvent): void {
    const downRay = new Ray();
    if (!this.worldRay(event.frame, event.inputSource, downRay)) return;
    this.beginTouch(event.frame, event.inputSource, { downRay, beganOnChrome: false, hitObject: false });
  }

  private readonly onSelectEnd = (event: XRInputSourceEvent): void => {
    if (!this.active.delete(event.inputSource)) return;
    const touch = this.touches.get(event.inputSource);
    this.touches.delete(event.inputSource);
    if (touch) {
      this.followTouch(event.frame, touch);
      this.onTouchEnd?.(touch, { cancelled: touch.pinched });
    }
    if (this.pinched) {
      // The pinch ends with its first lifted finger; no finger taps until all are up.
      this.pinch = null;
      if (this.active.size === 0) this.pinched = false;
      return;
    }
    this.aim(event.frame, event.inputSource);
    this.pointer.up({ timeStamp: performance.now(), button: 0 });
    this.pointer.exit({ timeStamp: performance.now() });
    const ray = this.downRay;
    this.downRay = null;
    if (ray) this.onTap?.({ ray, hitObject: this.downHit });
  };
}

function isFiniteMatrix(matrix: Float32Array): boolean {
  for (let i = 0; i < 16; i++) if (!Number.isFinite(matrix[i])) return false;
  return true;
}
