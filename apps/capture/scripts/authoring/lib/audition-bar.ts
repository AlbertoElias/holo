/**
 * The audition bar (`docs/features/directed-performance.md`, "The audition
 * bar, in numbers"): every row an avatar must pass to be cast, with its
 * measured value. The numbers are provisional; they were set for the new
 * base and grade any avatar, the stock included.
 *
 * Millimetre rows are stated for a 1.7 m avatar and scale with standing
 * height (a 1.5 m avatar's brows need 8 × 1.5 / 1.7 = 7.1 mm), so a short
 * or tall avatar is judged at the size the card shows it, not penalised for
 * its height.
 */
import type { FaceChannel } from '@holoim/avatar-face';

import { BROW_CHANNELS, SHAPE_CHANNELS, type FaceGeometry } from './face-geometry.ts';

export const BAR = {
  /** Height the millimetre rows are stated for. */
  referenceHeight: 1.7,
  /** The base's file size (1.8 MB, 10^6 bytes each). */
  sizeBytes: 1_800_000,
  browMm: 8,
  lidMm: 8,
  /** `eyeBlink*` 1 leaves at most this much eye showing between the lids. */
  blinkGapMm: 1,
  cornerMm: 14,
  jawMm: 15,
  lipMm: 4,
  /** Every other non-gaze ARKit channel; reported, not binding. */
  otherMm: 1,
  /** Left and right travel of a pair differ by at most this share of the larger. */
  symmetry: 0.15,
  /** Share of brow vertices a ray to the card camera reaches without another mesh in the way. */
  browVisible: 0.9,
  /** No face vertex goes more than this into glasses or hair at any channel at 1. */
  accessoryDepthMm: 2,
  /** OKLab lightness spread (90th − 10th percentile) across the brow in a front render. */
  browContrastL: 0.25,
  /** Neutral eye opening on the phone card, device px. */
  eyeOpenDevicePx: 3,
  /** Brow line to chin on the phone card, device px. */
  faceBoxDevicePx: 40
} as const;

export const GROUPS: ReadonlyArray<{ group: string; bar: keyof typeof BAR; channels: readonly FaceChannel[] }> = [
  { group: 'brows', bar: 'browMm', channels: BROW_CHANNELS },
  { group: 'lids', bar: 'lidMm', channels: ['eyeWideLeft', 'eyeWideRight', 'eyeSquintLeft', 'eyeSquintRight'] },
  { group: 'mouth corners', bar: 'cornerMm', channels: ['mouthSmileLeft', 'mouthSmileRight', 'mouthFrownLeft', 'mouthFrownRight', 'mouthStretchLeft', 'mouthStretchRight'] },
  { group: 'jaw', bar: 'jawMm', channels: ['jawOpen'] },
  { group: 'lip shapes', bar: 'lipMm', channels: ['mouthPressLeft', 'mouthPressRight', 'mouthPucker', 'mouthFunnel', 'mouthRollLower', 'mouthRollUpper'] }
];

export type Tier = 'file' | 'geometry' | 'render' | 'motion';

export interface AuditionRow {
  /** Stable name, e.g. `brows.browInnerUp`, `render.faceBox`. */
  readonly id: string;
  readonly group: string;
  readonly tier: Tier;
  /** The bar as text, already scaled for this avatar's height. */
  readonly bar: string;
  readonly value: number | string | null;
  /** null: not measured (a tier that did not run, or nothing to measure). */
  readonly pass: boolean | null;
  /** false for rows that are reported only and never fail the audition. */
  readonly binding: boolean;
  readonly note?: string;
}

const r1 = (x: number): number => Math.round(x * 10) / 10;

export function fileRows(bytes: number): AuditionRow[] {
  return [{ id: 'file.size', group: 'size', tier: 'file', bar: `≤ ${BAR.sizeBytes / 1e6} MB`, value: Math.round(bytes / 1e4) / 100, pass: bytes <= BAR.sizeBytes, binding: true }];
}

