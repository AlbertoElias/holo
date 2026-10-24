import { createSystem, Grabbed, type Entity } from "@iwsdk/core";
import { playbackLabel, type HologramControlActions } from "@holoim/xr-ui-core";
import { FootControls, HandDock, StatusLine, phoneMetresPerApx, targetMetrics, type XrUiTarget } from "@holoim/xr-ui-iwsdk";
import { Box3, Vector3, type Object3D } from "three";

import { HologramPlayback, restartHologram, seekHologram, setHologramPlaying } from "./hologramPlayback";
import { addTwoHandGrab } from "./twoHandGrab";
import { viewerContext } from "./viewerContext";

// The viewer's XR interface (docs/features/viewer-xr-interface.md, step 3):
// foot controls at the focused hologram's foot, the periphery status line,
// and Exit in the hand dock (headset) or the bottom dock (phone), all from
// @holoim/xr-ui-iwsdk. Built when the session starts, removed when it ends.

/** Gap between the hologram's pointer box and the chip, so grab and controls never share a target. */
const CHIP_CLEARANCE_M = 0.05;

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
}

export class HologramControlsSystem extends createSystem() {
  options: HologramControlsOptions = { exit: () => this.world.exitXR() };
  private ui: Ui | null = null;
  private placedSequence = -1;
  /** Horizontal half-diagonal of the hologram's pointer box at recorded scale. */
  private footprintRadius: number | null = null;

  init(): void {
    const onSessionEnd = (): void => this.teardown();
    this.xrManager.addEventListener("sessionend", onSessionEnd);
    this.cleanupFuncs.push(() => this.xrManager.removeEventListener("sessionend", onSessionEnd), () => this.teardown());
  }

  /** Probe readings for the e2e spec. */
  probe(): unknown {
    if (!this.ui) return null;
    return { target: this.ui.target, foot: this.ui.foot.probe(), status: this.ui.status.probe(), dock: this.ui.dock.probe() };
  }

  update(): void {
    const c = viewerContext(this.world);
    const hologram = c.focused;
    const object = hologram?.object3D;
    if (!hologram || !object || !this.xrFrame) return;
    if (!this.ui) {
      const target = this.detectTarget();
      if (!target) return;
      this.ui = this.build(hologram, target);
    }
    const { foot, status, dock } = this.ui;

    const placed = c.placement.stage !== "searching" && object.visible;
    foot.setVisible(placed);
    if (!placed) {
      status.set(null);
      return;
    }
    object.getWorldPosition(anchor);
    this.player.head.getWorldPosition(headPosition);
    if (c.placement.sequence !== this.placedSequence) {
      // The chip turns to the viewer only when the hologram is placed or recentered.
      this.placedSequence = c.placement.sequence;
      foot.faceViewer(anchor, headPosition);
    }
    const scale = object.scale.x;
    foot.follow(anchor, (this.footprint(object) * scale) + CHIP_CLEARANCE_M);

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
    // State only: the line reports a paused hologram and holds no control.
    const label = playbackLabel(state);
    status.set(label.prefix ? { prefix: label.prefix, body: label.time } : null);
    // The dock hides while the hand it sits on grabs (brief: palm dock vs two-hand grab).
    dock.setVisible(!hologram.hasComponent(Grabbed));
    dock.update();
  }

  private build(hologram: Entity, target: XrUiTarget): Ui {
    const object = hologram.object3D!;
    // A phone has no hands to grab with; its taps pause and place instead.
    if (target !== "ar-phone") addTwoHandGrab(hologram, this.player.gripSpaces);
    const actions: HologramControlActions = {
      togglePlay: () => setHologramPlaying(hologram, !hologram.getValue(HologramPlayback, "playing")),
      restart: () => restartHologram(hologram),
      seek: (clipTime) => seekHologram(hologram, clipTime),
      recenter: () => {
        // Default placement and recorded scale.
        object.scale.setScalar(1);
        viewerContext(this.world).recenterRequested = true;
      },
      resetScale: () => object.scale.setScalar(1)
    };
    const camera = this.camera;
    // The XR view's projection, not the page camera's: flat sizes are pixels of the image the phone shows.
    const fovy = 2 * Math.atan(1 / this.viewProjectionYScale());
    const foot = new FootControls(this.world, {
      target,
      actions,
      ...(target === "ar-phone" ? { metresPerApx: phoneMetresPerApx(fovy, window.innerHeight), viewportWidthCss: window.innerWidth } : {})
    });
    const status = new StatusLine(this.world, this.player.head, targetMetrics(target).chipOpacity);
    const exit = { id: "exit", glyph: "exit" as const, label: "Exit", onSelect: () => this.options.exit() };
    const dock = target === "ar-phone"
      ? new HandDock(this.world, { kind: "phone", camera, verticalFovRad: fovy, viewportHeightCss: window.innerHeight, viewportWidthCss: window.innerWidth }, [exit])
      // Handedness defaults to right, so the dock sits on the left hand or controller.
      : new HandDock(this.world, { kind: "hand", space: this.player.gripSpaces.left, ownPointerIds: this.handPointerIds("left") }, [exit]);
    this.placedSequence = -1;
    return { target, foot, status, dock };
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

  /** IWSDK keeps each hand's ray, grab and touch pointers private; their ids are read at runtime. */
  private handPointerIds(hand: "left" | "right"): number[] {
    const pointers = this.input.xr.multiPointers[hand] as unknown as Partial<Record<"ray" | "grab" | "touch", { pointer?: { id?: number } }>>;
    return (["ray", "grab", "touch"] as const).flatMap((kind) => {
      const id = pointers[kind]?.pointer?.id;
      return typeof id === "number" ? [id] : [];
    });
  }

  private footprint(object: Object3D): number {
    if (this.footprintRadius === null) {
      const hitBox = object.getObjectByName("HologramHitBox");
      const size = new Box3().setFromObject(hitBox ?? object).getSize(new Vector3()).divideScalar(object.scale.x || 1);
      this.footprintRadius = Math.hypot(size.x, size.z) / 2;
    }
    return this.footprintRadius;
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
    this.ui = null;
  }
}
