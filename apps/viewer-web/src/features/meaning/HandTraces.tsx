import { useFrame, useThree } from "@react-three/fiber";
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
import { HIGHLIGHT_COLOR } from "./PointingHighlights";
import {
  HAND_SIDES,
  HandTraceSampler,
  PAUSED_WINDOW_SEC,
  readRecordedHandSpans,
  resolveIndexTip,
  TAIL_WINDOW_SEC,
  type HandSide,
  type HandTrace,
  type TipSource,
  type TraceFrame
} from "./handTraceSampler";

// Hand traces (PRD-023): paused, each hand's last 3 s as a thin trace at true
// scale; playing with Traces on, a 1 s tail fading behind each moving hand.
// Ink, inferred style (styleguide 1.1, 4): the pointing highlight's hue,
// lighter than recorded marks, tapering in width and opacity to the oldest
// end, never under a legible width on a phone card.

/** Width at the newest end, in metres at true scale, */
const WORLD_WIDTH = 0.008;
/** never drawn narrower than this many CSS px anywhere along it (the oldest end too). */
const MIN_CSS_PX = 3;
/** Width at the oldest end, as a share of the newest. */
const OLDEST_WIDTH = 0.5;
/** Opacity at the newest and oldest ends: an inferred mark, lighter than a recorded one. */
const NEWEST_OPACITY = 0.85;
const OLDEST_OPACITY = 0.3;
/** The tail fades out entirely at its old end. */
const TAIL_OLDEST_OPACITY = 0;
/** How many per-frame timings the probe keeps. */
const PROBE_FRAMES = 600;
/** Frame time spent filling the sampler's keyframe cache while a card plays, so a pause reads cached samples. */
const WARM_BUDGET_MS = 0.5;

export type HandTracesProbe = {
  hasTraces: boolean;
  tip: Record<HandSide, TipSource | null>;
  spans: Record<HandSide, Array<{ start: number; end: number }>>;
  /** What is drawn now: the paused trace, the playing tail, or nothing. */
  mode: "none" | "paused" | "tail";
  /** Clip seconds the drawn trace ends at. */
  time: number;
  /** The drawn trace as plain data, read on demand so playing frames pay nothing for it. */
  snapshot: () => HandTracesSnapshot | null;
  /** ms of trace work, measured with performance.now(): once per pause or scrub, and per playing frame with the tail on. */
  timings: { pause: number[]; frame: number[] };
  /** The fingertip's world position at a clip time, as the trace samples it (for fidelity checks). */
  tipAt: ((side: HandSide, time: number) => [number, number, number]) | null;
  /** The fingertip nodes the trace follows, for checks against the mixer's own pose. */
  tipNode: Record<HandSide, Object3D | null>;
  /** The ribbons' group, as drawn. */
  group: Object3D | null;
};

export function createHandTracesProbe(): HandTracesProbe {
  return {
    hasTraces: false,
    tip: { left: null, right: null },
    spans: { left: [], right: [] },
    mode: "none",
    time: 0,
    snapshot: () => null,
    timings: { pause: [], frame: [] },
    tipAt: null,
    tipNode: { left: null, right: null },
    group: null
  };
}

type TraceGltf = { animations: AnimationClip[]; userData: Record<string, unknown> };

export type HandTraceSource = {
  sampler: HandTraceSampler;
  tips: Record<HandSide, TipSource>;
  nodes: Record<HandSide, Object3D>;
  spans: HandTracesProbe["spans"];
};

/** What a loaded take's traces are drawn from, or null when it has no recorded hand spans (desktop, older and third-party takes). */
export function useHandTraceSource(gltf: TraceGltf, scene: Object3D, anchors: HumanoidAnchors | null): HandTraceSource | null {
  return useMemo(() => {
    if (!anchors?.hips) return null;
    const spans = readRecordedHandSpans(gltf.userData);
    if (spans.left.length === 0 && spans.right.length === 0) return null;
    const clip = gltf.animations.slice().sort(compareTakeClips)[0];
    const left = resolveIndexTip(anchors, "left");
    const right = resolveIndexTip(anchors, "right");
    if (!clip || !left || !right) return null;
    const sampler = new HandTraceSampler(scene, clip, { left: left.node, right: right.node }, anchors.hips, spans);
    if (sampler.times.length < 2) return null;
    return { sampler, tips: { left: left.source, right: right.source }, nodes: { left: left.node, right: right.node }, spans };
  }, [anchors, gltf, scene]);
}