/** The geometry tier's rows, from `faceGeometry` on an avatar `height` metres tall. */
export function geometryRows(g: FaceGeometry, height: number): AuditionRow[] {
  const scale = height / BAR.referenceHeight;
  const mmBar = (n: number): number => r1(n * scale);
  const travel = new Map(g.channels.map((c) => [c.channel, c]));
  const rows: AuditionRow[] = [];
  const grouped = new Set<FaceChannel>();
  for (const { group, bar, channels } of GROUPS) {
    const need = mmBar(BAR[bar] as number);
    for (const channel of channels) {
      grouped.add(channel);
      const c = travel.get(channel);
      rows.push({ id: `${group.replace(/ /g, '-')}.${channel}`, group, tier: 'geometry', bar: `≥ ${need} mm`, value: c ? c.mm : null, pass: c ? c.mm >= need : false, binding: true, ...(c ? {} : { note: 'no face shape' }) });
    }
  }
  for (const e of g.eyes) {
    const blink = e.side === 'left' ? 'eyeBlinkLeft' : 'eyeBlinkRight';
    grouped.add(blink);
    rows.push({
      id: `lids.${blink}.closes`, group: 'lids', tier: 'geometry', bar: `≤ ${mmBar(BAR.blinkGapMm)} mm of eye showing at 1`,
      value: e.blinkGapMm, pass: e.blinkGapMm === null ? false : e.blinkGapMm <= mmBar(BAR.blinkGapMm), binding: true,
      ...(e.openMm === null ? { note: 'no eye found from the card camera' } : { note: `${e.openMm} mm open at neutral` })
    });
  }
  const otherBar = mmBar(BAR.otherMm);
  for (const channel of SHAPE_CHANNELS) {
    if (grouped.has(channel)) continue;
    const c = travel.get(channel);
    rows.push({ id: `other.${channel}`, group: 'other channels', tier: 'geometry', bar: `≥ ${otherBar} mm`, value: c ? c.mm : null, pass: c ? c.mm >= otherBar : false, binding: false });
  }
  for (const c of g.channels) {
    if (!c.channel.endsWith('Left')) continue;
    const right = travel.get(c.channel.replace(/Left$/, 'Right') as FaceChannel);
    if (!right) continue;
    const big = Math.max(c.mm, right.mm);
    const share = big ? Math.abs(c.mm - right.mm) / big : 0;
    rows.push({ id: `symmetry.${c.channel.replace(/Left$/, '')}`, group: 'symmetry', tier: 'geometry', bar: `L/R within ${BAR.symmetry * 100}%`, value: Math.round(share * 100) / 100, pass: share <= BAR.symmetry, binding: true, note: `${c.mm} / ${right.mm} mm` });
  }
  for (const v of g.browVisibility) {
    const worst = Object.entries(v.occluders).sort((x, y) => y[1] - x[1])[0];
    rows.push({ id: `brows.visible.${v.state}`, group: 'brows', tier: 'geometry', bar: `≥ ${BAR.browVisible * 100}% seen from the card`, value: v.visibleShare, pass: v.vertices ? v.visibleShare >= BAR.browVisible : false, binding: true, ...(worst ? { note: `hidden by ${worst[0]} (${Math.round(worst[1] * 100)}%)` } : v.vertices ? {} : { note: 'no brow region' }) });
  }
  const hits = g.accessories.hits;
  rows.push({
    id: 'face.accessories', group: 'accessories', tier: 'geometry', bar: `no face vertex > ${BAR.accessoryDepthMm} mm inside ${g.accessories.meshes.join(', ') || 'an accessory'}`,
    value: hits.length ? Math.max(...hits.map((h) => h.maxDepthMm)) : 0, pass: hits.length === 0, binding: true,
    ...(hits.length ? { note: hits.map((h) => `${h.channel} ${h.vertices} vertices into ${h.accessories.join('+')}`).join('; ') } : g.accessories.meshes.length ? {} : { note: 'no accessories' })
  });
  return rows;
}

export interface RenderMeasures {
  /** Brow line to chin on the phone card, device px. */
  readonly faceBoxDevicePx: number | null;
  readonly eyes: { side: string; devicePx: number }[];
  /** OKLab L across the brow vertices in a front render: 10th and 90th percentile. */
  readonly browL: { p10: number; p90: number; samples: number } | null;
}

export function renderRows(m: RenderMeasures | null, why = 'render tier not run'): AuditionRow[] {
  const off = m === null;
  const rows: AuditionRow[] = [];
  const contrast = m?.browL ? Math.round((m.browL.p90 - m.browL.p10) * 1000) / 1000 : null;
  rows.push({ id: 'render.browContrast', group: 'brows', tier: 'render', bar: `OKLab L spread ≥ ${BAR.browContrastL}`, value: contrast, pass: off ? null : contrast !== null && contrast >= BAR.browContrastL, binding: true, ...(off ? { note: why } : m.browL ? { note: `L ${m.browL.p10}–${m.browL.p90} over ${m.browL.samples} brow vertices` } : { note: 'no brow region' }) });
  for (const side of ['left', 'right']) {
    const e = m?.eyes.find((x) => x.side === side);
    rows.push({ id: `render.eyeOpen.${side}`, group: 'lids', tier: 'render', bar: `≥ ${BAR.eyeOpenDevicePx} device px on the phone card`, value: e ? r1(e.devicePx) : null, pass: off ? null : !!e && e.devicePx >= BAR.eyeOpenDevicePx, binding: true, ...(off ? { note: why } : e ? {} : { note: 'no eye found' }) });
  }
  rows.push({ id: 'render.faceBox', group: 'face box', tier: 'render', bar: `brow to chin ≥ ${BAR.faceBoxDevicePx} device px on the phone card`, value: m?.faceBoxDevicePx ?? null, pass: off ? null : (m.faceBoxDevicePx ?? 0) >= BAR.faceBoxDevicePx, binding: true, ...(off ? { note: why } : {}) });
  return rows;
}
