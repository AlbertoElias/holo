// The 3D halo (styleguide 3.4): the cloche, a glass dome on the hologram's
// floor with the burnt edge at its silhouette and along its foot, and the
// hologram's own shade on the floor under what is drawn. The dome casts no
// shadow and draws no soot; the char beside its gold keeps it legible on
// light ground. Every object is chrome, so recording, export and pointing
// skip it.
import { tokens } from "@holoim/design-tokens";
import { tokenColor } from "@holoim/design-tokens/three";
import {
  clocheCharShare,
  clocheOpacityAt,
  clocheSeedOffset,
  haloMaterialOpacity,
  shadeStops,
  type ClocheShape,
  type EdgeFrame,
  type Vector3Like
} from "@holoim/xr-ui-core";
import type { BufferGeometry} from "three";
import { DoubleSide, Float32BufferAttribute, Group, Mesh, PlaneGeometry, ShaderMaterial, SphereGeometry, Vector3 } from "three";

import { finishChrome } from "./chrome.js";

const { cloche, core, highlight, halo, char } = tokens.edge;

const NOISE = /* glsl */ `
float clocheHash(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
float clocheNoise(vec3 x) {
  vec3 i = floor(x); vec3 f = fract(x); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(clocheHash(i), clocheHash(i + vec3(1, 0, 0)), f.x), mix(clocheHash(i + vec3(0, 1, 0)), clocheHash(i + vec3(1, 1, 0)), f.x), f.y),
             mix(mix(clocheHash(i + vec3(0, 0, 1)), clocheHash(i + vec3(1, 0, 1)), f.x), mix(clocheHash(i + vec3(0, 1, 1)), clocheHash(i + vec3(1, 1, 1)), f.x), f.y), f.z);
}`;

const SHELL_VERTEX = /* glsl */ `
attribute vec3 unit;
varying vec3 vUnit;
varying vec3 vNormalW;
varying vec3 vPosW;
varying float vHeight;
void main() {
  vUnit = unit;
  vHeight = position.y;
  vec4 world = modelMatrix * vec4(position, 1.0);
  vPosW = world.xyz;
  vNormalW = normalize(mat3(modelMatrix) * normal);
  gl_Position = projectionMatrix * viewMatrix * world;
}`;

// Distances on the rim are screen pixels from the silhouette as a share of
// the dome's screen radius, so the line keeps one weight on every shape and
// scales with the hologram as it zooms, between the rim's reference
// radii: a far dome keeps a readable line, a near one never a rope. (1 - |N.V|) / fwidth is about twice
// the pixel distance near a silhouette.
const SHELL_FRAGMENT = /* glsl */ `
uniform vec3 uGlow;
uniform vec3 uCore;
uniform vec3 uHighlight;
uniform vec3 uChar;
uniform float uSeed;
uniform float uGlowLevel;
uniform float uCoreOpacity;
uniform float uHighlightOpacity;
uniform float uCharShare;
uniform float uOpacity;
uniform float uRadiusPx;
uniform float uFootWidth;
varying vec3 vUnit;
varying vec3 vNormalW;
varying vec3 vPosW;
varying float vHeight;
${NOISE}
void main() {
  vec3 toEye = normalize(cameraPosition - vPosW);
  float e = 1.0 - abs(dot(normalize(vNormalW), toEye));
  float px = (1.0 - e) / max(fwidth(e), 1e-5) * 0.5;
  float refPx = clamp(uRadiusPx, ${cloche.rimRefMinPx.toFixed(1)}, ${cloche.rimRefMaxPx.toFixed(1)});
  float share = px / refPx;

  float broad = clocheNoise(vUnit * 1.7 + uSeed) - 0.5;
  float wave = clocheNoise(vUnit * 4.3 + uSeed * 1.31) - 0.5;
  float tear = smoothstep(0.6, 0.92, clocheNoise(vUnit * 17.0 + uSeed * 1.73));
  float spark = step(0.55, clocheNoise(vUnit * 9.0 + uSeed * 2.1));

  // The rim: gold from the silhouette in, a cream thread inside it, char beside it.
  float coreWidth = ${(cloche.coreBand).toFixed(4)} * (1.0 + ${(cloche.rimWaves * 10).toFixed(4)} * (1.4 * broad + 0.6 * wave)) * (1.0 - ${(cloche.rimTears * 10).toFixed(4)} * tear);
  float aa = 1.0 / refPx;
  float coreMask = 1.0 - smoothstep(coreWidth - aa, coreWidth + aa, share);
  float hiHalf = ${(cloche.highlightBand / 2).toFixed(4)} * coreWidth / ${(cloche.coreBand).toFixed(4)};
  float hiMask = (1.0 - smoothstep(hiHalf - aa, hiHalf + aa, abs(share - coreWidth * 0.45))) * (1.0 - tear) * spark;
  float charMask = smoothstep(coreWidth - aa, coreWidth + aa, share) * (1.0 - smoothstep(coreWidth + ${(cloche.charBand).toFixed(4)} - aa, coreWidth + ${(cloche.charBand).toFixed(4)} + aa, share));
  charMask *= uCharShare * (0.55 + 0.45 * tear);

  // Glass lit at its rim, a little light inside it.
  float glow = exp(-share / ${(cloche.glowStart * 0.25).toFixed(4)}) * ${(cloche.glowShare).toFixed(4)} * uGlowLevel;

  // The foot: where the glass meets the floor, the same burnt line, quieter.
  float footWidth = uFootWidth * (1.0 + 0.6 * broad) * (1.0 - 0.5 * tear);
  float foot = (1.0 - smoothstep(footWidth * 0.6, footWidth, vHeight)) * ${(cloche.footShare).toFixed(4)};
  float footHi = (1.0 - smoothstep(footWidth * 0.15, footWidth * 0.35, vHeight)) * (1.0 - tear) * ${(cloche.footShare).toFixed(4)};

  float gold = max(coreMask, foot) * uCoreOpacity;
  float cream = max(hiMask, footHi) * uHighlightOpacity;
  vec3 colour = uChar * charMask + uCore * gold * (1.0 - cream) + uHighlight * cream + uGlow * glow;
  float alpha = clamp(charMask + gold + cream, 0.0, 1.0);
  // Premultiplied: the glow adds light with no cover; the line and char cover.
  gl_FragColor = vec4(colour * uOpacity, alpha * uOpacity);
}`;

