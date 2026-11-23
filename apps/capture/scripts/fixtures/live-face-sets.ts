// Hand-made score sets of the camera face tracker (ARKit names) for the live face check (B-093). No real face
// is in them. They keep the tracker's habits, because a face that is right only for ideal scores is wrong for
// a person: the cheek raise is almost absent in a smile, a sad face gives almost no frown (it shows as a lower
// lip pushed up and raised inner brows), wide eyes reach a small part of the range, the eye squint rests well
// above zero, the two sides of the mouth differ, and every score moves a little from frame to frame.

export type FaceTrack = { credit: string; fps: number; sets: Array<{ name: string; frames: Array<Record<string, number>> }> };

type Pose = Record<string, number>;
type Key = { at: number; pose: Pose };

const FPS = 15;
const NOISE = 0.012;
/** The right side of the mouth scores this share of the left side: no tracked face is symmetric. */
const RIGHT_MOUTH = 0.88;

/** `name_` is both sides. A face at rest: narrowed lower lids, a trace of raised inner brows, eyes a little down. */
const REST: Pose = { eyeSquint_: 0.31, browInnerUp: 0.05, eyeLookDown_: 0.15, mouthPress_: 0.04, mouthSmile_: 0.02, jawOpen: 0.01 };

const SMILE: Pose = { mouthSmile_: 0.85, mouthUpperUp_: 0.45, eyeSquint_: 0.45, cheekSquint_: 0.04, mouthDimple_: 0.1, mouthStretch_: 0.05, jawOpen: 0.03 };
const LAUGH: Pose = { mouthSmile_: 0.92, mouthUpperUp_: 0.8, mouthLowerDown_: 0.3, eyeSquint_: 0.6, cheekSquint_: 0.06, jawOpen: 0.55, browOuterUp_: 0.1 };
const LAUGH_IN: Pose = { ...LAUGH, jawOpen: 0.38 };
const SAD: Pose = { mouthShrugLower: 0.22, mouthFrown_: 0.025, browInnerUp: 0.3, eyeLookDown_: 0.5, eyeBlink_: 0.2, mouthPress_: 0.15, mouthSmile_: 0 };
const SURPRISE: Pose = { jawOpen: 0.42, eyeWide_: 0.17, browInnerUp: 0.5, browOuterUp_: 0.45, mouthFunnel: 0.15, eyeSquint_: 0.1, mouthSmile_: 0 };
const ANGER: Pose = { browDown_: 0.68, eyeSquint_: 0.5, jawOpen: 0.2, mouthUpperUp_: 0.3, noseSneer_: 0.08, mouthPress_: 0.25, mouthSmile_: 0 };

// The mouth of each speech sound, as the tracker scores it.
const SOUND: Record<string, Pose> = {
  M: { jawOpen: 0.015, mouthClose: 0.08, mouthPress_: 0.3, mouthRollLower: 0.15 },
  AH: { jawOpen: 0.45, mouthLowerDown_: 0.2, mouthUpperUp_: 0.1 },
  UH: { jawOpen: 0.25, mouthLowerDown_: 0.1 },
  OH: { jawOpen: 0.3, mouthFunnel: 0.5, mouthPucker: 0.3 },
  OO: { jawOpen: 0.1, mouthPucker: 0.75, mouthFunnel: 0.3 },
  EE: { jawOpen: 0.12, mouthStretch_: 0.12, mouthSmile_: 0.25, mouthUpperUp_: 0.2, mouthLowerDown_: 0.15 },
  T: { jawOpen: 0.08, mouthUpperUp_: 0.15, mouthLowerDown_: 0.2 }
};
// "My mum knows you owe me tea": lips closed for m, open for the vowels, round for o and u, wide for e.
const SENTENCE = ['M', 'AH', 'EE', 'M', 'UH', 'M', 'T', 'OH', 'OO', 'EE', 'OO', 'OH', 'M', 'EE', 'T', 'EE'];

const hold = (pose: Pose, seconds = 1.5): Key[] => [
  { at: 0, pose: {} },
  { at: 0.35, pose },
  { at: seconds - 0.4, pose },
  { at: seconds, pose: {} }
];

const SETS: Array<[string, Key[]]> = [
  ['neutral', [{ at: 0, pose: {} }, { at: 0.4, pose: {} }, { at: 0.5, pose: { eyeBlink_: 0.9 } }, { at: 0.65, pose: {} }, { at: 1, pose: {} }]],
  ['smile', hold(SMILE)],
  ['laugh', [{ at: 0, pose: {} }, { at: 0.3, pose: LAUGH }, { at: 0.5, pose: LAUGH_IN }, { at: 0.7, pose: LAUGH }, { at: 0.9, pose: LAUGH_IN }, { at: 1.1, pose: LAUGH }, { at: 1.5, pose: {} }]],
  ['sad', hold(SAD, 1.9)],
  ['surprise', hold(SURPRISE)],
  ['anger', hold(ANGER)],
  ['speech', [{ at: 0, pose: {} }, ...SENTENCE.map((sound, index) => ({ at: 0.2 + index * 0.17, pose: SOUND[sound]! })), { at: 0.2 + SENTENCE.length * 0.17 + 0.2, pose: {} }]]
];

/** A small repeatable random source (mulberry32), so the sets are the same on every run. */
function randomSource(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function sides(pose: Pose): Pose {
  const out: Pose = {};
  for (const [name, value] of Object.entries(pose)) {
    if (!name.endsWith('_')) out[name] = value;
    else {
      const stem = name.slice(0, -1);
      out[`${stem}Left`] = value;
      out[`${stem}Right`] = stem.startsWith('mouth') ? value * RIGHT_MOUTH : value;
    }
  }
  return out;
}

function frames(keys: Key[], random: () => number): Array<Record<string, number>> {
  const rest = sides(REST);
  const poses = keys.map((key) => ({ at: key.at, pose: { ...rest, ...sides(key.pose) } }));
  const names = [...new Set(poses.flatMap((key) => Object.keys(key.pose)))].sort();
  const count = Math.round(keys.at(-1)!.at * FPS) + 1;
  return Array.from({ length: count }, (_, frame) => {
    const time = frame / FPS;
    const next = Math.max(1, poses.findIndex((key) => key.at >= time));
    const from = poses[next - 1]!;
    const to = poses[next]!;
    const share = Math.min(1, Math.max(0, (time - from.at) / (to.at - from.at)));
    const eased = share * share * (3 - 2 * share);
    const scores: Record<string, number> = {};
    for (const name of names) {
      const value = (from.pose[name] ?? 0) + ((to.pose[name] ?? 0) - (from.pose[name] ?? 0)) * eased;
      scores[name] = Math.round(Math.min(1, Math.max(0, value + (random() * 2 - 1) * NOISE)) * 1000) / 1000;
    }
    return scores;
  });
}

export function liveFaceTrack(): FaceTrack {
  const random = randomSource(89);
  return {
    credit: 'Hand-made score sets (scripts/fixtures/live-face-sets.ts); no real face.',
    fps: FPS,
    sets: SETS.map(([name, keys]) => ({ name, frames: frames(keys, random) }))
  };
}
