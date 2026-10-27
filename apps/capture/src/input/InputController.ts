import type { DesktopViewMode, MockInputState } from '../types/contracts';
import type { FlatHalo } from '../ui/flatHalo';
import { TouchInput, type TouchStick } from './TouchInput';

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
  /** The walk stick appeared, moved or left. */
  onTouchStick?: (stick: TouchStick | null) => void;
  /** The Halo a held B summons (slice 5). */
  halo?: FlatHalo;
}

const MOUSE_LOOK_RAD_PER_PX = 0.0025;
// A finger drags a shorter way than a locked mouse for the same turn.
const TOUCH_LOOK_RAD_PER_PX = 0.006;
// Stick share past which a direction is held (the motor walks in eight directions).
const STICK_DIRECTION_THRESHOLD = 0.38;

export class InputController {
  readonly moveState: MoveState = { forward: false, back: false, left: false, right: false };

  // Point action sources held now: 'mouse' (right button under pointer lock),
  // 'key' (F), 'touch' (touch and hold on the scene), 'mock' (automation).
  // Any one holds the action.
  private readonly pointSources = new Set<PointSource>();
  /** Where the holding finger is, CSS px, while 'touch' holds the point. */
  private touchAim: { x: number; y: number } | null = null;
  private haloKeyHeld = false;
  private lastMouse = { x: 0, y: 0 };
  private pointAimPitch = 0;
  private jumpQueued = false;
  private crouchHeld = false;
  // Desktop object carry: G toggles (queued for the next step), Q/E turn, Z/X tip.
  private objectToggleQueued = false;
  private readonly objectTurnKeys = new Set<'KeyQ' | 'KeyE' | 'KeyZ' | 'KeyX'>();
  // Desktop tray (PRD-045): T holds it open; 1–5 while held summon (queued for the next step).
  private trayHeld = false;
  private summonSlotQueued: number | null = null;
  private focusRecoveryUntilMs = 0;
  private lastFocusAttemptMs = 0;
  private lastPointerType = 'mouse';
  private readonly options: InputControllerOptions;
  readonly touch: TouchInput;

  constructor(options: InputControllerOptions) {
    this.options = options;
    this.touch = new TouchInput({
      domElement: options.domElement,
      isXrPresenting: options.isXrPresenting,
      onMove: (x, y) => this.applyStick(x, y),
      onLook: (dx, dy) => this.applyLook(dx, dy, TOUCH_LOOK_RAD_PER_PX),
      onStick: (stick) => options.onTouchStick?.(stick),
      onHold: (phase, point) => {
        if (phase === 'end') {
          this.endPoint('touch');
          this.touchAim = null;
          return;
        }
        this.touchAim = point;
        if (phase === 'start') this.startPoint('touch');
      }
    });
  }

  init(): void {
    this.options.domElement.tabIndex = 0;
    document.addEventListener('keydown', this.onKeyDown, true);
    document.addEventListener('keyup', this.onKeyUp, true);
    window.addEventListener('blur', this.onWindowBlur);
    document.addEventListener('focusin', this.onFocusIn);
    document.addEventListener('visibilitychange', this.onVisibilityChange);
    document.addEventListener('mousemove', this.onMouseMove);
    document.addEventListener('mousedown', this.onMouseDown, true);
    document.addEventListener('mouseup', this.onMouseUp, true);
    document.addEventListener('contextmenu', this.onContextMenu, true);
    document.addEventListener('pointerlockchange', this.onPointerLockChange);
    this.options.domElement.addEventListener('click', this.onClick);
    this.options.domElement.addEventListener('pointerdown', this.onPointerDown, true);
    this.touch.init();
  }

  /** Whether the desktop point action is held (right button, F, or the mock hook). */
  isPointHeld(): boolean {
    return this.pointSources.size > 0;
  }

  /** While a touch holds the point: the finger, CSS px. The camera ray through it aims. */
  getPointScreenAim(): { x: number; y: number } | null {
    return this.pointSources.has('touch') ? this.touchAim : null;
  }

