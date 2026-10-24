// The golden edge (styleguide 3): one burnt outline from a seed, its strokes,
// soot per target, and the quieter edge while recording (8.5). SVG, canvas,
// three.js and the USDZ builder all draw `edgeOutline`'s points.
import { tokens } from "@holoim/design-tokens";

import { haloLevel, sparkCount, type MotionOptions } from "./motion.js";
import { seededRandom } from "./random.js";
import type { ViewTarget } from "./targets.js";

const { edge } = tokens;

export interface EdgePoint {
  x: number;
  y: number;
}

export interface EdgeTear {
  /** Centre along the loop, 0 to 1. */
  centre: number;
  /** Half width along the loop, 0 to 1. */
  halfWidth: number;
  /** Depth as a share of the short side. */
  depth: number;
}

export interface EdgeOutline {
  /** `edge.samples` points of a closed loop, clockwise, origin top-left, y down, in the card's units. */
  points: EdgePoint[];
  shortSide: number;
  /** Distance from the card's sides to the undisplaced outline. */
  inset: number;
  waves: number;
  tears: EdgeTear[];
}

export interface EdgeOutlineOptions {
  /** The hologram's id (Q10); capture's preview uses a seed per take. */
  seed: string;
  width: number;
  height: number;
}

interface Frame {
  x: number;
  y: number;
  nx: number;
  ny: number;
}

/** A point and its outward normal at `u` (0 to 1, by arc length) along a rounded rectangle. */
function roundedRectFrame(left: number, top: number, w: number, h: number, r: number, u: number): Frame {
  const straightX = w - 2 * r;
  const straightY = h - 2 * r;
  const arc = (Math.PI * r) / 2;
  let s = u * (2 * straightX + 2 * straightY + 4 * arc);
  const corner = (cx: number, cy: number, start: number): Frame => {
    const angle = start + (s / arc) * (Math.PI / 2);
    return { x: cx + r * Math.cos(angle), y: cy + r * Math.sin(angle), nx: Math.cos(angle), ny: Math.sin(angle) };
  };
  // Clockwise in y-down coordinates, from the end of the top-left corner.
  if (s <= straightX) return { x: left + r + s, y: top, nx: 0, ny: -1 };
  s -= straightX;
  if (s <= arc) return corner(left + w - r, top + r, -Math.PI / 2);
  s -= arc;
  if (s <= straightY) return { x: left + w, y: top + r + s, nx: 1, ny: 0 };
  s -= straightY;
  if (s <= arc) return corner(left + w - r, top + h - r, 0);
  s -= arc;
  if (s <= straightX) return { x: left + w - r - s, y: top + h, nx: 0, ny: 1 };
  s -= straightX;
  if (s <= arc) return corner(left + r, top + h - r, Math.PI / 2);
  s -= arc;
  if (s <= straightY) return { x: left, y: top + h - r - s, nx: -1, ny: 0 };
  s -= straightY;
  return corner(left + r, top + r, Math.PI);
}

function loopDistance(a: number, b: number): number {
  const d = Math.abs(a - b) % 1;
  return Math.min(d, 1 - d);
}

/**
 * The burnt outline (3.1): a rounded rectangle (radius 7% of the short side)
 * inset by the larger of 6% and the halo width, displaced along its normal by
 * low waves (3 to 9, about 2%), tears (16 to 38, about 0.9% deep, the deepest
 * 1.4×) and per-point jitter (0.7%), sampled at 280 points.
 *
 * Random draws, in order (the Python port follows it): wave phase, wave
 * count, tear count, then per tear its centre, half width and depth, then
 * per sample its jitter.
 */
