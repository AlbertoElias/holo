import * as THREE from 'three';
import { hitAreaMeters, tokens } from '@holoim/design-tokens';
import {
  VIEW_TARGETS,
  chromeVisible,
  createRecordingUiState,
  dominantHand,
  glyphAppearance,
  isInChrome,
  markChromeTree,
  nonDominantHand,
  recordingText,
  type Hand,
  type Handedness
} from '@holoim/xr-ui-core';
import {
  ThreeMsdfLabel,
  ThreeStatusLine,
  ThreeWorldPanel,
  ThreeWristGlyphs,
  createChromeMaterial,
  finishChrome,
  loadLabelAtlas,
  setChromeOpacity
} from '@holoim/xr-ui-three';
import type { UiViewModel } from '../types/contracts';
import type { XrTracking } from '../xr/XrTracking';
import { SpatialTick } from './SpatialTick';
import type { UIStateStore } from './UIStateStore';

interface VrChromeDeps {
  store: UIStateStore;
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  tracking: XrTracking;
  refitHeight: () => void;
  toggleRecording: () => void;
  setHandedness: (handedness: Handedness) => void;
}

// Set for slice 4 (docs/features/ui-redesign.md); the styleguide gives the
// fingertip shade's look but no distances, so these are open to revisit.
/** The fingertip shade appears this far above a glyph's face. */
const POKE_PROXIMITY_M = 0.1;
/** A fingertip this close to the face, inside the hit area, commits. */
const POKE_CONTACT_M = 0.008;
/** Below the face a fingertip still counts, so a fast poke is not missed. */
const POKE_THROUGH_M = 0.04;
/** One poke per approach: the finger must leave this far before the next. */
const POKE_REARM_M = 0.03;
/** After a commit the finger is still pulling back from chrome, not pointing. */
const POKE_RELEASE_SEC = 0.5;
/** How long a committed record glyph shows pressed; set to the rule, open to revisit. */
const PRESSED_SHOW_SEC = 0.12;
/** Controller pulses: a light one on hover, a firmer one on commit. */
const PULSE_HOVER = { intensity: 0.15, durationMs: 12 };
const PULSE_COMMIT = { intensity: 0.5, durationMs: 30 };
const RAY_IDLE_LENGTH_M = 1.4;
const SHADE_SEGMENTS = 32;

type RowId = 'refit' | 'hand';

interface PanelRow {
  id: RowId;
  label: ThreeMsdfLabel;
  hit: THREE.Mesh;
  enabled: boolean;
}

interface RayState {
  line: THREE.Line;
  /** The hit the ray rests on: the wrist's record glyph or a panel row. */
  hit: { kind: 'record' } | { kind: 'row'; id: RowId } | null;
  hitDistance: number;
}

