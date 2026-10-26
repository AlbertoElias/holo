import { createSystem, Grabbed, type Entity } from "@iwsdk/core";
import { loadHandedness } from "@holoim/ui-dom";
import { markChromeTree, nonDominantHand, playbackLabel, type Hand, type HologramControlActions } from "@holoim/xr-ui-core";
import { AimRays, FocusRing, FootControls, GRIP_PALM, HandDock, StatusLine, configureXrPointers, handPointerIds, phoneMetresPerApx, type XrUiTarget } from "@holoim/xr-ui-iwsdk";
import { Vector3, type Object3D } from "three";

import { HologramPlayback, restartHologram, seekHologram, setHologramPlaying } from "./hologramPlayback";
import { addTwoHandGrab, grabPointerIds, keepGrounded } from "./twoHandGrab";
import { focusedRecord, viewerContext, type PlacedHologram } from "./viewerContext";

// The viewer's XR interface (docs/features/viewer-xr-interface.md, steps 3
// and 4): foot controls at the focused hologram's foot, with the focus ring
// around its base, the periphery status line, and Exit in the hand dock
// (headset) or the bottom dock (phone), and the gold aim rays, all from
// @holoim/xr-ui-iwsdk, as capture's VR chrome is (step 5). The
// foot controls act on the hologram with audio focus and move with it when
// focus moves. Built when the session starts, removed when it ends.

/** Gap between the hologram's pointer box and the chip, so grab and controls never share a target. */
const CHIP_CLEARANCE_M = 0.05;
/** Frames to wait for IWSDK's grab handle before warning that grab is not grounded. */
const GROUNDING_WARN_FRAMES = 30;
/** The focus ring stands this far outside the hologram's pointer box. */
const RING_CLEARANCE_M = 0.04;

const anchor = new Vector3();
const headPosition = new Vector3();

export interface HologramControlsOptions {
  exit(): void;
}

interface Ui {
  target: XrUiTarget;
  foot: FootControls;
  status: StatusLine;
  dock: HandDock;
  /** The hand the dock rides; null on a phone. */
  dockHand: Hand | null;
  ring: FocusRing;
  /** Headsets only: a phone has no rays. */
  rays: AimRays | null;
}

export class HologramControlsSystem extends createSystem() {
  options: HologramControlsOptions = { exit: () => this.world.exitXR() };
  private ui: Ui | null = null;
  private placedSequence = -1;
  /** The hologram the foot controls are on; a focus change turns them to the viewer again. */
  private boundTo: Entity | null = null;
  private readonly grabbable = new WeakSet<Entity>();
  /** Grabbable holograms whose grab is not yet kept on the ground, with the frames waited. */
  private readonly ungrounded = new Map<Entity, number>();
  private chipMeasured = false;

  init(): void {
    const onSessionEnd = (): void => this.teardown();
    this.xrManager.addEventListener("sessionend", onSessionEnd);
    this.cleanupFuncs.push(() => this.xrManager.removeEventListener("sessionend", onSessionEnd), () => this.teardown());
  }

  /** Probe readings for the e2e spec. */
  probe(): unknown {
    if (!this.ui) return null;
    return { target: this.ui.target, foot: this.ui.foot.probe(), status: this.ui.status.probe(), dock: { ...this.ui.dock.probe(), hand: this.ui.dockHand }, ring: this.ui.ring.probe(), rays: this.ui.rays?.probe().map((ray) => ({ ...ray, hit: ray.hit ? ray.hit.name || ray.hit.type : null })) ?? [], boundTo: focusedRecord(viewerContext(this.world))?.id ?? null };
  }

