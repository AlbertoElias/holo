import { useFrame, useThree } from "@react-three/fiber";
import { HOLOIM_MEANING_EXTENSION, traceMarks, validateHoloimMeaning } from "@holoim/meaning";
import { useEffect, useMemo, useRef } from "react";
import {
  BufferAttribute,
  BufferGeometry,
  Color,
  DoubleSide,
  Mesh,
  ShaderMaterial,
  Vector2,
  Vector3
} from "three";
import type { AnimationClip, Group, Object3D } from "three";
import { markChromeTree } from "@holoim/xr-ui-core";

import { compareTakeClips } from "../hologram/takePlayback";
import type { HumanoidAnchors } from "../hologram/humanoidAnchors";
import type { PortalStore } from "../portal/portalStore";
import { mapNodeIndices, type MeaningGltf } from "./meaningLinks";
import { HIGHLIGHT_COLOR } from "./PointingHighlights";
import {
  HandTraceSampler,
  readRecordedHandSpans,
  type HandSide,
  type MarkPath,
  type SamplerMark,
  type SuppressedCounts
} from "./handTraceSampler";

// Author-marked hand traces (PRD-023 v1): each `trace` mark in the take's
// HOLOIM_meaning is one thin ribbon along the marked fingertip, drawn in with
// the original timing, whole after its span until the take loops, and drawn
// the same when paused or scrubbed (a pure function of the clip time).
// Ink (styleguide 1.1, 4): the pointing highlight's hue, plain (a recorded
// mark), tapering in width and opacity to the oldest end, never under a
// legible width on a phone card.

/** Width at the newest end, in metres at true scale, */
const WORLD_WIDTH = 0.008;
/** never drawn narrower than this many CSS px anywhere along it (the oldest end too). */
const MIN_CSS_PX = 3;
/** Width at the oldest end, as a share of the newest. */
const OLDEST_WIDTH = 0.5;
/** Opacity at the newest and oldest ends: a recorded mark, plainer and stronger than an inferred one. */
const NEWEST_OPACITY = 0.95;
const OLDEST_OPACITY = 0.55;
/** Trace marks drawn per card at most (a file is untrusted); the first by start are kept. */
export const MAX_TRACE_MARKS = 64;
/** How many per-frame timings the probe keeps. */
const PROBE_FRAMES = 600;
/** Frame time spent warming marks' keyframes while a card plays, so each is built before its span starts. */
const WARM_BUDGET_MS = 0.5;

export type HandTracesMarkProbe = {
  side: HandSide;
  bone: string;
  /** The glTF node index of the fingertip node the mark anchors. */
  node: number;
  span: { start: number; end: number };
  /** The mark draws something this frame. */
  drawn: boolean;
  /** Points drawn this frame, the head point included. */
  drawnPoints: number;
  /** Clip time of the drawn end, or null while nothing is drawn. */
  headTime: number | null;
  /** The drawn end, at the fingertip node's world position at `headTime`. */
  headPosition: [number, number, number] | null;
  /** The usable path's spatial extent (PRD-023's 5 cm rule, applied defensively), m. */
  extent: number;
  suppressed: SuppressedCounts;
};

export type HandTracesSnapshot = {
  time: number;
  marks: Array<{
    side: HandSide;
    drawn: boolean;
    extent: number;
    /** The drawn points in time order, the head last; `hipSpeed` is horizontal hip speed there, m/s. */
    points: Array<{ time: number; position: [number, number, number]; hipSpeed: number }>;
    /** Pairs of indices into `points` that are joined. */
    segments: Array<[number, number]>;
    suppressed: SuppressedCounts;
  }>;
};

