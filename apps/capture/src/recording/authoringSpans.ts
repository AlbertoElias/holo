import * as THREE from 'three';

import type { AuthoringSpan } from '@holoim/objects';

import type { RecordingFrame, VrHandSide } from '../types/contracts';

/** What the tray and hands were doing on one recorded frame (PRD-045). */
export interface AuthoringFrame {
  trayOpen: boolean;
  /** Each hand holds no object. */
  empty: Record<VrHandSide, boolean>;
  /** The right palm is within the tray zone. */
  rightNearTray: boolean;
  /** A tray item was summoned into the right hand this frame. */
  summoned: boolean;
  /** The hand's pose came from tracking (not a held or fallback pose). */
  tracked: Record<VrHandSide, boolean>;
}

/** A frame with no tray activity, for steps the object system skipped. */
export const IDLE_AUTHORING_FRAME: Readonly<AuthoringFrame> = {
  trayOpen: false,
  empty: { left: true, right: true },
  rightNearTray: false,
  summoned: false,
  tracked: { left: true, right: true }
};

/** A neutralized span as recorded frame indices, inclusive. */
export interface AuthoringFrameSpan {
  hand: VrHandSide;
  first: number;
  last: number;
}

const FINGERS = ['Thumb', 'Index', 'Middle', 'Ring', 'Pinky'] as const;

/** The arm chain one side's tray motion moves: shoulder to fingertips, nothing else. */
export function armChainBones(side: VrHandSide): string[] {
  const prefix = side === 'left' ? 'Left' : 'Right';
  return [
    `${prefix}Shoulder`,
    `${prefix}Arm`,
    `${prefix}ForeArm`,
    `${prefix}Hand`,
    ...FINGERS.flatMap((finger) => [1, 2, 3, 4].map((n) => `${prefix}Hand${finger}${n}`))
  ];
}

// A boundary frame is looked for this far outside the span, for a tracked pose.
const BOUNDARY_SEARCH_SEC = 0.5;

/** One frame per recorded avatar frame, at the same index. */
export class AuthoringSampleStore {
  private readonly frames: AuthoringFrame[] = [];

  capture(frame: AuthoringFrame): void {
    this.frames.push({ ...frame, empty: { ...frame.empty }, tracked: { ...frame.tracked } });
  }

  getFrames(): readonly AuthoringFrame[] {
    return this.frames;
  }

  clear(): void {
    this.frames.length = 0;
  }
}

function runs(length: number, active: (index: number) => boolean): Array<{ first: number; last: number }> {
  const out: Array<{ first: number; last: number }> = [];
  for (let i = 0; i < length; i += 1) {
    if (!active(i)) continue;
    const previous = out.at(-1);
    if (previous && previous.last === i - 1) previous.last = i;
    else out.push({ first: i, last: i });
  }
  return out;
}

/**
 * The take's hands-in-menu spans. The left arm is in the menu while the tray
 * is open (it holds it up; the tray never opens over a held object). The
 * right arm is in it from the frame its empty palm enters the tray zone
 * until a summon or the tray closing; a run that ends because the hand left
 * the zone or grabbed an event object was content, and stays live.
 */
export function findAuthoringSpans(frames: readonly AuthoringFrame[]): AuthoringFrameSpan[] {
  const spans: AuthoringFrameSpan[] = [];
  for (const run of runs(frames.length, (i) => frames[i]!.trayOpen && frames[i]!.empty.left)) spans.push({ hand: 'left', ...run });
  for (const run of runs(frames.length, (i) => frames[i]!.trayOpen && frames[i]!.empty.right && frames[i]!.rightNearTray)) {
    const next = frames[run.last + 1];
    const endedInMenu = !next || next.summoned || !next.trayOpen;
    if (endedInMenu) spans.push({ hand: 'right', ...run });
  }
  return spans.sort((a, b) => a.first - b.first || a.hand.localeCompare(b.hand));
}

/** Spans in simulation seconds (`timeSec`, like point samples), or take seconds from the first frame with `fromTakeStart`. */
export function toAuthoringSpans(spans: readonly AuthoringFrameSpan[], frames: readonly RecordingFrame[], fromTakeStart = false): AuthoringSpan[] {
  const t0 = fromTakeStart ? frames[0]?.timeSec ?? 0 : 0;
  return spans.map((span) => ({ hand: span.hand, start: frames[span.first]!.timeSec - t0, end: frames[span.last]!.timeSec - t0 }));
}

const smoothstep = (t: number): number => t * t * (3 - 2 * t);

/**
 * A copy of `frames` with each span's arm-chain rotations replaced by an
 * eased slerp between the boundary frames on either side: the nearest ones,
 * within `BOUNDARY_SEARCH_SEC`, whose hand pose was tracked. A span with one
 * boundary holds it; a span with none (it covers the take) is left as
 * recorded. Bone positions and every other bone are untouched, and frames
 * outside spans are shared with the input.
 */
export function neutralizeAuthoringSpans(
  frames: readonly RecordingFrame[],
  authoring: readonly AuthoringFrame[],
  spans: readonly AuthoringFrameSpan[]
): RecordingFrame[] {
  const out = [...frames];
  const qa = new THREE.Quaternion();
  const qb = new THREE.Quaternion();
  const copied = new Set<number>();

  const boundary = (from: number, direction: 1 | -1, side: VrHandSide): number | null => {
    const limitSec = BOUNDARY_SEARCH_SEC;
    let fallback: number | null = null;
    for (let i = from; i >= 0 && i < frames.length; i += direction) {
      if (Math.abs(frames[i]!.timeSec - frames[from]!.timeSec) > limitSec) break;
      fallback ??= i;
      if (authoring[i]?.tracked[side] ?? true) return i;
    }
    return fallback;
  };

  for (const span of spans) {
    const before = span.first > 0 ? boundary(span.first - 1, -1, span.hand) : null;
    const after = span.last < frames.length - 1 ? boundary(span.last + 1, 1, span.hand) : null;
    if (before === null && after === null) continue;
    const chain = new Set(armChainBones(span.hand));
    const poseAt = (index: number | null) => (index === null ? null : new Map(frames[index]!.bones.filter((b) => chain.has(b.name)).map((b) => [b.name, b.quaternion])));
    const from = poseAt(before) ?? poseAt(after)!;
    const to = poseAt(after) ?? from;
    const startIndex = before ?? span.first - 1;
    const endIndex = after ?? span.last + 1;
    for (let i = span.first; i <= span.last; i += 1) {
      const t = smoothstep((i - startIndex) / (endIndex - startIndex));
      if (!copied.has(i)) {
        out[i] = { ...frames[i]!, bones: frames[i]!.bones.map((bone) => ({ ...bone })) };
        copied.add(i);
      }
      for (const bone of out[i]!.bones) {
        const a = from.get(bone.name);
        const b = to.get(bone.name);
        if (!a || !b) continue;
        qa.set(a.x, a.y, a.z, a.w).slerp(qb.set(b.x, b.y, b.z, b.w), t);
        bone.quaternion = { x: qa.x, y: qa.y, z: qa.z, w: qa.w };
      }
    }
  }
  return out;
}
