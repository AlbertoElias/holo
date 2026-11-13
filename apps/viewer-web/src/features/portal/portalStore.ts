import { MathUtils, Vector3 } from "three";
import { deepTarget, type DeepZoom } from "./deepZoom";

// One portal per feed card. The store holds what the viewer chose (mode,
// pause, angles, zoom); the canvas turns that into a camera each frame.

export type PortalMode = "follow" | "free";
export type TiltStatus = "off" | "on" | "denied" | "unsupported";

export type PortalState = {
  mode: PortalMode;
  paused: boolean;
  /** Radians around world up; 0 looks at the author from +Z. */
  yaw: number;
  /** Radians above the horizon. */
  pitch: number;
  /** 0 = inside the scene near the author, 1 = third person at the Follow distance. */
  zoom: number;
  /**
   * Nepers past the inside end, into a hologram's declared layers (deep zoom,
   * docs/features/archive/deep-zoom.md): the camera stands the inside distance ×
   * e^−depth from the aim. Always 0 for a hologram that declares none.
   */
  depth: number;
  tiltStatus: TiltStatus;
  tiltYaw: number;
  tiltPitch: number;
};

/** Per-frame values the canvas writes for the actions to read; not rendered. */
export type PortalRuntime = {
  /** Follow camera angles, so entering Free starts where the camera already is. */
  followYaw: number;
  followPitch: number;
  /** ln(outside distance / inside distance); converts pinch scale to zoom. */
  zoomSpan: number;
  /** How deep the hologram's declared layers go (nepers); 0 when it declares none. Set by the canvas. */
  maxDepth: number;
  /**
   * Where a Return that began inside the layers began: the canvas retraces
   * the zoom path out to Follow (depth first, then zoom), in log distance,
   * so it passes back through each layer instead of leaping. Null otherwise.
   */
  returnFrom: { yaw: number; pitch: number; zoom: number; depth: number } | null;
  /** 1 right after Return, easing to 0 while the camera glides back. */
  returnBlend: number;
  /** Where the recording is, seconds, for the timecode. */
  playbackSeconds: number;
  /** What the camera did last frame, for tests and debugging. */
  measured: { cameraDistance: number; insideDistance: number; outsideDistance: number; target: [number, number, number] };
  /**
   * Whether a screen point lies on the hologram itself, or with `glass`
   * anywhere inside its cloche; set by the canvas once the model is in it.
   */
  hitTest: ((clientX: number, clientY: number, options?: { glass?: boolean }) => boolean) | null;
};

export const PITCH_MIN = MathUtils.degToRad(-8);
export const PITCH_MAX = MathUtils.degToRad(78);
/** Eye-level distance from the author at the inside end of the zoom continuum. */
export const INSIDE_DISTANCE = 1.6;
const MIN_ZOOM_SPAN = 0.4;

const INITIAL_STATE: PortalState = {
  mode: "follow",
  paused: false,
  yaw: 0,
  pitch: 0,
  zoom: 1,
  depth: 0,
  tiltStatus: "off",
  tiltYaw: 0,
  tiltPitch: 0
};

export type PortalStore = ReturnType<typeof createPortalStore>;