const vertexShader = /* glsl */ `
  uniform vec2 uResolution;
  uniform float uWorldWidth;
  uniform float uMinPx;
  uniform float uOldestWidth;
  attribute vec3 prev;
  attribute vec3 next;
  attribute float side;
  attribute float age;
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

/** One ribbon: two vertices per trace point, expanded across the screen in the vertex shader. */
class Ribbon {
  readonly mesh: Mesh<BufferGeometry, ShaderMaterial>;
  private capacity = 0;

  constructor(material: ShaderMaterial) {
    this.mesh = new Mesh(new BufferGeometry(), material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 997;
    this.mesh.visible = false;
  }

  private ensure(points: number): void {
    if (points <= this.capacity) return;
    const capacity = Math.max(64, Math.ceil(points * 1.5));
    const geometry = this.mesh.geometry;
    for (const [name, size] of [["position", 3], ["prev", 3], ["next", 3], ["side", 1], ["age", 1]] as const) {
      geometry.setAttribute(name, new BufferAttribute(new Float32Array(capacity * 2 * size), size));
    }
    geometry.setIndex(new BufferAttribute(new Uint32Array(capacity * 6), 1));
    this.capacity = capacity;
  }

  update(trace: HandTrace | null): void {
    if (!trace || !trace.drawn) {
      this.mesh.visible = false;
      return;
    }
    const { points, segments } = trace;
    this.ensure(points.length);
    const geometry = this.mesh.geometry;
    const position = geometry.getAttribute("position") as BufferAttribute;
    const prev = geometry.getAttribute("prev") as BufferAttribute;
    const next = geometry.getAttribute("next") as BufferAttribute;
    const side = geometry.getAttribute("side") as BufferAttribute;
    const age = geometry.getAttribute("age") as BufferAttribute;
    const index = geometry.getIndex()!;
    const drawnBefore = new Uint8Array(points.length);
    const drawnAfter = new Uint8Array(points.length);
    for (const [a, b] of segments) {
      drawnAfter[a] = 1;
      drawnBefore[b] = 1;
    }
    points.forEach((point, i) => {
      // At a break the direction comes from the one drawn neighbour.
      const p = point.position;
      const before = drawnBefore[i] ? points[i - 1]!.position : p;
      const after = drawnAfter[i] ? points[i + 1]!.position : p;
      for (let k = 0; k < 2; k += 1) {
        const v = i * 2 + k;
        position.setXYZ(v, p.x, p.y, p.z);
        prev.setXYZ(v, before.x, before.y, before.z);
        next.setXYZ(v, after.x, after.y, after.z);
        side.setX(v, k === 0 ? -1 : 1);
        age.setX(v, point.age);
      }
    });
    segments.forEach(([a, b], s) => {
      const i = s * 6;
      index.setX(i, a * 2);
      index.setX(i + 1, a * 2 + 1);
      index.setX(i + 2, b * 2);
      index.setX(i + 3, b * 2);
      index.setX(i + 4, a * 2 + 1);
      index.setX(i + 5, b * 2 + 1);
    });
    for (const attribute of [position, prev, next, side, age]) {
      attribute.clearUpdateRanges();
      attribute.addUpdateRange(0, points.length * 2 * attribute.itemSize);
      attribute.needsUpdate = true;
    }
    index.clearUpdateRanges();
    index.addUpdateRange(0, segments.length * 6);
    index.needsUpdate = true;
    geometry.setDrawRange(0, segments.length * 6);
    this.mesh.visible = true;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
  }
}

function material(oldestOpacity: number): ShaderMaterial {
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
      uOldestOpacity: { value: oldestOpacity }
    },
    transparent: true,
    depthWrite: false,
    // The quads' winding follows the stroke's screen direction, so either face may show.
    side: DoubleSide,
    toneMapped: false
  });
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
  const parts = useMemo(() => {
    const paused = material(OLDEST_OPACITY);
    const tail = material(TAIL_OLDEST_OPACITY);
    return { paused, tail, ribbons: { left: new Ribbon(paused), right: new Ribbon(paused) } as Record<HandSide, Ribbon> };
  }, []);
  const last = useRef<{ mode: HandTracesProbe["mode"]; time: number }>({ mode: "none", time: -1 });
  const size = useMemo(() => new Vector2(), []);
  const scratch = useMemo(() => new Vector3(), []);

  useEffect(() => {
    const group = groupRef.current;
    if (!group) return;
    for (const side of HAND_SIDES) group.add(parts.ribbons[side].mesh);
    markChromeTree(group);
    probe.hasTraces = true;
    probe.tip = source.tips;
    probe.tipNode = source.nodes;
    probe.group = group;
    probe.spans = source.spans;
    probe.tipAt = (side, time) => source.sampler.tipAt(side, time, scratch).toArray() as [number, number, number];
    return () => {
      for (const side of HAND_SIDES) {
        group.remove(parts.ribbons[side].mesh);
        parts.ribbons[side].dispose();
      }
      parts.paused.dispose();
      parts.tail.dispose();
      probe.hasTraces = false;
      probe.tipAt = null;
      probe.tipNode = { left: null, right: null };
      probe.group = null;
      last.current = { mode: "none", time: -1 };
    };
  }, [parts, probe, scratch, source]);

  useFrame(() => {
    const state = portal.getState();
    const mode: HandTracesProbe["mode"] = !active ? "none" : state.paused ? "paused" : state.traces ? "tail" : "none";
    gl.getDrawingBufferSize(size);
    const pixelRatio = gl.getPixelRatio();
    for (const mat of [parts.paused, parts.tail]) {
      (mat.uniforms.uResolution!.value as Vector2).copy(size);
      mat.uniforms.uMinPx!.value = MIN_CSS_PX * pixelRatio;
    }
    if (active && !state.paused) source.sampler.warm(WARM_BUDGET_MS);
    if (mode === "none") {
      if (last.current.mode !== "none") {
        for (const side of HAND_SIDES) parts.ribbons[side].update(null);
        probe.mode = "none";
        probe.snapshot = () => null;
        last.current = { mode: "none", time: -1 };
      }
      return;
    }
    const time = getPlaybackTime();
    // A paused trace is recomputed only when the paused moment changes (a scrub).
    if (mode === "paused" && last.current.mode === "paused" && Math.abs(last.current.time - time) < 1e-6) return;

    const started = performance.now();
    const frame = source.sampler.trace(time, mode === "paused" ? PAUSED_WINDOW_SEC : TAIL_WINDOW_SEC);
    for (const side of HAND_SIDES) {
      const ribbon = parts.ribbons[side];
      ribbon.mesh.material = mode === "paused" ? parts.paused : parts.tail;
      ribbon.update(frame.hands[side]);
    }
    const elapsed = performance.now() - started;
    const timings = mode === "paused" ? probe.timings.pause : probe.timings.frame;
    timings.push(elapsed);
    if (timings.length > PROBE_FRAMES) timings.shift();
    record(probe, mode, frame);
    last.current = { mode, time };
  });

  return <group ref={groupRef} name="HandTraces" />;
}

export type HandTracesSnapshot = {
  time: number;
  windowStart: number;
  hipSpeeds: number[];
  hands: Record<HandSide, {
    drawn: boolean;
    extent: number;
    points: Array<{ t: number; p: [number, number, number]; age: number }>;
    segments: Array<[number, number]>;
    suppressed: HandTrace["suppressed"];
  }>;
};

function record(probe: HandTracesProbe, mode: HandTracesProbe["mode"], frame: TraceFrame): void {
  probe.mode = mode;
  probe.time = frame.time;
  probe.snapshot = () => ({
    time: frame.time,
    windowStart: frame.windowStart,
    hipSpeeds: frame.hipSpeeds,
    hands: {
      left: snapshotHand(frame.hands.left),
      right: snapshotHand(frame.hands.right)
    }
  });
}

function snapshotHand(hand: HandTrace): HandTracesSnapshot["hands"][HandSide] {
  return {
    drawn: hand.drawn,
    extent: hand.extent,
    points: hand.points.map((point) => ({ t: point.time, p: point.position.toArray() as [number, number, number], age: point.age })),
    segments: hand.segments,
    suppressed: hand.suppressed
  };
}
