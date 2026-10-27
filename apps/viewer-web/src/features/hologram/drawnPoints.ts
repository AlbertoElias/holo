// World points of what a hologram draws, for fitting its cloche (styleguide
// 3.4): every visible mesh except the recorded bubble's own sphere and
// chrome, kept to the bubble when the take has one, and the author's bones
// through the take, so a walk stays under the dome.
import { isInChrome } from "@holoim/xr-ui-core";
import { AnimationMixer, Box3, LoopRepeat, Matrix4, Sphere, Vector3 } from "three";

import { compareTakeClips, TAKE_CLIP_WEIGHT } from "./takePlayback";
import type { AnimationClip, Bone, Mesh, Object3D, SkinnedMesh } from "three";

const BUBBLE_MESH_NAME = "RecordedBubbleSphere";
const AUTHOR_CAMERA_NAME = "RecordedAuthorCamera";
/** Enough points per mesh to find its extent, without walking every vertex of a dense scene. */
const POINTS_PER_MESH = 3000;
/** Times through the take at which the bones are read. */
const MOTION_SAMPLES = 8;
/** Head room above the highest bone (the head bone sits at the skull's base). */
const HEAD_ROOM_METERS = 0.18;

export type DrawnBubble = { center: Vector3; radius: number } | null;

function isHidden(object: Object3D, root: Object3D): boolean {
  for (let node: Object3D | null = object; node && node !== root.parent; node = node.parent) {
    // The author's camera is the author, not part of what is drawn.
    if (!node.visible || node.name === BUBBLE_MESH_NAME || node.name === AUTHOR_CAMERA_NAME) return true;
  }
  return false;
}

/** World space by default; with `into`, that object's local space (a placed AR hologram's group). */
function toSpace(into: Object3D | undefined): Matrix4 | null {
  return into ? new Matrix4().copy(into.matrixWorld).invert() : null;
}

/** The recorded bubble's sphere, from its own mesh, in `into`'s space (or world). Null for a take without one. */
export function recordedBubble(root: Object3D, into?: Object3D): DrawnBubble {
  const mesh = root.getObjectByName(BUBBLE_MESH_NAME) as Mesh | undefined;
  if (!mesh?.geometry) return null;
  root.updateWorldMatrix(true, true);
  mesh.geometry.computeBoundingSphere();
  const sphere = new Sphere().copy(mesh.geometry.boundingSphere!).applyMatrix4(mesh.matrixWorld);
  const space = toSpace(into);
  if (space) sphere.applyMatrix4(space);
  return sphere.radius > 0 ? { center: sphere.center, radius: sphere.radius } : null;
}

/** Bounds of what the hologram draws, as `drawnPoints` finds it: the set and its objects, never the bubble's sphere, the author's camera or chrome. */
export function drawnBounds(root: Object3D): Box3 {
  return new Box3().setFromPoints(drawnPoints(root, null));
}

/** `bubble` is in the same space as the points: world, or `into`'s. */
export function drawnPoints(root: Object3D, bubble: DrawnBubble, into?: Object3D): Vector3[] {
  const points: Vector3[] = [];
  root.updateWorldMatrix(true, true);
  const space = toSpace(into);
  root.traverse((child) => {
    const mesh = child as Mesh & Partial<SkinnedMesh>;
    if (!mesh.isMesh || !mesh.geometry || isHidden(child, root) || isInChrome(child)) return;
    const position = mesh.geometry.getAttribute("position");
    if (!position) return;
    const step = Math.max(1, Math.floor(position.count / POINTS_PER_MESH));
    for (let i = 0; i < position.count; i += step) {
      const point = new Vector3();
      if (mesh.isSkinnedMesh && mesh.getVertexPosition) {
        mesh.getVertexPosition(i, point);
      } else {
        point.fromBufferAttribute(position, i);
      }
      point.applyMatrix4(mesh.matrixWorld);
      if (space) point.applyMatrix4(space);
      if (bubble && point.distanceTo(bubble.center) > bubble.radius) continue;
      points.push(point);
    }
  });
  return points;
}