export function createPortalStore() {
  let state: PortalState = { ...INITIAL_STATE };
  const runtime: PortalRuntime = {
    followYaw: 0,
    followPitch: 0,
    zoomSpan: Math.log(6),
    maxDepth: 0,
    returnFrom: null,
    returnBlend: 0,
    playbackSeconds: 0,
    measured: { cameraDistance: 0, insideDistance: 0, outsideDistance: 0, target: [0, 0, 0] },
    hitTest: null
  };
  const listeners = new Set<() => void>();
  // Counts the viewer's own tilt moves (asking, turning it off, leaving the
  // card), so a motion-permission answer that arrives after one is stale.
  let tiltEpoch = 0;

  const set = (next: Partial<PortalState>) => {
    state = { ...state, ...next };
    listeners.forEach((listener) => listener());
  };

  const freeFromFollow = (): Partial<PortalState> => (
    state.mode === "free"
      ? {}
      : { mode: "free", yaw: runtime.followYaw, pitch: runtime.followPitch, zoom: 1, depth: 0 }
  );

  return {
    runtime,
    getState: () => state,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    togglePause: () => set({ paused: !state.paused }),
    setPaused: (paused: boolean) => {
      if (paused !== state.paused) set({ paused });
    },
    orbitBy: (deltaYaw: number, deltaPitch: number) => {
      const base = { ...state, ...freeFromFollow() };
      set({
        ...freeFromFollow(),
        yaw: base.yaw + deltaYaw,
        pitch: MathUtils.clamp(base.pitch + deltaPitch, PITCH_MIN, PITCH_MAX)
      });
    },
    /** The Free glyph: the viewer drives the camera, starting where Follow left it. */
    enterFree: () => {
      if (state.mode !== "free") set(freeFromFollow());
    },
    /**
     * `scale` > 1 moves in (fingers apart), < 1 moves out. Past the inside
     * end the move goes on into the declared layers, `deepRate` times as
     * fast (one log distance across the boundary, so one gesture crosses it
     * without a stop; a `deepRate` of 0 stops at the inside end); coming out
     * spends the depth first.
     */
    zoomByScale: (scale: number, deepRate = 1) => {
      if (!(scale > 0) || scale === 1) return;
      const base = { ...state, ...freeFromFollow() };
      const span = Math.max(runtime.zoomSpan, MIN_ZOOM_SPAN);
      const maxDepth = Math.max(runtime.maxDepth, 0);
      let nepers = Math.log(scale);
      let { zoom, depth } = base;
      if (maxDepth > 0 && nepers > 0) {
        const toInside = zoom * span;
        if (nepers > toInside) {
          zoom = 0;
          depth = Math.min(depth + (nepers - toInside) * deepRate, maxDepth);
          nepers = 0;
        }
      } else if (nepers < 0 && depth > 0) {
        const out = -nepers * deepRate;
        if (out <= depth) {
          depth -= out;
          nepers = 0;
        } else {
          nepers = -(out - depth) / deepRate;
          depth = 0;
        }
      }
      zoom = MathUtils.clamp(zoom - nepers / span, 0, 1);
      set({ ...freeFromFollow(), zoom, depth: maxDepth > 0 ? depth : 0 });
    },
    setTiltStatus: (tiltStatus: TiltStatus) => {
      tiltEpoch += 1;
      set(tiltStatus === "on" ? { tiltStatus } : { tiltStatus, tiltYaw: 0, tiltPitch: 0 });
    },
    /**
     * Starts a motion-permission ask. The returned function records its answer
     * only while nothing newer has happened: a later ask, turning tilt off,
     * or the card being reset all make the answer stale and it is dropped.
     */
    beginTiltRequest: () => {
      const epoch = (tiltEpoch += 1);
      return (tiltStatus: TiltStatus) => {
        if (epoch !== tiltEpoch) return;
        set(tiltStatus === "on" ? { tiltStatus } : { tiltStatus, tiltYaw: 0, tiltPitch: 0 });
      };
    },
    setTilt: (tiltYaw: number, tiltPitch: number) => {
      set({ ...freeFromFollow(), tiltYaw, tiltPitch });
    },
    returnToFollow: () => {
      if (state.mode === "follow") return;
      runtime.returnBlend = 1;
      runtime.returnFrom = state.depth > 0
        ? { yaw: state.yaw + state.tiltYaw, pitch: MathUtils.clamp(state.pitch + state.tiltPitch, PITCH_MIN, PITCH_MAX), zoom: state.zoom, depth: state.depth }
        : null;
      set({ mode: "follow", depth: 0, tiltYaw: 0, tiltPitch: 0 });
    },
    /** Back to playing in Follow, as a card is when it first scrolls into view. */
    reset: () => {
      tiltEpoch += 1;
      runtime.returnBlend = 0;
      runtime.returnFrom = null;
      state = { ...INITIAL_STATE };
      listeners.forEach((listener) => listener());
    }
  };
}

