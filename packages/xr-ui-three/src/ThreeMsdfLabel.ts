// Text in 3D (styleguide 7.3): one line of multi-channel signed-distance-field
// glyphs, set from a baked BMFont atlas. The size comes from the type role
// through `apxToMeters`, the colour from the role, and no text shows within
// arm's reach of the head (`headsetTextVisible`).
import { apxToMeters } from "@holoim/design-tokens";
import { isMsdfFace, loadMsdfAtlas, type BmFont, type BmFontChar } from "@holoim/design-tokens/msdf";
import { tokenColor } from "@holoim/design-tokens/three";
import {
  headsetTextVisible,
  typeStyle,
  type TextDistances,
  type TextKind,
  type TypeRole,
  type ViewTarget
} from "@holoim/xr-ui-core";
import {
  BufferGeometry,
  DoubleSide,
  Float32BufferAttribute,
  Group,
  LinearFilter,
  Mesh,
  NoColorSpace,
  ShaderMaterial,
  type Texture,
  TextureLoader
} from "three";

import { finishChrome } from "./chrome.js";

export type LabelAnchor = "left" | "center" | "right";

export interface MsdfLabelOptions {
  text: string;
  role: TypeRole;
  /** True in VR and Quest AR: the role's headset size (2.5×). */
  headset: boolean;
  distanceM: number;
  font: BmFont;
  /** The atlas image; null lays out and measures without drawing (tests). */
  texture: Texture | null;
  /** Which end of the line the origin is; default `left`. */
  anchor?: LabelAnchor;
}

export type MsdfLabelLoadOptions = Omit<MsdfLabelOptions, "font" | "texture">;

const VERTEX_SHADER = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

// Median of the three channels is the signed distance; the screen-pixel range
// (from the atlas's distance range and how large a texel appears on screen)
// turns it into an anti-aliased alpha. The colour is a linear working colour
// and `colorspace_fragment` converts it to the output once.
const FRAGMENT_SHADER = /* glsl */ `
uniform sampler2D map;
uniform vec3 color;
uniform float opacity;
uniform float distanceRange;
varying vec2 vUv;

float median(float r, float g, float b) {
  return max(min(r, g), min(max(r, g), b));
}

void main() {
  vec3 msd = texture2D(map, vUv).rgb;
  float signedDistance = median(msd.r, msd.g, msd.b);
  vec2 unitRange = vec2(distanceRange) / vec2(textureSize(map, 0));
  vec2 screenTexSize = vec2(1.0) / fwidth(vUv);
  float screenPxRange = max(0.5 * dot(unitRange, screenTexSize), 1.0);
  float alpha = clamp(screenPxRange * (signedDistance - 0.5) + 0.5, 0.0, 1.0);
  gl_FragColor = vec4(color, alpha * opacity);
  #include <colorspace_fragment>
}
`;

export interface MsdfLayout {
  /** Visible glyph quads: x0, y0 (bottom-left) and x1, y1 in metres, with atlas pixel rectangles. */
  quads: Array<{ char: BmFontChar; x0: number; y0: number; x1: number; y1: number }>;
  /** Advance of the whole line, metres. */
  widthM: number;
  /** The font's line height, metres. */
  heightM: number;
  /** Characters the atlas has no glyph for, each once, in order of first appearance. */
  missing: string[];
}

export interface LineStyle {
  /** Line height as a multiple of the font size (styleguide 7.1: 1.05 titles, 1.35 interface). */
  lineHeight: number;
  /** Figures share one advance, so changing numbers never shift (7.2). */
  tabularNumbers: boolean;
}

const DIGITS = /^[0-9]$/u;

/**
 * Lays out one line: xadvance, xoffset and yoffset from the atlas, and kerning
 * between neighbours. With tabular figures every digit takes the widest
 * digit's advance, centred in it, and is never kerned. The origin is the
 * line's vertical centre, and its left, centre or right. Characters with no
 * glyph render nothing and advance nothing.
 */
export function layoutMsdfLine(font: BmFont, text: string, scale: number, anchor: LabelAnchor, { lineHeight, tabularNumbers }: LineStyle): MsdfLayout {
  const byId = new Map<number, BmFontChar>(font.chars.map((char) => [char.id, char]));
  const kerning = new Map<number, number>(font.kernings.map(({ first, second, amount }) => [first * 0x110000 + second, amount]));
  const half = font.common.lineHeight / 2;
  const quads: MsdfLayout["quads"] = [];
  const missing: string[] = [];
  let cursor = 0;
  let previous: number | null = null;
  const digitAdvance = Math.max(0, ...font.chars.filter((char) => DIGITS.test(char.char)).map((char) => char.xadvance));
  const placed: Array<{ char: BmFontChar; x: number }> = [];
  for (const character of text) {
    const id = character.codePointAt(0)!;
    const char = byId.get(id);
    if (!char) {
      if (!missing.includes(character)) missing.push(character);
      continue;
    }
    const tabular = tabularNumbers && DIGITS.test(character);
    if (previous !== null && !tabular) cursor += kerning.get(previous * 0x110000 + id) ?? 0;
    const advance = tabular ? digitAdvance : char.xadvance;
    placed.push({ char, x: cursor + (advance - char.xadvance) / 2 });
    cursor += advance;
    previous = tabular ? null : id;
  }
  const originX = anchor === "left" ? 0 : anchor === "center" ? cursor / 2 : cursor;
  for (const { char, x } of placed) {
    if (char.width <= 0 || char.height <= 0 || /\s/u.test(char.char)) continue;
    const left = (x + char.xoffset - originX) * scale;
    const top = (half - char.yoffset) * scale;
    quads.push({ char, x0: left, y0: top - char.height * scale, x1: left + char.width * scale, y1: top });
  }
  return { quads, widthM: cursor * scale, heightM: lineHeight * font.info.size * scale, missing };
}