/** What the placement, label-distance and handedness reports read (`__sampleChrome`). */
export interface VrChromeSnapshot {
  shown: boolean;
  handedness: Handedness;
  /** `occludedBy`: the first scene mesh, not chrome, between the head and the record glyph, or null when the glyph is in view. */
  wrist: { hand: Hand; input: 'poke' | 'ray'; visible: boolean; position: number[]; anchor: number[] | null; hitSizeM: number; drawnSizeM: number; recording: boolean; occludedBy: string | null; drawnOverBody: boolean } | null;
  statusLine: { visible: boolean; text: string; position: number[]; distanceFromHeadM: number } | null;
  panel: { visible: boolean; position: number[]; distanceFromHeadM: number; rows: Array<{ id: RowId; text: string; visible: boolean; enabled: boolean; distanceFromHeadM: number; hitHeightM: number }> } | null;
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
const raycaster = new THREE.Raycaster();
const levelHead = new THREE.Object3D();
/** Above the scene and the avatar, below the aim rays (998). */
const WRIST_OVER_BODY_ORDER = 990;

/**
 * Capture's chrome in a headset (styleguide 1.2, 6.1, 8.5, 9.1; brief
 * slice 4): the record glyph on the non-dominant wrist, "Recording 0:12" on
 * the periphery status line, settings on a world panel opened 1.5 m ahead,
 * and nothing locked to the head but the status line. The dominant hand
 * pokes the wrist (a fingertip shade before contact, a soft tick on commit)
 * or points at it with a controller ray (a pulse on hover and commit).
 */
export class VrChrome {
  /** Every chrome object hangs here, chrome-flagged, so recording, export and pointing skip it. */
  readonly root = new THREE.Group();
  private wrist: ThreeWristGlyphs | null = null;
  private wristKey = '';
  private wristTracked = false;
  /** The record state the wrist row was last drawn for; null after a rebuild. */
  private wristDrawnRecording: boolean | null = null;
  private readonly wristAnchor = new THREE.Object3D();
  private status: ThreeStatusLine | null = null;
  private panel: ThreeWorldPanel | null = null;
  private readonly rows: PanelRow[] = [];
  private placePanel = false;
  private loading: Promise<void> | null = null;
  private readonly shade: THREE.Mesh;
  private readonly shadeMaterial: THREE.MeshBasicMaterial;
  private readonly rays: Record<Hand, RayState>;
  /** Armed once the fingertip is seen above the glyph's face, so only an approach from above commits. */
  private pokeArmed = false;
  private pokeNear = false;
  private lastPokeSec = -Infinity;
  private pressedUntilSec = 0;
  private elapsedSec = 0;
  private unbindSelect: (() => void) | null = null;
  private readonly tick = new SpatialTick();
  private readonly feedback = { ticks: 0, pulses: 0, commits: 0 };
  private shown = false;

  constructor(private readonly deps: VrChromeDeps) {
    this.root.name = 'capture-chrome';
    // The fingertip shade (6.1): deep sea, soft at its rim, never a glow.
    const geometry = new THREE.CircleGeometry(1, SHADE_SEGMENTS);
    const count = geometry.getAttribute('position').count;
    const colours = new Float32Array(count * 4);
    for (let i = 0; i < count; i += 1) colours.set([1, 1, 1, i === 0 ? 1 : 0], i * 4);
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(colours, 4));
    this.shadeMaterial = createChromeMaterial({ color: tokens.color.deepSea, vertexColors: true, doubleSided: true });
    this.shade = new THREE.Mesh(geometry, this.shadeMaterial);
    this.shade.name = 'fingertip-shade';
    this.shade.visible = false;
    this.shade.renderOrder = 9;
    this.root.add(this.shade);
    this.rays = { left: this.createRay(), right: this.createRay() };
    finishChrome(this.root);
  }

  show(): void {
    if (!this.root.parent) this.deps.scene.add(this.root);
    this.shown = true;
    this.placePanel = true;
    this.loading ??= this.loadText();
    this.bindSelect();
    this.tick.prime();
  }

  hide(): void {
    this.unbindSelect?.();
    this.root.parent?.remove(this.root);
    this.shown = false;
    this.shade.visible = false;
  }

  update(camera: THREE.Camera, deltaSec: number, elapsedSec: number): void {
    if (!this.shown) return;
    this.elapsedSec = elapsedSec;
    const state = this.deps.store.getState();
    const recording = state.recordingState === 'recording';
    camera.updateWorldMatrix(true, false);
    const head = camera.getWorldPosition(new THREE.Vector3());

    this.updateWrist(state.handedness, recording);
    this.updateStatus(camera, deltaSec, state, recording);
    this.updatePanel(camera, head, state, recording);
    this.updatePoke(state.handedness);
    this.updateRays(state.handedness, recording);
    finishChrome(this.root);
  }

