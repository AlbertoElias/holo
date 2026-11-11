import type { Vector3 } from "three";

import type { EarPose } from "./gltfAudio";

// Where the ear sits for a hologram seen through the feed's portal. The
// Follow camera stands several metres back to frame the whole cloche, so an
// ear at the camera hears every placed sound faint and nearly centred. The
// ear looks the camera's way from the point the camera looks at; its
// distance from that point is the camera's own, pulled in: fully zoomed in
// it is exactly the camera (eye level near the author), and at Follow it is
// HEAR_OUTSIDE_M away. One smooth function of the camera's distance, so the
// Follow view, the zoom and the eased return all hear continuously.

export type PortalEarPlacement = "camera" | "rides-zoom" | "middle";

/** The flat-screen ear (product decision, docs/features/archive/positional-audio.md). */
export const PORTAL_EAR: PortalEarPlacement = "rides-zoom";

/** How far from the view's middle the ear stands at Follow. */
export const HEAR_OUTSIDE_M = 2.5;

/** The ear's distance from the target for a camera `distance` away, with the zoom running from `inside` to `outside`. */
export function hearingDistance(distance: number, inside: number, outside: number, placement: PortalEarPlacement = PORTAL_EAR): number {
  if (placement === "camera") return distance;
  if (placement === "middle") return 0;
  if (!(inside > 0) || !(outside > inside) || outside <= HEAR_OUTSIDE_M || distance <= inside) return distance;
  const k = Math.log(HEAR_OUTSIDE_M / inside) / Math.log(outside / inside);
  return inside * (distance / inside) ** k;
}

/**
 * The portal's ear, written into `out`: `camera` is the camera's ear (its
 * position and orientation), `target` the point it looks at.
 */
export function portalEar(camera: EarPose, target: Vector3, inside: number, outside: number, out: EarPose, placement: PortalEarPlacement = PORTAL_EAR): EarPose {
  out.forward.copy(camera.forward);
  out.up.copy(camera.up);
  const distance = camera.position.distanceTo(target);
  if (!(distance > 1e-6)) {
    out.position.copy(camera.position);
    return out;
  }
  const hear = hearingDistance(distance, inside, outside, placement);
  out.position.copy(camera.position).sub(target).multiplyScalar(hear / distance).add(target);
  return out;
}
