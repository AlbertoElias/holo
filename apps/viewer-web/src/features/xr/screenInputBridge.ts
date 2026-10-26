import { createSystem } from "@iwsdk/core";
import { createRayPointer, type Pointer } from "@pmndrs/pointer-events";
import { Object3D, Ray, Vector3 } from "three";

// Phone AR delivers screen taps as transient input sources (handedness
// 'none', targetRayMode 'screen' or 'transient-pointer'). IWSDK's input
// manager only drives pointers for 'left'/'right' sources and IWSDK requests
// no DOM overlay, so these taps reach nothing unless bridged. This system
// drives a @pmndrs/pointer-events ray pointer (the event system PanelUI and
// scene objects listen to) from each screen source's target ray. A second
// finger turns the touch into a pinch: neither finger taps, and the spread
// between their rays reports a scale factor (brief Q13).

// pointer-events treats a press longer than its click threshold as no click;
// phone taps run longer than mouse clicks.
const TAP_CLICK_THRESHOLD_MS = 500;

export interface ScreenTap {
  /** Target ray in world space where the finger went down. */
  ray: Ray;
  /** Whether the finger went down on a scene object that listens for pointer events. */
  hitObject: boolean;
}

function isScreenSource(source: XRInputSource): boolean {
  return source.targetRayMode === "screen" || source.targetRayMode === "transient-pointer";
}

export class ScreenInputSystem extends createSystem() {
  /** Called after every tap, after the scene received its pointer events. */
  onTap: ((tap: ScreenTap) => void) | null = null;
  /** A pinch began (a second finger came down). */
  onPinchStart: (() => void) | null = null;
  /** Each frame of a pinch: the fingers' spread over their spread when the pinch began. */
  onPinch: ((factor: number) => void) | null = null;
  /** Set from a second finger down until every finger is up. */
  private pinch: { sources: [XRInputSource, XRInputSource]; startAngle: number } | null = null;
  private pinched = false;
  private readonly raySpace = new Object3D();
  private pointer!: Pointer;
  private readonly active = new Set<XRInputSource>();
  private session: XRSession | null = null;
  private downRay: Ray | null = null;
  private downHit = false;

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
    if (this.pinch) {
      const angle = this.spread(this.xrFrame, this.pinch.sources);
      if (angle !== null && this.pinch.startAngle > 0) this.onPinch?.(angle / this.pinch.startAngle);
      return;
    }
    // A held finger keeps moving the pointer (drag, scrub).
    if (this.pinched) return;
    for (const source of this.active) this.aim(this.xrFrame, source);
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
    this.active.clear();
    this.pinch = null;
    this.pinched = false;
    this.session = session;
    session?.addEventListener("selectstart", this.onSelectStart as EventListener);
    session?.addEventListener("selectend", this.onSelectEnd as EventListener);
  }

  private aim(frame: XRFrame, source: XRInputSource): boolean {
    const refSpace = this.xrManager.getReferenceSpace();
    const pose = refSpace ? frame.getPose(source.targetRaySpace, refSpace) : undefined;
    if (!pose) return false;
    this.raySpace.matrix.fromArray(pose.transform.matrix);
    this.raySpace.matrix.decompose(this.raySpace.position, this.raySpace.quaternion, this.raySpace.scale);
    this.raySpace.updateMatrixWorld(true);
    this.pointer.move(this.scene, { timeStamp: performance.now() });
    return true;
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
      this.onPinchStart?.();
      return;
    }
    if (this.pinched || !this.aim(event.frame, event.inputSource)) {
      if (this.pinched) this.active.add(event.inputSource);
      return;
    }
    this.active.add(event.inputSource);
    const origin = this.raySpace.getWorldPosition(new Vector3());
    this.downRay = new Ray(origin, new Vector3(0, 0, -1).transformDirection(this.raySpace.matrixWorld));
    // Rays that meet nothing end on pointer-events' void object.
    const hitObject = this.pointer.getIntersection()?.object as (Object3D & { isVoidObject?: boolean }) | undefined;
    this.downHit = Boolean(hitObject && !hitObject.isVoidObject);
    this.pointer.down({ timeStamp: performance.now(), button: 0 });
  };

  private readonly onSelectEnd = (event: XRInputSourceEvent): void => {
    if (!this.active.delete(event.inputSource)) return;
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