  snapshot(camera: THREE.Camera): VrChromeSnapshot {
    const head = camera.getWorldPosition(new THREE.Vector3());
    const state = this.deps.store.getState();
    const world = (object: THREE.Object3D): THREE.Vector3 => object.getWorldPosition(new THREE.Vector3());
    const labels: VrChromeSnapshot['labels'] = [];
    this.root.traverseVisible((object) => {
      const label = object.userData.msdfLabel as ThreeMsdfLabel | undefined;
      if (label) labels.push({ name: object.name, text: label.getText(), distanceFromHeadM: world(object).distanceTo(head) });
    });
    return {
      shown: this.shown,
      handedness: state.handedness,
      wrist: this.wrist
        ? {
            hand: this.wrist.hand,
            input: this.wrist.input === 'poke' ? 'poke' : 'ray',
            visible: isShown(this.wrist.group),
            position: world(this.wrist.glyphs[0]!.group).toArray(),
            anchor: this.wristTracked ? world(this.wristAnchor).toArray() : null,
            hitSizeM: this.wrist.glyphs[0]!.hitSizeM,
            drawnSizeM: this.wrist.glyphs[0]!.drawnSizeM,
            occludedBy: this.occluder(camera, world(this.wrist.glyphs[0]!.group)),
            drawnOverBody: everyMesh(this.wrist.group, (mesh) => !(Array.isArray(mesh.material) ? mesh.material : [mesh.material]).some((material) => material.depthTest)),
            recording: state.recordingState === 'recording'
          }
        : null,
      statusLine: this.status
        ? { visible: isShown(this.status.group), text: this.status.label.getText(), position: world(this.status.group).toArray(), distanceFromHeadM: world(this.status.group).distanceTo(head) }
        : null,
      panel: this.panel
        ? {
            visible: isShown(this.panel.group),
            position: world(this.panel.group).toArray(),
            distanceFromHeadM: world(this.panel.group).distanceTo(head),
            rows: this.rows.map((row) => ({
              id: row.id,
              text: row.label.getText(),
              visible: isShown(row.label.group),
              enabled: row.enabled,
              distanceFromHeadM: world(row.label.group).distanceTo(head),
              hitHeightM: (row.hit.geometry as THREE.PlaneGeometry).parameters.height
            }))
          }
        : null,
      rays: (['left', 'right'] as const).map((side) => {
        const positions = this.rays[side].line.geometry.getAttribute('position') as THREE.BufferAttribute;
        return { side, visible: this.rays[side].line.visible, hit: describeHit(this.rays[side].hit), origin: [positions.getX(0), positions.getY(0), positions.getZ(0)] };
      }),
      poke: this.pokeSnapshot(state.handedness),
      fingertipShade: { visible: this.shade.visible, radiusM: this.shade.scale.x, opacity: this.shadeMaterial.opacity },
      labels,
      feedback: { ...this.feedback },
      head: head.toArray()
    };
  }

