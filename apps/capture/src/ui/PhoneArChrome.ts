import * as THREE from 'three';
import type { Entity, World } from '@iwsdk/core';
import { chromeVisible, markChromeTree, recordingText, type DockAction, type DockGlyph } from '@holoim/xr-ui-core';
import { HandDock, StatusLine, type HandDockProbe, type ScreenRect, type StatusLineProbe } from '@holoim/xr-ui-iwsdk';
import type { UIStateStore } from './UIStateStore';

interface PhoneArChromeDeps {
  world: World;
  store: UIStateStore;
  renderer: THREE.WebGLRenderer;
  /** The camera the frame draws with: the docks are its children, so they never lag the view. */
  xrCamera: THREE.Camera;
  /** The set's entry placement has finished. */
  isSettled: () => boolean;
  /** A take is starting, recording or exporting. */
  isTakeBusy: () => boolean;
  toggleRecording: () => void;
  recenter: () => void;
  /** Ends the AR session, as Android's back does. */
  exit: () => void;
}

type DockId = 'record' | 'recenter' | 'exit';
const DOCK_IDS: readonly DockId[] = ['recenter', 'record', 'exit'];

export interface PhoneArChromeProbe {
  built: boolean;
  viewport: { width: number; height: number; fovyDeg: number } | null;
  /** One entry per action, each the dock's reading narrowed to that action (`visible` is the action showing). */
  docks: Partial<Record<DockId, HandDockProbe>>;
  /** The chip under the row on the screen (CSS px from the top left), null while no action shows. */
  chip: ScreenRect | null;
  statusLine: StatusLineProbe | null;
}

/**
 * Capture's chrome in phone AR as a camera author (docs/features/archive/ar-recording.md,
 * slice 3; styleguide 6, 8.5, 9.2, 9.3): Record/Stop, Recenter and Exit in the
 * bottom dock, and "Recording 0:12" on the periphery status line, from
 * @holoim/xr-ui-iwsdk as the viewer's phone chrome is. Taps arrive as screen
 * input sources through the package's ScreenInputSystem.
 *
 * One `HandDock` holds the three actions, Recenter, Record, Exit, on one chip
 * fitted to the ones showing, with Record (the 36 apx ring) at the screen's
 * middle whatever else shows. While a take runs or exports only Record, as
 * Stop, shows (§8.5), and the chip shrinks to it.
 *
 * The dock and the status line are children of the XR camera, a plain three object, so they
 * never lag the view. IWSDK's TransformSystem moves an entity whose parent is
 * not an entity back under the level, so the camera is given an entity of its
 * own (an index and an object, no Transform: capture's camera stays a plain
 * three object, never float32 ECS state).
 */
export class PhoneArChrome {
  private dock: HandDock | null = null;
  private status: StatusLine | null = null;
  private cameraEntity: Entity | null = null;
  /** What each part should show when the camera pose is usable; a frame without one draws none of it. */
  private wanted = { record: false, recenter: false, exit: false, status: false };
  private releaseGuard: (() => void) | null = null;
  private viewport: PhoneArChromeProbe['viewport'] = null;
  private shown = false;

  constructor(private readonly deps: PhoneArChromeDeps) {}

  show(): void {
    this.shown = true;
    this.status?.reset();
  }

  hide(): void {
    this.shown = false;
    this.teardown();
  }

  update(deltaSec: number): void {
    if (!this.shown) return;
    if (!this.dock && !this.build()) return;
    const { store } = this.deps;
    const state = store.getState();
    const recording = state.recordingState === 'recording';
    const busy = this.deps.isTakeBusy();
    const dock = this.dock!;
    // Record shows once the set has settled (not while it exports); while a take runs it is the stop control.
    this.wanted.record = this.deps.isSettled() && state.recordingState !== 'exporting' && chromeVisible('record', recording);
    dock.setRecording(recording);
    // Between takes only (§8.5): not while a take runs, exports, or waits on the microphone. A session end still stops and exports.
    this.wanted.recenter = !busy;
    this.wanted.exit = !busy;
    dock.update();

    const status = this.status!;
    const base = recording ? recordingText(state.recordingElapsedMs) : state.recordingState === 'exporting' ? (state.recordingMessage ?? 'Exporting…') : (state.recordingMessage ?? '');
    const text = state.notice ? (base ? `${base} · ${state.notice}` : state.notice) : base;
    this.wanted.status = text !== '' && chromeVisible('status', recording);
    status.set(this.wanted.status ? { prefix: null, body: text } : null);
    // The lazy follow keeps no memory of a NaN head: it skips the step.
    const usable = this.poseUsable();
    if (usable) status.update(deltaSec * 1000);
    markChromeTree(status.entity.object3D!);
    markChromeTree(dock.entity.object3D!);
    this.applyVisibility(usable);
  }

