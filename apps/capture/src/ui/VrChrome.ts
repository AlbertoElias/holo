import * as THREE from 'three';
import type { World } from '@iwsdk/core';
import { tokens } from '@holoim/design-tokens';
import {
  chromeVisible,
  createRecordingUiState,
  dominantHand,
  isInChrome,
  markChromeTree,
  nonDominantHand,
  recordingText,
  type DockAction,
  type Hand,
  type Handedness
} from '@holoim/xr-ui-core';
import { AimRays, CHIP_OPACITY, HandDock, POKE, StatusLine, WorldPanel, configureXrPointers, handPointerIds, multiPointer, pointerHand } from '@holoim/xr-ui-iwsdk';
import { SHOW_CAPABILITIES, capabilityLine } from '../objects/findCapabilities';
import { ObjectSearchSession } from '../objects/objectSearchSession';
import type { UiViewModel } from '../types/contracts';
import type { XrTracking } from '../xr/XrTracking';
import { SpatialTick } from './SpatialTick';
import { SystemKeyboard } from './systemKeyboard';
import { VrFindPanel, type FindTargetId, type VrFindPanelProbe } from './VrFindPanel';
import type { UIStateStore } from './UIStateStore';

interface VrChromeDeps {
  world: World;
  store: UIStateStore;
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  /** Carries the tracked head pose; the status line follows it. */
  xrCamera: THREE.Camera;
  tracking: XrTracking;
  refitHeight: () => void;
  toggleRecording: () => void;
  setHandedness: (handedness: Handedness) => void;
  /** True when a held select on this source is already something else's (a Halo, a mark). */
  ownsSelect?: (source: XRInputSource | undefined) => boolean;
  /** A Find pick: the result's GLB goes to the tray through its loader (PRD-060). */
  pickObject: (url: string) => void;
}

/** VR carries the whole chrome; passthrough AR (the spectator) carries Find only. */
export type ChromeMode = 'vr' | 'ar';

/** After a commit the finger is still pulling back from chrome, not pointing. */
const POKE_RELEASE_SEC = 0.5;
/** Controller pulses: a light one on hover, a firmer one on commit. */
const PULSE_HOVER = { intensity: 0.15, durationMs: 12 };
const PULSE_COMMIT = { intensity: 0.5, durationMs: 30 };
// A controller's grip to the wrist joint's axes, in which the palm faces −Y.
const GRIP_TO_JOINT_LEFT = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI / 2);
const GRIP_TO_JOINT_RIGHT = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), -Math.PI / 2);
const SHADE_SEGMENTS = 32;

type RowId = 'refit' | 'hand';
/** What a check can aim at: the dock's glyphs, a settings row, or a Find panel target (`find:category:chairs`). */
export type ChromeTarget = 'record' | 'find' | RowId | `find:${FindTargetId}`;

/** What the placement, label-distance and handedness reports read (`__sampleChrome`). */
export interface VrChromeSnapshot {
  shown: boolean;
  handedness: Handedness;
  /** `occludedBy`: the first scene mesh, not chrome, between the head and the record glyph, or null when the glyph is in view. */
  wrist: { hand: Hand; input: 'poke' | 'ray'; visible: boolean; position: number[]; anchor: number[] | null; hitSizeM: number; drawnSizeM: number; recording: boolean; occludedBy: string | null; drawnOverBody: boolean } | null;
  statusLine: { visible: boolean; text: string; position: number[]; distanceFromHeadM: number } | null;
  panel: { visible: boolean; position: number[]; distanceFromHeadM: number; rows: Array<{ id: RowId; text: string; visible: boolean; enabled: boolean; distanceFromHeadM: number; hitHeightM: number }> } | null;
  /** The Find panel (PRD-060 slice 2) and the dock's Find glyph. */
  find: (VrFindPanelProbe & { mode: ChromeMode; dockGlyph: boolean; distanceFromHeadM: number }) | null;
  rays: Array<{ side: Hand; visible: boolean; hit: string | null; origin: number[] }>;
  /** The dominant index fingertip against the wrist glyph: world tip, the glyph's face normal, height above it. */
  poke: { tip: number[] | null; glyphNormal: number[] | null; depthM: number | null };
  fingertipShade: { visible: boolean; radiusM: number; opacity: number };
  /** Every visible label and its distance from the head: none may sit within 1 m. */
  labels: Array<{ name: string; text: string; distanceFromHeadM: number }>;
  feedback: { ticks: number; pulses: number; commits: number };
  head: number[];
}

