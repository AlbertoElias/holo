import { CONTROL_NAMES } from "./controlNames.js";

export { CONTROL_NAMES, type ControlName } from "./controlNames.js";

// The redesigned parts (docs/features/ui-redesign.md, slice 2): each rule
// and formula of the styleguide written once, for every renderer.
export * from "./chip.js";
export * from "./chromeFlag.js";
export * from "./cloche.js";
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
