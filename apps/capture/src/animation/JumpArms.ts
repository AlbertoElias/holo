import * as THREE from 'three';
import type { VrmHumanoidBone } from '@holoim/meaning';
import type { HumanoidSkeleton } from '../avatar/HumanoidSkeleton';

/**
 * The arms of a flat-screen jump, from motion capture. The library's jump and fall clips move the legs only, so the
 * desktop body would keep its idle (or walk) arms through the whole jump and read as stiff; a hand-tuned swing settled
 * into held poses and read as stiff too. The Leap clip is one recorded standing jump (CMU 118_01): arms back through
 * the squat, thrown forward as the legs drive, dropping through the flight and reaching for the landing. Each frame,
 * after the clip and the leg pose, this samples Leap's shoulder, arm and hand tracks at a clip time mapped from the
 * game's own jump (wind-up progress, then the upward speed against the launch speed, then the time since touch-down),
 * so the arms keep moving at the game's pace however long the flight lasts, and blends them over the playing pose.
 * Outside a jump its weight is zero and the clip plays untouched.
 */

/** Where the jump is, from the body pose system's own jump timing. */
export interface JumpPhase {
  /** Wind-up progress (0..1), held through the launch frame; 0 outside a wind-up. */
  windup: number;
  /** In the air: a jump from its take-off, any other fall only once it has lasted (a bump on a slope does not count). */
  airborne: boolean;
  /** Upward speed (m/s) and the speed a jump leaves the ground with. */
  velocityY: number;
  launchSpeed: number;
}

// Leap's marks (s): the squat with the arms going back, the arms furthest back as the legs drive, lift-off,
// touch-down and the end of the absorb (CMU 13_42 frames 24, 34, 46, 63 and 70, the clip starting at 14).
const FPS = 30;
const SQUAT = 10 / FPS;
const DRIVE = 20 / FPS;
const LIFT = 32 / FPS;
const TOUCH = 49 / FPS;
const ABSORBED = 56 / FPS;
/** The share of the flight (by vertical speed) the legs' drive spans: the push-off's first ~0.12 s of a 3.3 m/s jump. */
const DRIVE_SHARE = 0.18;
/** The landing holds the clip's arms this long after touch-down, then hands back to the playing pose over LAND_OUT_SEC. */
const LAND_HOLD_SEC = 0.3;
const LAND_OUT_SEC = 0.35;
/**
 * The clip time runs at most this many times its own pace. The game's wind-up and push-off are shorter than the
 * recorded ones (the drive to lift-off, 0.4 s of clip, maps onto the flight's first 0.13 s), and played that fast the
 * arm throw reached 455 m/s² at the wrists; capped, the arms finish the throw early in the flight, which is longer
 * than the clip's.
 */
const MAX_CLIP_RATE = 1.5;
/** Time constants (s) for the weight rising into a jump (fast: the wind-up is under 0.2 s) and a fall. */
const IN_SEC = 0.05;
const FALL_IN_SEC = 0.12;

const BONES: readonly VrmHumanoidBone[] = [
  'leftShoulder', 'leftUpperArm', 'leftLowerArm', 'leftHand',
  'rightShoulder', 'rightUpperArm', 'rightLowerArm', 'rightHand'
];

interface Channel {
  bone: THREE.Bone;
  side: 'left' | 'right';
  interpolant: THREE.Interpolant;
  /**
   * What the bone held before this layer turned it, and what it wrote. Not every state's clip writes the arms each
   * frame, so a bone still holding last frame's write is put back first; otherwise the blend would creep onto the
   * clip and stay there after the jump.
   */
  before: THREE.Quaternion;
  written: THREE.Quaternion;
  active: boolean;
}

export class JumpArms {
  private channels: Channel[] = [];
  private clip: THREE.AnimationClip | undefined;
  private humanoid: HumanoidSkeleton | undefined;
  private weight = 0;
  private time = SQUAT;
  private airborne = false;
  /** Seconds since touch-down, while a landing plays (Infinity otherwise). */
  private sinceTouch = Infinity;
  /** This frame's blend weight, for checks. */
  lastWeight = 0;
  private readonly sample = new THREE.Quaternion();

  /** Binds Leap's arm tracks to the avatar's bones (tracks named by node uuid or name); none without the clip. */
  attach(root: THREE.Object3D | undefined, humanoid: HumanoidSkeleton | undefined, clip: THREE.AnimationClip | undefined): void {
    this.reset();
    this.channels = [];
    this.clip = clip;
    this.humanoid = humanoid;
    if (!root || !humanoid || !clip) return;
    for (const name of BONES) {
      const bone = humanoid.bone(name);
      if (!bone) continue;
      const track = clip.tracks.find((t) => {
        const [node, property] = t.name.split('.');
        return property === 'quaternion' && (node === bone.uuid || node === bone.name);
      });
      if (!track) continue;
      this.channels.push({
        bone, side: name.startsWith('left') ? 'left' : 'right', interpolant: track.createInterpolant(),
        before: new THREE.Quaternion(), written: new THREE.Quaternion(), active: false
      });
    }
  }

