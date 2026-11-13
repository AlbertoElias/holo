import { MathUtils, PropertyBinding, Vector3 } from "three";
import type { AnimationClip, Object3D } from "three";

import type { SoundLayers } from "../hologram/gltfAudio";

// Deep zoom (docs/features/deep-zoom.md). A hologram may declare layers
// nested inside it: nodes named `HologramLayer…`, each at the point the
// camera aims at in that layer, with a still uniform scale that is the
// layer's size against the hologram. Past the portal's inside end the
// camera goes on in, `depth` nepers further (its distance from the aim is
// the inside distance × e^−depth); layer i is "home" at depth −ln(size),
// where its own world stands as the hologram stood at the inside end.

export const LAYER_NODE_PREFIX = "HologramLayer";
/** How far past the deepest layer's home the viewer may lean in (×16). */
export const LEAN_NEPERS = Math.log(16);
/** Each layer must be at least this many times smaller than the one before it. */
const MIN_STEP = 2;
const UNIFORM_TOLERANCE = 1e-4;

export type DeepLayer = {
  node: Object3D;
  name: string;
  /** World size against the hologram (its root's world scale is 1). */
  size: number;
  /** The depth at which this layer is home: −ln(size). */
  depth: number;
};

export type DeepZoom = {
  layers: DeepLayer[];
  /** The deepest the camera may go, in nepers past the inside end. */
  maxDepth: number;
};

const scratchScale = new Vector3();
const rootScale = new Vector3();

/**
 * The hologram's declared layers, read once at load from `root` (the model's
 * scene, world matrices current). Null when it declares none, or when the
 * declaration is invalid (then it is warned about and the hologram behaves
 * as one without it).
 */
export function readDeepZoom(root: Object3D, animations: readonly AnimationClip[] = []): DeepZoom | null {
  const found: Object3D[] = [];
  root.traverse((object) => {
    if (object !== root && object.name.startsWith(LAYER_NODE_PREFIX)) found.push(object);
  });
  if (found.length === 0) return null;
  const invalid = (why: string) => {
    console.warn(`[deep zoom] ${why}; the hologram is shown without its layers`);
    return null;
  };
  root.updateWorldMatrix(true, true);
  rootScale.setFromMatrixScale(root.matrixWorld);
  const base = Math.abs(rootScale.x) || 1;
  // A layer's size is read once, so its scale (and every parent's) must hold
  // still over the take: a scale track on one may only repeat the scale it
  // already has (one that holds another value would change it on the first frame).
  const changing = new Set<string>();
  for (const clip of animations) {
    for (const track of clip.tracks) {
      const { nodeName, propertyName } = PropertyBinding.parseTrackName(track.name);
      if (propertyName !== "scale" || !nodeName) continue;
      const rest = root.getObjectByName(nodeName)?.scale;
      const values = track.values;
      for (let i = 0; i < values.length; i += 1) {
        const first = rest ? rest.getComponent(i % 3) : values[i % 3]!;
        if (Math.abs(values[i]! - first) > Math.abs(first) * UNIFORM_TOLERANCE) {
          changing.add(nodeName);
          break;
        }
      }
    }
  }
  const nearestLayer = (node: Object3D): Object3D | null => {
    for (let at = node.parent; at && at !== root; at = at.parent) {
      if (found.includes(at)) return at;
    }
    return null;
  };
  const layers: DeepLayer[] = [];
  for (const node of found) {
    for (let at: Object3D | null = node; at && at !== root; at = at.parent) {
      if (changing.has(at.name) || changing.has(at.uuid)) return invalid(`${node.name} (or a parent) has a changing scale`);
    }
    scratchScale.setFromMatrixScale(node.matrixWorld);
    const { x, y, z } = scratchScale;
    if (!(x > 0) || Math.abs(y - x) > x * UNIFORM_TOLERANCE || Math.abs(z - x) > x * UNIFORM_TOLERANCE) return invalid(`${node.name} is not uniformly scaled`);
    const size = x / base;
    if (!(size < 1)) return invalid(`${node.name} is not smaller than the hologram`);
    layers.push({ node, name: node.name, size, depth: -Math.log(size) });
  }
  layers.sort((a, b) => b.size - a.size);
  for (let i = 0; i < layers.length; i += 1) {
    const layer = layers[i]!;
    if (nearestLayer(layer.node) !== (i === 0 ? null : layers[i - 1]!.node)) return invalid(`${layer.name} is not nested in the layer before it`);
    if (i > 0 && layers[i - 1]!.size / layer.size < MIN_STEP) return invalid(`${layer.name} is not ${MIN_STEP}× smaller than ${layers[i - 1]!.name}`);
  }
  // What is computed in float32 world space shakes or mis-lights deep in; a layer may still hold it, with a warning.
  for (const layer of layers) {
    layer.node.traverse((child) => {
      const material = (child as { material?: { transmission?: number } | { transmission?: number }[] }).material;
      const transmits = [material ?? []].flat().some((each) => (each.transmission ?? 0) > 0);
      const why = (child as { isSkinnedMesh?: boolean }).isSkinnedMesh ? "a skinned mesh"
        : (child as { isLight?: boolean }).isLight ? "a light"
        : transmits ? "a transmissive material"
        : child.name.startsWith("RecordedBubbleSphere") ? "the recorded bubble"
        : null;
      if (why) console.warn(`[deep zoom] ${layer.name} holds ${why} (${child.name || child.type}), which is computed in world space and may shake deep in`);
    });
  }
  return { layers, maxDepth: layers.at(-1)!.depth + LEAN_NEPERS };
}