const scratchOffset = new Vector3();

/** Angles of `position` seen from `target`, as the Free orbit parameterises them. */
export function anglesFromPose(position: Vector3, target: Vector3): { yaw: number; pitch: number; distance: number } {
  scratchOffset.subVectors(position, target);
  const distance = scratchOffset.length();
  if (!(distance > 0)) return { yaw: 0, pitch: 0, distance: 0 };
  return {
    yaw: Math.atan2(scratchOffset.x, scratchOffset.z),
    pitch: Math.asin(MathUtils.clamp(scratchOffset.y / distance, -1, 1)),
    distance
  };
}

/** Camera distance for a zoom value: log-linear between the inside and outside ends. */
export function distanceForZoom(zoom: number, insideDistance: number, outsideDistance: number): number {
  const inside = Math.min(insideDistance, outsideDistance);
  return Math.exp(MathUtils.lerp(Math.log(inside), Math.log(outsideDistance), MathUtils.clamp(zoom, 0, 1)));
}

/** Seconds a Return from inside the layers takes: the plain glide plus this much per neper of depth. */
export const RETURN_SECONDS_PER_NEPER = 0.12;

/**
 * The pose a Return from inside the layers passes through at `t` (0 at the
 * start, 1 at Follow): the nepers between there and Follow spent depth first,
 * then zoom, while the angles turn to Follow's the short way.
 */
export function returnPose(
  from: NonNullable<PortalRuntime["returnFrom"]>,
  t: number,
  follow: { yaw: number; pitch: number },
  zoomSpan: number
): Pick<PortalState, "yaw" | "pitch" | "zoom" | "tiltYaw" | "tiltPitch"> & { depth: number } {
  const span = Math.max(zoomSpan, MIN_ZOOM_SPAN);
  const total = from.depth + (1 - from.zoom) * span;
  const spent = MathUtils.clamp(t, 0, 1) * total;
  const depth = Math.max(from.depth - spent, 0);
  const zoom = MathUtils.clamp(from.zoom + Math.max(spent - from.depth, 0) / span, 0, 1);
  const turn = Math.atan2(Math.sin(follow.yaw - from.yaw), Math.cos(follow.yaw - from.yaw));
  return { yaw: from.yaw + turn * t, pitch: MathUtils.lerp(from.pitch, follow.pitch, t), zoom, depth, tiltYaw: 0, tiltPitch: 0 };
}

/**
 * Free camera pose. The look target slides from the author's head (inside) to
 * the Follow target (outside), so zooming in ends at eye level with them.
 * With `deep` (a hologram that declares layers) and a depth past the inside
 * end, the camera goes on in: the inside distance × e^−depth from the aim
 * `deepTarget` gives for that depth.
 */
export function freeCameraPose(
  state: Pick<PortalState, "yaw" | "pitch" | "zoom" | "tiltYaw" | "tiltPitch"> & { depth?: number },
  followTarget: Vector3,
  headTarget: Vector3,
  insideDistance: number,
  outsideDistance: number,
  outPosition: Vector3,
  outTarget: Vector3,
  deep?: DeepZoom | null
): void {
  const depth = deep ? Math.max(state.depth ?? 0, 0) : 0;
  const distance = depth > 0
    ? Math.min(insideDistance, outsideDistance) * Math.exp(-depth)
    : distanceForZoom(state.zoom, insideDistance, outsideDistance);
  const yaw = state.yaw + state.tiltYaw;
  const pitch = MathUtils.clamp(state.pitch + state.tiltPitch, PITCH_MIN, PITCH_MAX);
  if (depth > 0 && deep) deepTarget(deep, depth, headTarget, outTarget);
  else outTarget.lerpVectors(headTarget, followTarget, MathUtils.clamp(state.zoom, 0, 1));
  outPosition.set(
    Math.sin(yaw) * Math.cos(pitch),
    Math.sin(pitch),
    Math.cos(yaw) * Math.cos(pitch)
  ).multiplyScalar(distance).add(outTarget);
}