  /** Aim pitch (radians above the horizon) while held; the mouse's vertical axis drives it. */
  getPointAimPitch(): number {
    return this.pointAimPitch;
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

  consumeObjectToggle(): boolean {
    const queued = this.objectToggleQueued;
    this.objectToggleQueued = false;
    return queued;
  }

  isTrayHeld(): boolean {
    return this.trayHeld;
  }

  consumeSummonSlot(): number | null {
    const slot = this.summonSlotQueued;
    this.summonSlotQueued = null;
    return slot;
  }

  /** −1..1 turn (Q turns left, positive about world up) and tip (X positive, Z negative) for a carried object. */
  getObjectTurn(): { yaw: number; pitch: number } {
    const held = (code: 'KeyQ' | 'KeyE' | 'KeyZ' | 'KeyX'): number => (this.objectTurnKeys.has(code) ? 1 : 0);
    return { yaw: held('KeyQ') - held('KeyE'), pitch: held('KeyX') - held('KeyZ') };
  }

  applyMockInput(payload: MockInputState): void {
    if (typeof payload.forward === 'boolean') this.moveState.forward = payload.forward;
    if (typeof payload.back === 'boolean') this.moveState.back = payload.back;
    if (typeof payload.left === 'boolean') this.moveState.left = payload.left;
    if (typeof payload.right === 'boolean') this.moveState.right = payload.right;
    if (typeof payload.crouch === 'boolean') this.crouchHeld = payload.crouch;
    if (payload.jump) this.jumpQueued = true;
    if (typeof payload.lookYaw === 'number') this.options.look.lookYaw = payload.lookYaw;
    if (typeof payload.point === 'boolean') {
      if (payload.point) this.startPoint('mock');
      else this.endPoint('mock');
    }
    if (typeof payload.aimPitch === 'number') {
      const look = this.options.look;
      this.pointAimPitch = look.clampFirstPersonPitch(payload.aimPitch);
      if (look.desktopViewMode === 'first') look.firstPersonPitch = this.pointAimPitch;
    }
  }

  private startPoint(source: PointSource): void {
    if (this.options.isXrPresenting()) return;
    if (this.pointSources.size === 0) {
      const look = this.options.look;
      // First person aims where the view looks; third person starts level.
      this.pointAimPitch = look.desktopViewMode === 'first' ? look.firstPersonPitch : 0;
    }
    this.pointSources.add(source);
  }

  private endPoint(source: PointSource): void {
    this.pointSources.delete(source);
  }

  /** The touch stick as the four walk keys. */
  private applyStick(x: number, y: number): void {
    this.moveState.forward = y > STICK_DIRECTION_THRESHOLD;
    this.moveState.back = y < -STICK_DIRECTION_THRESHOLD;
    this.moveState.right = x > STICK_DIRECTION_THRESHOLD;
    this.moveState.left = x < -STICK_DIRECTION_THRESHOLD;
    if (x !== 0 || y !== 0) this.focusRecoveryUntilMs = 0;
  }

  private clearMovementState(): void {
    this.touch.reset();
    this.moveState.forward = false;
    this.moveState.back = false;
    this.moveState.left = false;
    this.moveState.right = false;
    this.crouchHeld = false;
    this.jumpQueued = false;
    this.objectToggleQueued = false;
    this.objectTurnKeys.clear();
    this.trayHeld = false;
    this.summonSlotQueued = null;
    this.pointSources.clear();
    this.touchAim = null;
    this.haloKeyHeld = false;
    this.options.halo?.cancel();
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
    // Typing in a text field (the Find field) never moves, records or summons.
    if (isTextEntry(event.target)) return;
    // A focused control (a button in the dock or the side sheet, a file
    // picker) takes Space and Enter as its press; the scene never jumps on them.
    if ((event.code === 'Space' || event.key === 'Enter') && isControl(event.target)) return;
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

    if (event.code === 'KeyF' && !event.repeat) {
      this.startPoint('key');
      event.preventDefault();
    }

    // B holds the Halo; the mouse points its direction meanwhile (slice 5).
    if (event.code === 'KeyB' && !event.repeat && !this.options.isXrPresenting() && this.options.halo) {
      this.haloKeyHeld = true;
      const locked = document.pointerLockElement === this.options.domElement;
      this.options.halo.press(locked ? { x: window.innerWidth / 2, y: window.innerHeight / 2 } : this.lastMouse);
      event.preventDefault();
    }

    if (!this.options.isXrPresenting()) {
      if (event.code === 'KeyG' && !event.repeat) {
        this.objectToggleQueued = true;
        event.preventDefault();
      }
      if (isObjectTurnKey(event.code)) {
        this.objectTurnKeys.add(event.code);
        event.preventDefault();
      }
      if (event.code === 'KeyT') {
        this.trayHeld = true;
        event.preventDefault();
      }
      const slot = summonSlot(event.code);
      if (slot !== null && this.trayHeld && !event.repeat) {
        this.summonSlotQueued = slot;
        event.preventDefault();
      }
    }
  };

  private readonly onKeyUp = (event: KeyboardEvent): void => {
    // Releases are always processed: a key held before focus moved into a text
    // field must still end when it is let go.
    if (this.setMoveStateFromKeyboardEvent(event, false)) {
      event.preventDefault();
    }

    if (event.code === 'KeyC') {
      this.crouchHeld = false;
      event.preventDefault();
    }

    if (event.code === 'KeyF') {
      this.endPoint('key');
      event.preventDefault();
    }

    if (event.code === 'KeyB' && this.haloKeyHeld) {
      this.haloKeyHeld = false;
      this.options.halo?.release();
      event.preventDefault();
    }

    if (isObjectTurnKey(event.code)) {
      this.objectTurnKeys.delete(event.code);
      event.preventDefault();
    }

    if (event.code === 'KeyT') {
      this.trayHeld = false;
      event.preventDefault();
    }
  };

  private readonly onWindowBlur = (): void => {
    this.clearMovementState();
  };

  private readonly onFocusIn = (event: FocusEvent): void => {
    // Focus entering a text field drops every held key, since their releases
    // would otherwise be lost to the field.
    if (isTextEntry(event.target)) this.clearMovementState();
  };

  private readonly onVisibilityChange = (): void => {
    if (document.hidden) {
      this.clearMovementState();
    }
  };

  private readonly onMouseDown = (event: MouseEvent): void => {
    if (event.button !== 2 || this.options.isXrPresenting() || document.pointerLockElement !== this.options.domElement) return;
    this.startPoint('mouse');
    event.preventDefault();
  };

  private readonly onMouseUp = (event: MouseEvent): void => {
    if (event.button !== 2) return;
    this.endPoint('mouse');
  };

  // The point action owns the right button on the canvas; no browser menu.
  private readonly onContextMenu = (event: Event): void => {
    if (event.target === this.options.domElement || document.pointerLockElement === this.options.domElement) event.preventDefault();
  };

  private readonly onPointerLockChange = (): void => {
    if (document.pointerLockElement !== this.options.domElement) this.endPoint('mouse');
  };

  private readonly onPointerDown = (event: PointerEvent): void => {
    this.lastPointerType = event.pointerType;
  };

  private readonly onClick = (): void => {
    this.options.domElement.focus({ preventScroll: true });
    // Touch looks by dragging; there is no pointer to lock.
    if (this.lastPointerType === 'touch') return;
    if (!this.options.isXrPresenting() && document.pointerLockElement !== this.options.domElement) {
      // Browsers that refuse the lock reject the request; clicking again retries.
      void Promise.resolve(this.options.domElement.requestPointerLock()).catch(() => undefined);
    }
  };

  private applyLook(dx: number, dy: number, sensitivity: number): void {
    if (this.options.isXrPresenting()) return;
    const look = this.options.look;
    look.lookYaw -= dx * sensitivity;
    if (this.pointSources.size > 0) {
      // Held: vertical motion aims the point (first person's view follows it).
      this.pointAimPitch = look.clampFirstPersonPitch(this.pointAimPitch - dy * sensitivity);
      if (look.desktopViewMode === 'first') look.firstPersonPitch = this.pointAimPitch;
    } else if (look.desktopViewMode === 'third') {
      look.thirdPersonPitch = look.clampThirdPersonPitch(look.thirdPersonPitch - dy * sensitivity);
    } else {
      look.firstPersonPitch = look.clampFirstPersonPitch(look.firstPersonPitch - dy * sensitivity);
    }
  }

  private readonly onMouseMove = (event: MouseEvent): void => {
    this.lastMouse = { x: event.clientX, y: event.clientY };
    // While B holds the Halo the mouse picks its direction: no look, no aim.
    if (this.haloKeyHeld) {
      this.options.halo?.move(event.movementX, event.movementY);
      return;
    }
    if (this.options.isXrPresenting() || document.pointerLockElement !== this.options.domElement) {
      return;
    }

    this.applyLook(event.movementX, event.movementY, MOUSE_LOOK_RAD_PER_PX);
  };
}

type PointSource = 'mouse' | 'key' | 'touch' | 'mock';

/** Digit1–Digit5 (and the numpad's) as tray slots 1–5. */
function summonSlot(code: string): number | null {
  const match = /^(?:Digit|Numpad)([1-5])$/.exec(code);
  return match ? Number(match[1]) : null;
}

function isObjectTurnKey(code: string): code is 'KeyQ' | 'KeyE' | 'KeyZ' | 'KeyX' {
  return code === 'KeyQ' || code === 'KeyE' || code === 'KeyZ' || code === 'KeyX';
}

function isTextEntry(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest('input[type="search"], input[type="text"], textarea, [contenteditable="true"]') !== null;
}

function isControl(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest('button, input, select, textarea, [contenteditable="true"], [role="radio"], [role="button"]') !== null;
}