  /** The hand pressing chrome now (its fingertip at a glyph, or just after a commit), whose points are not evidence. */
  pokingHand(elapsedSec: number): Hand | null {
    if (!this.shown || !this.wrist || this.wrist.input !== 'poke') return null;
    const presser = dominantHand(this.deps.store.getState().handedness);
    return this.pokeNear || elapsedSec - this.lastPokeSec < POKE_RELEASE_SEC ? presser : null;
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

  /** The world-space point at the centre of a panel row or the wrist glyph, for checks that aim at it. */
  targetPosition(target: 'record' | RowId): number[] | null {
    if (target === 'record') return this.wrist ? this.wrist.glyphs[0]!.hitTarget.getWorldPosition(new THREE.Vector3()).toArray() : null;
    const row = this.rows.find((candidate) => candidate.id === target);
    return row ? row.hit.getWorldPosition(new THREE.Vector3()).toArray() : null;
  }

  private pokeSnapshot(handedness: Handedness): VrChromeSnapshot['poke'] {
    const glyph = this.wrist?.glyphs[0];
    const read = new THREE.Vector3();
    const tip = this.deps.tracking.getTrackedHandJointPosition(dominantHand(handedness), 'index-finger-tip', read) ? read : null;
    if (!glyph) return { tip: tip?.toArray() ?? null, glyphNormal: null, depthM: null };
    const normal = new THREE.Vector3(0, 0, 1).applyQuaternion(glyph.hitTarget.getWorldQuaternion(new THREE.Quaternion()));
    const depth = tip ? glyph.hitTarget.worldToLocal(tip.clone()).z : null;
    return { tip: tip?.toArray() ?? null, glyphNormal: normal.toArray(), depthM: depth };
  }

  private async loadText(): Promise<void> {
    const [status, atlas] = await Promise.all([ThreeStatusLine.load({ chip: false, target: VIEW_TARGETS.vr }), loadLabelAtlas('controlLabel')]);
    this.status = status;
    this.status.group.visible = false;
    this.root.add(this.status.group);
    const panel = new ThreeWorldPanel({ target: VIEW_TARGETS.vr });
    for (const id of ['refit', 'hand'] as const) {
      const label = new ThreeMsdfLabel({ text: ' ', role: 'controlLabel', headset: true, distanceM: panel.distanceM, font: atlas.font, texture: atlas.texture, anchor: 'center' });
      label.group.name = `panel-row-${id}`;
      label.group.userData.msdfLabel = label;
      panel.addRow(label);
      const hit = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), createChromeMaterial({ color: tokens.glyph.color, visible: false, doubleSided: true }));
      hit.name = `panel-hit-${id}`;
      panel.group.add(hit);
      this.rows.push({ id, label, hit, enabled: true });
    }
    status.label.group.userData.msdfLabel = status.label;
    this.panel = panel;
    this.panel.group.visible = false;
    this.root.add(panel.group);
    markChromeTree(this.root);
  }

  // --- The wrist ---

  private updateWrist(handedness: Handedness, recording: boolean): void {
    const tracking = this.deps.tracking;
    const carrier = nonDominantHand(handedness);
    const presser = tracking.getChromeInput(dominantHand(handedness));
    // The pressing hand sets every hit area: a poke for a tracked hand, a ray for a controller.
    const input = presser.hand ? 'poke' : 'ray';
    const key = `${handedness}:${input}`;
    if (key !== this.wristKey) {
      if (this.wrist) {
        this.root.remove(this.wrist.group);
        this.wrist.dispose();
      }
      this.wrist = new ThreeWristGlyphs({ handedness, glyphs: ['record'], input });
      this.wristKey = key;
      this.wristDrawnRecording = null;
      this.pokeArmed = false;
      this.root.add(this.wrist.group);
    }
    this.wristTracked = this.placeWristAnchor(carrier);
    const wrist = this.wrist!;
    wrist.group.visible = this.wristTracked && chromeVisible('record', recording);
    if (this.wristTracked) wrist.update(this.wristAnchor);
    if (this.wristDrawnRecording !== recording) {
      wrist.setRecording(recording);
      drawOverBody(wrist.group);
      this.wristDrawnRecording = recording;
    }
  }

  /** The carrying hand's wrist joint, or its controller's grip; false when neither is tracked. */
  private placeWristAnchor(side: Hand): boolean {
    const tracking = this.deps.tracking;
    const chromeInput = tracking.getChromeInput(side);
    if (chromeInput.hand) {
      if (!tracking.getTrackedHandJointPosition(side, 'wrist', tmpA) || !tracking.getTrackedHandJointQuaternion(side, 'wrist', tmpQuat)) return false;
      this.wristAnchor.position.copy(tmpA);
      this.wristAnchor.quaternion.copy(tmpQuat);
    } else if (chromeInput.grip) {
      chromeInput.grip.updateWorldMatrix(true, false);
      chromeInput.grip.matrixWorld.decompose(this.wristAnchor.position, this.wristAnchor.quaternion, tmpScale);
    } else {
      return false;
    }
    this.wristAnchor.updateMatrixWorld(true);
    return true;
  }

  // --- The status line and the world panel ---

  private updateStatus(camera: THREE.Camera, deltaSec: number, state: UiViewModel, recording: boolean): void {
    if (!this.status) return;
    const text = recording ? recordingText(state.recordingElapsedMs) : state.heightFit.pending ? 'Hold still: fitting your height' : '';
    if (text !== this.status.label.getText()) this.status.setText(text);
    this.status.group.visible = text !== '' && chromeVisible('status', recording);
    this.status.update(camera, deltaSec * 1000, false);
  }

  private updatePanel(camera: THREE.Camera, head: THREE.Vector3, state: UiViewModel, recording: boolean): void {
    const panel = this.panel;
    if (!panel) return;
    if (this.placePanel) {
      // Opened level ahead: a head pitched at that moment must not set the panel high or low.
      camera.updateWorldMatrix(true, false);
      camera.matrixWorld.decompose(levelHead.position, tmpQuat, tmpScale);
      levelHead.quaternion.setFromEuler(new THREE.Euler(0, new THREE.Euler().setFromQuaternion(tmpQuat, 'YXZ').y, 0, 'YXZ'));
      levelHead.updateMatrixWorld(true);
      panel.place(levelHead);
      this.placePanel = false;
    }
    panel.group.visible = chromeVisible('settings', recording);
    const refit = this.rows[0]!;
    const hand = this.rows[1]!;
    refit.enabled = state.heightFit.enabled && !state.heightFit.pending;
    const texts: Record<RowId, string> = {
      refit: state.heightFit.pending ? 'Hold still…' : state.heightFit.enabled ? 'Refit height' : 'Refit after the take',
      hand: state.handedness === 'right' ? 'Right-handed' : 'Left-handed'
    };
    let changed = false;
    for (const row of [refit, hand]) {
      if (row.label.getText() !== texts[row.id]) {
        row.label.setText(texts[row.id]);
        changed = true;
      }
    }
    if (changed) {
      panel.layout();
      this.layoutRowHits(panel);
    }
    const pressed = glyphAppearance({ pressed: true }, { headset: true }).opacity;
    refit.label.setOpacity(refit.enabled ? 1 : pressed);
    // Text within 1 m of the head hides (7.3), wherever the user has walked.
    for (const row of this.rows) row.label.updateVisibility(VIEW_TARGETS.vr, 'label', { fromHeadM: row.label.group.getWorldPosition(tmpA).distanceTo(head) });
  }

  /** Each row's hit area spans the panel and is at least a ray's minimum tall (6.1). */
  private layoutRowHits(panel: ThreeWorldPanel): void {
    const width = panel.rows.reduce((widest, row) => Math.max(widest, row.widthM), 0);
    const minHeight = hitAreaMeters('ray', 0, panel.distanceM, { headset: false });
    for (const row of this.rows) {
      const height = Math.max(row.label.heightM, minHeight);
      row.hit.geometry.dispose();
      row.hit.geometry = new THREE.PlaneGeometry(width, height);
      row.hit.position.set(0, row.label.group.position.y, 0.002);
    }
  }

  // --- Poke, with the fingertip shade and the tick ---

  private updatePoke(handedness: Handedness): void {
    const tracking = this.deps.tracking;
    const presser = dominantHand(handedness);
    const glyph = this.wrist?.glyphs[0];
    this.shade.visible = false;
    this.pokeNear = false;
    if (!glyph || this.wrist?.input !== 'poke' || !isShown(glyph.group) || !tracking.getTrackedHandJointPosition(presser, 'index-finger-tip', tmpA)) {
      this.pokeArmed = false;
      this.setGlyphState(false);
      return;
    }
    const local = glyph.hitTarget.worldToLocal(tmpB.copy(tmpA));
    const half = glyph.hitSizeM / 2;
    const inside = Math.abs(local.x) <= half && Math.abs(local.y) <= half;
    const depth = local.z;
    // A tip arriving from the side, from behind, or already through the face never commits.
    if (inside && depth > POKE_REARM_M) this.pokeArmed = true;
    const near = inside && depth <= POKE_PROXIMITY_M && depth >= -POKE_THROUGH_M;
    this.pokeNear = near;
    if (near) {
      // Blurred and wide while far, sharpening onto the glyph at contact.
      const t = THREE.MathUtils.clamp(Math.max(0, depth) / POKE_PROXIMITY_M, 0, 1);
      const radius = (glyph.drawnSizeM / 2) * (1 + 2 * t);
      glyph.hitTarget.getWorldQuaternion(this.shade.quaternion);
      glyph.hitTarget.localToWorld(this.shade.position.set(local.x, local.y, 0.001));
      this.shade.scale.setScalar(radius);
      setChromeOpacity(this.shadeMaterial, tokens.shade.mid.alpha + (tokens.shade.inner.alpha - tokens.shade.mid.alpha) * (1 - t));
      this.shade.visible = true;
    }
    this.setGlyphState(near);
    if (near && this.pokeArmed && depth <= POKE_CONTACT_M) {
      this.pokeArmed = false;
      this.lastPokeSec = this.elapsedSec;
      if (this.commit({ kind: 'record' })) {
        this.tick.play(glyph.hitTarget.getWorldPosition(tmpA), this.deps.renderer.xr.getCamera());
        this.feedback.ticks += 1;
      }
    }
  }

  private setGlyphState(approached: boolean): void {
    const glyph = this.wrist?.glyphs[0];
    if (!glyph) return;
    const rayOnIt = this.rays.left.hit?.kind === 'record' || this.rays.right.hit?.kind === 'record';
    glyph.setState({ hovered: approached || rayOnIt, pressed: this.elapsedSec < this.pressedUntilSec });
  }

  // --- Rays and select ---

  private createRay(): RayState {
    const geometry = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3(0, 0, -1)]);
    const material = new THREE.LineBasicMaterial({ color: tokens.glyph.color, transparent: true, depthTest: false, toneMapped: false });
    const line = new THREE.Line(geometry, material);
    line.name = 'aim-ray';
    line.renderOrder = 998;
    line.frustumCulled = false;
    line.visible = false;
    this.root.add(line);
    return { line, hit: null, hitDistance: RAY_IDLE_LENGTH_M };
  }

  private updateRays(handedness: Handedness, recording: boolean): void {
    for (const side of ['left', 'right'] as const) {
      const ray = this.rays[side];
      const chromeInput = this.deps.tracking.getChromeInput(side);
      const before = describeHit(ray.hit);
      ray.hit = null;
      ray.hitDistance = RAY_IDLE_LENGTH_M;
      const object = chromeInput.targetRay;
      // The carrying hand never presses its own wrist; a hand's ray only reaches the panel, and
      // a row whose label hides within 1 m takes no hits.
      if (!object || !this.deps.renderer.xr.isPresenting) {
        ray.line.visible = false;
        continue;
      }
      object.updateWorldMatrix(true, false);
      object.getWorldPosition(tmpA);
      tmpB.set(0, 0, -1).applyQuaternion(object.getWorldQuaternion(tmpQuat)).normalize();
      raycaster.set(tmpA, tmpB);
      const targets: Array<{ mesh: THREE.Mesh; hit: NonNullable<RayState['hit']> }> = [];
      if (this.wrist && side === dominantHand(handedness) && !chromeInput.hand) targets.push({ mesh: this.wrist.glyphs[0]!.hitTarget, hit: { kind: 'record' } });
      for (const row of this.rows) if (row.enabled && isShown(row.label.group)) targets.push({ mesh: row.hit, hit: { kind: 'row', id: row.id } });
      let best = Infinity;
      for (const target of targets) {
        if (!isShown(target.mesh)) continue;
        const intersection = raycaster.intersectObject(target.mesh, false)[0];
        if (intersection && intersection.distance < best) {
          best = intersection.distance;
          ray.hit = target.hit;
          ray.hitDistance = intersection.distance;
        }
      }
      // While a take runs, a ray shows only on the stop control it rests on.
      ray.line.visible = !recording || ray.hit !== null;
      const length = ray.hit ? Math.max(0.05, ray.hitDistance) : RAY_IDLE_LENGTH_M;
      const positions = ray.line.geometry.getAttribute('position') as THREE.BufferAttribute;
      positions.setXYZ(0, tmpA.x, tmpA.y, tmpA.z);
      positions.setXYZ(1, tmpA.x + tmpB.x * length, tmpA.y + tmpB.y * length, tmpA.z + tmpB.z * length);
      positions.needsUpdate = true;
      const material = ray.line.material as THREE.LineBasicMaterial;
      material.color.set(ray.hit ? tokens.glyph.states.hoverColor : tokens.glyph.color);
      const now = describeHit(ray.hit);
      if (now && now !== before) this.pulse(chromeInput.inputSource, PULSE_HOVER);
    }
  }

  private bindSelect(): void {
    if (this.unbindSelect) return;
    const xr = this.deps.renderer.xr;
    const bindings = [xr.getController(0), xr.getController(1)].map((controller) => {
      const handler = (): void => {
        if (!xr.isPresenting) return;
        // Only the ray of the controller that fired selects (a refit never starts a take).
        for (const side of ['left', 'right'] as const) {
          const chromeInput = this.deps.tracking.getChromeInput(side);
          const hit = this.rays[side].hit;
          if (chromeInput.targetRay !== controller || !hit) continue;
          if (this.commit(hit)) this.pulse(chromeInput.inputSource, PULSE_COMMIT);
          return;
        }
      };
      controller.addEventListener('select', handler);
      return { controller, handler };
    });
    this.unbindSelect = () => {
      for (const { controller, handler } of bindings) controller.removeEventListener('select', handler);
      this.unbindSelect = null;
    };
  }

  /** Runs the hit's action; false when it cannot run now (Record while a take exports). */
  private commit(hit: NonNullable<RayState['hit']>): boolean {
    const state = this.deps.store.getState();
    if (hit.kind === 'record' && !createRecordingUiState(state.recordingState, state.recordingMessage).canToggle) return false;
    this.feedback.commits += 1;
    if (hit.kind === 'record') {
      this.pressedUntilSec = this.elapsedSec + PRESSED_SHOW_SEC;
      this.deps.toggleRecording();
    } else if (hit.id === 'refit') this.deps.refitHeight();
    else this.deps.setHandedness(state.handedness === 'right' ? 'left' : 'right');
    return true;
  }

  private pulse(inputSource: XRInputSource | undefined, { intensity, durationMs }: { intensity: number; durationMs: number }): void {
    // `pulse` is the Gamepad extension WebXR browsers ship; the DOM types lack it.
    const actuator = (inputSource?.gamepad as { hapticActuators?: ReadonlyArray<{ pulse?: (value: number, ms: number) => Promise<boolean> }> } | undefined)?.hapticActuators?.[0];
    if (!actuator?.pulse) return;
    void actuator.pulse(intensity, durationMs).catch(() => undefined);
    this.feedback.pulses += 1;
  }
}

