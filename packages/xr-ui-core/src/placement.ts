// Where each control lives (styleguide 1.2; brief Q11), and handedness: the
// non-dominant hand frames and holds modes, the dominant hand acts. Every
// slot and held mode reads the hand from here, so they cannot disagree.
import { tokens } from "@holoim/design-tokens";

import { isHeadset, isRoom, type ViewTarget } from "./targets.js";

export type Hand = "left" | "right";
/** The user's dominant hand. Right-handed by default, stored per device (brief Q8). */
export type Handedness = Hand;

export const DEFAULT_HANDEDNESS: Handedness = "right";

/** A stored setting read back safely; anything unexpected is the default. */
export function parseHandedness(stored: unknown): Handedness {
  return stored === "left" || stored === "right" ? stored : DEFAULT_HANDEDNESS;
}

export function dominantHand(handedness: Handedness): Hand {
  return handedness;
}

export function nonDominantHand(handedness: Handedness): Hand {
  return handedness === "right" ? "left" : "right";
}

export type Control =
  // At the hologram's foot.
  | "play" | "free" | "return" | "timecode" | "caption" | "scale"
  // Actions: general controls and the hand's tools.
  | "record" | "ink" | "undo" | "exitAr" | "placingHint" | "upload" | "signIn" | "halo"
  // Capture's object tray and the search that fills it (docs/features/tray-everywhere.md).
  | "tray" | "find"
  // Lists and long text.
  | "settings" | "library" | "longText"
  // State only.
  | "status"
  // Editing a mark, and menus that bloom from the hand.
  | "markEditor" | "menu";

export type Slot =
  | "stageBase" | "shade"
  | "wrist" | "dock"
  | "pointOfAction" | "cursor"
  | "referent" | "popover"
  | "periphery" | "statusLine"
  | "world" | "sideSheet"
  | "none";

export interface Placement {
  slot: Slot;
  /** The hand that carries it, for hand slots. */
  hand?: Hand;
  /** Only the periphery status line follows the head. */
  followsHead: boolean;
  /** Nearest distance from the head, for world panels. */
  minDistanceM?: number;
}

const FOOT: ReadonlySet<Control> = new Set(["play", "free", "return", "timecode", "caption", "scale"]);
const ACTIONS: ReadonlySet<Control> = new Set(["record", "ink", "undo", "exitAr", "placingHint", "upload", "signIn", "halo", "tray", "find"]);
const LISTS: ReadonlySet<Control> = new Set(["settings", "library", "longText"]);

/**
 * The slot a control lives in. In a headset, actions go on the non-dominant
 * wrist (Exit and the placing hint too, so they are reachable before
 * placement and with the hologram out of view) and lists on a world panel
 * 1 m away or more. On a phone, a desktop or phone AR they go in the bottom
 * dock and a side sheet. Nothing is head-locked except the periphery status
 * line, which holds state only. Quick Look holds no controls.
 */
export function placeControl(control: Control, target: ViewTarget, handedness: Handedness): Placement {
  if (target.kind === "quickLook") return { slot: "none", followsHead: false };
  const headset = isHeadset(target);
  if (FOOT.has(control)) return { slot: isRoom(target) ? "stageBase" : "shade", followsHead: false };
  if (ACTIONS.has(control)) {
    return headset ? { slot: "wrist", hand: nonDominantHand(handedness), followsHead: false } : { slot: "dock", followsHead: false };
  }
  if (LISTS.has(control)) {
    return headset ? { slot: "world", followsHead: false, minDistanceM: tokens.placement.worldPanelMinM } : { slot: "sideSheet", followsHead: false };
  }
  if (control === "status") return headset ? { slot: "periphery", followsHead: true } : { slot: "statusLine", followsHead: false };
  if (control === "markEditor") return { slot: headset ? "referent" : "popover", followsHead: false };
  return headset ? { slot: "pointOfAction", hand: dominantHand(handedness), followsHead: false } : { slot: "cursor", followsHead: false };
}

/** Where a world panel opens: 1.5 m away until the user moves it, never nearer than 1 m. */
export function worldPanelDistanceM(requestedM: number = tokens.placement.worldPanelDefaultM): number {
  return Math.max(tokens.placement.worldPanelMinM, requestedM);
}

// --- The periphery status line's lazy follow ---

export interface LazyFollow {
  /** Where the line sits, as yaw and pitch of the head, in degrees. */
  yaw: number;
  pitch: number;
  following: boolean;
}

function wrapDegrees(angle: number): number {
  return ((((angle + 180) % 360) + 360) % 360) - 180;
}

/** The status line's start: centred above the line of sight. */
export function startLazyFollow(headYaw: number, headPitch: number): LazyFollow {
  return { yaw: headYaw, pitch: headPitch + tokens.placement.statusLine.elevationDegrees, following: false };
}

/**
 * One frame of the status line's lazy follow: it stays put until the head
 * turns more than 20° away from it, then eases back (time constant 240 ms)
 * until it is within 1°.
 */
export function stepLazyFollow(state: LazyFollow, headYaw: number, headPitch: number, dtMs: number): LazyFollow {
  const { followBeyondDegrees, settleDegrees, follow, elevationDegrees } = tokens.placement.statusLine;
  const targetPitch = headPitch + elevationDegrees;
  const yawOff = wrapDegrees(headYaw - state.yaw);
  const pitchOff = targetPitch - state.pitch;
  const off = Math.hypot(yawOff, pitchOff);
  const following = state.following ? off > settleDegrees : off > followBeyondDegrees;
  if (!following) return { ...state, following: false };
  const k = 1 - Math.exp(-dtMs / follow);
  return { yaw: wrapDegrees(state.yaw + yawOff * k), pitch: state.pitch + pitchOff * k, following: true };
}