function labelGeometry(font: BmFont, layout: MsdfLayout): BufferGeometry {
  const { scaleW, scaleH } = font.common;
  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  layout.quads.forEach(({ char, x0, y0, x1, y1 }, index) => {
    positions.push(x0, y0, 0, x1, y0, 0, x1, y1, 0, x0, y1, 0);
    // BMFont rows run down the image; the texture is flipped on upload (flipY), so v runs up.
    const u0 = char.x / scaleW;
    const u1 = (char.x + char.width) / scaleW;
    const vTop = 1 - char.y / scaleH;
    const vBottom = 1 - (char.y + char.height) / scaleH;
    uvs.push(u0, vBottom, u1, vBottom, u1, vTop, u0, vTop);
    const base = index * 4;
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  });
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new Float32BufferAttribute(positions, 3));
  geometry.setAttribute("uv", new Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  return geometry;
}

const atlasCache = new Map<string, Promise<{ font: BmFont; texture: Texture }>>();

function loadAtlas(face: string): Promise<{ font: BmFont; texture: Texture }> {
  if (!isMsdfFace(face)) throw new Error(`ThreeMsdfLabel: no MSDF atlas for "${face}"`);
  let pending = atlasCache.get(face);
  if (!pending) {
    pending = (async () => {
      const { font, textureUrl } = await loadMsdfAtlas(face);
      const texture = await new TextureLoader().loadAsync(textureUrl);
      // Distance data, not colour: no colour conversion, no mipmaps, linear filtering.
      texture.colorSpace = NoColorSpace;
      texture.flipY = true;
      texture.generateMipmaps = false;
      texture.minFilter = LinearFilter;
      texture.magFilter = LinearFilter;
      return { font, texture };
    })();
    atlasCache.set(face, pending);
    pending.catch(() => atlasCache.delete(face));
  }
  return pending;
}

/** A role's atlas, loaded once and shared between labels. */
export function loadLabelAtlas(role: TypeRole): Promise<{ font: BmFont; texture: Texture }> {
  return loadAtlas(typeStyle(role, { headset: false }).msdfFace);
}

export class ThreeMsdfLabel {
  readonly group = new Group();
  readonly mesh: Mesh;
  readonly material: ShaderMaterial;
  readonly role: TypeRole;
  readonly anchor: LabelAnchor;
  readonly distanceM: number;
  readonly headset: boolean;
  /** Characters of the text the atlas has no glyph for; nothing is drawn for them. */
  missingGlyphs: string[] = [];
  /** Advance of the line in metres. */
  widthM = 0;
  /** The role's line height in metres (styleguide 7.1). */
  heightM = 0;
  /** Number of glyph quads drawn (non-space characters the atlas has). */
  quadCount = 0;
  private text: string;
  private readonly font: BmFont;
  private readonly scale: number;

  constructor({ text, role, headset, distanceM, font, texture, anchor = "left" }: MsdfLabelOptions) {
    this.role = role;
    this.anchor = anchor;
    this.distanceM = distanceM;
    this.headset = headset;
    this.font = font;
    this.text = text;
    const style = typeStyle(role, { headset: false });
    // Font size in metres over the atlas's em size in pixels.
    this.scale = apxToMeters(style.fontSizeApx, distanceM, { headset }) / font.info.size;
    this.material = new ShaderMaterial({
      uniforms: {
        map: { value: texture },
        color: { value: tokenColor(style.color) },
        opacity: { value: 1 },
        distanceRange: { value: font.distanceField.distanceRange }
      },
      vertexShader: VERTEX_SHADER,
      fragmentShader: FRAGMENT_SHADER,
      transparent: true,
      depthWrite: false,
      side: DoubleSide,
      toneMapped: false
    });
    this.mesh = new Mesh(new BufferGeometry(), this.material);
    this.mesh.name = "msdf-label";
    this.group.add(this.mesh);
    this.group.name = "label";
    this.layout();
  }

  /** Loads the role's atlas (shared between labels) and builds the label. */
  static async load(options: MsdfLabelLoadOptions): Promise<ThreeMsdfLabel> {
    const { font, texture } = await loadLabelAtlas(options.role);
    return new ThreeMsdfLabel({ ...options, font, texture });
  }

  private layout(): void {
    const style = typeStyle(this.role, { headset: false });
    const layout = layoutMsdfLine(this.font, this.text, this.scale, this.anchor, style);
    this.mesh.geometry.dispose();
    this.mesh.geometry = labelGeometry(this.font, layout);
    this.missingGlyphs = layout.missing;
    this.widthM = layout.widthM;
    this.heightM = layout.heightM;
    this.quadCount = layout.quads.length;
    finishChrome(this.group);
  }

  getText(): string {
    return this.text;
  }

  setText(text: string): void {
    if (text === this.text) return;
    this.text = text;
    this.layout();
  }

  setOpacity(opacity: number): void {
    this.material.uniforms.opacity!.value = opacity;
  }

  /** Hides the label where headset text rules say so (7.3); returns whether it shows. */
  updateVisibility(target: ViewTarget, kind: TextKind, distances: TextDistances): boolean {
    const visible = headsetTextVisible(target, kind, distances);
    this.group.visible = visible;
    return visible;
  }

  dispose(): void {
    // The atlas texture is shared between labels from `load`, so it stays.
    this.mesh.geometry.dispose();
    this.material.dispose();
  }
}