  /** Clears the jump (a respawn, or the body handed to tracking). */
  reset(): void {
    this.weight = 0;
    this.lastWeight = 0;
    this.time = SQUAT;
    this.airborne = false;
    this.sinceTouch = Infinity;
  }

  /** Moves the clip time forward toward `time`, never back and never faster than MAX_CLIP_RATE. */
  private advance(time: number, dt: number): void {
    if (time > this.time) this.time = Math.min(time, this.time + dt * MAX_CLIP_RATE);
  }

  update(humanoid: HumanoidSkeleton | undefined, deltaSec: number, phase: JumpPhase, owned: Readonly<Record<'left' | 'right', boolean>>): void {
    const dt = Math.max(0, deltaSec);
    if (humanoid !== this.humanoid || !this.clip) return;
    for (const channel of this.channels) {
      if (channel.active && channel.bone.quaternion.equals(channel.written)) channel.bone.quaternion.copy(channel.before);
      channel.active = false;
    }
    let target = 0;
    let tau = IN_SEC;
    if (phase.airborne) {
      // Lift-off and the flight by the upward speed: 0 leaving the ground, 0.5 at the apex, 1 falling as fast as it
      // rose. A fall that never rose starts at its apex. The time only runs forward within one flight.
      const launch = Math.max(1e-3, phase.launchSpeed);
      const u = THREE.MathUtils.clamp((launch - phase.velocityY) / (2 * launch), 0, 1);
      const time = u < DRIVE_SHARE
        ? DRIVE + (LIFT - DRIVE) * (u / DRIVE_SHARE)
        : LIFT + (TOUCH - LIFT) * ((u - DRIVE_SHARE) / (1 - DRIVE_SHARE));
      if (!this.airborne && this.weight < 0.05) this.time = time;
      this.advance(time, dt);
      if (!this.airborne) this.sinceTouch = Infinity;
      this.airborne = true;
      target = 1;
      tau = phase.windup > 0 || this.weight > 0.5 ? IN_SEC : FALL_IN_SEC;
    } else if (phase.windup > 0) {
      this.airborne = false;
      this.sinceTouch = Infinity;
      if (this.weight < 0.05) this.time = SQUAT;
      this.advance(SQUAT + (DRIVE - SQUAT) * THREE.MathUtils.clamp(phase.windup, 0, 1), dt);
      target = 1;
    } else {
      if (this.airborne) {
        // Touch-down: the landing runs from the clip's own touch-down, at its own pace.
        this.airborne = false;
        this.sinceTouch = this.weight > 0.05 ? 0 : Infinity;
      } else this.sinceTouch += dt;
      if (this.sinceTouch < LAND_HOLD_SEC + LAND_OUT_SEC) {
        this.advance(Math.min(ABSORBED, Math.max(this.time + dt, TOUCH - 2 / FPS)), dt);
        target = this.sinceTouch < LAND_HOLD_SEC ? 1 : 0;
        tau = LAND_OUT_SEC / 3;
      } else {
        target = 0;
        tau = LAND_OUT_SEC / 3;
      }
    }
    this.weight += (target - this.weight) * (1 - Math.exp(-dt / Math.max(1e-3, tau)));
    if (target === 0 && this.weight < 1e-3) this.weight = 0;
    this.lastWeight = this.weight;
    let wrote = false;
    for (const channel of this.channels) {
      if (owned[channel.side] || this.weight <= 0) continue;
      const v = channel.interpolant.evaluate(this.time);
      this.sample.set(v[0]!, v[1]!, v[2]!, v[3]!).normalize();
      channel.before.copy(channel.bone.quaternion);
      channel.bone.quaternion.slerp(this.sample, this.weight);
      channel.written.copy(channel.bone.quaternion);
      channel.active = true;
      wrote = true;
    }
    // Restored or turned, the arms' world matrices are refreshed from the shoulders down (the arm clearance and the
    // aim read world positions after this).
    if (!wrote && !this.channels.length) return;
    for (const channel of this.channels) {
      const parent = channel.bone.parent;
      if (!parent || !this.channels.some((c) => c.bone === parent)) channel.bone.updateWorldMatrix(true, true);
    }
  }
}
