import { clamp } from "../shared/math";

export type CrouchSource = "none" | "desktop" | "vr" | "mixed";

export interface CrouchTuning {
  deadzoneMeters: number;
  fullDropMeters: number;
  engageSmoothingHz: number;
  releaseSmoothingHz: number;
  minEffectThreshold: number;
  baselineRecoveryPerSec: number;
  responseGamma: number;
  vrVisualBoost: number;
  maxPoseAmount: number;
}

export interface VrCrouchBaselineState {
  standingHeadY: number;
  standingCaptured: boolean;
}

export const DEFAULT_CROUCH_TUNING: Readonly<CrouchTuning> = {
  deadzoneMeters: 0.03,
  fullDropMeters: 0.2,
  engageSmoothingHz: 12,
  releaseSmoothingHz: 24,
  minEffectThreshold: 0.05,
  baselineRecoveryPerSec: 0.2,
  responseGamma: 0.55,
  vrVisualBoost: 2.1,
  maxPoseAmount: 1.45
};

export function computeVrCrouchTarget(
  deltaSec: number,
  headY: number | undefined,
  baseline: VrCrouchBaselineState,
  tuning: CrouchTuning = DEFAULT_CROUCH_TUNING
): { vrTarget: number; baseline: VrCrouchBaselineState } {
  if (headY === undefined || !Number.isFinite(headY)) {
    return { vrTarget: 0, baseline };
  }

  let standingHeadY = baseline.standingHeadY;
  let standingCaptured = baseline.standingCaptured;
  if (!standingCaptured) {
    standingHeadY = headY;
    standingCaptured = true;
  } else if (headY > standingHeadY) {
    const maxRecover = tuning.baselineRecoveryPerSec * Math.max(0, deltaSec);
    standingHeadY = Math.min(headY, standingHeadY + maxRecover);
  }

  const drop = Math.max(0, standingHeadY - headY);
  const normalizedDrop = clamp(
    (drop - tuning.deadzoneMeters) / Math.max(1e-6, tuning.fullDropMeters - tuning.deadzoneMeters),
    0,
    1
  );
  const vrTarget = Math.pow(normalizedDrop, tuning.responseGamma);

  return {
    vrTarget,
    baseline: {
      standingHeadY,
      standingCaptured
    }
  };
}

export function resolveCrouchTargetAndSource(
  isVrActive: boolean,
  desktopTarget: number,
  vrTarget: number,
  tuning: CrouchTuning = DEFAULT_CROUCH_TUNING
): { target: number; source: CrouchSource } {
  if (!isVrActive) {
    const target = desktopTarget;
    return {
      target,
      source: target >= tuning.minEffectThreshold ? "desktop" : "none"
    };
  }

  const target = Math.max(desktopTarget, vrTarget);
  if (target < tuning.minEffectThreshold) {
    return { target, source: "none" };
  }
  if (desktopTarget >= tuning.minEffectThreshold && vrTarget >= tuning.minEffectThreshold) {
    return { target, source: "mixed" };
  }
  if (vrTarget >= tuning.minEffectThreshold) {
    return { target, source: "vr" };
  }
  if (desktopTarget >= tuning.minEffectThreshold) {
    return { target, source: "desktop" };
  }

  return { target, source: "none" };
}

export function stepCrouchAmount(
  currentAmount: number,
  targetAmount: number,
  deltaSec: number,
  tuning: CrouchTuning = DEFAULT_CROUCH_TUNING
): number {
  const crouchSmoothingHz = targetAmount < currentAmount
    ? tuning.releaseSmoothingHz
    : tuning.engageSmoothingHz;
  const smoothing = 1 - Math.exp(-crouchSmoothingHz * Math.max(0, deltaSec));
  let next = currentAmount + (targetAmount - currentAmount) * smoothing;
  next = clamp(next, 0, 1);
  if (next < 1e-4 && targetAmount < 1e-4) {
    return 0;
  }
  return next;
}

export function computeCrouchPoseAmount(
  crouchAmount: number,
  isVrActive: boolean,
  tuning: CrouchTuning = DEFAULT_CROUCH_TUNING
): number {
  const visualBoost = isVrActive ? tuning.vrVisualBoost : 1;
  return clamp(crouchAmount * visualBoost, 0, tuning.maxPoseAmount);
}
