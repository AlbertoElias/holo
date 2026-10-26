import { tokens } from "@holoim/design-tokens";
import { angleBetweenDegrees, arCompositorFromUserAgent, nearestToForwardRay, relativeLuminance, VIEW_TARGETS, type SootInput, type ViewTarget } from "@holoim/xr-ui-core";
import { createSystem } from "@iwsdk/core";
import { Vector3 } from "three";
import type { Material, Mesh, Object3D } from "three";

import { ArSoot } from "../ar/arSoot";
import { DepthOcclusion } from "../ar/depthOcclusion";
import { viewerContext } from "./viewerContext";

// Drives every placed hologram's bubble (`HologramBubble`): clipping, aura
// and cloche, with sparks on the one nearest the head's forward ray (8.2),
// the char from the room (3.2), and, in AR, depth occlusion behind real
// surfaces with the controls exempt from it.

/** VR's room behind the edge is the blue-hour horizon band (9.1: the flat-screen rule from its luminance). */
const VR_SOOT: SootInput = { groundLuminance: relativeLuminance(tokens.color.ground.grey) };

/** The XR UI roots: drawn over real surfaces, never hidden by them. */
const CONTROL_ROOT = /^(FootControls|StatusLine|HandDock|FocusRing|AimRays|Gallery)/;

export interface BubbleSystemProbe {
  /** Depth occlusion asked for and drawing this frame. */
  occlusion: { requested: boolean; drawing: boolean };
  sootOn: boolean | null;
  sparkFocusId: string | null;
}

export class HologramBubbleSystem extends createSystem() {
  /** Whether the session should occlude holograms behind real surfaces (it asked for depth sensing). */
  occlusionRequested = false;
  private readonly occlusion = new DepthOcclusion();
  private readonly soot = new ArSoot();
  private readonly reducedMotion = typeof matchMedia === "function" ? matchMedia("(prefers-reduced-motion: reduce)") : null;
  private occluding = false;
  private sparkFocusId: string | null = null;
  private readonly head = new Vector3();
  private readonly forward = new Vector3();
  private readonly toHologram = new Vector3();

  probe(): BubbleSystemProbe {
    return { occlusion: { requested: this.occlusionRequested, drawing: this.occluding }, sootOn: this.soot.sootOn, sparkFocusId: this.sparkFocusId };
  }

  update(delta: number, time: number): void {
    const c = viewerContext(this.world);
    const renderer = this.world.renderer;
    const isAr = c.mode === "ar";
    if (isAr) {
      this.soot.attach(renderer.xr.getSession());
      this.soot.update(this.xrFrame ?? undefined);
      const occluding = this.occlusion.update(renderer, this.occlusionRequested);
      if (occluding) this.exemptControls();
      this.occluding = occluding;
    }
    const target = this.viewTarget(isAr);
    const soot: SootInput = isAr ? { arSootOn: this.soot.sootOn } : VR_SOOT;
    this.sparkFocusId = this.nearestToHeadRay();
    const reducedMotion = this.reducedMotion?.matches ?? false;
    for (const record of c.placed) {
      if (!record.entity.object3D?.visible) continue;
      record.bubble.update({
        renderer,
        camera: this.camera,
        timeS: time,
        deltaMs: delta * 1000,
        target,
        inFocus: record.id === this.sparkFocusId,
        reducedMotion,
        soot
      });
    }
  }

  private viewTarget(isAr: boolean): ViewTarget {
    if (!isAr) return VIEW_TARGETS.vr;
    const compositor = arCompositorFromUserAgent(navigator.userAgent);
    if (compositor === "questPassthrough") return VIEW_TARGETS.questPassthrough;
    if (compositor === "androidChrome") return VIEW_TARGETS.androidChrome;
    return { kind: "ar", compositor, headset: viewerContext(this.world).target !== "ar-phone" };
  }

  /** Spark focus: the placed hologram nearest the head's forward ray, none in peripheral vision. */
  private nearestToHeadRay(): string | null {
    const head = this.player.head;
    head.getWorldPosition(this.head);
    head.getWorldDirection(this.forward).negate();
    const candidates = viewerContext(this.world).placed.flatMap((record) => {
      const object = record.entity.object3D;
      if (!object?.visible) return [];
      const shape = record.bubble.shape;
      const centre = object.localToWorld(this.toHologram.set(shape?.base.x ?? 0, (shape?.radii.y ?? 1.6) / 2, shape?.base.z ?? 0));
      const direction = centre.sub(this.head);
      return [{ id: record.id, angleDegrees: angleBetweenDegrees(this.forward.toArray(), direction.toArray()) }];
    });
    return nearestToForwardRay(candidates);
  }

  /** The controls draw over the depth the occlusion pass wrote: a real table never hides the foot chip. */
  private exemptControls(): void {
    for (const root of this.world.scene.children.flatMap(controlRoots)) {
      root.traverse((object) => {
        const material = (object as Mesh).material as Material | Material[] | undefined;
        for (const each of Array.isArray(material) ? material : material ? [material] : []) each.depthTest = false;
      });
    }
  }
}

function controlRoots(object: Object3D): Object3D[] {
  if (CONTROL_ROOT.test(object.name)) return [object];
  return object.children.flatMap(controlRoots);
}