export function edgeOutline({ seed, width, height }: EdgeOutlineOptions): EdgeOutline {
  const random = seededRandom(seed);
  const shortSide = Math.min(width, height);
  const inset = Math.max(edge.insetMin, edge.halo.width) * shortSide;
  const radius = edge.radius * shortSide;
  const wavePhase = random() * Math.PI * 2;
  const waves = edge.wavesMin + Math.floor(random() * (edge.wavesMax - edge.wavesMin + 1));
  const tearCount = edge.tearsMin + Math.floor(random() * (edge.tearsMax - edge.tearsMin + 1));
  const tears: EdgeTear[] = [];
  for (let k = 0; k < tearCount; k += 1) {
    tears.push({
      centre: (k + random()) / tearCount,
      halfWidth: (0.2 + 0.3 * random()) / tearCount,
      depth: edge.tearAmplitude * (0.6 + 0.8 * random())
    });
  }
  const points: EdgePoint[] = [];
  for (let i = 0; i < edge.samples; i += 1) {
    const u = i / edge.samples;
    const frame = roundedRectFrame(inset, inset, width - 2 * inset, height - 2 * inset, radius, u);
    let offset = edge.waveAmplitude * Math.sin(2 * Math.PI * waves * u + wavePhase);
    for (const tear of tears) offset -= tear.depth * Math.max(0, 1 - loopDistance(u, tear.centre) / tear.halfWidth);
    offset += edge.jitter * (random() * 2 - 1);
    points.push({ x: frame.x + frame.nx * offset * shortSide, y: frame.y + frame.ny * offset * shortSide });
  }
  return { points, shortSide, inset, waves, tears };
}

/** An SVG path `d` for the closed outline. */
export function edgePathData(points: readonly EdgePoint[], digits = 2): string {
  const f = (n: number) => Number(n.toFixed(digits)).toString();
  return `${points.map((p, i) => `${i === 0 ? "M" : "L"}${f(p.x)} ${f(p.y)}`).join("")}Z`;
}

/** Points centred on the card with y up, for three.js. */
export function edgePointsYUp(outline: EdgeOutline, width: number, height: number): EdgePoint[] {
  return outline.points.map((p) => ({ x: p.x - width / 2, y: height / 2 - p.y }));
}

export interface EdgeStroke {
  /** Width in the outline's units. */
  width: number;
  color: string;
  /** Gaussian blur standard deviation, in the outline's units (0: sharp). */
  blur: number;
}

export interface EdgeStrokes {
  halo: EdgeStroke;
  core: EdgeStroke;
  highlight: EdgeStroke;
  soot: EdgeStroke;
}

/**
 * Stroke widths as shares of the short side (3.2, 3.3): halo 6%, blurred by
 * half its width; core 1.4%, softly blurred; highlight 0.4%; the soot halo is
 * the halo's shape in deep sea.
 */
export function edgeStrokes(shortSide: number): EdgeStrokes {
  const haloWidth = edge.halo.width * shortSide;
  const haloBlur = edge.halo.blurStdDevOfWidth * haloWidth;
  return {
    halo: { width: haloWidth, color: edge.halo.color, blur: haloBlur },
    // The styleguide calls the core "softly blurred" but gives no value, so it is drawn sharp until one is set.
    core: { width: edge.core.width * shortSide, color: edge.core.color, blur: 0 },
    highlight: { width: edge.highlight.width * shortSide, color: edge.highlight.color, blur: 0 },
    soot: { width: haloWidth, color: edge.soot.color, blur: haloBlur }
  };
}

/** The 3D halo material's opacity for a level: `min(1, 0.9 × level / 0.5)` (3.2). */
export function haloMaterialOpacity(level: number): number {
  return Math.min(1, (edge.halo.material3DRest * level) / edge.halo.level);
}

// --- Soot (3.2) ---

function srgbToLinear(channel: number): number {
  return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
}

function rgbOf(hex: string): [number, number, number] {
  return [1, 3, 5].map((start) => parseInt(hex.slice(start, start + 2), 16) / 255) as [number, number, number];
}

