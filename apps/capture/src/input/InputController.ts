import type { DesktopViewMode, MockInputState } from '../types/contracts';

export interface MoveState {
  forward: boolean;
  back: boolean;
  left: boolean;
  right: boolean;
}

/** The desktop view the mouse and V key steer (the camera controller owns it). */
export interface DesktopLook {
  desktopViewMode: DesktopViewMode;
  lookYaw: number;
  thirdPersonPitch: number;
  firstPersonPitch: number;
  clampThirdPersonPitch(value: number): number;
  clampFirstPersonPitch(value: number): number;
}

interface InputControllerOptions {
  domElement: HTMLCanvasElement;
  isXrPresenting: () => boolean;
  look: DesktopLook;
  onRecordToggle: () => void;
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
      const look = this.options.look;
      look.desktopViewMode = look.desktopViewMode === 'third' ? 'first' : 'third';
      // Enter first person near neutral to avoid immediately looking into the torso.
      if (look.desktopViewMode === 'first') look.firstPersonPitch = -0.04;
    }

    if (key === 'r' && !event.repeat) {
      this.options.onRecordToggle();
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
    const look = this.options.look;
    look.lookYaw -= event.movementX * sensitivity;
    if (look.desktopViewMode === 'third') {
      look.thirdPersonPitch = look.clampThirdPersonPitch(look.thirdPersonPitch - event.movementY * sensitivity);
    } else {
      look.firstPersonPitch = look.clampFirstPersonPitch(look.firstPersonPitch - event.movementY * sensitivity);
    }
  };
}
