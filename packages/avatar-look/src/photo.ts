/**
 * The arithmetic of the photo read (slice 5a of
 * docs/features/directed-performance.md): white balance, the trait picks and
 * the hair style proposal. It has no browser or model code, so Node and the
 * browser both use it; `read.ts` measures a photo and calls these.
 *
 * Colours here are linear sRGB 0–1 unless a name says sRGB.
 */
import type { LookCard } from './card.js';
import { EYES, HAIR_STYLES, SKIN, linear, type Eyes, type HairColour, type HairStyle, type Skin, type SRGB } from './traits.js';

export type Linear = readonly [number, number, number];

/** OKLab of a linear sRGB colour. */
export function oklab(c: Linear): [number, number, number] {
  const l = Math.cbrt(0.4122214708 * c[0] + 0.5363325363 * c[1] + 0.0514459929 * c[2]);
  const m = Math.cbrt(0.2119034982 * c[0] + 0.6806995451 * c[1] + 0.1073969566 * c[2]);
  const s = Math.cbrt(0.0883024619 * c[0] + 0.2817188376 * c[1] + 0.6299787005 * c[2]);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s
  ];
}

/** Distance between two linear colours in OKLab (ΔE ok; 0.02 is about one just-noticeable step). */
export function deltaE(a: Linear, b: Linear): number {
  const [p, q] = [oklab(a), oklab(b)];
  return Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
}

/** Linear 0–1 to sRGB 0–255, rounded. */
export function toSrgb(c: Linear): SRGB {
  return c.map((v) => {
    const x = Math.min(1, Math.max(0, v));
    return Math.round(255 * (x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055));
  }) as unknown as SRGB;
}

/** Relative luminance of a linear colour. */
export const luminance = (c: Linear): number => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];

/**
 * The lightness of a typical eye white (OKLab L). The skin is read against the
 * photo's own eye whites; when they are not usable, against this value.
 */
export const SCLERA_L = 0.88;

/**
 * The least an eye-white sample must show to be used: its OKLab lightness, and
 * its greyness (its lowest channel over its highest). A darker or more coloured
 * sample is not an eye white: dark glasses, or lids and skin in narrow eyes.
 * Calibrated by the agent on 2026-11-23 on 66 online photos of 10 people and 42
 * public-domain portraits (slice 5a evidence in
 * docs/features/directed-performance.md).
 */
export const WHITE_MIN = { lightness: 0.55, greyness: 0.45 } as const;

/** True when a measured eye white can set the white balance and the skin's scale. */
export function usableWhite(white: Linear): boolean {
  return oklab(white)[0] >= WHITE_MIN.lightness && Math.min(...white) / Math.max(1e-4, ...white) >= WHITE_MIN.greyness;
}

/**
 * The per-channel gains that turn the measured eye white into a neutral grey of
 * the same luminance (a von Kries white balance). The lightness is not changed:
 * the skin is read as a ratio to the eye whites (`pickSkin`).
 */
export function whiteGains(white: Linear): Linear {
  // The colour correction is capped: an eye white is a little warm and never far from grey, so a large cast is a bad sample.
  return white.map((v) => Math.min(WHITE_CAST, Math.max(1 / WHITE_CAST, luminance(white) / Math.max(v, 1e-4)))) as unknown as Linear;
}

/** The most a white balance changes one channel against the luminance (×). */
export const WHITE_CAST = 1.25;

export const applyGains = (c: Linear, g: Linear): Linear => [c[0] * g[0], c[1] * g[1], c[2] * g[2]];

/**
 * The span of skin lightness over eye-white lightness (both OKLab L, after
 * white balance) that the eight `SKIN` swatches are spread over: `lightest`
 * takes porcelain, `darkest` espresso. The ratio cancels the photo's exposure,
 * which a camera sets for the face (a darker face is shot brighter). The
 * swatches are the clay sheet's warm colours, not real skin colours, so a
 * photo's skin takes the swatch of the same rank, not the nearest colour.
 * Calibrated by the agent on 2026-11-23 on 66 online photos of 10 people and 42
 * public-domain portraits; darker skin is under-sampled there.
 */
export const SKIN_RATIO = { lightest: 1.2, darkest: 0.6 } as const;

/**
 * The largest lightness difference (OKLab L) between the lightest and darkest
 * skin areas of one face before the light is called uneven: a hat brim, a side
 * light or a hand's shadow. Calibrated with `SKIN_RATIO`.
 */
