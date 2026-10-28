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

// A reach demand up to this fraction takes the crouch to its full pose; the rest becomes a squat.
const REACH_CROUCH_SHARE = 0.6;

/** Smoothed crouch from the desktop key and the VR head's drop below standing, and a desktop reach's demand (0 to 1). */
export class CrouchState {
  amount = 0;
  poseAmount = 0;
  /** 0 to 1 beyond the crouch: how far the hips drop below the full crouch for a floor reach. */
  squat = 0;
  /** A desktop reach's demand (0 to 1; 0 in VR): above 0 the body is bent by a reach, and the feet stay planted. */
  reach = 0;
  /** 0 to 1: the extra depth past a full squat a reach's set-down asks for. */
  deepExtra = 0;
  private keyAmount = 0;
  target = 0;
  source: CrouchSource = "none";
  private baseline: VrCrouchBaselineState = { standingHeadY: 0, standingCaptured: false };

  update(deltaSec: number, isVrActive: boolean, desktopHeld: boolean, vrHeadY: number | undefined, reachDemand = 0, reachDeep = 0): void {
    const vrCrouch = computeVrCrouchTarget(deltaSec, isVrActive ? vrHeadY : undefined, this.baseline);
    this.baseline = vrCrouch.baseline;
    const resolution = resolveCrouchTargetAndSource(isVrActive, desktopHeld ? 1 : 0, vrCrouch.vrTarget);
    this.target = resolution.target;
    this.source = resolution.source;
    this.keyAmount = stepCrouchAmount(this.keyAmount, this.target, deltaSec);
    this.amount = this.keyAmount;
    this.poseAmount = computeCrouchPoseAmount(this.amount, isVrActive);
    // A reach is already smoothed by its own rate: it bends the body as far as it asks, past the key's crouch.
    const reach = clamp(isVrActive ? 0 : reachDemand, 0, 1);
    this.reach = reach;
    this.deepExtra = isVrActive ? 0 : clamp(reachDeep, 0, 1);
    const crouchShare = clamp(reach / REACH_CROUCH_SHARE, 0, 1);
    this.squat = clamp((reach - REACH_CROUCH_SHARE) / (1 - REACH_CROUCH_SHARE), 0, 1);
    this.amount = Math.max(this.amount, crouchShare);
    this.poseAmount = Math.max(this.poseAmount, crouchShare * DEFAULT_CROUCH_TUNING.maxPoseAmount);
  }

  /** A fitted height is the standing reference for VR crouch. */
  setStandingHeadY(headY: number): void {
    this.baseline = { standingHeadY: headY, standingCaptured: true };
  }

  resetBaseline(): void {
    this.baseline = { standingHeadY: 0, standingCaptured: false };
  }

  release(): void {
    this.keyAmount = 0;
    this.squat = 0;
    this.reach = 0;
    this.deepExtra = 0;
    this.amount = 0;
    this.poseAmount = 0;
    this.target = 0;
    this.source = "none";
  }
}
