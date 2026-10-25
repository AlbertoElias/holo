// The 3D halo (styleguide 3.4): the burnt globe. The cloche, a dome on the
// hologram's floor, burnt through so only torn burning fronts remain, embers
// in and just off its surface, and sparks shed from the fronts into the
// space around it, with the hologram's own shade on the floor under what is
// drawn. Quiet where the dome faces you over the event, full at its
// silhouette and on its far side, dimmer with depth: it wraps the event
// rather than outlining it. No shadow, no soot; the char beside the gold
// keeps it legible on light ground. Every object is chrome, so recording,
// export and pointing skip it.
import { tokens } from "@holoim/design-tokens";
import { tokenColor } from "@holoim/design-tokens/three";
import {
  CLOCHE_NOISE_GLSL,
  clocheBurnFronts,
  clocheCharShare,
  clocheEmbers,
  clocheOpacityAt,
  clocheRandom,
  clocheSeedOffset,
  shadeStops,
  type ClocheShape,
  type EdgeFrame,
  type Vector3Like
} from "@holoim/xr-ui-core";
import type { BufferGeometry } from "three";
import {
  AdditiveBlending,
  BufferGeometry as Geometry,
  DoubleSide,
  Float32BufferAttribute,
  Group,
  Mesh,
  PlaneGeometry,
  Points,
  ShaderMaterial,
  SphereGeometry,
  Vector3
} from "three";

import { finishChrome } from "./chrome.js";

const { cloche, core, highlight, halo, char, ember } = tokens.edge;
const { sparks } = tokens.motion;


const f = (value: number) => value.toFixed(4);

// The quiet front, for any stage.
const QUIET = /* glsl */ `
uniform float uWider;
uniform float uFocus;
uniform float uOpacity;
float clocheQuiet(float facing) {
  if (facing <= 0.0) return ${f(cloche.farSide)};
  return pow(1.0 - min(facing, 1.0), mix(${f(cloche.quietRest)}, ${f(cloche.quietFocus)}, uFocus));
}`;

// Depth falloff, in view space, so a placed and rescaled hologram (AR) needs
// nothing from the CPU. Vertex stage only (it reads the model matrices).
const COMMON = /* glsl */ `
${QUIET}
uniform vec3 uCentre;
float clocheViewWider() { return uWider * length(modelMatrix[0].xyz); }
float clocheCentreDepth() { return -(modelViewMatrix * vec4(uCentre, 1.0)).z; }
float clocheDepthFade(float depth) {
  float w = clocheViewWider();
  float c = clocheCentreDepth();
  return 1.0 - ${f(cloche.depthDim)} * smoothstep(c - w, c + w, depth);
}`;

const SHELL_VERTEX = /* glsl */ `
varying vec3 vLocal;
varying vec3 vNormalW;
varying vec3 vPosW;
varying float vDepthFade;
${COMMON}
void main() {
  vLocal = position;
  vec4 world = modelMatrix * vec4(position, 1.0);
  vPosW = world.xyz;
  vNormalW = normalize(mat3(modelMatrix) * normal);
  vec4 view = viewMatrix * world;
  vDepthFade = clocheDepthFade(-view.z);
  gl_Position = projectionMatrix * view;
}`;

