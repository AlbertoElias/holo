import { VisibilityState, type World } from '@iwsdk/core';
import * as THREE from 'three';

/**
 * Who advances simulation time. One clock, three modes:
 * - `realtime` (default): every animation frame steps by the time since the last.
 * - `manual`: frames only present; `advanceTime` steps in fixed 1/60 s steps,
 *   so automation results do not depend on host speed.
 * - `frame-stepping`: every XR frame steps by its own delta inside the frame
 *   callback, in a headset's order (input, simulation, draw). It overrides the
 *   manual clock while on and hands time back to it when switched off.
 */
export type ClockMode = 'realtime' | 'manual' | 'frame-stepping';

const ADVANCE_STEP_SEC = 1 / 60;
const MAX_FRAME_STEP_SEC = 0.1;

interface FrameLoopDeps {
  world: World;
  // Reads this frame's device input inside the XR frame callback, before any
  // simulation, so nothing keeps the frame object past it.
  acquire: (frame: XRFrame | undefined) => void;
  // Samples IWSDK's XR input and runs its pointers on this XR frame, for a
  // frame that does not step (the manual clock): see `holdXrInputBetweenFrames`.
  sampleInput: (deltaSec: number, timeSec: number) => void;
  // Draws, or only applies a draw's camera and matrix updates, after a step.
  present: (draw: boolean) => void;
  // Assets loaded: a step presents only then.
  isStarted: () => boolean;
  // Simulation steps the systems have run; IWSDK's ECS debugger can hold them.
  simulationSteps: () => number;
}

/**
 * Capture's single animation loop on World's renderer. Each simulation step
 * is one `world.update` — the systems in priority order — then one present.
 * It replaces World's built-in loop, which always draws and reads device
 * input only inside the pausable ECS update.
 */
export class FrameLoop {
  private manualClock = false;
  private manualDraws = true;
  private frameStepping = false;
  private frameSteppingDraws = false;
  private readonly clock = new THREE.Clock();

  constructor(private readonly deps: FrameLoopDeps) {}

  get clockMode(): ClockMode {
    if (this.frameStepping) return 'frame-stepping';
    return this.manualClock ? 'manual' : 'realtime';
  }

  start(): void {
    this.deps.world.renderer.setAnimationLoop((_time, frame) => this.onFrame(frame));
  }

  // Both switches discard time that passed before them, so stepping or
  // realtime resumes without a jump.
  setManualClock(enabled: boolean, draw = true): void {
    this.manualClock = enabled;
    this.manualDraws = draw;
    this.clock.getDelta();
  }

  setFrameStepping(enabled: boolean, draw = false): void {
    this.frameStepping = enabled;
    this.frameSteppingDraws = draw;
    this.clock.getDelta();
  }

  /**
   * Steps simulation by `ms` in fixed 1/60 s steps. Only the last step draws,
   * and under the manual clock none do: draws outside an XR frame are never
   * composited and queue up while automation holds frames.
   */
  advanceTime(ms: number): void {
    const steps = Math.max(1, Math.round(ms / (1000 / 60)));
    for (let i = 0; i < steps; i += 1) {
      const before = this.deps.simulationSteps();
      this.step(ADVANCE_STEP_SEC, !this.manualClock && i === steps - 1);
      if (this.deps.isStarted() && this.deps.simulationSteps() === before) {
        throw new Error('Simulation did not step: the IWSDK ECS debugger is paused. Resume it before advancing time.');
      }
    }
  }

  private onFrame(frame: XRFrame | undefined): void {
    const { world } = this.deps;
    world.visibilityState.value = (world.session?.visibilityState as VisibilityState | undefined) ?? VisibilityState.NonImmersive;
    this.deps.acquire(frame);
    const deltaSec = this.clock.getDelta();
    if (this.frameStepping) {
      this.step(Math.min(deltaSec, MAX_FRAME_STEP_SEC), this.frameSteppingDraws);
    } else if (this.manualClock) {
      // Simulation waits for advanceTime. The frame still applies render()'s
      // camera updates, so results do not depend on drawing, and runs the
      // chrome's pointers, which need the frame.
      this.deps.sampleInput(deltaSec, this.clock.elapsedTime);
      this.deps.present(this.manualDraws);
    } else {
      this.step(deltaSec, true);
    }
  }

  private step(deltaSec: number, draw: boolean): void {
    // Called through the property each time: IWSDK's debugger wraps
    // world.update to pause and single-step the simulation.
    this.deps.world.update(deltaSec, this.clock.elapsedTime);
    if (this.deps.isStarted()) this.deps.present(draw);
  }
}