function describeHit(hit: RayState['hit']): string | null {
  if (!hit) return null;
  return hit.kind === 'record' ? 'record' : `row:${hit.id}`;
}

/** Visible all the way up to the scene (hit meshes draw nothing, but their objects stay visible). */
function isShown(object: THREE.Object3D): boolean {
  for (let node: THREE.Object3D | null = object; node; node = node.parent) {
    if (!node.visible) return false;
    if (node.type === 'Scene') return true;
  }
  return false;
}

/**
 * The wrist row draws over the wearer's own avatar: held on a controller,
 * the record glyph sits inside the avatar's sleeve and cuff, and depth
 * testing hid it there (measured in IWER: occluded by the outfit). Nothing
 * else comes between the eye and a wrist at arm's reach. Record rebuilds its
 * shape and materials when it turns into Stop, so this runs after each
 * change. Set here, open to revisit; proposed as a ThreeWristGlyphs option.
 */
function drawOverBody(group: THREE.Object3D): void {
  group.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.renderOrder = WRIST_OVER_BODY_ORDER;
    for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) material.depthTest = false;
  });
}

function everyMesh(root: THREE.Object3D, test: (mesh: THREE.Mesh) => boolean): boolean {
  let all = true;
  root.traverse((object) => {
    if ((object as THREE.Mesh).isMesh && !test(object as THREE.Mesh)) all = false;
  });
  return all;
}