// Widths are screen pixels from the front: e / fwidth(e) is the distance in
// pixels to where the shell has burnt away, so a front keeps one weight at
// every zoom, a cream core, gold, a pixel of char, then a little glow.
const SHELL_FRAGMENT = /* glsl */ `
uniform vec3 uGlow;
uniform vec3 uCore;
uniform vec3 uHighlight;
uniform vec3 uChar;
uniform float uSeed;
uniform float uTime;
uniform float uGlowLevel;
uniform float uLine;
uniform float uCharShare;
varying vec3 vLocal;
varying vec3 vNormalW;
varying vec3 vPosW;
varying float vDepthFade;
${CLOCHE_NOISE_GLSL}
${QUIET}
void main() {
  vec3 q = vLocal / uWider * ${f(cloche.burnFrequency)} + uSeed;
  float e = clocheFbm(q) - (${f(cloche.burnThreshold)} + ${f(cloche.burnBreath)} * uFocus * sin(uTime * 0.35 + uSeed));
  if (e < 0.0) discard;
  float px = e / max(fwidth(e), 1e-5);
  if (px > ${f(cloche.glowPx)}) discard;
  float cream = 1.0 - smoothstep(0.0, ${f(cloche.corePx)}, px);
  float gold = 1.0 - smoothstep(${f(cloche.corePx)}, ${f(cloche.goldPx)}, px);
  float charLine = smoothstep(${f(cloche.goldPx - 0.6)}, ${f(cloche.goldPx)}, px) * (1.0 - smoothstep(${f(cloche.goldPx)}, ${f(cloche.goldPx + cloche.charPx)}, px));
  float glow = (1.0 - smoothstep(${f(cloche.goldPx - 0.2)}, ${f(cloche.glowPx)}, px)) * ${f(cloche.glowShare)} * uGlowLevel;
  // Torn into dashes, so the fronts read as burning, not as contours.
  float tear = smoothstep(${f(cloche.tearFrom)}, ${f(cloche.tearTo)}, clocheNoise(q * ${f(cloche.tearFrequency)} + uSeed * 1.3));
  float flicker = 0.75 + 0.25 * clocheNoise(q * 5.0 + vec3(0.0, uTime * 1.7, 0.0));
  vec3 toEye = normalize(cameraPosition - vPosW);
  float k = tear * clocheQuiet(dot(normalize(vNormalW), toEye)) * vDepthFade * uOpacity;
  vec3 colour = ((uCore * gold + uHighlight * cream) * ${f(cloche.lineGain)} * uLine + uGlow * glow) * flicker * k + uChar * charLine * uCharShare * k;
  // Premultiplied: gold, cream and char cover; the glow only adds light.
  gl_FragColor = vec4(colour, clamp(((gold + cream) * uLine + charLine * uCharShare) * k, 0.0, 1.0));
}`;

const EMBER_VERTEX = /* glsl */ `
attribute vec3 aNormal;
attribute vec4 aSeed;
uniform float uTime;
uniform float uRadiusPx;
varying float vHeat;
varying float vFade;
${COMMON}
void main() {
  float t = uTime * (0.4 + aSeed.x * 0.8) + aSeed.y * 6.28;
  float drift = uWider * ${f(cloche.emberDrift)};
  vec3 p = position + vec3(sin(t) * 0.6, 0.5 + 0.5 * sin(t * 0.7), cos(t * 1.3) * 0.6) * drift + aNormal * sin(t * 0.5) * drift * 0.7;
  vec4 world = modelMatrix * vec4(p, 1.0);
  vec4 view = viewMatrix * world;
  float depth = -view.z;
  vec3 toEye = normalize(cameraPosition - world.xyz);
  vFade = clocheDepthFade(depth) * clocheQuiet(dot(normalize(mat3(modelMatrix) * aNormal), toEye)) * uOpacity;
  // Out of focus about half drift; the rest join on focus.
  vFade *= step(aSeed.x, mix(${f(cloche.emberRestShare)}, 1.0, uFocus));
  // None close to the eye, so none becomes a bokeh disc.
  float w = clocheViewWider();
  vFade *= smoothstep(${f(cloche.emberNearFrom)} * w, ${f(cloche.emberNearTo)} * w, depth);
  vHeat = 0.5 + 0.5 * sin(uTime * (2.0 + aSeed.z * 5.0) + aSeed.w * 40.0);
  gl_Position = projectionMatrix * view;
  gl_PointSize = clamp(${f(cloche.emberSize)} * (0.6 + aSeed.w) * uRadiusPx * clocheCentreDepth() / max(depth, 1e-4), ${f(cloche.emberMinPx)}, ${f(cloche.emberMaxPx)});
}`;

