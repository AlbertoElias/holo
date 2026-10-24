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
      ? "Stop Recording"
      : status === "exporting"
        ? (message ?? "Exporting...")
        : "Start Recording"
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

// Hologram controls (docs/features/viewer-xr-interface.md): the app-agnostic
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

export type DockGlyph = "exit" | "record";

/** A glyph in the hand dock (headset) or bottom dock (phone). Glyphs only within reach. */
export interface DockAction {
  id: string;
  glyph: DockGlyph;
  /** Accessible name; never drawn within arm's reach. */
  label: string;
  onSelect(): void;
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

/** The scale chip: "life size" at recorded scale, otherwise the share of it ("62%"). Rescaling is always labelled. */
export function scaleLabel(scale: number): string {
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