  private poseUsable(): boolean {
    return this.deps.xrCamera.matrixWorld.elements.every(Number.isFinite);
  }

  /** Shows what `wanted` says, and nothing while the camera pose is not finite (UIKit cannot draw under a NaN matrix). */
  private applyVisibility(usable: boolean): void {
    if (!this.dock || !this.status) return;
    for (const id of DOCK_IDS) this.dock.setActionVisible(id, this.wanted[id]);
    this.dock.setVisible(usable);
    this.status.entity.object3D!.visible = usable && this.wanted.status;
  }

  probe(): PhoneArChromeProbe {
    const docks: PhoneArChromeProbe['docks'] = {};
    const whole = this.dock?.probe();
    if (whole) {
      // The shape capture's check reads: one entry per action, with that action's own sizes and button.
      for (const id of DOCK_IDS) {
        const button = whole.buttons[id]!;
        docks[id] = { ...whole, visible: whole.visible && button.shown, hitApx: button.hitApx, glyphApx: button.glyphApx, buttons: { [id]: button } };
      }
    }
    return { built: this.dock !== null, viewport: this.viewport, docks, chip: whole?.chip ?? null, statusLine: this.status?.probe() ?? null };
  }

  /** Builds the dock and the status line once the XR view's projection is known; false until it is. */
  private build(): boolean {
    const { world, renderer, xrCamera } = this.deps;
    const yScale = renderer.xr.getCamera().cameras[0]?.projectionMatrix.elements[5];
    if (!yScale || !Number.isFinite(yScale) || yScale <= 0) return false;
    // The XR view's projection, not the page camera's: flat sizes are pixels of the image the phone shows.
    const fovy = 2 * Math.atan(1 / yScale);
    const { innerWidth: width, innerHeight: height } = window;
    this.cameraEntity = world.createEntity();
    this.cameraEntity.object3D = xrCamera;
    (xrCamera as THREE.Camera & { entityIdx?: number }).entityIdx = this.cameraEntity.index;
    const mount = { kind: 'phone', camera: xrCamera, verticalFovRad: fovy, viewportHeightCss: height, viewportWidthCss: width } as const;
    const action = (id: DockId, glyph: DockGlyph, label: string, onSelect: () => void): DockAction => ({ id, glyph, label, onSelect });
    // Recenter, Record, Exit: Record in the middle where it stays whatever else shows.
    this.dock = new HandDock(world, mount, [
      action('recenter', 'recenter', 'Recenter', () => this.deps.recenter()),
      action('record', 'record', 'Record', () => this.deps.toggleRecording()),
      action('exit', 'exit', 'Exit', () => this.deps.exit())
    ]);
    markChromeTree(this.dock.entity.object3D!);
    // A frame's camera pose arrives after the step; a pose lost to NaN (an emulated tracking loss) would stop the draw.
    const scene = world.scene;
    const previous = scene.onBeforeRender;
    scene.onBeforeRender = (...args) => {
      previous.apply(scene, args);
      this.applyVisibility(this.poseUsable());
    };
    this.releaseGuard = () => {
      scene.onBeforeRender = previous;
    };
    this.viewport = { width, height, fovyDeg: (fovy * 180) / Math.PI };

    // Top centre of the screen, inside the safe area, on the chip, in CSS pixels (§1.2, §7.1, §9.2).
    const status = new StatusLine(world, xrCamera, { phone: { verticalFovRad: fovy, viewportHeightCss: height, viewportWidthCss: width } });
    this.status = status;
    return true;
  }

  private teardown(): void {
    this.releaseGuard?.();
    this.releaseGuard = null;
    this.dock?.dispose();
    this.dock = null;
    this.status?.dispose();
    this.status = null;
    this.viewport = null;
    if (this.cameraEntity) {
      delete (this.deps.xrCamera as THREE.Camera & { entityIdx?: number }).entityIdx;
      this.cameraEntity.destroy();
      this.cameraEntity = null;
    }
  }
}
