// A take's own stored place (docs/features/splat-capture.md, Q4): which node
// carries `HOLOIM_place` in the loaded GLB. Spark-free and three-free, so the
// card reads it in its first chunk and loads the rest only for a take that
// has a place.
import { PLACE_EXTENSION, PLACE_NODE_NAME, parsePlaceExtension, type PlaceExtension } from "@holoim/contracts";

export type StoredPlaceRef = { nodeIndex: number; nodeName: string; extension: PlaceExtension };

type GltfJson = { nodes?: Array<{ name?: string; extensions?: Record<string, unknown> }> };

/** The take's place, or null for a take without one or with a malformed one (warned once by the caller). */
export function findStoredPlace(json: unknown): { place: StoredPlaceRef | null; error: string | null } {
  const nodes = (json as GltfJson | null)?.nodes ?? [];
  const holders = nodes.flatMap((node, index) => (node.extensions?.[PLACE_EXTENSION] === undefined ? [] : [index]));
  if (holders.length === 0) return { place: null, error: null };
  if (holders.length > 1) return { place: null, error: `${holders.length} nodes carry ${PLACE_EXTENSION}` };
  const nodeIndex = holders[0]!;
  try {
    const extension = parsePlaceExtension(nodes[nodeIndex]!.extensions![PLACE_EXTENSION]);
    return { place: { nodeIndex, nodeName: nodes[nodeIndex]!.name ?? PLACE_NODE_NAME, extension }, error: null };
  } catch (error) {
    return { place: null, error: error instanceof Error ? error.message : String(error) };
  }
}
