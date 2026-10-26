import { edgeFrame, fitCloche, type ClocheShape, type SootInput, type ViewTarget } from "@holoim/xr-ui-core";
import { ThreeCloche } from "@holoim/xr-ui-three";
import { Vector2, Vector3 } from "three";
import type { AnimationClip, Camera, Object3D, WebGLRenderer } from "three";

import { BubbleAura } from "../ar/bubbleAura";
import { drawnPoints, motionPoints, recordedBubble } from "../hologram/drawnPoints";
import { applySphereClipping, type SphereClipping, type SphereClipResult } from "../hologram/sphereClipping";

// A placed hologram's bubble in the IWSDK shells, as the R3F AR view draws
// it: geometry outside the recorded bubble clipped away, the aura, and the
// cloche (styleguide 3.4, 9.1, 9.2) in place of the bubble's old glass. The
// aura and the cloche live in the hologram's placed and scaled space, so
// placing, grabbing and rescaling carry them along; the take's bubble stays
// put there.

/** Width of the soft fade inside the bubble's edge, in metres (as the R3F view). */
const CLIP_FALLOFF_M = 0.2;

export interface BubbleFrame {
  renderer: WebGLRenderer;
  /** The camera the page draws with; the XR camera is read while presenting. */
  camera: Camera;
  timeS: number;
  deltaMs: number;
  target: ViewTarget;
  /** Spark focus (8.2): the hologram nearest the head's forward ray. */
  inFocus: boolean;
  reducedMotion: boolean;
  soot: SootInput;
}

export class HologramBubble {
  readonly clipping: SphereClipping;
  readonly aura = new BubbleAura();
  readonly cloche: ThreeCloche | null;
  private readonly scratch = { eye: new Vector3(), centre: new Vector3(), scale: new Vector3(), buffer: new Vector2() };

  /**
   * `space` is the placed hologram's object; `model` the recorded scene under
   * it, whose recorded floor is at the space's origin (B-022).
   */
  constructor(space: Object3D, model: Object3D, clips: readonly AnimationClip[], seed: string) {
    this.clipping = applySphereClipping(model, {
      falloffWidth: CLIP_FALLOFF_M,
      safeMode: true,
      onError: (error) => console.warn("[xr-viewer] Bubble clipping fallback triggered.", error)
    });
    // Pointers aim through them at the body's box (the hologram's pointer target).
    noPointer(this.aura.group);
    space.add(this.aura.group);
    this.cloche = fitBubbleCloche(space, model, clips, seed);
    if (this.cloche) {
      noPointer(this.cloche.group);
      space.add(this.cloche.group);
      // The cloche is the bubble's look now; the recorded sphere's old glass is not drawn.
      const sphere = model.getObjectByName("RecordedBubbleSphere");
      if (sphere) sphere.visible = false;
    }
  }

  get bubble(): SphereClipResult {
    return this.clipping.result;
  }

  get shape(): ClocheShape | null {
    return this.cloche?.shape ?? null;
  }

  update(frame: BubbleFrame): void {
    this.clipping.sync();
    this.aura.update(this.clipping.result, frame.timeS, frame.deltaMs);
    const cloche = this.cloche;
    if (!cloche) return;
    const { group, shape } = cloche;
    group.position.set(shape.base.x, shape.base.y, shape.base.z);
    group.updateWorldMatrix(true, false);
    const { renderer } = frame;
    const presenting = renderer.xr.isPresenting;
    const viewer = presenting ? renderer.xr.getCamera() : frame.camera;
    const eye = viewer.getWorldPosition(this.scratch.eye);
    // The dome's wider radius on screen, in device pixels: what the rim's widths are shares of.
    const centre = group.localToWorld(this.scratch.centre.set(0, shape.radii.y / 2, 0));
    const worldScale = group.getWorldScale(this.scratch.scale).x;
    const distance = Math.max(eye.distanceTo(centre), 1e-3);
    const projection = ((presenting ? renderer.xr.getCamera().cameras[0] : undefined) ?? viewer).projectionMatrix.elements[5] ?? 1;
    const heightPx = renderer.getDrawingBufferSize(this.scratch.buffer).y;
    const wider = Math.max(shape.radii.x, shape.radii.y, shape.radii.z) * worldScale;
    const radiusPx = (wider / distance) * (heightPx / 2) * projection;
    const edge = edgeFrame(frame.target, {
      timeMs: frame.timeS * 1000,
      recording: false,
      inFocus: frame.inFocus,
      reducedMotion: frame.reducedMotion,
      soot: frame.soot
    });
    cloche.update(edge, { eye: cloche.eyeInShape(eye), radiusPx, timeS: frame.timeS, inFocus: frame.inFocus, reducedMotion: frame.reducedMotion });
  }

  dispose(): void {
    this.clipping.dispose();
    this.aura.dispose();
    if (this.cloche) {
      this.cloche.group.removeFromParent();
      this.cloche.dispose();
    }
  }
}

function noPointer(object: Object3D): void {
  (object as Object3D & { pointerEvents?: string }).pointerEvents = "none";
}

/**
 * Fitted once, in the placed space, to what the hologram draws inside its
 * bubble and the author's reach through the take; its foot on the recorded
 * floor (B-022). Null when there is nothing to fit.
 */
function fitBubbleCloche(space: Object3D, model: Object3D, clips: readonly AnimationClip[], seed: string): ThreeCloche | null {
  space.updateWorldMatrix(true, true);
  const bubble = recordedBubble(model, space);
  const points = [...drawnPoints(model, bubble, space), ...motionPoints(model, clips, { into: space, bubble })];
  const shape = fitCloche(points, { floorY: 0 });
  return shape ? new ThreeCloche({ seed, shape }) : null;
}
