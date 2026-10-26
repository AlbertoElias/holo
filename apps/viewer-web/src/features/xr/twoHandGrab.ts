import { TwoHandsGrabbable, type Entity } from "@iwsdk/core";
import { Euler, Vector3 } from "three";
import type { Object3D, Quaternion } from "three";

// Two-hand grab: move, turn and scale the hologram with both hands (grips or
// pinch), between these shares of the recorded scale (brief). Headsets only:
// IWSDK's grab handle denies ray pointers on the hologram and stays bound once
// added, so a phone, which has no hands, never gets one.
export const GRAB_SCALE_MIN = 0.1;
export const GRAB_SCALE_MAX = 2;

/** The hands whose grips hold the hologram (IWSDK's player grip spaces). */
export interface GrabHands {
  left: Object3D;
  right: Object3D;
}

export function addTwoHandGrab(entity: Entity): void {
  entity.addComponent(TwoHandsGrabbable, {
    scaleMin: [GRAB_SCALE_MIN, GRAB_SCALE_MIN, GRAB_SCALE_MIN],
    scaleMax: [GRAB_SCALE_MAX, GRAB_SCALE_MAX, GRAB_SCALE_MAX]
  });
}

type TransformState = { position: Vector3; quaternion: Quaternion; scale: Vector3; pointerAmount: number };
type HandleState = { current: TransformState; first: boolean };
type HandleStoreLike = {
  getOptions: () => { scale?: false | Record<string, unknown>; apply?: (state: HandleState, target: Object3D) => void };
  /** The pointers holding the handle now (pmndrs handle store). */
  capturedObjects?: Map<number, unknown>;
};

function handleStore(entity: Entity): HandleStoreLike | undefined {
  const handle = entity.getComponents().find((component) => component?.id === "Handle") as { data: { instance: HandleStoreLike[] } } | undefined;
  return handle?.data.instance[entity.index];
}

/** The ids of the pointers grabbing `entity` now; none when it has no grab handle yet. */
export function grabPointerIds(entity: Entity): number[] {
  return [...(handleStore(entity)?.capturedObjects?.keys() ?? [])];
}

const yawOf = (quaternion: Quaternion): number => new Euler().setFromQuaternion(quaternion, "YXZ").y;
const midpoint = (hands: GrabHands, out: Vector3): Vector3 =>
  out.copy(hands.left.getWorldPosition(new Vector3())).add(hands.right.getWorldPosition(new Vector3())).multiplyScalar(0.5);

/**
 * A recorded person stays standing on the ground it was placed on (brief:
 * the user, 2026-10-24). IWSDK's two-hand handle turns, moves and scales
 * about the hands, which would tilt the hologram and sink its feet, so its
 * `apply` is replaced: the base (the hologram's origin, at its feet) moves
 * horizontally by the hands' midpoint, turns by the hands' yaw only, and
 * scales uniformly about itself, clamped to GRAB_SCALE_MIN..MAX; its height
 * never changes. IWSDK keeps the handle in an unexported `Handle` component,
 * found here by id; its grab system creates it on a later frame than the
 * grab is added, so this returns false until it exists.
 */
export function keepGrounded(entity: Entity, hands: GrabHands): boolean {
  const store = handleStore(entity);
  if (!store) return false;
  // Baselines, taken when a grab starts and whenever a hand joins or leaves it.
  let pointers = 0;
  const basePosition = new Vector3();
  const handsAt = new Vector3();
  const handleAt = new Vector3();
  let baseYaw = 0;
  let handleYaw = 0;
  let baseScale = 1;
  let handleScale = 1;
  const moved = new Vector3();

  const apply = (state: HandleState, target: Object3D): void => {
    const current = state.current;
    if (state.first || current.pointerAmount !== pointers) {
      pointers = current.pointerAmount;
      basePosition.copy(target.position);
      midpoint(hands, handsAt);
      handleAt.copy(current.position);
      baseYaw = yawOf(target.quaternion);
      handleYaw = yawOf(current.quaternion);
      baseScale = target.scale.x;
      handleScale = current.scale.x || 1;
    }
    if (pointers >= 2) {
      // Both hands: the base follows their midpoint, flat.
      midpoint(hands, moved).sub(handsAt);
      target.position.set(basePosition.x + moved.x, basePosition.y, basePosition.z + moved.z);
    } else {
      // One hand: the handle's own follow, flat.
      target.position.set(basePosition.x + current.position.x - handleAt.x, basePosition.y, basePosition.z + current.position.z - handleAt.z);
    }
    target.quaternion.setFromEuler(new Euler(0, baseYaw + yawOf(current.quaternion) - handleYaw, 0, "YXZ"));
    target.scale.setScalar(Math.min(GRAB_SCALE_MAX, Math.max(GRAB_SCALE_MIN, (baseScale * current.scale.x) / handleScale)));
  };

  const options = store.getOptions;
  store.getOptions = () => {
    const value = options();
    return { ...value, ...(value.scale ? { scale: { ...value.scale, uniform: true } } : {}), apply };
  };
  return true;
}