export const SKIN_SPREAD_MAX = 0.3;

/** The skin swatches from lightest to darkest: the order `SKIN` names them in. */
export const SKIN_ORDER = Object.keys(SKIN) as Skin[];

export interface SkinPick {
  readonly value: Skin;
  /** 0 (lightest swatch) to 7 (darkest), unrounded: how near the pick is to the next swatch. */
  readonly rank: number;
  readonly lightness: number;
  /** The skin's lightness over the eye whites' lightness. */
  readonly ratio: number;
}

/** The skin swatch for a white-balanced skin colour, by its lightness over the eye whites' lightness (`whiteL`). */
export function pickSkin(skin: Linear, whiteL: number): SkinPick {
  const L = oklab(skin)[0];
  const ratio = L / Math.max(whiteL, 1e-4);
  const t = (SKIN_RATIO.lightest - ratio) / (SKIN_RATIO.lightest - SKIN_RATIO.darkest);
  const rank = Math.min(SKIN_ORDER.length - 1, Math.max(0, t * (SKIN_ORDER.length - 1)));
  return { value: SKIN_ORDER[Math.round(rank)]!, rank, lightness: L, ratio };
}

export interface NearestPick<T extends string> {
  readonly value: T;
  /** ΔE ok to the picked swatch. */
  readonly distance: number;
  /** ΔE ok to the next nearest swatch. */
  readonly runnerUp: { readonly value: T; readonly distance: number };
}

/**
 * The swatch nearest a linear colour, in OKLab. `lightnessWeight` under 1
 * counts a lightness difference less than a hue or chroma one.
 */
export function nearest<T extends string>(palette: Record<T, SRGB>, c: Linear, lightnessWeight = 1): NearestPick<T> {
  const p = oklab(c);
  const distance = (s: SRGB): number => { const q = oklab(linear(s)); return Math.hypot((p[0] - q[0]) * lightnessWeight, p[1] - q[1], p[2] - q[2]); };
  const ranked = (Object.keys(palette) as T[])
    .map((value) => ({ value, distance: distance(palette[value]) }))
    .sort((a, b) => a.distance - b.distance);
  return { ...ranked[0]!, runnerUp: ranked[1]! };
}

/**
 * The weight of lightness in the hair colour pick. Hair in a photo is lit
 * unevenly, so its lightness varies more than its hue: at full weight,
 * grey-brown hair read as chestnut and blonde as silver on the 42 portraits.
 */
export const HAIR_LIGHTNESS_WEIGHT = 0.5;

/** A hair colour further than this from every swatch is flagged as outside the palette. */
export const HAIR_OUTSIDE = 0.08;

/** Hair whose mask covers less than this share of the face's width squared is not read (a hat, a hood, no hair). */
export const HAIR_MIN_AREA = 0.15;

/** Below this eye confidence the card keeps the default eyes. */
export const EYES_MIN_CONFIDENCE = 0.5;

export interface IrisMeasure {
  readonly colour: Linear;
  /** Iris radius, image px. */
  readonly radiusPx: number;
  readonly pixels: number;
  /** Share of the iris disc left out as glints (reflections, glasses glare). */
  readonly glare: number;
}

export interface EyesPick extends NearestPick<Eyes> {
  readonly confidence: number;
  readonly perEye: readonly { readonly value: Eyes; readonly distance: number }[];
  readonly why: readonly string[];
}

const clamp01 = (x: number): number => Math.min(1, Math.max(0, x));

/**
 * The eye colour from both irises, with a confidence 0–1: the product of the
 * iris size, the two eyes agreeing, the margin over the next swatch and the
 * glare. Each factor under 1 is named in `why`.
 */