export type HandTracesProbe = {
  /** The card has trace marks, so its traces are mounted. */
  hasTraces: boolean;
  /** One entry per trace mark, for the current frame. */
  marks: HandTracesMarkProbe[];
  /** Recorded hand spans per side, as the viewer intersects marks with. */
  spans: Record<HandSide, Array<{ start: number; end: number }>>;
  mode: "none" | "drawing";
  /** Clip seconds of the last drawn frame. */
  time: number;
  /** What is drawn now, as plain data, read on demand so frames pay nothing for it. */
  snapshot: () => HandTracesSnapshot | null;
  /** ms: `frame` per playing frame, `pause` per pause or scrub, `warmSync` per mark finished synchronously because playback reached its span first. */
  timings: { frame: number[]; pause: number[]; warmSync: number[] };
  /** The mark's fingertip node's world position at a clip time, as the path samples it (for fidelity checks). */
  tipAt: ((mark: number, time: number) => [number, number, number]) | null;
  /** The fingertip nodes the marks follow, by mark index, for checks against the mixer's own pose. */
  tipNode: Array<Object3D | null>;
  /** The ribbons' group, as drawn. */
  group: Object3D | null;
};

export function createHandTracesProbe(): HandTracesProbe {
  return {
    hasTraces: false,
    marks: [],
    spans: { left: [], right: [] },
    mode: "none",
    time: 0,
    snapshot: () => null,
    timings: { frame: [], pause: [], warmSync: [] },
    tipAt: null,
    tipNode: [],
    group: null
  };
}

type TraceGltf = Pick<MeaningGltf, "scene" | "parser" | "userData"> & { animations: AnimationClip[] };

export type HandTraceSource = {
  sampler: HandTraceSampler;
  marks: Array<{ side: HandSide; bone: string; node: number; span: { start: number; end: number } }>;
  nodes: Object3D[];
  spans: HandTracesProbe["spans"];
};

/**
 * What a loaded take's traces are drawn from, or null unless its
 * `HOLOIM_meaning` validates and holds trace marks whose fingertip nodes map
 * to objects of the card's clone (desktop, older and third-party takes).
 */
export function useHandTraceSource(gltf: TraceGltf, clone: Object3D, anchors: HumanoidAnchors | null): HandTraceSource | null {
  return useMemo(() => {
    if (!anchors?.hips) return null;
    const raw = (gltf.userData?.gltfExtensions as Record<string, unknown> | undefined)?.[HOLOIM_MEANING_EXTENSION];
    if (raw === undefined) return null;
    const result = validateHoloimMeaning(raw);
    if (!result.ok) return null;
    const marks = traceMarks(result.value).slice().sort((a, b) => a.span.start - b.span.start);
    if (marks.length === 0) return null;
    const objects = mapNodeIndices(gltf.scene, clone, gltf.parser?.associations);
    const resolved: HandTraceSource["marks"] = [];
    const sampled: SamplerMark[] = [];
    const seen = new Set<string>();
    let dropped = 0;
    for (const mark of marks) {
      const node = objects.get(mark.anchor.node);
      if (!node) continue;
      const key = `${mark.anchor.node}:${mark.span.start}:${mark.span.end}`;
      if (seen.has(key)) continue;
      if (sampled.length >= MAX_TRACE_MARKS) {
        dropped += 1;
        continue;
      }
      seen.add(key);
      const side: HandSide = mark.anchor.bone.startsWith("left") ? "left" : "right";
      resolved.push({ side, bone: mark.anchor.bone, node: mark.anchor.node, span: { start: mark.span.start, end: mark.span.end } });
      sampled.push({ side, node, span: { start: mark.span.start, end: mark.span.end } });
    }
    if (dropped > 0) console.warn(`HandTraces: drew the first ${MAX_TRACE_MARKS} trace marks and dropped ${dropped}.`);
    if (sampled.length === 0) return null;
    const spans = readRecordedHandSpans(gltf.userData);
    const clip = gltf.animations.slice().sort(compareTakeClips)[0];
    if (!clip) return null;
    const sampler = new HandTraceSampler(clone, clip, sampled, anchors.hips, spans);
    if (sampler.times.length < 2) return null;
    return { sampler, marks: resolved, nodes: sampled.map((mark) => mark.node), spans };
  }, [anchors, clone, gltf]);
}

