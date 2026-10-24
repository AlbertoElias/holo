import type { TargetFormula } from "./formula.js";
import { normalizeMorphName } from "./normalize.js";
import { FACE_STANDARDS, TARGET_TABLES, type FaceStandard } from "./standards.js";

export { normalizeMorphName };

const DEFAULT_ORDER: readonly FaceStandard[] = [
  "arkit",
  "oculus-viseme",
  "cc4",
  "meta-fb2",
  "vrm1",
  "vrm0",
  "rpm-legacy"
];

const indexes = new Map<FaceStandard, Map<string, TargetFormula>>();
function indexFor(standard: FaceStandard): Map<string, TargetFormula> {
  let index = indexes.get(standard);
  if (!index) {
    index = new Map();
    for (const [name, formula] of Object.entries(TARGET_TABLES[standard])) {
      const key = normalizeMorphName(name);
      if (!index.has(key)) index.set(key, formula);
    }
    indexes.set(standard, index);
  }
  return index;
}

/**
 * Finds how to drive a morph target / expression called `name` from canonical
 * weights. Single-letter keys (VRM0 vowels) only match vrm0.
 */
export function resolveMorphTarget(
  name: string,
  preferred?: FaceStandard[]
): { standard: FaceStandard; formula: TargetFormula } | null {
  const key = normalizeMorphName(name);
  if (!key) return null;
  const order = preferred ?? DEFAULT_ORDER;
  // Preferred standards first, then the remaining ones in default order.
  const rest = DEFAULT_ORDER.filter((s) => !order.includes(s));
  for (const standard of [...order, ...rest]) {
    if (!FACE_STANDARDS.includes(standard)) continue;
    if (key.length < 2 && standard !== "vrm0") continue;
    const formula = indexFor(standard).get(key);
    if (formula) return { standard, formula };
  }
  return null;
}
