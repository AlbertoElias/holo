import type { IwerEnvironmentSnapshot, XrCapabilities } from "@holoim/xr-runtime";

import type { ArPlacementStatus } from "./ARHologramModel";

const AR_SESSION_CONNECTIVITY_ERROR_PATTERN = /not connected to three\.js/i;

type InputSourceStateLike = {
  type: string;
};

export type ArDepthOcclusionStatus = {
  enabled: boolean;
  reason: "active" | "feature-unavailable" | "inactive-session" | "iwer-runtime" | "unsupported";
};

export function stripProblematicInputSources<T extends InputSourceStateLike>(inputSourceStates: readonly T[]): readonly T[] {
  return inputSourceStates.filter((inputSourceState) => (
    inputSourceState.type !== "controller" && inputSourceState.type !== "hand"
  ));
}

export function shouldRetryArSessionEntry(message: string, attempts: number, maxAttempts: number): boolean {
  return AR_SESSION_CONNECTIVITY_ERROR_PATTERN.test(message) && attempts < maxAttempts;
}

export function isPlacementResolved(status: ArPlacementStatus | null): boolean {
  return status != null
    && status.sequence > 0
    && status.stage !== "searching"
    && status.stage !== "unplaced";
}

export function resolvePlacementPreviewStatus(
  current: ArPlacementStatus | null,
  runtime: IwerEnvironmentSnapshot,
  timedOut: boolean
): ArPlacementStatus | null {
  if (isPlacementResolved(current)) {
    return null;
  }

  const nextSequence = (current?.sequence ?? 0) + 1;
  if (runtime.trackedPlanesCount > 0) {
    return {
      stage: "placed",
      mode: "floor",
      reason: "plane-detected",
      anchored: false,
      sequence: nextSequence
    };
  }

  if (!timedOut) {
    return null;
  }

  return {
    stage: "placed",
    mode: "visibility-fallback",
    reason: "hit-test-timeout",
    anchored: false,
    sequence: nextSequence
  };
}

export function resolveArSupportMessage(isIOS: boolean, capabilities: XrCapabilities): string | null {
  if (isIOS) {
    return null;
  }

  if (!capabilities.hasNavigatorXr) {
    return "WebXR is not supported on this device. Please use a WebXR-compatible browser on Android.";
  }

  if (!capabilities.supportsImmersiveAr) {
    return "AR is not supported on this browser. Please use a WebXR-compatible browser on Android.";
  }

  return null;
}

export function resolveDepthOcclusionStatus(capabilities: XrCapabilities | null): ArDepthOcclusionStatus {
  if (!capabilities?.supportsImmersiveAr) {
    return { enabled: false, reason: "unsupported" };
  }

  if (capabilities.hasIwerRuntime) {
    return { enabled: false, reason: "iwer-runtime" };
  }

  if (capabilities.sessionMode !== "immersive-ar") {
    return { enabled: false, reason: "inactive-session" };
  }

  if (!capabilities.depthSensingEnabled) {
    return { enabled: false, reason: "feature-unavailable" };
  }

  return { enabled: true, reason: "active" };
}
