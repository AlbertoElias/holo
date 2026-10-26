import { HOLOIM_MEANING_EXTENSION, isCameraFrom, validateHoloimMeaning } from "@holoim/meaning";
import type { MeaningLinkMark } from "@holoim/meaning";
import type { Object3D } from "three";

// Reads the HOLOIM_meaning root extension (PRD-022) off a loaded glTF the way
// useGltfAudio reads KHR_audio, and turns its node indices into objects of the
// card's clone. Old recordings have no extension and yield no links.

/** What the viewer needs of a loader result. */
export type MeaningGltf = {
  scene: Object3D;
  parser: { associations?: Map<unknown, { nodes?: number } | undefined> };
  userData: Record<string, unknown>;
};

export type ResolvedLink = {
  mark: MeaningLinkMark;
  style: "recorded" | "inferred";
  /** The author's fingertip, hand, or camera in the card's scene. */
  from: Object3D;
  /** Which form of presence `from` is: a performer's bone or the author's camera. */
  fromKind: "bone" | "camera";
  /** The referent: a scene node, or a bone of the author's body. */
  to: Object3D;
};

/**
 * Node index → object of `clone`. The loader's association map keys the
 * original scene's objects; SkeletonUtils.clone keeps child order, so the two
 * trees are walked in parallel.
 */
export function mapNodeIndices(
  original: Object3D,
  clone: Object3D,
  associations: MeaningGltf["parser"]["associations"]
): Map<number, Object3D> {
  const byIndex = new Map<number, Object3D>();
  const walk = (source: Object3D, copy: Object3D) => {
    const node = associations?.get(source)?.nodes;
    if (node !== undefined && !byIndex.has(node)) byIndex.set(node, copy);
    const count = Math.min(source.children.length, copy.children.length);
    for (let i = 0; i < count; i += 1) walk(source.children[i]!, copy.children[i]!);
  };
  walk(original, clone);
  return byIndex;
}

export function readMeaningLinks(gltf: MeaningGltf, clone: Object3D): ResolvedLink[] {
  const extensions = gltf.userData?.gltfExtensions as Record<string, unknown> | undefined;
  const raw = extensions?.[HOLOIM_MEANING_EXTENSION];
  if (raw === undefined) return [];

  const result = validateHoloimMeaning(raw);
  if (!result.ok) {
    console.warn(`Ignoring invalid ${HOLOIM_MEANING_EXTENSION}:`, result.errors.join("; "));
    return [];
  }

  const nodes = mapNodeIndices(gltf.scene, clone, gltf.parser?.associations);
  const links: ResolvedLink[] = [];
  for (const mark of result.value.marks) {
    const from = nodes.get(mark.anchor.from.node);
    const to = nodes.get(mark.anchor.to.node);
    if (!from || !to) continue;
    links.push({ mark, style: mark.provenance.value, from, fromKind: isCameraFrom(mark.anchor.from) ? "camera" : "bone", to });
  }
  return links;
}

const EDGE_SECONDS = 0.12;

/** 0 outside the span, 1 inside, easing over a short edge so lights do not pop. */
export function spanStrength(time: number, span: { start: number; end: number }): number {
  if (time < span.start || time > span.end) return 0;
  const edge = Math.min(EDGE_SECONDS, (span.end - span.start) / 2);
  if (edge <= 0) return 1;
  return Math.min(1, (time - span.start) / edge, (span.end - time) / edge);
}
