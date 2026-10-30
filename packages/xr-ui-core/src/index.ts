import { CONTROL_NAMES } from "./controlNames.js";

export { CONTROL_NAMES, type ControlName } from "./controlNames.js";

// The redesigned parts (docs/features/ui-redesign.md, slice 2): each rule
// and formula of the styleguide written once, for every renderer.
export * from "./chip.js";
export * from "./chromeFlag.js";
export * from "./cloche.js";
export * from "./clocheBurn.js";
export * from "./clocheRim.js";
export * from "./edge.js";
export * from "./glyph.js";
export * from "./halo.js";
export * from "./headsetText.js";
export * from "./heldMode.js";
export * from "./hitArea.js";
export * from "./motion.js";
export * from "./placement.js";
export * from "./random.js";
export * from "./recordingChrome.js";
export * from "./scale.js";
export * from "./shade.js";
export * from "./targets.js";
export * from "./typeRoles.js";

export type XrMode = "desktop" | "mobile" | "vr" | "ar";

export type UiRecordingStatus = "idle" | "recording" | "exporting";
export type UiPermissionStatus = "pending" | "granted" | "denied" | "unsupported";
export type UiLoadStatus = "loading" | "ready" | "warning" | "error";

export interface XrSessionUiState {
  mode: XrMode;
  entered: boolean;
  supported: boolean;
  label: string;
  message: string | null;
}

export interface RecordingUiState {
  status: UiRecordingStatus;
  message: string | null;
  canToggle: boolean;
  actionLabel: string;
}

export function createRecordingUiState(status: UiRecordingStatus, message: string | null): RecordingUiState {
  return {
    status,
    message,
    canToggle: status !== "exporting",
    actionLabel: status === "recording"
      ? CONTROL_NAMES.stopRecording
      : status === "exporting"
        ? (message ?? "Exporting...")
        : CONTROL_NAMES.startRecording
  };
}

export interface ArShellNoticeState {
  bubbleWarning: string | null;
  depthOcclusionWarning: string | null;
}

export function resolveArShellNoticeState({
  bubbleStatus,
  depthOcclusionEnabled,
  isNativeRuntime
}: {
  bubbleStatus: string;
  depthOcclusionEnabled: boolean;
  isNativeRuntime: boolean;
}): ArShellNoticeState {
  const bubbleWarning = bubbleStatus === "missing-bubble"
    ? "Bubble effect unavailable for this hologram."
    : bubbleStatus === "error"
      ? "Bubble effect disabled for stability."
      : null;

  return {
    bubbleWarning,
    depthOcclusionWarning: !depthOcclusionEnabled && isNativeRuntime
      ? "Native AR session active, but depth occlusion is unavailable on this device."
      : null
  };
}

export interface ArImmersiveAction {
  id: "exit" | "recenter";
  label: string;
  tone: "danger" | "ghost";
  onSelect: () => void;
}

export function createArImmersiveActions({
  onExit,
  onRecenter
}: {
  onExit: () => void;
  onRecenter: () => void;
}): readonly ArImmersiveAction[] {
  return [
    { id: "exit", label: "Exit AR", onSelect: onExit, tone: "danger" },
    { id: "recenter", label: "Recenter Model", onSelect: onRecenter, tone: "ghost" }
  ];
}

export interface PlacementUiState {
  anchored: boolean;
  stage: string | null;
  mode: string | null;
  reason: string | null;
  sequence: number;
}

export interface PermissionUiState {
  micPermission: UiPermissionStatus;
}

export interface XrUiActions {
  enterVr?: () => void;
  enterAr?: () => void;
  exitXr?: () => void;
  recenter?: () => void;
  toggleRecording?: () => void;
  retryPermission?: () => void;
  exportRecording?: () => void;
}

// Hologram controls (docs/features/archive/viewer-xr-interface.md): the app-agnostic
// action model behind the foot controls, status line and hand dock. Each app
// supplies the actions; @holoim/xr-ui-iwsdk draws them.

/** Playback and pose state of one placed hologram, as its foot controls show it. */
export interface HologramControlState {
  playing: boolean;
  clipTime: number;
  /** Clip length in seconds; 0 is a still hologram (no timeline). */
  duration: number;
  /** Uniform scale relative to the recorded scale (1 = life size). */
  scale: number;
}