const tmpA = new THREE.Vector3();
const tmpB = new THREE.Vector3();
const tmpQuat = new THREE.Quaternion();
const tmpScale = new THREE.Vector3();
const axisX = new THREE.Vector3();
const axisY = new THREE.Vector3();
const normal = new THREE.Vector3();
const raycaster = new THREE.Raycaster();

/**
 * Capture's chrome in a headset (styleguide 1.2, 6.1, 8.5, 9.1), built from
 * @holoim/xr-ui-iwsdk as the viewer's is (docs/features/archive/viewer-xr-interface.md,
 * step 5): the record glyph in the hand dock on the non-dominant wrist,
 * "Recording 0:12" on the periphery status line, refit and handedness on a
 * world panel opened 1.5 m ahead, and the gold aim rays. Nothing is locked to
 * the head but the status line. IWSDK's pointers deliver every press: a
 * controller ray clicks, a poke commits on contact. This class adds capture's
 * feedback around them: the fingertip shade before contact, a soft tick on a
 * poke, controller pulses on hover and commit.
 */
export class VrChrome {
  /** Every chrome object hangs here, chrome-flagged, so recording, export and pointing skip it. */
  readonly root = new THREE.Group();
  private dock: HandDock | null = null;
  private dockKey = '';
  private wristTracked = false;
  private readonly wristAnchor = new THREE.Object3D();
  private status: StatusLine | null = null;
  private panel: WorldPanel | null = null;
  private rays: AimRays | null = null;
  private placePanel = false;
  /** Updates since show() while presenting; the head is posed from the second. */
  private presentedFrames = 0;
  private readonly shade: THREE.Mesh;
  private readonly shadeMaterial: THREE.MeshBasicMaterial;
  private pokeNear = false;
  private lastPokeSec = -Infinity;
  private elapsedSec = 0;
  private readonly tick = new SpatialTick();
  private readonly feedback = { ticks: 0, pulses: 0, commits: 0 };
  private shown = false;
  private mode: ChromeMode = 'vr';
  private find: VrFindPanel | null = null;
  private findOpen = false;
  private placeFind = false;
  /** The select holding Speak: its release, tracking loss or blur ends the hold. */
  private speakHold: { hand: Hand; source: XRInputSource; session: XRSession; end: () => void } | null = null;
  /** The tray's item count when a pick was made, so the panel can say it landed. */
  private pickedAt: number | null = null;
  readonly findSession = new ObjectSearchSession();
  private readonly keyboard = new SystemKeyboard({
    onInput: (value) => this.findSession.setQuery(value),
    onSubmit: (value) => {
      this.find?.systemKeyboardClosed();
      if (value.trim()) this.findSession.search(value);
    }
  });