export function pickEyes(irises: readonly IrisMeasure[]): EyesPick | null {
  const usable = irises.filter((i) => i.pixels >= 20);
  if (!usable.length) return null;
  const mean: Linear = [0, 1, 2].map((k) => usable.reduce((s, i) => s + i.colour[k]!, 0) / usable.length) as unknown as Linear;
  const pick = nearest(EYES, mean);
  const perEye = usable.map((i) => { const p = nearest(EYES, i.colour); return { value: p.value, distance: p.distance }; });
  const factors: [string, number][] = [
    ['iris size', clamp01((Math.min(...usable.map((i) => i.radiusPx)) - 4) / 8)],
    ['both eyes', usable.length < 2 ? 0.6 : perEye.every((e) => e.value === pick.value) ? 1 : 0.5],
    ['margin', clamp01((pick.runnerUp.distance - pick.distance) / 0.03)],
    ['glare', clamp01(1 - Math.max(0, Math.max(...usable.map((i) => i.glare)) - 0.2) * 2.5)]
  ];
  const confidence = factors.reduce((p, [, f]) => p * f, 1);
  return { ...pick, confidence, perEye, why: factors.filter(([, f]) => f < 1).map(([n, f]) => `${n} ${f.toFixed(2)}`) };
}

/**
 * A hair mask in the face's own frame: cells `GRID.cell` face widths square,
 * from `GRID.left`/`GRID.top` (face widths from the eyes' midpoint, the eye
 * line level). 1 is hair, 0 not hair, 2 outside the image (left out).
 */
export interface HairGrid { readonly w: number; readonly h: number; readonly cells: readonly number[] }
export const GRID = { left: -1.2, top: -1.5, cell: 0.05, w: 48, h: 62 } as const;

function iou(a: HairGrid, b: HairGrid, mirror: boolean): number {
  let both = 0;
  let either = 0;
  for (let y = 0; y < a.h; y += 1) {
    for (let x = 0; x < a.w; x += 1) {
      const p = a.cells[y * a.w + x]!;
      const q = b.cells[y * b.w + (mirror ? b.w - 1 - x : x)]!;
      if (p === 2 || q === 2) continue;
      if (p && q) both += 1;
      if (p || q) either += 1;
    }
  }
  return either ? both / either : 0;
}

export interface HairStyleProposal {
  readonly value: HairStyle;
  /** Overlap (intersection over union) of the photo's hair with each style's, best of as-is and mirrored (a parting's side is not a trait). */
  readonly overlap: Readonly<Record<HairStyle, number>>;
  /** The best overlap less the next best. */
  readonly margin: number;
  /** 0–1: a full margin is 0.2 and a full best overlap 0.4; under `HAIR_STYLE_MIN_CONFIDENCE` the card keeps the default style. */
  readonly confidence: number;
}

/** Below this hair style confidence the card keeps the default style (very short hair overlaps every style a little). */
export const HAIR_STYLE_MIN_CONFIDENCE = 0.5;

/** The hair style whose outline, from the same view, overlaps the photo's hair most: a proposal, not a fact. */
export function proposeHairStyle(photo: HairGrid, styles: Readonly<Record<HairStyle, HairGrid>>): HairStyleProposal {
  const overlap = Object.fromEntries(HAIR_STYLES.map((s) => [s, Math.max(iou(photo, styles[s], false), iou(photo, styles[s], true))])) as Record<HairStyle, number>;
  const ranked = [...HAIR_STYLES].sort((a, b) => overlap[b] - overlap[a]);
  const margin = overlap[ranked[0]!] - overlap[ranked[1]!];
  return { value: ranked[0]!, overlap, margin, confidence: clamp01(margin / 0.2) * clamp01(overlap[ranked[0]!] / 0.4) };
}

/** What the read found for one trait, for the report. */
export interface TraitRead<T extends string> {
  /** The value the card takes: the read's, or the default when `read` is false. */
  readonly value: T;
  readonly read: boolean;
  /** The measured colour after white balance, sRGB 0–255. */
  readonly measured?: SRGB;
  /** The picked swatch's colour, sRGB 0–255. */
  readonly swatch?: SRGB;
  /** ΔE ok from the measured colour to the swatch. */
  readonly distance?: number;
  readonly confidence?: number;
  readonly notes: readonly string[];
}

/** The read's values on top of a default card: the traits it does not read (build, glasses, clothing) stay the default's. */
export function cardFromRead(defaults: LookCard, read: { skin: TraitRead<Skin>; eyes: TraitRead<Eyes>; hairColour: TraitRead<HairColour>; hairStyle: TraitRead<HairStyle> }): LookCard {
  return {
    build: defaults.build,
    skin: read.skin.value,
    eyes: read.eyes.value,
    hair: { style: read.hairStyle.value, colour: read.hairColour.value },
    glasses: defaults.glasses,
    clothing: defaults.clothing
  };
}