const vertexShader = /* glsl */ `
  uniform vec2 uResolution;
  uniform float uWorldWidth;
  uniform float uMinPx;
  uniform float uOldestWidth;
  uniform float uHead;
  uniform float uStart;
  attribute vec3 prev;
  attribute vec3 next;
  attribute float side;
  attribute float time;
  varying float vAge;
  void main() {
    mat4 mvp = projectionMatrix * modelViewMatrix;
    vec4 clip = mvp * vec4(position, 1.0);
    vec4 clipPrev = mvp * vec4(prev, 1.0);
    vec4 clipNext = mvp * vec4(next, 1.0);
    vec2 halfRes = uResolution * 0.5;
    vec2 screen = clip.xy / clip.w * halfRes;
    vec2 dir = clipNext.xy / clipNext.w * halfRes - clipPrev.xy / clipPrev.w * halfRes;
    float len = length(dir);
    dir = len > 1e-5 ? dir / len : vec2(1.0, 0.0);
    vec2 normal = vec2(-dir.y, dir.x);
    // 0 at the drawn end (the head), 1 at the span's start: the taper follows the mark, not a window.
    float age = clamp((uHead - time) / max(uHead - uStart, 1e-4), 0.0, 1.0);
    // True-scale width in px at this depth, tapering to the oldest end; never under the legible minimum anywhere.
    float worldPx = uWorldWidth * projectionMatrix[1][1] * halfRes.y / max(clip.w, 1e-4);
    float px = max(worldPx * mix(1.0, uOldestWidth, age), uMinPx);
    screen += normal * side * px * 0.5;
    gl_Position = vec4(screen / halfRes * clip.w, clip.z, clip.w);
    vAge = age;
  }
`;

const fragmentShader = /* glsl */ `
  uniform vec3 uColor;
  uniform float uNewestOpacity;
  uniform float uOldestOpacity;
  varying float vAge;
  void main() {
    gl_FragColor = vec4(uColor, mix(uNewestOpacity, uOldestOpacity, vAge));
    #include <colorspace_fragment>
  }
`;

function material(start: number): ShaderMaterial {
  return new ShaderMaterial({
    vertexShader,
    fragmentShader,
    uniforms: {
      uResolution: { value: new Vector2(1, 1) },
      uWorldWidth: { value: WORLD_WIDTH },
      uMinPx: { value: MIN_CSS_PX },
      uOldestWidth: { value: OLDEST_WIDTH },
      uColor: { value: new Color(HIGHLIGHT_COLOR) },
      uNewestOpacity: { value: NEWEST_OPACITY },
      uOldestOpacity: { value: OLDEST_OPACITY },
      uHead: { value: start },
      uStart: { value: start }
    },
    transparent: true,
    depthWrite: false,
    // The quads' winding follows the stroke's screen direction, so either face may show.
    side: DoubleSide,
    toneMapped: false
  });
}

/** What one mark drew at the last frame. */
type Drawn = { k: number; partial: boolean; headTime: number; head: Vector3 };

/**
 * One mark's ribbon: two vertices per path sample plus two for the head,
 * expanded across the screen in the vertex shader. The geometry is filled
 * once from the mark's path; a frame moves the draw range and rewrites only
 * the head segment.
 */
class Ribbon {
  readonly mesh: Mesh<BufferGeometry, ShaderMaterial>;
  readonly material: ShaderMaterial;
  private path: MarkPath | null = null;
  /** The segment whose index currently ends at the head slot, or -1. */
  private patched = -1;

