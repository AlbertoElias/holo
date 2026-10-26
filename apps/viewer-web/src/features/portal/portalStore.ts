import { MathUtils, Vector3 } from "three";

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
  tiltStatus: TiltStatus;
  tiltYaw: number;
  tiltPitch: number;
  /** The viewer's choice to see what the author pointed at (PRD-022); resets with the card. */
  highlights: boolean;
  /** The recording carries pointing links, so the toggle is worth showing. A fact about the model, not reset. */
  hasHighlights: boolean;
};

/** Per-frame values the canvas writes for the actions to read; not rendered. */
export type PortalRuntime = {
  /** Follow camera angles, so entering Free starts where the camera already is. */
  followYaw: number;
  followPitch: number;
  /** ln(outside distance / inside distance); converts pinch scale to zoom. */
  zoomSpan: number;
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
  tiltStatus: "off",
  tiltYaw: 0,
  tiltPitch: 0,
  highlights: true,
  hasHighlights: false
};

export type PortalStore = ReturnType<typeof createPortalStore>;

export function createPortalStore() {
  let state: PortalState = { ...INITIAL_STATE };
  const runtime: PortalRuntime = {
    followYaw: 0,
    followPitch: 0,
    zoomSpan: Math.log(6),
    returnBlend: 0,
    playbackSeconds: 0,
    measured: { cameraDistance: 0, insideDistance: 0, outsideDistance: 0, target: [0, 0, 0] },
    hitTest: null
  };
  const listeners = new Set<() => void>();

  const set = (next: Partial<PortalState>) => {
    state = { ...state, ...next };
    listeners.forEach((listener) => listener());
  };

  const freeFromFollow = (): Partial<PortalState> => (
    state.mode === "free"
      ? {}
      : { mode: "free", yaw: runtime.followYaw, pitch: runtime.followPitch, zoom: 1 }
  );

  return {
    runtime,
    getState: () => state,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    togglePause: () => set({ paused: !state.paused }),
    toggleHighlights: () => set({ highlights: !state.highlights }),
    setHasHighlights: (hasHighlights: boolean) => {
      if (hasHighlights !== state.hasHighlights) set({ hasHighlights });
    },
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
    /** `scale` > 1 moves in (fingers apart), < 1 moves out. */
    zoomByScale: (scale: number) => {
      if (!(scale > 0) || scale === 1) return;
      const base = { ...state, ...freeFromFollow() };
      const span = Math.max(runtime.zoomSpan, MIN_ZOOM_SPAN);
      set({ ...freeFromFollow(), zoom: MathUtils.clamp(base.zoom - Math.log(scale) / span, 0, 1) });
    },
    setTiltStatus: (tiltStatus: TiltStatus) => {
      set(tiltStatus === "on" ? { tiltStatus } : { tiltStatus, tiltYaw: 0, tiltPitch: 0 });
    },
    setTilt: (tiltYaw: number, tiltPitch: number) => {
      set({ ...freeFromFollow(), tiltYaw, tiltPitch });
    },
    returnToFollow: () => {
      if (state.mode === "follow") return;
      runtime.returnBlend = 1;
      set({ mode: "follow", tiltYaw: 0, tiltPitch: 0 });
    },
    /** Back to playing in Follow, as a card is when it first scrolls into view. */
    reset: () => {
      runtime.returnBlend = 0;
      state = { ...INITIAL_STATE, hasHighlights: state.hasHighlights };
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

/**
 * Free camera pose. The look target slides from the author's head (inside) to
 * the Follow target (outside), so zooming in ends at eye level with them.
 */
export function freeCameraPose(
  state: Pick<PortalState, "yaw" | "pitch" | "zoom" | "tiltYaw" | "tiltPitch">,
  followTarget: Vector3,
  headTarget: Vector3,
  insideDistance: number,
  outsideDistance: number,
  outPosition: Vector3,
  outTarget: Vector3
): void {
  const distance = distanceForZoom(state.zoom, insideDistance, outsideDistance);
  const yaw = state.yaw + state.tiltYaw;
  const pitch = MathUtils.clamp(state.pitch + state.tiltPitch, PITCH_MIN, PITCH_MAX);
  outTarget.lerpVectors(headTarget, followTarget, MathUtils.clamp(state.zoom, 0, 1));
  outPosition.set(
    Math.sin(yaw) * Math.cos(pitch),
    Math.sin(pitch),
    Math.cos(yaw) * Math.cos(pitch)
  ).multiplyScalar(distance).add(outTarget);
}
