import type { MeaningMotionSpan, VrmHumanoidBone } from '@holoim/meaning';

import type { RecordingFrame, VrHandSide } from '../types/contracts';
import type { AuthoringFrameSpan } from './authoringSpans';

/** A tracked stretch shorter than this is source flicker, not a recorded motion. */
export const MIN_RECORDED_HAND_SPAN_SEC = 0.25;

const FINGER_JOINTS = [
  'ThumbMetacarpal', 'ThumbProximal', 'ThumbDistal',
  'IndexProximal', 'IndexIntermediate', 'IndexDistal',
  'MiddleProximal', 'MiddleIntermediate', 'MiddleDistal',
  'RingProximal', 'RingIntermediate', 'RingDistal',
  'LittleProximal', 'LittleIntermediate', 'LittleDistal'
] as const;

/** One side's hand and finger bones, in VRM names: what tracked hands drive. */
export function handSpanBones(side: VrHandSide): VrmHumanoidBone[] {
  return [`${side}Hand`, ...FINGER_JOINTS.map((joint) => `${side}${joint}`)] as VrmHumanoidBone[];
}

const round = (value: number): number => Math.round(value * 1000) / 1000;

/**
 * The take's `recorded` motion spans (PRD-023): for each side, the runs of
 * frames whose hand pose came from real hand tracking (`xr-hand`), less that
 * side's hands-in-menu frames, over its hand and finger bones. Controller,
 * mock, held, fallback and untracked frames never count, and a run shorter
 * than `MIN_RECORDED_HAND_SPAN_SEC` is dropped. Times are take seconds from
 * the first frame. A take recorded without hand sources (desktop) has none.
 */
export function buildRecordedHandSpans(frames: readonly RecordingFrame[], menuSpans: readonly AuthoringFrameSpan[]): MeaningMotionSpan[] {
  const t0 = frames[0]?.timeSec ?? 0;
  const spans: MeaningMotionSpan[] = [];
  for (const side of ['left', 'right'] as const) {
    const inMenu = new Uint8Array(frames.length);
    for (const span of menuSpans) {
      if (span.hand === side) inMenu.fill(1, span.first, span.last + 1);
    }
    let first = -1;
    const close = (last: number): void => {
      if (first < 0) return;
      const start = frames[first]!.timeSec - t0;
      const end = frames[last]!.timeSec - t0;
      if (end - start >= MIN_RECORDED_HAND_SPAN_SEC) {
        spans.push({ kind: 'motion', bones: handSpanBones(side), span: { start: round(start), end: round(end) }, provenance: { value: 'recorded' } });
      }
      first = -1;
    };
    for (let i = 0; i < frames.length; i += 1) {
      const tracked = frames[i]!.handSources?.[side] === 'xr-hand' && inMenu[i] === 0;
      if (tracked && first < 0) first = i;
      else if (!tracked) close(i - 1);
    }
    close(frames.length - 1);
  }
  return spans.sort((a, b) => a.span.start - b.span.start);
}
