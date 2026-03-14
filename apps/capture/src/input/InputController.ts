import type { DesktopViewMode, MockInputState } from '../types/contracts';
import { clamp } from '../shared/math';

export interface MoveState {
  forward: boolean;
  back: boolean;
  left: boolean;
  right: boolean;
}

interface InputControllerOptions {
  domElement: HTMLCanvasElement;
  isXrPresenting: () => boolean;
  getDesktopViewMode: () => DesktopViewMode;
  setDesktopViewMode: (mode: DesktopViewMode) => void;
  getLookYaw: () => number;
  setLookYaw: (value: number) => void;
  getThirdPersonPitch: () => number;
  setThirdPersonPitch: (value: number) => void;
  getFirstPersonPitch: () => number;
  setFirstPersonPitch: (value: number) => void;
  onRecordToggle?: () => void;
}

export class InputController {
  readonly moveState: MoveState = { forward: false, back: false, left: false, right: false };

  private jumpQueued = false;
  private crouchHeld = false;
  private focusRecoveryUntilMs = 0;
  private lastFocusAttemptMs = 0;
  private readonly options: InputControllerOptions;

  constructor(options: InputControllerOptions) {
    this.options = options;
  }

  init(): void {
    this.options.domElement.tabIndex = 0;
    document.addEventListener('keydown', this.onKeyDown, true);
    document.addEventListener('keyup', this.onKeyUp, true);
    window.addEventListener('blur', this.onWindowBlur);
    document.addEventListener('visibilitychange', this.onVisibilityChange);
    document.addEventListener('mousemove', this.onMouseMove);
    this.options.domElement.addEventListener('click', this.onClick);
  }

  dispose(): void {
    document.removeEventListener('keydown', this.onKeyDown, true);
    document.removeEventListener('keyup', this.onKeyUp, true);
    window.removeEventListener('blur', this.onWindowBlur);
    document.removeEventListener('visibilitychange', this.onVisibilityChange);
    document.removeEventListener('mousemove', this.onMouseMove);
    this.options.domElement.removeEventListener('click', this.onClick);
  }

  onXrEntered(): void {
    this.clearMovementState();
  }

  onXrExited(): void {
    this.clearMovementState();
    this.focusRecoveryUntilMs = performance.now() + 4000;
    this.lastFocusAttemptMs = 0;
    this.restoreDesktopFocus();
  }

  onXrSessionEnded(): void {
    this.focusRecoveryUntilMs = performance.now() + 4000;
    this.lastFocusAttemptMs = 0;
    this.restoreDesktopFocus();
  }

  tickDesktopFocusRecovery(isXrPresenting: boolean): void {
    if (isXrPresenting) return;
    if (this.focusRecoveryUntilMs <= 0) return;

    const now = performance.now();
    if (now >= this.focusRecoveryUntilMs) {
      this.focusRecoveryUntilMs = 0;
      return;
    }

    if (now - this.lastFocusAttemptMs >= 160) {
      this.lastFocusAttemptMs = now;
      this.restoreDesktopFocus();
    }
  }

  consumeJumpQueued(): boolean {
    const queued = this.jumpQueued;
    this.jumpQueued = false;
    return queued;
  }

  isCrouchHeld(): boolean {
    return this.crouchHeld;
  }

  applyMockInput(payload: MockInputState): void {
    if (typeof payload.forward === 'boolean') this.moveState.forward = payload.forward;
    if (typeof payload.back === 'boolean') this.moveState.back = payload.back;
    if (typeof payload.left === 'boolean') this.moveState.left = payload.left;
    if (typeof payload.right === 'boolean') this.moveState.right = payload.right;
    if (typeof payload.crouch === 'boolean') this.crouchHeld = payload.crouch;
    if (payload.jump) this.jumpQueued = true;
  }

  private clearMovementState(): void {
    this.moveState.forward = false;
    this.moveState.back = false;
    this.moveState.left = false;
    this.moveState.right = false;
    this.crouchHeld = false;
    this.jumpQueued = false;
  }

  private restoreDesktopFocus(): void {
    const focusCanvas = (): void => {
      const active = document.activeElement;
      if (active instanceof HTMLElement && active !== this.options.domElement && active !== document.body) {
        active.blur();
      }
      this.options.domElement.focus({ preventScroll: true });
      window.focus();
    };
    focusCanvas();
    window.requestAnimationFrame(focusCanvas);
    window.setTimeout(focusCanvas, 120);
  }

  private setMoveStateFromKeyboardEvent(event: KeyboardEvent, active: boolean): boolean {
    const key = event.key.toLowerCase();
    const code = event.code;

    if (code === 'KeyW' || key === 'w') {
      this.moveState.forward = active;
      return true;
    }
    if (code === 'KeyS' || key === 's') {
      this.moveState.back = active;
      return true;
    }
    if (code === 'KeyA' || key === 'a') {
      this.moveState.left = active;
      return true;
    }
    if (code === 'KeyD' || key === 'd') {
      this.moveState.right = active;
      return true;
    }
    return false;
  }

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (this.setMoveStateFromKeyboardEvent(event, true)) {
      this.focusRecoveryUntilMs = 0;
      event.preventDefault();
    }

    const key = event.key.toLowerCase();

    if (key === 'v' && !this.options.isXrPresenting() && !event.repeat) {
      const nextMode = this.options.getDesktopViewMode() === 'third' ? 'first' : 'third';
      this.options.setDesktopViewMode(nextMode);
      if (nextMode === 'first') {
        // Keep default entry close to neutral to avoid immediately looking into torso.
        this.options.setFirstPersonPitch(-0.04);
      }
    }

    if (key === 'r' && !event.repeat) {
      this.options.onRecordToggle?.();
    }

    if (event.code === 'Space') {
      this.jumpQueued = true;
      event.preventDefault();
    }

    if (event.code === 'KeyC') {
      this.crouchHeld = true;
      event.preventDefault();
    }
  };

  private readonly onKeyUp = (event: KeyboardEvent): void => {
    if (this.setMoveStateFromKeyboardEvent(event, false)) {
      event.preventDefault();
    }

    if (event.code === 'KeyC') {
      this.crouchHeld = false;
      event.preventDefault();
    }
  };

  private readonly onWindowBlur = (): void => {
    this.clearMovementState();
  };

  private readonly onVisibilityChange = (): void => {
    if (document.hidden) {
      this.clearMovementState();
    }
  };

  private readonly onClick = (): void => {
    this.options.domElement.focus({ preventScroll: true });
    if (!this.options.isXrPresenting() && document.pointerLockElement !== this.options.domElement) {
      this.options.domElement.requestPointerLock();
    }
  };

  private readonly onMouseMove = (event: MouseEvent): void => {
    if (this.options.isXrPresenting() || document.pointerLockElement !== this.options.domElement) {
      return;
    }

    const sensitivity = 0.0025;
    this.options.setLookYaw(this.options.getLookYaw() - event.movementX * sensitivity);

    if (this.options.getDesktopViewMode() === 'third') {
      const next = clamp(this.options.getThirdPersonPitch() - event.movementY * sensitivity, 0.18, 0.72);
      this.options.setThirdPersonPitch(next);
      return;
    }

    const next = clamp(this.options.getFirstPersonPitch() - event.movementY * sensitivity, -1.2, 1.2);
    this.options.setFirstPersonPitch(next);
  };
}
