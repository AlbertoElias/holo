import type { FaceChannel } from "./canonical.js";

export type TargetFormula = {
  op: "sum" | "max" | "mean" | "min";
  terms: { channel: FaceChannel; scale: number }[];
};

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

/** Evaluates a formula over canonical weights; result is clamped to 0..1, missing channels count as 0. */
export function evaluateTarget(
  formula: TargetFormula,
  weights: Partial<Record<FaceChannel, number>>
): number {
  const values = formula.terms.map((t) => (weights[t.channel] ?? 0) * t.scale);
  if (values.length === 0) return 0;
  switch (formula.op) {
    case "sum":
      return clamp01(values.reduce((a, b) => a + b, 0));
    case "mean":
      return clamp01(values.reduce((a, b) => a + b, 0) / values.length);
    case "max":
      return clamp01(Math.max(...values));
    case "min":
      return clamp01(Math.min(...values));
  }
}