const EMBER_FRAGMENT = /* glsl */ `
uniform vec3 uCore;
uniform vec3 uHighlight;
uniform vec3 uEmber;
uniform float uGlowLevel;
uniform float uLine;
varying float vHeat;
varying float vFade;
void main() {
  float a = smoothstep(0.5, 0.05, length(gl_PointCoord - 0.5));
  vec3 colour = mix(uEmber, uCore, smoothstep(0.2, 0.7, vHeat));
  colour = mix(colour, uHighlight, smoothstep(0.85, 1.0, vHeat));
  float alpha = a * (0.5 + 0.5 * vHeat) * vFade * mix(0.6, 1.0, uGlowLevel) * uLine;
  gl_FragColor = vec4(colour * ${f(cloche.emberGain)}, clamp(alpha, 0.0, 1.0));
}`;

// A spark leaves a front outward and up, buoyant, with a little curl, cream
// to gold to ember over its life, then goes; it is born again elsewhere.
const SPARK_VERTEX = /* glsl */ `
attribute vec3 aNormal;
attribute vec4 aSeed;
uniform float uTime;
uniform float uRadiusPx;
varying float vAge;
varying float vFade;
${COMMON}
vec3 clocheJitter(vec3 p) {
  p = fract(p * vec3(0.1031, 0.1030, 0.0973));
  p += dot(p, p.yxz + 33.33);
  return fract((p.xxy + p.yxx) * p.zyx) - 0.5;
}
void main() {
  float life = mix(${f(sparks.lifeMin / 1000)}, ${f(sparks.lifeMax / 1000)}, aSeed.y);
  float clock = uTime + aSeed.x * life * 7.0;
  float t = mod(clock, life);
  vAge = t / life;
  vec3 r = clocheJitter(position * 17.0 + floor(clock / life) * 3.7);
  float speed = uWider * ${f(cloche.sparkSpeed)};
  vec3 velocity = (aNormal * (0.25 + 0.4 * aSeed.z) + vec3(0.0, 0.5, 0.0) + r * 0.6) * speed;
  vec3 curl = sin(vec3(t * 3.1, t * 2.3, t * 2.7) + r * 6.28) * uWider * 0.012 * t;
  vec3 p = position + velocity * t + vec3(0.0, 0.3 * speed * t * t, 0.0) + curl;
  vec4 view = modelViewMatrix * vec4(p, 1.0);
  float depth = -view.z;
  vFade = clocheDepthFade(depth) * uOpacity;
  gl_Position = projectionMatrix * view;
  gl_PointSize = clamp(${f(cloche.sparkSize)} * (0.5 + aSeed.w) * (1.0 - 0.6 * vAge) * uRadiusPx * clocheCentreDepth() / max(depth, 1e-4), 1.2, ${f(cloche.sparkMaxPx)});
}`;