/** WCAG relative luminance of an sRGB hex colour. */
export function relativeLuminance(hex: string): number {
  const [r, g, b] = rgbOf(hex).map(srgbToLinear) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** The flat ground's colour at a share of the way down the screen, interpolated in sRGB as CSS does. */
export function flatGroundColorAt(fraction: number): string {
  const stops = tokens.ground.flat;
  const at = Math.min(1, Math.max(0, fraction));
  let i = 1;
  while (i < stops.length - 1 && at > stops[i]!.position) i += 1;
  const from = stops[i - 1]!;
  const to = stops[i]!;
  const progress = to.position === from.position ? 0 : (at - from.position) / (to.position - from.position);
  const a = rgbOf(from.color);
  const b = rgbOf(to.color);
  return `#${a.map((c, k) => Math.round((c + (b[k]! - c) * progress) * 255).toString(16).padStart(2, "0")).join("")}`;
}

/** Soot share `t = clamp((L − 0.095) / (0.16 − 0.095), 0, 1)` for the luminance behind the edge. */
export function sootBlend(luminance: number): number {
  const { blendFromLuminance: from, blendToLuminance: to } = edge.soot;
  return Math.min(1, Math.max(0, (luminance - from) / (to - from)));
}

/** Relative luminance of a WebXR lighting estimate's ambient (first) SH coefficient, linear light. */
export function ambientLuminance(sphericalHarmonics: ArrayLike<number>): number {
  return 0.2126 * sphericalHarmonics[0]! + 0.7152 * sphericalHarmonics[1]! + 0.0722 * sphericalHarmonics[2]!;
}

/** AR soot with a lighting estimate: on at Y ≥ 0.16, off below 0.095, otherwise as it was. */
export function nextArSootOn(wasOn: boolean, luminance: number): boolean {
  if (luminance >= edge.soot.arOnLuminance) return true;
  if (luminance < edge.soot.arOffLuminance) return false;
  return wasOn;
}

export type SootInput =
  /** Flat screens and VR: the luminance of the ground or room behind the edge. */
  | { groundLuminance: number }
  /** AR: whether the lighting estimate says bright (from `nextArSootOn`), or null with no estimate. */
  | { arSootOn: boolean | null };

export interface HaloLayers {
  /** Glow halo level, `level × (1 − t)`; the only part that flickers. */
  glowLevel: number;
  /** Soot halo opacity, `soot × t`; never flickers. */
  sootOpacity: number;
  t: number;
}

/** Splits a halo level between glow and soot for a target (3.2 "Per target"). */
export function haloLayers(target: ViewTarget, level: number, soot: SootInput): HaloLayers {
  let t = 0;
  let sootStrength = 0;
  if (target.kind === "flat" || target.kind === "vr") {
    t = "groundLuminance" in soot ? sootBlend(soot.groundLuminance) : 0;
    sootStrength = target.kind === "vr" ? edge.soot.vrOpacity : edge.soot.flatOpacity;
  } else if (target.kind === "ar") {
    const on = "arSootOn" in soot ? soot.arSootOn : null;
    t = on === null ? 1 : on ? 1 : 0;
    sootStrength = on === null ? edge.soot.arNoEstimateOpacity : edge.soot.arOpacity;
  }
  return { glowLevel: level * (1 - t), sootOpacity: sootStrength * t, t };
}

// --- The edge's state per frame, including recording (8.5) ---

export interface EdgeFrameOptions extends MotionOptions {
  timeMs: number;
  recording: boolean;
  inFocus: boolean;
  soot: SootInput;
}

export interface EdgeFrame {
  drawn: boolean;
  glowLevel: number;
  sootOpacity: number;
  coreOpacity: number;
  highlightOpacity: number;
  sparks: number;
}

const NO_EDGE: EdgeFrame = { drawn: false, glowLevel: 0, sootOpacity: 0, coreOpacity: 0, highlightOpacity: 0, sparks: 0 };

/**
 * What the edge draws this frame. While recording, flat screens hold the halo
 * at 0.08 with the core and highlight at 0.55 and no sparks; headsets draw no
 * edge at all (VR and AR). Quick Look's edge is baked and static at the resting level.
 */
export function edgeFrame(target: ViewTarget, options: EdgeFrameOptions): EdgeFrame {
  if (options.recording) {
    if (target.kind !== "flat") return NO_EDGE;
    const { flatHaloLevel: level, flatCoreAndHighlightOpacity: opacity } = tokens.motion.recording;
    return { drawn: true, ...pick(haloLayers(target, level, options.soot)), coreOpacity: opacity, highlightOpacity: opacity, sparks: 0 };
  }
  const level = haloLevel(target, options.timeMs, options) ?? edge.halo.level;
  return {
    drawn: true,
    ...pick(haloLayers(target, level, options.soot)),
    coreOpacity: 1,
    highlightOpacity: 1,
    sparks: sparkCount(target, options)
  };
}

function pick({ glowLevel, sootOpacity }: HaloLayers) {
  return { glowLevel, sootOpacity };
}