  constructor(start: number) {
    this.material = material(start);
    this.mesh = new Mesh(new BufferGeometry(), this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 997;
    this.mesh.visible = false;
  }

  private attr(name: string): BufferAttribute {
    return this.mesh.geometry.getAttribute(name) as BufferAttribute;
  }

  /** Fills the geometry from the mark's path, once. */
  private fill(path: MarkPath): void {
    this.path = path;
    const geometry = this.mesh.geometry;
    const vertices = (path.count + 1) * 2;
    const position = new Float32Array(vertices * 3);
    const prev = new Float32Array(vertices * 3);
    const next = new Float32Array(vertices * 3);
    const side = new Float32Array(vertices);
    const time = new Float32Array(vertices);
    const at = (i: number, out: Float32Array, v: number) => {
      out[v * 3] = path.positions[i * 3]!;
      out[v * 3 + 1] = path.positions[i * 3 + 1]!;
      out[v * 3 + 2] = path.positions[i * 3 + 2]!;
    };
    for (let i = 0; i < path.count; i += 1) {
      // At a break the direction comes from the one joined neighbour.
      const before = i > 0 && path.usable[i - 1] ? i - 1 : i;
      const after = i < path.count - 1 && path.usable[i] ? i + 1 : i;
      for (let k = 0; k < 2; k += 1) {
        const v = i * 2 + k;
        at(i, position, v);
        at(before, prev, v);
        at(after, next, v);
        side[v] = k === 0 ? -1 : 1;
        time[v] = path.times[i]!;
      }
    }
    const head = path.count * 2;
    side[head] = -1;
    side[head + 1] = 1;
    const index = new Uint32Array(Math.max(1, path.count - 1) * 6);
    for (let s = 0; s < path.count - 1; s += 1) this.writeSegment(index, s, s, s + 1);
    geometry.setAttribute("position", new BufferAttribute(position, 3));
    geometry.setAttribute("prev", new BufferAttribute(prev, 3));
    geometry.setAttribute("next", new BufferAttribute(next, 3));
    geometry.setAttribute("side", new BufferAttribute(side, 1));
    geometry.setAttribute("time", new BufferAttribute(time, 1));
    geometry.setIndex(new BufferAttribute(index, 1));
  }

  /** Writes segment `s`'s quad from point `a` to point `b` (a degenerate one when the segment is not usable). */
  private writeSegment(index: Uint32Array | BufferAttribute, s: number, a: number, b: number): void {
    const usable = this.path!.usable[s] === 1;
    const values = usable ? [a * 2, a * 2 + 1, b * 2, b * 2, a * 2 + 1, b * 2 + 1] : [0, 0, 0, 0, 0, 0];
    values.forEach((value, j) => {
      if (index instanceof Uint32Array) index[s * 6 + j] = value;
      else index.setX(s * 6 + j, value);
    });
  }

  /** Draws samples `0..k-1` whole and, when `partial`, a last segment to the head. */
  update(path: MarkPath, drawn: Drawn | null): void {
    if (!drawn) {
      this.mesh.visible = false;
      return;
    }
    if (this.path !== path) this.fill(path);
    const geometry = this.mesh.geometry;
    const index = geometry.getIndex()!;
    const { k, partial, headTime, head } = drawn;
    const segments = partial ? k : k - 1;
    // Restore the segment that last ended at the head, then patch the new one.
    const want = partial ? k - 1 : -1;
    if (this.patched !== want) {
      if (this.patched >= 0) {
        this.writeSegment(index, this.patched, this.patched, this.patched + 1);
        index.addUpdateRange(this.patched * 6, 6);
        index.needsUpdate = true;
      }
      this.patched = want;
    }
    if (partial) {
      const headVertex = path.count;
      const a = k - 1;
      const position = this.attr("position");
      const prev = this.attr("prev");
      const next = this.attr("next");
      const time = this.attr("time");
      for (let v = headVertex * 2; v < headVertex * 2 + 2; v += 1) {
        position.setXYZ(v, head.x, head.y, head.z);
        prev.setXYZ(v, path.positions[a * 3]!, path.positions[a * 3 + 1]!, path.positions[a * 3 + 2]!);
        next.setXYZ(v, head.x, head.y, head.z);
        time.setX(v, headTime);
      }
      for (const attribute of [position, prev, next, time]) {
        attribute.addUpdateRange(headVertex * 2 * attribute.itemSize, 2 * attribute.itemSize);
        attribute.needsUpdate = true;
      }
      const base = a * 6;
      const usable = path.usable[a] === 1;
      const values = usable ? [a * 2, a * 2 + 1, headVertex * 2, headVertex * 2, a * 2 + 1, headVertex * 2 + 1] : [0, 0, 0, 0, 0, 0];
      values.forEach((value, j) => index.setX(base + j, value));
      index.addUpdateRange(base, 6);
      index.needsUpdate = true;
    }
    this.material.uniforms.uHead!.value = headTime;
    geometry.setDrawRange(0, Math.max(0, segments) * 6);
    this.mesh.visible = segments > 0;
  }

  hide(): void {
    this.mesh.visible = false;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.material.dispose();
  }
}

type Props = {
  source: HandTraceSource;
  portal: PortalStore;
  /** The card is on screen and drawing. */
  active: boolean;
  getPlaybackTime: () => number;
  probe: HandTracesProbe;
};

export function HandTraces({ source, portal, active, getPlaybackTime, probe }: Props) {
  const groupRef = useRef<Group>(null);
  const { gl } = useThree();
  const ribbons = useMemo(() => source.marks.map((mark) => new Ribbon(mark.span.start)), [source]);
  const drawn = useRef<Array<Drawn | null>>([]);
  const last = useRef<{ paused: boolean; time: number; visible: boolean }>({ paused: false, time: -1, visible: false });
  const size = useMemo(() => new Vector2(), []);
  const scratch = useMemo(() => new Vector3(), []);

  useEffect(() => {
    const group = groupRef.current;
    if (!group) return;
    for (const ribbon of ribbons) group.add(ribbon.mesh);
    markChromeTree(group);
    drawn.current = source.marks.map(() => null);
    probe.hasTraces = true;
    probe.marks = source.marks.map((mark) => ({
      ...mark,
      drawn: false,
      drawnPoints: 0,
      headTime: null,
      headPosition: null,
      extent: 0,
      suppressed: { outsideSpan: 0, travel: 0, jumps: 0 }
    }));
    probe.tipNode = source.nodes;
    probe.group = group;
    probe.spans = source.spans;
    probe.tipAt = (mark, time) => source.sampler.tipAt(mark, time, scratch).toArray() as [number, number, number];
    return () => {
      for (const ribbon of ribbons) {
        group.remove(ribbon.mesh);
        ribbon.dispose();
      }
      probe.hasTraces = false;
      probe.marks = [];
      probe.tipAt = null;
      probe.tipNode = [];
      probe.group = null;
      probe.mode = "none";
      probe.snapshot = () => null;
      last.current = { paused: false, time: -1, visible: false };
    };
  }, [probe, ribbons, scratch, source]);

  useFrame(() => {
    const paused = portal.getState().paused;
    gl.getDrawingBufferSize(size);
    const pixelRatio = gl.getPixelRatio();
    for (const ribbon of ribbons) {
      (ribbon.material.uniforms.uResolution!.value as Vector2).copy(size);
      ribbon.material.uniforms.uMinPx!.value = MIN_CSS_PX * pixelRatio;
    }
    if (active && !paused) source.sampler.warm(WARM_BUDGET_MS);
    if (!active) {
      if (last.current.visible) {
        ribbons.forEach((ribbon) => ribbon.hide());
        probe.marks.forEach(clearMarkProbe);
        probe.mode = "none";
        probe.snapshot = () => null;
        last.current = { paused: false, time: -1, visible: false };
      }
      return;
    }
    const time = getPlaybackTime();
    // A paused frame is recomputed only when the paused moment changes (a scrub).
    if (paused && last.current.paused && Math.abs(last.current.time - time) < 1e-6) return;

    const started = performance.now();
    let any = false;
    const frameDrawn = drawn.current;
    source.marks.forEach((mark, m) => {
      const entry = probe.marks[m]!;
      const ribbon = ribbons[m]!;
      frameDrawn[m] = null;
      // Nothing before the span starts; the loop restart returns here.
      if (time < mark.span.start - 1e-6) {
        ribbon.hide();
        clearMarkProbe(entry);
        return;
      }
      if (!source.sampler.isBuilt(m)) {
        // Playback (or a scrub) reached the mark before it was warm: finish it now.
        const built = performance.now();
        source.sampler.path(m);
        pushTiming(probe.timings.warmSync, performance.now() - built);
      }
      const path = source.sampler.path(m);
      entry.extent = path.extent;
      entry.suppressed = path.suppressed;
      if (!path.drawable) {
        ribbon.hide();
        clearMarkProbe(entry);
        return;
      }
      const headTime = Math.min(time, mark.span.end);
      let k = 0;
      while (k < path.count && path.times[k]! <= headTime + 1e-6) k += 1;
      const partial = k > 0 && k < path.count && headTime > path.times[k - 1]! + 1e-6 && path.usable[k - 1] === 1;
      const head = new Vector3();
      if (partial) source.sampler.tipAt(m, headTime, head);
      else if (k > 0) head.fromArray(path.positions, (k - 1) * 3);
      const shown = k > 0 && (partial ? k : k - 1) > 0;
      const state: Drawn | null = k > 0 ? { k, partial, headTime: partial ? headTime : path.times[k - 1]!, head } : null;
      frameDrawn[m] = state;
      ribbon.update(path, state);
      entry.drawn = shown;
      entry.drawnPoints = shown ? k + (partial ? 1 : 0) : 0;
      entry.headTime = shown ? state!.headTime : null;
      entry.headPosition = shown ? (head.toArray() as [number, number, number]) : null;
      if (shown) any = true;
    });
    const elapsed = performance.now() - started;
    pushTiming(paused ? probe.timings.pause : probe.timings.frame, elapsed);
    probe.mode = any ? "drawing" : "none";
    probe.time = time;
    probe.snapshot = () => snapshot(source, frameDrawn.slice(), probe, time);
    last.current = { paused, time, visible: any };
  });

  return <group ref={groupRef} name="HandTraces" />;
}

function pushTiming(into: number[], value: number): void {
  into.push(value);
  if (into.length > PROBE_FRAMES) into.shift();
}

function clearMarkProbe(entry: HandTracesMarkProbe): void {
  entry.drawn = false;
  entry.drawnPoints = 0;
  entry.headTime = null;
  entry.headPosition = null;
}

function snapshot(source: HandTraceSource, frame: Array<Drawn | null>, probe: HandTracesProbe, time: number): HandTracesSnapshot {
  return {
    time,
    marks: source.marks.map((mark, m) => {
      const path = source.sampler.path(m);
      const state = frame[m];
      const entry = probe.marks[m];
      const shown = state !== null && state !== undefined && entry?.drawn === true;
      const points: HandTracesSnapshot["marks"][number]["points"] = [];
      const segments: Array<[number, number]> = [];
      if (shown && state) {
        for (let i = 0; i < state.k; i += 1) {
          points.push({ time: path.times[i]!, position: [path.positions[i * 3]!, path.positions[i * 3 + 1]!, path.positions[i * 3 + 2]!], hipSpeed: path.hipSpeeds[i]! });
        }
        if (state.partial) points.push({ time: state.headTime, position: state.head.toArray() as [number, number, number], hipSpeed: path.hipSpeeds[state.k - 1]! });
        for (let i = 0; i < points.length - 1; i += 1) if (path.usable[i] === 1) segments.push([i, i + 1]);
      }
      return { side: mark.side, drawn: shown, extent: path.extent, points, segments, suppressed: path.suppressed };
    })
  };
}
