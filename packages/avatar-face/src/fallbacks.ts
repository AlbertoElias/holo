import type { FaceChannel } from "./canonical.js";

type Weights = Partial<Record<FaceChannel, number>>;
type Term = { channel: FaceChannel; scale: number };

/**
 * Where a channel's weight goes when the avatar has no target for it: the
 * nearest channels that do read on a face. Visemes fall back to mouth shapes
 * so speech still moves an ARKit-only face; fine ARKit detail falls back to
 * the coarse shapes most rigs carry.
 */
export const CHANNEL_FALLBACKS: Partial<Record<FaceChannel, Term[]>> = {
  viseme_aa: [{ channel: "jawOpen", scale: 0.7 }],
  viseme_E: [{ channel: "jawOpen", scale: 0.35 }, { channel: "mouthStretchLeft", scale: 0.4 }, { channel: "mouthStretchRight", scale: 0.4 }],
  viseme_I: [{ channel: "jawOpen", scale: 0.15 }, { channel: "mouthStretchLeft", scale: 0.5 }, { channel: "mouthStretchRight", scale: 0.5 }],
  viseme_O: [{ channel: "jawOpen", scale: 0.4 }, { channel: "mouthFunnel", scale: 0.7 }],
  viseme_U: [{ channel: "jawOpen", scale: 0.15 }, { channel: "mouthPucker", scale: 0.8 }],
  viseme_CH: [{ channel: "jawOpen", scale: 0.2 }, { channel: "mouthFunnel", scale: 0.4 }],
  viseme_SS: [{ channel: "jawOpen", scale: 0.1 }, { channel: "mouthStretchLeft", scale: 0.3 }, { channel: "mouthStretchRight", scale: 0.3 }],
  viseme_DD: [{ channel: "jawOpen", scale: 0.2 }],
  viseme_kk: [{ channel: "jawOpen", scale: 0.25 }],
  viseme_nn: [{ channel: "jawOpen", scale: 0.15 }],
  viseme_RR: [{ channel: "jawOpen", scale: 0.2 }, { channel: "mouthPucker", scale: 0.3 }],
  viseme_TH: [{ channel: "jawOpen", scale: 0.15 }],
  viseme_FF: [{ channel: "mouthRollLower", scale: 0.6 }],
  viseme_PP: [{ channel: "mouthPressLeft", scale: 0.5 }, { channel: "mouthPressRight", scale: 0.5 }],
  cheekSquintLeft: [{ channel: "eyeSquintLeft", scale: 0.6 }],
  cheekSquintRight: [{ channel: "eyeSquintRight", scale: 0.6 }],
  mouthDimpleLeft: [{ channel: "mouthSmileLeft", scale: 0.35 }],
  mouthDimpleRight: [{ channel: "mouthSmileRight", scale: 0.35 }],
  mouthUpperUpLeft: [{ channel: "mouthSmileLeft", scale: 0.3 }],
  mouthUpperUpRight: [{ channel: "mouthSmileRight", scale: 0.3 }],
  mouthLowerDownLeft: [{ channel: "jawOpen", scale: 0.2 }],
  mouthLowerDownRight: [{ channel: "jawOpen", scale: 0.2 }],
  mouthShrugLower: [{ channel: "mouthFrownLeft", scale: 0.3 }, { channel: "mouthFrownRight", scale: 0.3 }],
  mouthShrugUpper: [{ channel: "mouthPucker", scale: 0.2 }],
  mouthRollLower: [{ channel: "mouthPucker", scale: 0.3 }],
  mouthRollUpper: [{ channel: "mouthPucker", scale: 0.3 }],
  mouthPressLeft: [{ channel: "mouthStretchLeft", scale: 0.3 }],
  mouthPressRight: [{ channel: "mouthStretchRight", scale: 0.3 }],
  mouthLeft: [{ channel: "mouthStretchLeft", scale: 0.5 }],
  mouthRight: [{ channel: "mouthStretchRight", scale: 0.5 }],
  noseSneerLeft: [{ channel: "browDownLeft", scale: 0.4 }],
  noseSneerRight: [{ channel: "browDownRight", scale: 0.4 }],
  jawForward: [{ channel: "jawOpen", scale: 0.1 }],
  jawLeft: [{ channel: "mouthStretchLeft", scale: 0.3 }],
  jawRight: [{ channel: "mouthStretchRight", scale: 0.3 }]
};

/**
 * Adds each unbound channel's weight to its fallbacks (taking the max with
 * any weight already there), following fallbacks of fallbacks. Channels the
 * avatar binds pass through unchanged; unbound ones with no route are dropped.
 */
export function routeToBound(weights: Weights, bound: ReadonlySet<FaceChannel>): Weights {
  const out: Weights = {};
  const add = (channel: FaceChannel, value: number, depth: number): void => {
    if (value <= 0) return;
    if (bound.has(channel)) {
      out[channel] = Math.max(out[channel] ?? 0, Math.min(1, value));
      return;
    }
    if (depth > 2) return;
    for (const term of CHANNEL_FALLBACKS[channel] ?? []) add(term.channel, value * term.scale, depth + 1);
  };
  for (const [channel, value] of Object.entries(weights) as [FaceChannel, number][]) add(channel, value, 0);
  return out;
}