const SHADE_VERTEX = /* glsl */ `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;

function shadeFragment(): string {
  const stops = shadeStops();
  const [first, second, third] = stops;
  return /* glsl */ `
uniform vec3 uShade;
uniform float uOpacity;
varying vec2 vUv;
void main() {
  float r = length(vUv - 0.5) * 2.0;
  float a = r < ${second!.position.toFixed(4)}
    ? mix(${first!.alpha.toFixed(4)}, ${second!.alpha.toFixed(4)}, r / ${second!.position.toFixed(4)})
    : mix(${second!.alpha.toFixed(4)}, ${third!.alpha.toFixed(4)}, clamp((r - ${second!.position.toFixed(4)}) / (1.0 - ${second!.position.toFixed(4)}), 0.0, 1.0));
  gl_FragColor = vec4(uShade * a * uOpacity, a * uOpacity);
}`;
}

/**
 * The upper half of a unit sphere pushed out to the dome, with the
 * superellipsoid's own normals and a `unit` attribute (the direction scaled
 * to the dome's proportions) for seeded noise that stays put on the glass.
 */
export function clocheGeometry(shape: Pick<ClocheShape, "radii" | "exponent">, widthSegments = 160, heightSegments = 64): BufferGeometry {
  const { radii, exponent: n } = shape;
  const geometry = new SphereGeometry(1, widthSegments, heightSegments, 0, Math.PI * 2, 0, Math.PI / 2);
  const position = geometry.getAttribute("position");
  const normal = geometry.getAttribute("normal");
  const unit = new Float32Array(position.count * 3);
  const wider = Math.max(radii.x, radii.y, radii.z);
  const d = new Vector3();
  for (let i = 0; i < position.count; i += 1) {
    d.fromBufferAttribute(position, i);
    const k = (Math.abs(d.x) ** n + Math.abs(d.y) ** n + Math.abs(d.z) ** n) ** (1 / n);
    const x = (d.x / k) * radii.x;
    const y = (d.y / k) * radii.y;
    const z = (d.z / k) * radii.z;
    position.setXYZ(i, x, y, z);
    // The gradient of |x/rx|^n + |y/ry|^n + |z/rz|^n.
    const nx = (Math.sign(x) * Math.abs(x / radii.x) ** (n - 1)) / radii.x;
    const ny = (Math.sign(y) * Math.abs(y / radii.y) ** (n - 1)) / radii.y;
    const nz = (Math.sign(z) * Math.abs(z / radii.z) ** (n - 1)) / radii.z;
    const length = Math.hypot(nx, ny, nz) || 1;
    normal.setXYZ(i, nx / length, ny / length, nz / length);
    unit[i * 3] = (d.x * radii.x) / wider;
    unit[i * 3 + 1] = (d.y * radii.y) / wider;
    unit[i * 3 + 2] = (d.z * radii.z) / wider;
  }
  geometry.setAttribute("unit", new Float32BufferAttribute(unit, 3));
  geometry.computeBoundingSphere();
  return geometry;
}

export interface ThreeClocheOptions {
  /** The hologram's id (Q10): the same burns wherever it appears. */
  seed: string;
  shape: ClocheShape;
  /** Render order of the shade; the dome draws after it. Default 0. */
  baseRenderOrder?: number;
}

export class ThreeCloche {
  /** Named `cloche`; placed at the dome's foot. Move it to follow a hologram whose volume moves. */
  readonly group = new Group();
  readonly shell: Mesh<BufferGeometry, ShaderMaterial>;
  readonly shade: Mesh<PlaneGeometry, ShaderMaterial>;
  readonly shape: ClocheShape;
  private readonly local = new Vector3();
  private readonly base = new Vector3();

  constructor({ seed, shape, baseRenderOrder = 0 }: ThreeClocheOptions) {
    this.shape = shape;
    const wider = Math.max(shape.radii.x, shape.radii.z);
    const shellMaterial = new ShaderMaterial({
      name: "cloche-shell",
      uniforms: {
        uGlow: { value: tokenColor(halo.color) },
        uCore: { value: tokenColor(core.color) },
        uHighlight: { value: tokenColor(highlight.color) },
        uChar: { value: tokenColor(char.color) },
        uSeed: { value: clocheSeedOffset(seed) },
        uGlowLevel: { value: 1 },
        uCoreOpacity: { value: 1 },
        uHighlightOpacity: { value: 1 },
        uCharShare: { value: char.rest },
        uOpacity: { value: 1 },
        uRadiusPx: { value: 300 },
        uFootWidth: { value: cloche.footWidth * wider }
      },
      vertexShader: SHELL_VERTEX,
      fragmentShader: SHELL_FRAGMENT,
      transparent: true,
      depthWrite: false,
      side: DoubleSide,
      premultipliedAlpha: true,
      toneMapped: false
    });
    this.shell = new Mesh(clocheGeometry(shape), shellMaterial);
    this.shell.name = "cloche-shell";
    this.shell.renderOrder = baseRenderOrder + 1;
    this.shell.frustumCulled = false;
    this.shell.castShadow = false;
    this.shell.receiveShadow = false;

    const shadeMaterial = new ShaderMaterial({
      name: "cloche-shade",
      uniforms: { uShade: { value: tokenColor(tokens.color.deepSea) }, uOpacity: { value: 1 } },
      vertexShader: SHADE_VERTEX,
      fragmentShader: shadeFragment(),
      transparent: true,
      depthWrite: false,
      premultipliedAlpha: true,
      toneMapped: false
    });
    this.shade = new Mesh(new PlaneGeometry(1, 1), shadeMaterial);
    this.shade.name = "cloche-shade";
    this.shade.rotation.x = -Math.PI / 2;
    this.shade.scale.set(shape.shade.radiusX * 2, shape.shade.radiusZ * 2, 1);
    // Just under the floor, so the hologram's own floor covers it where it has one.
    this.shade.position.set(shape.shade.center.x - shape.base.x, -0.002 * wider, shape.shade.center.z - shape.base.z);
    this.shade.renderOrder = baseRenderOrder;

    this.group.add(this.shade, this.shell);
    this.group.name = "cloche";
    this.group.position.set(shape.base.x, shape.base.y, shape.base.z);
    finishChrome(this.group);
  }

  /**
   * What the dome draws this frame. `eye` is the viewer's position in the
   * hologram's space (the shape's), `radiusPx` the dome's wider radius on
   * screen in device pixels.
   */
  update(frame: EdgeFrame, { eye, radiusPx }: { eye: Vector3Like; radiusPx: number }): void {
    const uniforms = this.shell.material.uniforms;
    const opacity = clocheOpacityAt(this.shape, eye);
    this.group.visible = frame.drawn;
    // Inside, the glass goes; the hologram's shade on its floor stays.
    this.shell.visible = opacity > 0;
    uniforms.uGlowLevel!.value = haloMaterialOpacity(frame.glowLevel);
    uniforms.uCoreOpacity!.value = frame.coreOpacity;
    uniforms.uHighlightOpacity!.value = frame.highlightOpacity;
    uniforms.uCharShare!.value = clocheCharShare(frame);
    uniforms.uOpacity!.value = opacity;
    uniforms.uRadiusPx!.value = radiusPx;
  }

  /** A world point in the shape's own space (the group's parent may be placed and scaled, as in AR). */
  eyeInShape(world: Vector3Like): Vector3Like {
    this.group.updateWorldMatrix(true, false);
    return this.group
      .worldToLocal(this.local.set(world.x, world.y, world.z))
      .add(this.base.set(this.shape.base.x, this.shape.base.y, this.shape.base.z));
  }

  dispose(): void {
    this.shell.geometry.dispose();
    this.shell.material.dispose();
    this.shade.geometry.dispose();
    this.shade.material.dispose();
  }
}