const SPARK_FRAGMENT = /* glsl */ `
uniform vec3 uCore;
uniform vec3 uHighlight;
uniform vec3 uEmber;
varying float vAge;
varying float vFade;
void main() {
  float a = smoothstep(0.5, 0.0, length(gl_PointCoord - 0.5));
  vec3 colour = mix(uHighlight, uCore, smoothstep(0.0, 0.35, vAge));
  colour = mix(colour, uEmber, smoothstep(0.55, 1.0, vAge));
  gl_FragColor = vec4(colour * 1.6, clamp(a * pow(1.0 - vAge, 1.4) * vFade, 0.0, 1.0));
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

export interface ClocheUpdate {
  /** The viewer's position in the hologram's space (the shape's). */
  eye: Vector3Like;
  /** The dome's wider radius on screen, in device pixels: embers and sparks are sized by it. */
  radiusPx: number;
  /** Seconds, for the burn's breath, drift and flicker. */
  timeS?: number;
  /** In focus the fronts reach further in and every ember drifts; out of it only the silhouette band burns. */
  inFocus?: boolean;
  /** Holds everything still: no drift, no flicker, no breath. */
  reducedMotion?: boolean;
}

const MAX_SPARKS = Math.max(sparks.countFlat, sparks.countRoomMax);

export class ThreeCloche {
  /** Named `cloche`; placed at the dome's foot. Move it to follow a hologram whose volume moves. */
  readonly group = new Group();
  readonly shell: Mesh<BufferGeometry, ShaderMaterial>;
  readonly embers: Points<BufferGeometry, ShaderMaterial>;
  readonly sparks: Points<BufferGeometry, ShaderMaterial>;
  readonly shade: Mesh<PlaneGeometry, ShaderMaterial>;
  readonly shape: ClocheShape;
  private readonly local = new Vector3();
  private readonly base = new Vector3();
  private focus = 0;
  private lastTime: number | null = null;

  constructor({ seed, shape, baseRenderOrder = 0 }: ThreeClocheOptions) {
    this.shape = shape;
    const seedOffset = clocheSeedOffset(seed);
    const wider = Math.max(shape.radii.x, shape.radii.y, shape.radii.z);
    // One set of uniforms for every part, so a frame sets them once.
    const shared = {
      uWider: { value: wider },
      uFocus: { value: 0 },
      uOpacity: { value: 1 },
      uCentre: { value: new Vector3(0, shape.radii.y / 2, 0) },
      uTime: { value: 0 },
      uRadiusPx: { value: 300 },
      uGlowLevel: { value: 1 },
      uLine: { value: 1 },
      uCharShare: { value: char.rest },
      uSeed: { value: seedOffset },
      uGlow: { value: tokenColor(halo.color) },
      uCore: { value: tokenColor(core.color) },
      uHighlight: { value: tokenColor(highlight.color) },
      uChar: { value: tokenColor(char.color) },
      uEmber: { value: tokenColor(ember.color) }
    };

    this.shell = new Mesh(
      clocheGeometry(shape),
      new ShaderMaterial({
        name: "cloche-shell",
        uniforms: shared,
        vertexShader: SHELL_VERTEX,
        fragmentShader: SHELL_FRAGMENT,
        transparent: true,
        depthWrite: false,
        side: DoubleSide,
        premultipliedAlpha: true,
        toneMapped: false
      })
    );
    this.shell.name = "cloche-shell";
    this.shell.renderOrder = baseRenderOrder + 1;

    const embers = clocheEmbers(shape, seedOffset);
    const emberGeometry = new Geometry();
    emberGeometry.setAttribute("position", new Float32BufferAttribute(embers.positions, 3));
    emberGeometry.setAttribute("aNormal", new Float32BufferAttribute(embers.normals, 3));
    emberGeometry.setAttribute("aSeed", new Float32BufferAttribute(embers.seeds, 4));
    this.embers = new Points(emberGeometry, glowPoints("cloche-embers", shared, EMBER_VERTEX, EMBER_FRAGMENT));
    this.embers.name = "cloche-embers";
    this.embers.renderOrder = baseRenderOrder + 2;

    // Sparks leave from the burning fronts; with none found (a tiny dome), from the crown.
    const fronts = clocheBurnFronts(shape, seedOffset, 160);
    const sites = fronts.length > 0 ? fronts : [{ point: { x: 0, y: shape.radii.y, z: 0 }, normal: { x: 0, y: 1, z: 0 } }];
    const random = clocheRandom(seedOffset + 17);
    const sparkPositions = new Float32Array(MAX_SPARKS * 3);
    const sparkNormals = new Float32Array(MAX_SPARKS * 3);
    const sparkSeeds = new Float32Array(MAX_SPARKS * 4);
    for (let i = 0; i < MAX_SPARKS; i += 1) {
      const site = sites[Math.floor(random() * sites.length)]!;
      sparkPositions.set([site.point.x, site.point.y, site.point.z], i * 3);
      sparkNormals.set([site.normal.x, site.normal.y, site.normal.z], i * 3);
      sparkSeeds.set([random(), random(), random(), random()], i * 4);
    }
    const sparkGeometry = new Geometry();
    sparkGeometry.setAttribute("position", new Float32BufferAttribute(sparkPositions, 3));
    sparkGeometry.setAttribute("aNormal", new Float32BufferAttribute(sparkNormals, 3));
    sparkGeometry.setAttribute("aSeed", new Float32BufferAttribute(sparkSeeds, 4));
    sparkGeometry.setDrawRange(0, 0);
    this.sparks = new Points(sparkGeometry, glowPoints("cloche-sparks", shared, SPARK_VERTEX, SPARK_FRAGMENT));
    this.sparks.name = "cloche-sparks";
    this.sparks.renderOrder = baseRenderOrder + 3;

    for (const part of [this.shell, this.embers, this.sparks]) {
      part.frustumCulled = false;
      part.castShadow = false;
      part.receiveShadow = false;
    }

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

    this.group.add(this.shade, this.shell, this.embers, this.sparks);
    this.group.name = "cloche";
    this.group.position.set(shape.base.x, shape.base.y, shape.base.z);
    finishChrome(this.group);
  }

  /** What the globe draws this frame. */
  update(frame: EdgeFrame, { eye, radiusPx, timeS = 0, inFocus = false, reducedMotion = false }: ClocheUpdate): void {
    const uniforms = this.shell.material.uniforms;
    const opacity = clocheOpacityAt(this.shape, eye);
    this.group.visible = frame.drawn;
    // Inside, the globe goes; the hologram's shade on its floor stays.
    const globe = opacity > 0;
    this.shell.visible = globe;
    this.embers.visible = globe;
    this.sparks.visible = globe && frame.sparks > 0;
    this.sparks.geometry.setDrawRange(0, Math.min(frame.sparks, MAX_SPARKS));
    // Rest and focus ease into each other (about 400 ms); reduced motion jumps.
    const dt = this.lastTime === null ? Infinity : Math.max(0, timeS - this.lastTime);
    this.lastTime = timeS;
    const goal = inFocus ? 1 : 0;
    this.focus = reducedMotion ? goal : this.focus + (goal - this.focus) * (1 - Math.exp(-dt / (cloche.focusEase / 1000)));
    uniforms.uFocus!.value = this.focus;
    uniforms.uTime!.value = reducedMotion ? 0 : timeS;
    uniforms.uOpacity!.value = opacity;
    uniforms.uRadiusPx!.value = radiusPx;
    // The decided flicker (8.1) moves the glow; recording on a flat screen quiets the line (8.5).
    uniforms.uGlowLevel!.value = Math.min(frame.glowLevel / halo.level, 2);
    uniforms.uLine!.value = Math.max(frame.coreOpacity, frame.highlightOpacity);
    uniforms.uCharShare!.value = clocheCharShare(frame);
  }

  /** A world point in the shape's own space (the group's parent may be placed and scaled, as in AR). */
  eyeInShape(world: Vector3Like): Vector3Like {
    this.group.updateWorldMatrix(true, false);
    return this.group
      .worldToLocal(this.local.set(world.x, world.y, world.z))
      .add(this.base.set(this.shape.base.x, this.shape.base.y, this.shape.base.z));
  }

  dispose(): void {
    for (const part of [this.shell, this.embers, this.sparks, this.shade]) {
      part.geometry.dispose();
      part.material.dispose();
    }
  }
}

function glowPoints(name: string, uniforms: ShaderMaterial["uniforms"], vertexShader: string, fragmentShader: string): ShaderMaterial {
  return new ShaderMaterial({
    name,
    uniforms,
    vertexShader,
    fragmentShader,
    transparent: true,
    depthWrite: false,
    blending: AdditiveBlending,
    toneMapped: false
  });
}