  update(delta: number): void {
    const c = viewerContext(this.world);
    if (!this.xrFrame) return;
    if (!this.ui) {
      const target = this.detectTarget();
      if (!target) return;
      this.ui = this.build(target);
      c.target = target;
    }
    const { foot, status, dock, ring, rays } = this.ui;
    rays?.update();
    status.update(delta * 1000);
    // A phone has no hands to grab with; its taps focus, pause and place instead.
    if (this.ui.target !== "ar-phone") {
      for (const placed of c.placed) {
        if (this.grabbable.has(placed.entity)) continue;
        this.grabbable.add(placed.entity);
        addTwoHandGrab(placed.entity);
        this.ungrounded.set(placed.entity, 0);
      }
      for (const [entity, frames] of this.ungrounded) {
        if (!c.placed.some((placed) => placed.entity === entity) || keepGrounded(entity, this.player.gripSpaces)) {
          this.ungrounded.delete(entity);
          continue;
        }
        if (frames === GROUNDING_WARN_FRAMES) console.warn("[xr-viewer] two-hand grab handle missing; grab stays IWSDK's default.");
        this.ungrounded.set(entity, frames + 1);
      }
    }
    // The dock hides while the hand it sits on grabs (brief: palm dock vs two-hand grab); the other hand's grab leaves it.
    const dockPointers = this.ui.dockHand ? handPointerIds(this.world, this.ui.dockHand) : [];
    dock.setVisible(!c.placed.some((placed) => placed.entity.hasComponent(Grabbed) && grabPointerIds(placed.entity).some((id) => dockPointers.includes(id))));
    dock.update();

    const record = focusedRecord(c);
    const object = record?.entity.object3D;
    const placed = Boolean(record && object && record.placement.stage !== "searching" && object.visible);
    foot.setVisible(placed);
    if (!record || !object || !placed) {
      ring.hide();
      status.set(null);
      this.boundTo = null;
      return;
    }
    object.getWorldPosition(anchor);
    this.player.head.getWorldPosition(headPosition);
    if (record.entity !== this.boundTo || record.placement.sequence !== this.placedSequence) {
      // The chip turns to the viewer when its hologram is placed, recentered or focused (a phone's also turns each frame).
      this.boundTo = record.entity;
      this.placedSequence = record.placement.sequence;
      foot.faceViewer(anchor, headPosition);
    }
    const hologram = record.entity;
    const scale = object.scale.x;
    foot.follow(anchor, (record.footprintRadius * scale) + CHIP_CLEARANCE_M);
    ring.show(anchor, (record.footprintRadius * scale) + RING_CLEARANCE_M);

    const state = {
      playing: Boolean(hologram.getValue(HologramPlayback, "playing")),
      clipTime: hologram.getValue(HologramPlayback, "clipTime") ?? 0,
      duration: hologram.getValue(HologramPlayback, "duration") ?? 0,
      scale
    };
    foot.update(state, {
      now: performance.now(),
      // The XR camera carries the head pose (player.head is not oriented in this IWSDK build).
      head: this.camera,
      hands: this.trackedHands(),
      hologramDistanceM: Math.hypot(headPosition.x - anchor.x, headPosition.z - anchor.z)
    });
    if (!this.chipMeasured) this.measureChip();
    // State only: the line reports a paused hologram and holds no control.
    const label = playbackLabel(state);
    status.set(label.prefix ? { prefix: label.prefix, body: label.time } : null);
  }

  /** The chip's widest row, once laid out, sets how far apart placed holograms stand. */
  private measureChip(): void {
    const foot = this.ui!.foot.probe();
    if (foot.reachRow.widthApx <= 0) return;
    this.chipMeasured = true;
    viewerContext(this.world).chipWidthM = foot.reachRow.widthApx * foot.metresPerApx * foot.worldScale;
  }

