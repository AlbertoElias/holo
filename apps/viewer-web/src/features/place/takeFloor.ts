import { Raycaster, Vector3 } from "three";
import type { AnimationClip, Mesh, Object3D } from "three";

import { sampleTake } from "../hologram/drawnPoints";

const FOOT_BONE = /(Left|Right)(Foot|ToeBase)$/;
/** A foot bone is the ankle, a little above the floor, so the ground that counts is within this of it, metres. */
const GROUND_REACH_METERS = 0.05;

/**
 * The floor the author stands on at the start of the take: the recorded
 * set's ground under their feet, found by casting down through it, the way
 * the viewer's floor checks do. It is not the cloche's foot, which sits on the
 * lowest ground the set draws and so under a hillside's author. Null for a
 * take with no author or no set; the caller then keeps the foot.
 */
export function recordedFloorY(root: Object3D, clips: readonly AnimationClip[]): number | null {
  const avatar = root.getObjectByName("RecordedAvatar");
  const set = root.getObjectByName("RecordedSceneBubble");
  if (!avatar || !set) return null;
  const ground: Mesh[] = [];
  set.traverse((node) => {
    if ((node as Mesh).isMesh) ground.push(node as Mesh);
  });
  const feet: Object3D[] = [];
  avatar.traverse((node) => {
    if (FOOT_BONE.test(node.name)) feet.push(node);
  });
  if (ground.length === 0 || feet.length === 0) return null;
  let floor: number | null = null;
  const read = () => {
    root.updateWorldMatrix(true, true);
    const at = new Vector3();
    const foot = new Vector3();
    let lowest = Infinity;
    for (const bone of feet) {
      bone.getWorldPosition(foot);
      at.x += foot.x / feet.length;
      at.z += foot.z / feet.length;
      lowest = Math.min(lowest, foot.y);
    }
    const down = new Raycaster(new Vector3(at.x, lowest + 2, at.z), new Vector3(0, -1, 0));
    const hit = down.intersectObjects(ground, false).find((candidate) => candidate.point.y <= lowest + GROUND_REACH_METERS);
    floor = hit ? hit.point.y : null;
  };
  if (clips.some((clip) => clip.duration > 0)) sampleTake(root, clips, 1, read);
  else read();
  return floor;
}