  constructor(private readonly deps: VrChromeDeps) {
    this.root.name = 'capture-chrome';
    this.wristAnchor.name = 'wrist-anchor';
    this.root.add(this.wristAnchor);
    // The fingertip shade (6.1): deep sea, soft at its rim, never a glow.
    const geometry = new THREE.CircleGeometry(1, SHADE_SEGMENTS);
    const count = geometry.getAttribute('position').count;
    const colours = new Float32Array(count * 4);
    for (let i = 0; i < count; i += 1) colours.set([1, 1, 1, i === 0 ? 1 : 0], i * 4);
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(colours, 4));
    this.shadeMaterial = new THREE.MeshBasicMaterial({ color: tokens.color.deepSea, vertexColors: true, transparent: true, depthWrite: false, side: THREE.DoubleSide, toneMapped: false });
    this.shade = new THREE.Mesh(geometry, this.shadeMaterial);
    this.shade.name = 'fingertip-shade';
    this.shade.visible = false;
    this.shade.renderOrder = 991;
    this.shade.raycast = () => undefined;
    this.root.add(this.shade);
    markChromeTree(this.root);
  }

  show(mode: ChromeMode = 'vr'): void {
    if (!this.root.parent) this.deps.scene.add(this.root);
    this.root.visible = true;
    this.shown = true;
    if (mode !== this.mode) this.dockKey = '';
    this.mode = mode;
    this.find?.setChipOpacity(this.chipOpacity());
    this.placePanel = mode === 'vr';
    this.closeFind();
    this.presentedFrames = 0;
    this.build();
    this.status?.reset();
    this.tick.prime();
  }

  hide(): void {
    this.root.parent?.remove(this.root);
    this.root.visible = false;
    this.shown = false;
    this.shade.visible = false;
    this.status?.set(null);
    this.panel?.setVisible(false);
    this.dock?.setVisible(false);
    this.closeFind();
  }

  private sdkRoots(): THREE.Object3D[] {
    return [this.status, this.panel, this.dock, this.find].flatMap((part) => (part ? [part.entity.object3D!] : []));
  }

  /** The status line, the world panel and the rays, once: the wrist is rebuilt per handedness and input. */
  private build(): void {
    if (this.status) return;
    const { world } = this.deps;
    configureXrPointers(world);
    // IWSDK keeps its entities (status line, panel, wrist dock) under its level,
    // outside this root: they place themselves in world space, and `sdkRoots`
    // marks and hides them with the rest of the chrome.
    this.status = new StatusLine(world, this.deps.xrCamera);
    this.panel = new WorldPanel(
      world,
      [
        { id: 'refit', text: 'Refit height', onSelect: () => this.deps.refitHeight() },
        { id: 'hand', text: 'Right-handed', onSelect: () => this.deps.setHandedness(this.deps.store.getState().handedness === 'right' ? 'left' : 'right') }
      ],
      {
        canCommit: (_row, pointerId) => !this.ownedElsewhere(pointerId),
        onCommit: (_row, pointerId) => this.committed(pointerId, 'ray'),
        onHover: (_row, pointerId, hovered) => hovered && this.pulsePointer(pointerId, PULSE_HOVER)
      }
    );
    this.rays = new AimRays(world);
    this.root.add(this.rays.group);
  }

  /** The Find panel, built on first open: its chip is the session's (VR 72%, passthrough 97%). */
  private buildFind(): VrFindPanel {
    if (this.find) return this.find;
    this.find = new VrFindPanel(this.deps.world, this.findSession, {
      chipOpacity: this.chipOpacity(),
      onPick: (url) => {
        this.pickedAt = this.deps.store.getState().tray.names.length;
        this.deps.pickObject(url);
      },
      onClose: () => this.closeFind(),
      openSystemKeyboard: () => {
        if (!SystemKeyboard.supported(this.deps.renderer.xr.getSession())) return false;
        this.keyboard.open();
        return true;
      },
      closeSystemKeyboard: () => this.keyboard.close(),
      canCommit: (pointerId) => !this.ownedElsewhere(pointerId),
      onCommit: (pointerId) => this.committed(pointerId, 'ray'),
      onHover: (pointerId, hovered) => hovered && this.pulsePointer(pointerId, PULSE_HOVER),
      onHoldStart: (pointerId) => this.holdSpeak(pointerId)
    });
    return this.find;
  }

  private chipOpacity(): number {
    return this.mode === 'ar' ? CHIP_OPACITY.arQuestPassthrough : CHIP_OPACITY.vr;
  }

  private holdSpeak(pointerId: number): void {
    this.endSpeakHold();
    const hand = pointerHand(this.deps.world, pointerId);
    const source = hand ? this.deps.tracking.getChromeInput(hand).inputSource : undefined;
    const session = this.deps.renderer.xr.getSession();
    if (!hand || !source || !session) {
      this.findSession.stopVoice();
      return;
    }
    const onSelectEnd = (event: XRInputSourceEvent) => {
      if (event.inputSource === source) this.endSpeakHold();
    };
    const onSourcesChange = (event: XRInputSourcesChangeEvent) => {
      if (event.removed.includes(source)) this.endSpeakHold();
    };
    const onBlur = () => {
      if (session.visibilityState !== 'visible') this.endSpeakHold();
    };
    session.addEventListener('selectend', onSelectEnd);
    session.addEventListener('inputsourceschange', onSourcesChange);
    session.addEventListener('visibilitychange', onBlur);
    this.speakHold = {
      hand,
      source,
      session,
      end: () => {
        session.removeEventListener('selectend', onSelectEnd);
        session.removeEventListener('inputsourceschange', onSourcesChange);
        session.removeEventListener('visibilitychange', onBlur);
      }
    };
  }

  private endSpeakHold(): void {
    if (!this.speakHold) return;
    this.speakHold.end();
    this.speakHold = null;
    this.findSession.stopVoice();
  }

  /** Find on the dock: the panel opens ahead and the settings panel steps aside (one world panel at a time). */
  private openFind(): void {
    if (this.findOpen) {
      this.closeFind();
      return;
    }
    this.buildFind();
    this.findOpen = true;
    this.placeFind = true;
    this.pickedAt = null;
  }

  private closeFind(): void {
    this.speakHold?.end();
    this.speakHold = null;
    this.findOpen = false;
    this.keyboard.close();
    this.findSession.cancel();
    this.find?.setVisible(false);
  }

  update(camera: THREE.Camera, deltaSec: number, elapsedSec: number): void {
    if (!this.shown) return;
    this.elapsedSec = elapsedSec;
    if (this.deps.renderer.xr.isPresenting) this.presentedFrames += 1;
    const state = this.deps.store.getState();
    const recording = state.recordingState === 'recording';
    camera.updateWorldMatrix(true, false);

    this.updateWrist(state.handedness, recording);
    this.updateStatus(deltaSec, state, recording);
    this.updatePanel(camera, state, recording);
    this.updateFind(camera, state, recording);
    this.updatePoke(state.handedness);
    // While a take runs, a ray shows only on the stop control it rests on.
    this.rays?.update((hand) => this.deps.renderer.xr.isPresenting && Boolean(this.deps.tracking.getChromeInput(hand).targetRay) && (!recording || this.rayHit(hand) === 'record'));
    markChromeTree(this.root);
    for (const object of this.sdkRoots()) markChromeTree(object);
  }

  snapshot(camera: THREE.Camera): VrChromeSnapshot {
    const head = camera.getWorldPosition(new THREE.Vector3());
    const state = this.deps.store.getState();
    const world = (object: THREE.Object3D): THREE.Vector3 => object.getWorldPosition(new THREE.Vector3());
    const labels: VrChromeSnapshot['labels'] = [];
    const status = this.status?.probe();
    if (status?.visible && status.text) labels.push({ name: 'status-line', text: status.text, distanceFromHeadM: new THREE.Vector3(...status.worldPosition).distanceTo(head) });
    for (const row of this.panel?.readableRows() ?? []) labels.push({ name: `panel-row-${row.id}`, text: row.text, distanceFromHeadM: world(row.object).distanceTo(head) });
    for (const label of this.find?.readableLabels() ?? []) labels.push({ name: `find-${label.id}`, text: label.text, distanceFromHeadM: world(label.object).distanceTo(head) });
    const panel = this.panel?.probe();
    const recordHit = this.dock?.hitTarget('record');
    const dock = this.dock?.probe();
    return {
      shown: this.shown,
      handedness: state.handedness,
      wrist: this.dock && recordHit && dock
        ? {
            hand: nonDominantHand(state.handedness),
            input: dock.input === 'poke' ? 'poke' : 'ray',
            visible: dock.visible,
            position: world(recordHit).toArray(),
            anchor: this.wristTracked ? world(this.wristAnchor).toArray() : null,
            hitSizeM: dock.hitSizeM,
            drawnSizeM: dock.drawnSizeM,
            occludedBy: this.occluder(camera, world(recordHit)),
            drawnOverBody: everyMesh(this.dock.entity.object3D!, (mesh) => !(Array.isArray(mesh.material) ? mesh.material : [mesh.material]).some((material) => material.depthTest)),
            recording: state.recordingState === 'recording'
          }
        : null,
      statusLine: status
        ? { visible: status.visible, text: status.text, position: status.worldPosition, distanceFromHeadM: new THREE.Vector3(...status.worldPosition).distanceTo(head) }
        : null,
      panel: panel
        ? {
            visible: panel.visible,
            position: panel.worldPosition,
            distanceFromHeadM: new THREE.Vector3(...panel.worldPosition).distanceTo(head),
            rows: panel.rows.map((row) => ({
              id: row.id as RowId,
              text: row.text,
              visible: row.visible,
              enabled: row.enabled,
              distanceFromHeadM: new THREE.Vector3(...row.worldPosition).distanceTo(head),
              hitHeightM: row.hitHeightM
            }))
          }
        : null,
      find: this.find
        ? {
            ...this.find.probe(),
            mode: this.mode,
            dockGlyph: Boolean(this.dock?.probe().buttons.find?.shown && this.dock.probe().visible),
            distanceFromHeadM: this.find.entity.object3D!.getWorldPosition(new THREE.Vector3()).distanceTo(head)
          }
        : this.dock
          ? { visible: false, worldPosition: [], query: '', status: '', keyboard: 'none', results: [], targets: [], mode: this.mode, dockGlyph: Boolean(this.dock.probe().buttons.find?.shown && this.dock.probe().visible), distanceFromHeadM: 0 }
          : null,
      rays: (this.rays?.probe() ?? []).map((ray) => ({ side: ray.hand, visible: ray.visible, hit: ray.visible ? this.rayHit(ray.hand) : null, origin: ray.origin })),
      poke: this.pokeSnapshot(state.handedness),
      fingertipShade: { visible: this.shade.visible, radiusM: this.shade.scale.x, opacity: this.shadeMaterial.opacity },
      labels,
      feedback: { ...this.feedback },
      head: head.toArray()
    };
  }

  /** A committed Halo action: a controller pulses, a hand hears the tick where the ring was. */
  haloFeedback(side: Hand, at: THREE.Vector3, input: 'hands' | 'controllers'): void {
    if (input === 'controllers') this.pulse(this.deps.tracking.getChromeInput(side).inputSource, PULSE_COMMIT);
    else {
      this.tick.play(at, this.deps.renderer.xr.getCamera());
      this.feedback.ticks += 1;
    }
  }

  /** The hand pressing chrome now (its fingertip at a glyph, or just after a commit), whose points are not evidence. */
  pokingHand(elapsedSec: number): Hand | null {
    if (!this.shown || !this.dock || this.dockInput() !== 'poke') return null;
    const presser = dominantHand(this.deps.store.getState().handedness);
    return this.pokeNear || elapsedSec - this.lastPokeSec < POKE_RELEASE_SEC ? presser : null;
  }

  /** The world-space point at the centre of a panel row or the wrist glyph, for checks that aim at it. */
  targetPosition(target: ChromeTarget): number[] | null {
    const object = target === 'record' || target === 'find' ? this.dock?.hitTarget(target) : target === 'refit' || target === 'hand' ? this.panel?.hitTarget(target) : this.find?.hitTarget(target.slice('find:'.length) as FindTargetId);
    return object ? object.getWorldPosition(new THREE.Vector3()).toArray() : null;
  }

  // --- The wrist ---

  private dockInput(): 'poke' | 'ray' {
    return this.dockKey.endsWith(':poke') ? 'poke' : 'ray';
  }

  private updateWrist(handedness: Handedness, recording: boolean): void {
    const carrier = nonDominantHand(handedness);
    // The pressing hand sets every hit area: a poke for a tracked hand, a ray for a controller.
    const input = this.deps.tracking.getChromeInput(dominantHand(handedness)).hand ? 'poke' : 'ray';
    const key = `${this.mode}:${handedness}:${input}`;
    if (key !== this.dockKey) {
      this.dock?.dispose();
      const record: DockAction = { id: 'record', glyph: 'record', label: 'Record', onSelect: () => this.deps.toggleRecording() };
      const find: DockAction = { id: 'find', glyph: 'find', label: 'Find an object', onSelect: () => this.openFind() };
      this.dock = new HandDock(this.deps.world, { kind: 'hand', space: this.wristAnchor, ownPointerIds: handPointerIds(this.deps.world, carrier), palm: [0, -1, 0] }, this.mode === 'vr' ? [record, find] : [find], {
        input,
        drawOverBody: true,
        canCommit: (action, pointerId) => (action.id === 'find' ? this.canFind(pointerId) : this.canRecord(pointerId)),
        onCommit: (_action, pointerId, kind) => this.committed(pointerId, kind),
        onHover: (_action, pointerId, hovered) => hovered && this.pulsePointer(pointerId, PULSE_HOVER)
      });
      this.dockKey = key;
    }
    this.wristTracked = this.placeWristAnchor(carrier);
    this.dock!.setVisible(this.wristTracked && (this.mode === 'ar' || chromeVisible('record', recording)));
    // Find is for before the take (PRD-060): it leaves the wrist while one runs.
    this.dock!.setActionVisible('find', chromeVisible('settings', recording));
    this.dock!.setRecording(recording);
    this.dock!.update();
  }

  /** Record runs unless a take is exporting, the select is something else's, or a hand-tracked ray points (hands poke). */
  private canRecord(pointerId: number): boolean {
    const state = this.deps.store.getState();
    if (!createRecordingUiState(state.recordingState, state.recordingMessage).canToggle || this.ownedElsewhere(pointerId)) return false;
    const hand = pointerHand(this.deps.world, pointerId);
    const viaRay = hand !== null && multiPointer(this.deps.world, hand).ray.pointer.id === pointerId;
    return !(viaRay && hand && this.deps.tracking.getChromeInput(hand).hand);
  }

  /** Find opens before a take, from a poke (hands) or a controller ray, like Record. */
  private canFind(pointerId: number): boolean {
    if (this.deps.store.getState().recordingState !== 'idle' || this.ownedElsewhere(pointerId)) return false;
    const hand = pointerHand(this.deps.world, pointerId);
    const viaRay = hand !== null && multiPointer(this.deps.world, hand).ray.pointer.id === pointerId;
    return !(viaRay && hand && this.deps.tracking.getChromeInput(hand).hand);
  }

  /** The carrying hand's wrist joint, or its controller's grip in the joint's axes; false when neither is tracked. */
  private placeWristAnchor(side: Hand): boolean {
    const tracking = this.deps.tracking;
    const chromeInput = tracking.getChromeInput(side);
    if (chromeInput.hand) {
      if (!tracking.getTrackedHandJointPosition(side, 'wrist', tmpA) || !tracking.getTrackedHandJointQuaternion(side, 'wrist', tmpQuat)) return false;
    } else if (chromeInput.grip) {
      chromeInput.grip.updateWorldMatrix(true, false);
      chromeInput.grip.matrixWorld.decompose(tmpA, tmpQuat, tmpScale);
      // In the joint's axes, as the anchor is: out of the palm is −Y. The grip's
      // palm is +X on the left hand and −X on the right (WebXR), a quarter turn
      // about the grip's rod axis (Z) away.
      tmpQuat.multiply(side === 'left' ? GRIP_TO_JOINT_LEFT : GRIP_TO_JOINT_RIGHT);
    } else {
      return false;
    }
    // World pose under the chrome root (which may itself be moved by a check's probe).
    this.root.updateWorldMatrix(true, false);
    const parentInverse = this.root.matrixWorld.clone().invert();
    const local = new THREE.Matrix4().compose(tmpA, tmpQuat, new THREE.Vector3(1, 1, 1)).premultiply(parentInverse);
    local.decompose(this.wristAnchor.position, this.wristAnchor.quaternion, tmpScale);
    this.wristAnchor.updateMatrixWorld(true);
    return true;
  }

  // --- The status line and the world panel ---

  private updateStatus(deltaSec: number, state: UiViewModel, recording: boolean): void {
    if (!this.status) return;
    const base = recording ? recordingText(state.recordingElapsedMs) : state.heightFit.pending ? 'Hold still: fitting your height' : '';
    // No mark shows live in a headset, so a Halo action is said here (slice 5).
    const text = state.notice ? (base ? `${base} · ${state.notice}` : state.notice) : base;
    this.status.set(text !== '' && chromeVisible('status', recording) ? { prefix: null, body: text } : null);
    this.status.update(deltaSec * 1000);
  }

  private updatePanel(camera: THREE.Camera, state: UiViewModel, recording: boolean): void {
    const panel = this.panel;
    if (!panel) return;
    // Opened level ahead once a presented frame has posed the head: on the
    // session's first update three has not yet written the XR camera.
    const posed = this.presentedFrames > 1 || !this.deps.renderer.xr.isPresenting;
    if (this.placePanel && posed) {
      panel.place(camera);
      this.placePanel = false;
    }
    panel.setVisible(this.mode === 'vr' && !this.placePanel && !this.findOpen && chromeVisible('settings', recording));
    panel.setRow('refit', {
      text: state.heightFit.pending ? 'Hold still…' : state.heightFit.enabled ? 'Refit height' : 'Refit after the take',
      enabled: state.heightFit.enabled && !state.heightFit.pending
    });
    panel.setRow('hand', { text: state.handedness === 'right' ? 'Right-handed' : 'Left-handed' });
    // Text within 1 m of the head hides (7.3), wherever the user has walked.
    panel.update(camera);
  }

  private updateFind(camera: THREE.Camera, state: UiViewModel, recording: boolean): void {
    if (!this.find) return;
    // A take closes Find, as the desktop field disables.
    if (this.findOpen && recording) this.closeFind();
    const posed = this.presentedFrames > 1 || !this.deps.renderer.xr.isPresenting;
    if (this.findOpen && this.placeFind && posed) {
      this.find.place(camera);
      this.placeFind = false;
    }
    this.find.setVisible(this.findOpen && !this.placeFind);
    if (!this.findOpen) return;
    // A hold also ends when its hand or controller stops tracking (6.1, holds).
    const hold = this.speakHold;
    if (hold) {
      const input = this.deps.tracking.getChromeInput(hold.hand);
      if (input.inputSource !== hold.source || !input.targetRay) this.endSpeakHold();
    }
    const { tray } = state;
    const trayLine = tray.loading
      ? 'Adding to the tray…'
      : tray.message ?? (this.pickedAt !== null && tray.names.length > this.pickedAt ? `In the tray: ${tray.names[tray.names.length - 1]}` : null);
    this.find.update(camera, {
      disabled: state.recordingState !== 'idle' || tray.loading,
      trayLine,
      debugLine: SHOW_CAPABILITIES ? capabilityLine(this.deps.renderer.xr.getSession()) : null
    });
  }

  // --- Poke feedback: the fingertip shade before contact ---

  private updatePoke(handedness: Handedness): void {
    const tracking = this.deps.tracking;
    const presser = dominantHand(handedness);
    this.shade.visible = false;
    this.pokeNear = false;
    if (!this.dock || this.dockInput() !== 'poke' || !this.dock.probe().visible || !tracking.getTrackedHandJointPosition(presser, 'index-finger-tip', tmpA)) return;
    const { drawnSizeM, hitSizeM } = this.dock.sizes;
    const buttons = this.dock.probe().buttons;
    for (const id of ['record', 'find']) {
      const hit = this.dock.hitTarget(id);
      if (!hit || !buttons[id]?.shown) continue;
      const face = faceFrame(hit);
      const offset = tmpB.copy(tmpA).sub(face.centre);
      const x = offset.dot(axisX);
      const y = offset.dot(axisY);
      const depth = offset.dot(normal);
      const half = hitSizeM / 2;
      if (!(Math.abs(x) <= half && Math.abs(y) <= half && depth <= POKE.proximityM && depth >= -POKE.throughM)) continue;
      this.pokeNear = true;
      // Blurred and wide while far, sharpening onto the glyph at contact.
      const t = THREE.MathUtils.clamp(Math.max(0, depth) / POKE.proximityM, 0, 1);
      this.shade.quaternion.copy(face.rotation);
      this.shade.position.copy(face.centre).addScaledVector(axisX, x).addScaledVector(axisY, y).addScaledVector(normal, 0.001);
      this.root.updateWorldMatrix(true, false);
      this.root.worldToLocal(this.shade.position);
      this.shade.scale.setScalar((drawnSizeM / 2) * (1 + 2 * t));
      this.shadeMaterial.opacity = tokens.shade.mid.alpha + (tokens.shade.inner.alpha - tokens.shade.mid.alpha) * (1 - t);
      this.shade.visible = true;
      return;
    }
  }

  private pokeSnapshot(handedness: Handedness): VrChromeSnapshot['poke'] {
    const hit = this.dock?.hitTarget('record');
    const read = new THREE.Vector3();
    const tip = this.deps.tracking.getTrackedHandJointPosition(dominantHand(handedness), 'index-finger-tip', read) ? read : null;
    if (!hit) return { tip: tip?.toArray() ?? null, glyphNormal: null, depthM: null };
    const face = faceFrame(hit);
    return { tip: tip?.toArray() ?? null, glyphNormal: normal.toArray(), depthM: tip ? tip.clone().sub(face.centre).dot(normal) : null };
  }

  // --- Rays, commits and feedback ---

  /** What a hand's ray pointer rests on, in the snapshot's words. */
  private rayHit(hand: Hand): string | null {
    const id = multiPointer(this.deps.world, hand).ray.pointer.id;
    if (this.dock?.isHoveredBy('record', id)) return 'record';
    if (this.dock?.isHoveredBy('find', id)) return 'find';
    for (const row of ['refit', 'hand'] as const) if (this.panel?.isHoveredBy(row, id)) return `row:${row}`;
    const found = this.find?.isShown() ? this.find.hoveredBy(id) : null;
    return found ? `find:${found}` : null;
  }

  private ownedElsewhere(pointerId: number): boolean {
    const hand = pointerHand(this.deps.world, pointerId);
    return hand !== null && Boolean(this.deps.ownsSelect?.(this.deps.tracking.getChromeInput(hand).inputSource));
  }

  private committed(pointerId: number, kind: 'poke' | 'ray'): void {
    this.feedback.commits += 1;
    if (kind === 'poke') {
      this.lastPokeSec = this.elapsedSec;
      const hit = this.dock?.hitTarget('record');
      if (hit) this.tick.play(hit.getWorldPosition(tmpA), this.deps.renderer.xr.getCamera());
      this.feedback.ticks += 1;
    } else {
      this.pulsePointer(pointerId, PULSE_COMMIT);
    }
  }

  private pulsePointer(pointerId: number, strength: { intensity: number; durationMs: number }): void {
    const hand = pointerHand(this.deps.world, pointerId);
    if (hand) this.pulse(this.deps.tracking.getChromeInput(hand).inputSource, strength);
  }

  private pulse(inputSource: XRInputSource | undefined, { intensity, durationMs }: { intensity: number; durationMs: number }): void {
    // `pulse` is the Gamepad extension WebXR browsers ship; the DOM types lack it.
    const actuator = (inputSource?.gamepad as { hapticActuators?: ReadonlyArray<{ pulse?: (value: number, ms: number) => Promise<boolean> }> } | undefined)?.hapticActuators?.[0];
    if (!actuator?.pulse) return;
    void actuator.pulse(intensity, durationMs).catch(() => undefined);
    this.feedback.pulses += 1;
  }

  /** The first visible scene mesh, not chrome, on the line from the head to `point`. */
  private occluder(camera: THREE.Camera, point: THREE.Vector3): string | null {
    const head = camera.getWorldPosition(new THREE.Vector3());
    const toPoint = point.clone().sub(head);
    const length = toPoint.length();
    raycaster.set(head, toPoint.normalize());
    raycaster.near = 0.01;
    raycaster.far = length - 0.002;
    const hit = raycaster.intersectObject(this.deps.scene, true).find((candidate) => !isInChrome(candidate.object) && isShown(candidate.object));
    raycaster.near = 0;
    raycaster.far = Infinity;
    return hit ? hit.object.name || hit.object.type : null;
  }
}

/** A glyph's face in world space: its centre, its rotation, and its axes (x, y in the face; the normal out of it). */
function faceFrame(hit: THREE.Object3D): { centre: THREE.Vector3; rotation: THREE.Quaternion } {
  hit.updateWorldMatrix(true, false);
  const centre = hit.getWorldPosition(new THREE.Vector3());
  const rotation = hit.getWorldQuaternion(new THREE.Quaternion());
  axisX.set(1, 0, 0).applyQuaternion(rotation);
  axisY.set(0, 1, 0).applyQuaternion(rotation);
  normal.set(0, 0, 1).applyQuaternion(rotation);
  return { centre, rotation };
}

/** Visible all the way up to the scene (hit meshes draw nothing, but their objects stay visible). */
function isShown(object: THREE.Object3D): boolean {
  for (let node: THREE.Object3D | null = object; node; node = node.parent) {
    if (!node.visible) return false;
    if (node.type === 'Scene') return true;
  }
  return false;
}

function everyMesh(root: THREE.Object3D, test: (mesh: THREE.Mesh) => boolean): boolean {
  let all = true;
  root.traverse((object) => {
    if ((object as THREE.Mesh).isMesh && !test(object as THREE.Mesh)) all = false;
  });
  return all;
}
