// Offline segmenting of point evidence. Pure functions over time-ordered
// samples, so the thresholds are visible in one place.

import type { HandPointSample } from './PointSampleStore';

/** Hysteresis: a point starts when the pose score reaches ENTER and holds while it stays above EXIT. */
export const POINT_SCORE_ENTER = 0.6;
export const POINT_SCORE_EXIT = 0.35;
/** The pose has begun once the score passes this; spans are backdated to it. */
export const POINT_SCORE_ONSET = 0.1;
/** Tracking gaps and dips below EXIT shorter than this are bridged. */
export const POINT_GAP_BRIDGE_SEC = 0.3;
/** A point, or a referent within one, must last this long to count. */
export const POINT_DWELL_SEC = 0.4;

export interface PoseSegment {
  startSec: number;
  endSec: number;
  /** Samples inside [startSec, endSec], including bridged dips. */
  samples: HandPointSample[];
}

/**
 * Point segments of one hand's samples (ordered by time): entered at
 * POINT_SCORE_ENTER, held above POINT_SCORE_EXIT with gaps under
 * POINT_GAP_BRIDGE_SEC bridged, backdated to the onset, and kept only when
 * they last POINT_DWELL_SEC. A segment still open at the last sample closes
 * there (recording stopped mid-point).
 */
export function segmentPoses(samples: readonly HandPointSample[]): PoseSegment[] {
  const segments: PoseSegment[] = [];
  let openStart = -1;
  let lastHeld = -1;

  const close = (): void => {
    if (openStart < 0) return;
    const startSec = samples[openStart]!.timeSec;
    const endSec = samples[lastHeld]!.timeSec;
    if (endSec - startSec >= POINT_DWELL_SEC) {
      segments.push({ startSec, endSec, samples: samples.slice(openStart, lastHeld + 1) });
    }
    openStart = -1;
    lastHeld = -1;
  };

  for (let i = 0; i < samples.length; i += 1) {
    const sample = samples[i]!;
    if (openStart >= 0) {
      if (sample.timeSec - samples[lastHeld]!.timeSec > POINT_GAP_BRIDGE_SEC) close();
      else if (sample.score >= POINT_SCORE_EXIT) lastHeld = i;
    }
    if (openStart < 0 && sample.score >= POINT_SCORE_ENTER) {
      openStart = onsetIndex(samples, i);
      lastHeld = i;
    }
  }
  close();
  return mergeOverlapping(segments);
}

// Walks back from the entry over contiguous samples whose score has risen
// past the onset, so the span starts when the hand began to point.
function onsetIndex(samples: readonly HandPointSample[], entry: number): number {
  let start = entry;
  while (start > 0) {
    const previous = samples[start - 1]!;
    if (previous.score < POINT_SCORE_ONSET) break;
    if (samples[start]!.timeSec - previous.timeSec > POINT_GAP_BRIDGE_SEC) break;
    start -= 1;
  }
  return start;
}

// Backdating can reach into the previous segment's tail; join them.
function mergeOverlapping(segments: PoseSegment[]): PoseSegment[] {
  const merged: PoseSegment[] = [];
  for (const segment of segments) {
    const last = merged.at(-1);
    if (last && segment.startSec <= last.endSec) {
      const tail = segment.samples.filter((s) => s.timeSec > last.endSec);
      last.samples.push(...tail);
      last.endSec = Math.max(last.endSec, segment.endSec);
      continue;
    }
    merged.push(segment);
  }
  return merged;
}

/** One resolved sample: the referent its ray chose (`null` for nothing). */
export interface ReferentSample {
  timeSec: number;
  key: string | null;
}

export interface ReferentRun {
  /** Inclusive indices into the resolved samples. */
  first: number;
  last: number;
  /** The majority referent of the run, `null` when nothing was hit most often. */
  key: string | null;
  /** Share of the run's samples that chose `key`, in (0, 1]. */
  agreement: number;
}

/**
 * Splits one point into consecutive referents ("this one … and that one"):
 * a new run starts only where a different referent holds for `dwellSec`;
 * shorter flicker counts against the run it falls in. Each run reports its
 * majority referent and agreement.
 */
export function splitByReferent(samples: readonly ReferentSample[], dwellSec = POINT_DWELL_SEC): ReferentRun[] {
  if (samples.length === 0) return [];
  const raw = runLengths(samples);
  // Stable runs anchor the split; consecutive stable runs of one key join.
  const stable: Array<{ first: number; key: string | null }> = [];
  for (const run of raw) {
    if (runDuration(samples, run.first, run.last) < dwellSec) continue;
    if (stable.length > 0 && stable.at(-1)!.key === run.key) continue;
    stable.push({ first: run.first, key: run.key });
  }
  const boundaries = stable.length === 0 ? [0] : stable.map((run, i) => (i === 0 ? 0 : run.first));
  return boundaries.map((first, i) => {
    const last = i + 1 < boundaries.length ? boundaries[i + 1]! - 1 : samples.length - 1;
    return { first, last, ...majority(samples, first, last) };
  });
}

function runLengths(samples: readonly ReferentSample[]): Array<{ first: number; last: number; key: string | null }> {
  const runs: Array<{ first: number; last: number; key: string | null }> = [];
  samples.forEach((sample, i) => {
    const run = runs.at(-1);
    if (run && run.key === sample.key) run.last = i;
    else runs.push({ first: i, last: i, key: sample.key });
  });
  return runs;
}

// A run of one sample lasts one sample interval, not zero.
function runDuration(samples: readonly ReferentSample[], first: number, last: number): number {
  const interval = samples.length > 1 ? (samples.at(-1)!.timeSec - samples[0]!.timeSec) / (samples.length - 1) : 0;
  return samples[last]!.timeSec - samples[first]!.timeSec + interval;
}

function majority(samples: readonly ReferentSample[], first: number, last: number): { key: string | null; agreement: number } {
  const counts = new Map<string | null, number>();
  for (let i = first; i <= last; i += 1) {
    const key = samples[i]!.key;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  let best: string | null = null;
  let bestCount = -1;
  for (const [key, count] of counts) {
    if (count > bestCount) {
      best = key;
      bestCount = count;
    }
  }
  return { key: best, agreement: bestCount / (last - first + 1) };
}