/** The depth at which layer `index` is home: 0 for the hologram itself. */
function homeDepth(deep: DeepZoom, index: number): number {
  return index <= 0 ? 0 : deep.layers[index - 1]!.depth;
}

/**
 * Where the camera looks at `depth`. Between two homes the aim moves from
 * one layer's aim point to the next's, and its offset from the next shrinks
 * with the camera's distance, so the next aim never leaves the view while
 * the camera closes in, and it is centred when its layer is home.
 */
export function deepTarget(deep: DeepZoom, depth: number, insideTarget: Vector3, out: Vector3): Vector3 {
  const aim = (index: number, into: Vector3) => (index === 0 ? into.copy(insideTarget) : deep.layers[index - 1]!.node.getWorldPosition(into));
  const count = deep.layers.length;
  let next = 1;
  while (next < count && depth >= homeDepth(deep, next)) next += 1;
  if (depth >= homeDepth(deep, count)) return aim(count, out);
  const from = homeDepth(deep, next - 1);
  const to = homeDepth(deep, next);
  const t = MathUtils.smoothstep(depth, from, to);
  aim(next, out);
  const outer = aim(next - 1, scratchAim);
  return out.addScaledVector(outer.sub(out), Math.exp(-(depth - from)) * (1 - t));
}
const scratchAim = new Vector3();

/**
 * The outermost layer still drawn at `depth`: a layer's own meshes are left
 * undrawn once the camera is two homes deeper, so only the layer the camera
 * is in and its parent draw.
 */
export function outermostDrawn(deep: DeepZoom, depth: number): number {
  let index = 0;
  while (index + 2 <= deep.layers.length && depth > homeDepth(deep, index + 2)) index += 1;
  return index;
}

/** The share of a step, around its middle, over which one layer's sound hands over to the next. */
const SOUND_HANDOVER = 0.5;

/**
 * How loud layer `index` (0 = the hologram itself) is at `depth`: full at
 * its home, handing over to its neighbours across the middle of each step
 * with equal power, so going in the outer music falls away as the inner
 * rises.
 */
export function layerGain(deep: DeepZoom, index: number, depth: number): number {
  const count = deep.layers.length;
  const handover = (a: number, b: number) => {
    const mid = (a + b) / 2;
    const half = ((b - a) * SOUND_HANDOVER) / 2;
    return MathUtils.clamp((depth - (mid - half)) / (2 * half), 0, 1);
  };
  let gain = 1;
  if (index > 0) gain *= Math.sin((Math.PI / 2) * handover(homeDepth(deep, index - 1), homeDepth(deep, index)));
  if (index < count) gain *= Math.cos((Math.PI / 2) * handover(homeDepth(deep, index), homeDepth(deep, index + 1)));
  return gain;
}

/** The layer `object` belongs to: its nearest declared ancestor (1-based), or 0 for the hologram itself. */
export function layerIndexOf(deep: DeepZoom, object: Object3D): number {
  for (let node: Object3D | null = object; node; node = node.parent) {
    const index = deep.layers.findIndex((layer) => layer.node === node);
    if (index >= 0) return index + 1;
  }
  return 0;
}

/** The size of layer `index` against the hologram (1 for the hologram itself). */
export function layerSize(deep: DeepZoom, index: number): number {
  return index <= 0 ? 1 : deep.layers[index - 1]!.size;
}

/** How a hologram's sounds are placed and faded by layer, with the camera `depth()` deep. */
export function soundLayers(deep: DeepZoom, depth: () => number = () => 0): SoundLayers {
  return {
    of: (node) => layerIndexOf(deep, node),
    size: (layer) => layerSize(deep, layer),
    gain: (layer) => layerGain(deep, layer, depth())
  };
}