/**
 * Where the take moves through, at evenly spaced times: the bones' world
 * positions, with head room over the highest, and the box corners of every
 * mesh the take moves by its own transform (a recorded object, a walk not
 * driven by bones), kept to `bubble` when there is one. With `anchor` (a
 * bubble that follows its author), each sample is taken relative to where
 * the anchor is then, and put back where it is now: the dome travels with the
 * bubble, so only the author's reach inside it matters.
 *
 * The clips play together on a mixer of their own, ranked and weighted as
 * the viewer plays them, so a clip on a child bone stacks on its parent's as
 * it does on screen; a viewer's paused or stopped playback cannot freeze the
 * samples at one time, and its playback is never touched. Stopping that
 * mixer puts the pose back as it was.
 */
export function motionPoints(
  root: Object3D,
  clips: readonly AnimationClip[],
  { into, anchor, bubble = null }: { into?: Object3D | undefined; anchor?: Object3D | undefined; bubble?: DrawnBubble } = {}
): Vector3[] {
  const played = clips.filter((clip) => clip.duration > 0);
  if (played.length === 0) return [];
  const bones: Bone[] = [];
  const meshes: Mesh[] = [];
  root.traverse((child) => {
    const mesh = child as Mesh & Partial<SkinnedMesh>;
    if ((child as Bone).isBone) bones.push(child as Bone);
    else if (mesh.isMesh && !mesh.isSkinnedMesh && mesh.geometry && !isHidden(child, root) && !isInChrome(child)) meshes.push(mesh);
  });
  const points: Vector3[] = [];
  const space = toSpace(into);
  root.updateWorldMatrix(true, true);
  const anchorNow = anchor?.getWorldPosition(new Vector3()) ?? null;
  const anchorThen = new Vector3();
  const firstMatrices = new Map<Mesh, Matrix4>();
  const corner = new Vector3();
  const place = (point: Vector3) => {
    if (anchorNow) point.sub(anchorThen).add(anchorNow);
    if (space) point.applyMatrix4(space);
    return point;
  };
  const readSample = () => {
    root.updateWorldMatrix(true, true);
    if (anchor && anchorNow) anchor.getWorldPosition(anchorThen);
    let top: Vector3 | null = null;
    for (const bone of bones) {
      const point = place(bone.getWorldPosition(new Vector3()));
      points.push(point);
      if (!top || point.y > top.y) top = point;
    }
    if (top) points.push(top.clone().setY(top.y + HEAD_ROOM_METERS));
    for (const mesh of meshes) {
      const first = firstMatrices.get(mesh);
      if (!first) {
        firstMatrices.set(mesh, mesh.matrixWorld.clone());
        continue;
      }
      // A mesh that stays put is already in drawnPoints, vertex by vertex.
      if (first.equals(mesh.matrixWorld)) continue;
      mesh.geometry.computeBoundingBox();
      const box = mesh.geometry.boundingBox!;
      for (let i = 0; i < 8; i += 1) {
        corner.set(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z).applyMatrix4(mesh.matrixWorld);
        const point = place(corner.clone());
        if (bubble && point.distanceTo(bubble.center) > bubble.radius) continue;
        points.push(point);
      }
    }
  };
  const sampler = new AnimationMixer(root);
  played.sort(compareTakeClips).forEach((clip, index) => {
    const weight = index === 0 ? TAKE_CLIP_WEIGHT.primary : TAKE_CLIP_WEIGHT.secondary;
    sampler.clipAction(clip).setLoop(LoopRepeat, Infinity).setEffectiveWeight(weight).play();
  });
  const span = Math.max(...played.map((clip) => clip.duration));
  for (let sample = 0; sample < MOTION_SAMPLES; sample += 1) {
    sampler.setTime((span * sample) / MOTION_SAMPLES);
    readSample();
  }
  sampler.stopAllAction();
  sampler.uncacheRoot(root);
  root.updateWorldMatrix(true, true);
  return points;
}