  private build(target: XrUiTarget): Ui {
    // Every action acts on the focused hologram, the one the controls stand at.
    const on = (act: (record: PlacedHologram) => void) => () => {
      const record = focusedRecord(viewerContext(this.world));
      if (record) act(record);
    };
    const actions: HologramControlActions = {
      togglePlay: on(({ entity }) => setHologramPlaying(entity, !entity.getValue(HologramPlayback, "playing"))),
      restart: on(({ entity }) => restartHologram(entity)),
      seek: (clipTime) => on(({ entity }) => seekHologram(entity, clipTime))(),
      recenter: on((record) => {
        // Default placement and recorded scale.
        record.entity.object3D!.scale.setScalar(1);
        record.recenterRequested = true;
      }),
      resetScale: on(({ entity }) => entity.object3D!.scale.setScalar(1))
    };
    const camera = this.camera;
    // The XR view's projection, not the page camera's: flat sizes are pixels of the image the phone shows.
    const fovy = 2 * Math.atan(1 / this.viewProjectionYScale());
    const phoneApx = target === "ar-phone" ? phoneMetresPerApx(fovy, window.innerHeight) : null;
    viewerContext(this.world).phoneMetresPerApx = phoneApx;
    const foot = new FootControls(this.world, {
      target,
      actions,
      ...(phoneApx !== null ? { metresPerApx: phoneApx, viewportWidthCss: window.innerWidth } : {})
    });
    // The XR camera carries the head pose (player.head is not oriented in this IWSDK build).
    const status = new StatusLine(this.world, this.camera);
    const exit = { id: "exit", glyph: "exit" as const, label: "Exit", onSelect: () => this.options.exit() };
    const dock = target === "ar-phone"
      ? new HandDock(this.world, { kind: "phone", camera, verticalFovRad: fovy, viewportHeightCss: window.innerHeight, viewportWidthCss: window.innerWidth }, [exit])
      : this.handDock(exit);
    let rays: AimRays | null = null;
    if (target !== "ar-phone") {
      configureXrPointers(this.world);
      rays = new AimRays(this.world);
      // Chrome, not the recording: pixel checks and pointing skip it.
      markChromeTree(rays.group);
      this.world.scene.add(rays.group);
    }
    this.placedSequence = -1;
    this.boundTo = null;
    const ring = new FocusRing(this.world.activeLevel.value.object3D!);
    markChromeTree(ring.mesh);
    return { target, foot, status, dock, dockHand: target === "ar-phone" ? null : nonDominantHand(loadHandedness()), ring, rays };
  }

  /** On the non-dominant hand or controller, as set in the feed's settings on this device (right-handed by default). */
  private handDock(exit: ConstructorParameters<typeof HandDock>[2][number]): HandDock {
    const hand = nonDominantHand(loadHandedness());
    return new HandDock(this.world, { kind: "hand", space: this.player.gripSpaces[hand], ownPointerIds: handPointerIds(this.world, hand), palm: GRIP_PALM[hand] }, [exit]);
  }

  /**
   * VR; AR on a headset; AR on a phone, which reports screen-space interaction
   * (WebXR DOM Overlays) and a single view. Null until the viewer pose is known.
   */
  private detectTarget(): XrUiTarget | null {
    if (viewerContext(this.world).mode === "vr") return "vr";
    if ((this.xrManager.getSession() as (XRSession & { interactionMode?: string }) | null)?.interactionMode === "screen-space") return "ar-phone";
    const refSpace = this.xrManager.getReferenceSpace();
    const views = refSpace ? this.xrFrame!.getViewerPose(refSpace)?.views.length : undefined;
    if (!views) return null;
    return views === 1 ? "ar-phone" : "ar-quest";
  }

  private viewProjectionYScale(): number {
    const refSpace = this.xrManager.getReferenceSpace();
    const view = refSpace ? this.xrFrame?.getViewerPose(refSpace)?.views[0] : undefined;
    return view?.projectionMatrix[5] ?? this.camera.projectionMatrix.elements[5]!;
  }

  private trackedHands(): Object3D[] {
    const session = this.xrManager.getSession();
    if (!session) return [];
    const hands: Object3D[] = [];
    for (const source of session.inputSources) {
      if (source.handedness === "left" || source.handedness === "right") hands.push(this.player.gripSpaces[source.handedness]);
    }
    return hands;
  }

  private teardown(): void {
    if (!this.ui) return;
    this.ui.foot.dispose();
    this.ui.status.dispose();
    this.ui.dock.dispose();
    this.ui.ring.dispose();
    this.ui.rays?.dispose();
    this.ui = null;
  }
}