/** What a hologram's foot controls do; each acts only on its own hologram. */
export interface HologramControlActions {
  togglePlay(): void;
  restart(): void;
  seek(clipTime: number): void;
  recenter(): void;
  resetScale(): void;
}

export type DockGlyph = "exit" | "record" | "recenter" | "find" | "tray" | "putBack";

/** A glyph in the hand dock (headset) or bottom dock (phone). Glyphs only within reach. */
export interface DockAction {
  id: string;
  glyph: DockGlyph;
  /** Accessible name; never drawn within arm's reach. */
  label: string;
  onSelect(): void;
}

// The gallery shelf (docs/features/archive/viewer-xr-interface.md, step 4): feed
// holograms as small paused previews. A placed hologram leaves its tile empty
// until it goes back to the gallery: everything returns to its source (§1.2).

/** What a gallery tile shows. */
export type GalleryTileStatus = "loading" | "ready" | "placing" | "placed" | "error";

export interface GalleryTileState {
  title: string;
  status: GalleryTileStatus;
}

export const GALLERY_LABELS = {
  loading: "Loading…",
  error: "Couldn't load",
  newer: "Newer",
  older: "Older"
} as const;

/** The tile's label: the title, or its loading or error state. */
export function galleryTileLabel(tile: GalleryTileState): string {
  if (tile.status === "loading") return GALLERY_LABELS.loading;
  if (tile.status === "error") return GALLERY_LABELS.error;
  return tile.title;
}

/** Figtree tabular timecode, "0:08" (styleguide §7.2). */
export function formatTimecode(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

/** The label beside Play: "0:08", or "Paused · 0:08" (styleguide §6, §7.2); "Still" without a clip. */
export function playbackLabel(state: Pick<HologramControlState, "playing" | "clipTime" | "duration">): { prefix: string | null; time: string } {
  if (state.duration <= 0) return { prefix: null, time: "Still" };
  return { prefix: state.playing ? null : "Paused", time: formatTimecode(state.clipTime) };
}

/** Elapsed and total beside the timeline: "0:08 / 0:30". */
export function elapsedTotalLabel(state: Pick<HologramControlState, "clipTime" | "duration">): string {
  return `${formatTimecode(state.clipTime)} / ${formatTimecode(state.duration)}`;
}

export const LIFE_SIZE_LABEL = "life size";
const LIFE_SIZE_TOLERANCE = 0.005;

export function isLifeSize(scale: number): boolean {
  return Math.abs(scale - 1) < LIFE_SIZE_TOLERANCE;
}

/** The viewer's scale chip: "life size" at recorded scale, otherwise the share of it ("62%"); main's `scaleLabel` (scale.ts) reads "1:4". */
export function scaleChipLabel(scale: number): string {
  return isLifeSize(scale) ? LIFE_SIZE_LABEL : `${Math.round(scale * 100)}%`;
}

/**
 * Attention on the always-there set (styleguide §1.2): it dims after `idleAfterMs` unused and
 * returns when something comes near. The on-reach set shows only while something is near, and
 * holds `holdMs` after it leaves so it does not flicker at the edge of a trigger.
 */
export interface AttentionState {
  /** Last time (ms) anything came near or a control was used. */
  lastActiveAt: number;
  /** Last time (ms) a near trigger was true. */
  lastNearAt: number;
}

export interface AttentionTiming {
  idleAfterMs: number;
  idleOpacity: number;
  holdMs: number;
}

export interface AttentionReading {
  /** Opacity of the always-there set: 1, or idleOpacity once idle. */
  opacity: number;
  /** Whether the on-reach set is shown. */
  revealed: boolean;
  /** Time left before the always-there set dims, in ms (0 once dimmed). */
  dimInMs: number;
}

export function createAttentionState(now: number): AttentionState {
  return { lastActiveAt: now, lastNearAt: Number.NEGATIVE_INFINITY };
}

export function updateAttention(state: AttentionState, now: number, near: boolean, used: boolean, timing: AttentionTiming): AttentionReading {
  if (near) state.lastNearAt = now;
  if (near || used) state.lastActiveAt = now;
  const idleFor = now - state.lastActiveAt;
  return {
    opacity: idleFor >= timing.idleAfterMs ? timing.idleOpacity : 1,
    revealed: now - state.lastNearAt <= timing.holdMs,
    dimInMs: Math.max(0, timing.idleAfterMs - idleFor)
  };
}
export * from "./provisionalGlyphs.js";
