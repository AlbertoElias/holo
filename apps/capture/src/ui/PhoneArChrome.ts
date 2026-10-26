import * as THREE from 'three';
import type { Entity, World } from '@iwsdk/core';
import { chromeVisible, markChromeTree, recordingText, type DockAction, type DockGlyph } from '@holoim/xr-ui-core';
import { GLYPH, HEADSET_SCALE, HandDock, StatusLine, metresPerApx as headsetMetresPerApx, type HandDockProbe, type StatusLineProbe } from '@holoim/xr-ui-iwsdk';
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

export interface PhoneArChromeProbe {
  built: boolean;
  viewport: { width: number; height: number; fovyDeg: number } | null;
  docks: Partial<Record<DockId, HandDockProbe>>;
  statusLine: StatusLineProbe | null;
}

/**
 * Capture's chrome in phone AR as a camera author (docs/features/ar-recording.md,
 * slice 3; styleguide 6, 8.5, 9.2, 9.3): Record/Stop, Recenter and Exit in the
 * bottom dock, and "Recording 0:12" on the periphery status line, from
 * @holoim/xr-ui-iwsdk as the viewer's phone chrome is. Taps arrive as screen
 * input sources through the package's ScreenInputSystem.
 *
 * `HandDock` draws every glyph of one dock at the size of its biggest (the
 * Record ring), and Exit and Recenter are 16 apx icons, so each action is its
 * own one-glyph dock, side by side: Recenter, Record, Exit, Record in the
 * middle where it stays whatever else shows. Showing and hiding one never
 * moves another. While a take runs or exports only Record, as Stop, shows (§8.5). The shade is spread under all three and hangs on the camera, since any dock may hide.
 *
 * The docks are children of the XR camera, a plain three object, so they
 * never lag the view. IWSDK's TransformSystem moves an entity whose parent is
 * not an entity back under the level, so the camera is given an entity of its
 * own (an index and an object, no Transform: capture's camera stays a plain
 * three object, never float32 ECS state).
 */
export class PhoneArChrome {
  private docks: Record<DockId, HandDock> | null = null;
  private status: StatusLine | null = null;
  private cameraEntity: Entity | null = null;
  /** What each part should show when the camera pose is usable; a frame without one draws none of it. */
  private wanted = { record: false, recenter: false, exit: false, status: false };
  private shade: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial> | null = null;
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
    if (!this.docks && !this.build()) return;
    const { store } = this.deps;
    const state = store.getState();
    const recording = state.recordingState === 'recording';
    const busy = this.deps.isTakeBusy();
    const docks = this.docks!;
    // Record shows once the set has settled (not while it exports); while a take runs it is the stop control.
    this.wanted.record = this.deps.isSettled() && state.recordingState !== 'exporting' && chromeVisible('record', recording);
    docks.record.setRecording(recording);
    // Between takes only (§8.5): not while a take runs, exports, or waits on the microphone. A session end still stops and exports.
    this.wanted.recenter = !busy;
    this.wanted.exit = !busy;
    for (const dock of Object.values(docks)) dock.update();

    const status = this.status!;
    const base = recording ? recordingText(state.recordingElapsedMs) : state.recordingState === 'exporting' ? (state.recordingMessage ?? 'Exporting…') : (state.recordingMessage ?? '');
    const text = state.notice ? (base ? `${base} · ${state.notice}` : state.notice) : base;
    this.wanted.status = text !== '' && chromeVisible('status', recording);
    status.set(this.wanted.status ? { prefix: null, body: text } : null);
    // The lazy follow keeps no memory of a NaN head: it skips the step.
    const usable = this.poseUsable();
    if (usable) status.update(deltaSec * 1000);
    markChromeTree(status.entity.object3D!);
    this.applyVisibility(usable);
  }

  private poseUsable(): boolean {
    return this.deps.xrCamera.matrixWorld.elements.every(Number.isFinite);
  }

  /** Shows what `wanted` says, and nothing while the camera pose is not finite (UIKit cannot draw under a NaN matrix). */
  private applyVisibility(usable: boolean): void {
    if (!this.docks || !this.status) return;
    for (const id of Object.keys(this.docks) as DockId[]) this.docks[id].setVisible(usable && this.wanted[id]);
    this.status.entity.object3D!.visible = usable && this.wanted.status;
  }


  probe(): PhoneArChromeProbe {
    const docks: PhoneArChromeProbe['docks'] = {};
    if (this.docks) for (const id of Object.keys(this.docks) as DockId[]) docks[id] = this.docks[id].probe();
    return { built: this.docks !== null, viewport: this.viewport, docks, statusLine: this.status?.probe() ?? null };
  }

  /** Builds the docks and the status line once the XR view's projection is known; false until it is. */
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
    const action = (id: string, glyph: DockGlyph, label: string, onSelect: () => void): DockAction => ({ id, glyph, label, onSelect });
    const docks: Record<DockId, HandDock> = {
      record: new HandDock(world, mount, [action('record', 'record', 'Record', () => this.deps.toggleRecording())]),
      recenter: new HandDock(world, mount, [action('recenter', 'recenter', 'Recenter', () => this.deps.recenter())]),
      exit: new HandDock(world, mount, [action('exit', 'exit', 'Exit', () => this.deps.exit())])
    };
    // One glyph pitch: its hit area and a glyph gap.
    const probe = docks.record.probe();
    const pitchM = (probe.hitApx + GLYPH.gap) * probe.metresPerApx;
    const offsets: Record<DockId, number> = { recenter: -pitchM, record: 0, exit: pitchM };
    for (const id of Object.keys(docks) as DockId[]) {
      const dock = docks[id];
      const object = dock.entity.object3D!;
      object.position.x = offsets[id];
      markChromeTree(object);
      // One shade under the whole row, centred on the screen. It hangs on the camera, not on a dock: any dock may hide.
      const shade = object.getObjectByName('PhoneDockShade') as THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial> | undefined;
      if (!shade) continue;
      if (id === 'exit') {
        shade.position.set(0, object.position.y + shade.position.y, object.position.z + shade.position.z);
        xrCamera.add(shade);
        markChromeTree(shade);
        this.shade = shade;
      } else {
        shade.visible = false;
      }
    }
    this.docks = docks;
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

    const status = new StatusLine(world, xrCamera);
    // The line is built at a headset's size (2.5× apx at its distance); a phone shows the flat scale: type in CSS pixels (§7.1, §9.2).
    const flatScale = (2 * Math.tan(fovy / 2)) / height / (headsetMetresPerApx(1) * HEADSET_SCALE);
    status.entity.object3D!.scale.setScalar(flatScale);
    status.reset();
    this.status = status;
    return true;
  }

  private teardown(): void {
    this.releaseGuard?.();
    this.releaseGuard = null;
    if (this.docks) for (const dock of Object.values(this.docks)) dock.dispose();
    this.docks = null;
    if (this.shade) {
      this.shade.removeFromParent();
      this.shade.geometry.dispose();
      this.shade.material.map?.dispose();
      this.shade.material.dispose();
      this.shade = null;
    }
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
