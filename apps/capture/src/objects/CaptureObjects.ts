import { dominantHand, nonDominantHand, type Handedness } from '@holoim/xr-ui-core';
import * as THREE from 'three';

import type { AuthoringFrame } from '../recording/authoringSpans';
import type { HandPoseSource, TrayUiState } from '../types/contracts';
import type { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

import type { AvatarRig } from '../avatar/AvatarRig';
import { ObjectPhysics, type ObjectPhysicsStats, prepareHull } from '../physics/ObjectPhysics';
import type { UIStateStore } from '../ui/UIStateStore';
import type { XrTracking } from '../xr/XrTracking';
import { DesktopCarryPose } from './DesktopCarryPose';
import { ObjectGrabInput } from './ObjectGrabInput';
import { ObjectInteraction, type ObjectStep, VR_REACH_M } from './ObjectInteraction';
import { MAX_TRAY_BYTES, MAX_TRAY_ITEMS, ObjectTray, type TrayItem } from './ObjectTray';
import { SceneObjectRegistry, type SceneObject } from './SceneObjectRegistry';
import { fetchSuppliedObject, parseSuppliedObject, readSuppliedObjectFile, type SuppliedObjectInput, SuppliedObjectError } from './suppliedObject';
import { TrayGestureInput } from './TrayGestureInput';
import { parseTrayItem } from './trayItem';
import { nextTask, type TrayThumbnail, TrayThumbnailer, trayMark } from './trayThumbnail';

export interface CaptureObjectsDeps {
  worldGroup: THREE.Group;
  renderer: THREE.WebGLRenderer;
  loader: GLTFLoader;
  avatar: AvatarRig;
  tracking: XrTracking;
  ui: UIStateStore;
  embodyOffset: number;
  /** A take is recording or exporting: the supplied object is chosen before it. */
  isTakeActive: () => boolean;
  /** The dominant hand: in a headset the other hand holds the tray up and this one summons. */
  getHandedness: () => Handedness;
}

const TRACKED_SOURCES: ReadonlySet<HandPoseSource> = new Set(['xr-hand', 'controller', 'mock']);
/** How long a slot stays lit after an object is put back into it. */
const RETURN_FLASH_MS = 400;

/** Capture's objects: the registry, the supplied-model loader, grab/carry, and the PRD-045 tray. */
export class CaptureObjects {
  readonly registry: SceneObjectRegistry;
  readonly grabInput: ObjectGrabInput;
  readonly carry: DesktopCarryPose;
  readonly tray: ObjectTray;
  readonly trayGesture: TrayGestureInput;
  readonly interaction: ObjectInteraction;
  private physics: ObjectPhysics | null = null;
  private loadSeq = 0;
  private trayLoadSeq = 0;
  private lastAuthoring: AuthoringFrame | null = null;
  private readonly thumbnailer: TrayThumbnailer;
  private readonly thumbnails = new Map<TrayItem, TrayThumbnail>();
  private lastTimeSec = 0;
  /** Items taken off the tray: their bytes count toward the budget while a copy of them is in the scene. */
  private removedItems: TrayItem[] = [];
  /** A tray item left the tray since the last authoring frame. */
  private removedSinceFrame = false;
  /** The slot a put-back just went into, lit until `returnFlashUntil` (performance.now ms). */
  private returnFlash: { slot: number; untilMs: number } | null = null;
  // Tray loads run one after another, so a pick made while another loads is never dropped.
  private trayLoads: Promise<unknown> = Promise.resolve();
  private trayLoadsPending = 0;
  private trayLive = { open: false, blocked: false, reachableSlot: null as number | null, holding: false, returnSlot: null as number | null };
  private readonly palm = new THREE.Vector3();
  private readonly pickRay = new THREE.Raycaster();
  private readonly pickNdc = new THREE.Vector2();

  constructor(private readonly deps: CaptureObjectsDeps) {
    this.registry = new SceneObjectRegistry(deps.worldGroup);
    this.grabInput = new ObjectGrabInput(deps.renderer, deps.tracking);
    this.carry = new DesktopCarryPose(deps.avatar);
    this.tray = new ObjectTray(this.registry, deps.avatar, deps.embodyOffset);
    this.trayGesture = new TrayGestureInput(deps.renderer, deps.tracking);
    this.thumbnailer = new TrayThumbnailer(deps.renderer);
    this.interaction = new ObjectInteraction({
      registry: this.registry,
      avatar: deps.avatar,
      tracking: deps.tracking,
      grabInput: this.grabInput,
      carry: this.carry,
      tray: this.tray,
      embodyOffset: deps.embodyOffset
    });
  }

  hasPhysics(): boolean {
    return this.physics !== null;
  }

  /** Once the scene's collision mesh exists: props get their own world over a copy of it. */
  enablePhysics(trimesh: { vertices: Float32Array; indices: Uint32Array }, gravity: number): void {
    this.physics = new ObjectPhysics(trimesh, gravity);
    this.physics.setAvatar(this.deps.avatar);
    this.interaction.setPhysics(this.physics);
    this.registry.onRemove = (object) => this.physics?.remove(object);
  }

  /**
   * The reachable prop under a screen point (normalized device coordinates) of
   * the desktop camera, for a mouse or touch press; null when none is hit or
   * in reach.
   */
  pickAt(camera: THREE.Camera, ndcX: number, ndcY: number, anywhere: boolean, far = false): SceneObject | null {
    this.pickRay.setFromCamera(this.pickNdc.set(ndcX, ndcY), camera);
    return this.interaction.pick(this.pickRay, anywhere, far);
  }

  /** Whether either hand holds a prop. */
  isHolding(): boolean {
    return this.interaction.isHolding('left') || this.interaction.isHolding('right');
  }

  /** The body's reach demand (0 to 1) for the crouch and squat. */
  reachDemand(): number {
    return this.interaction.reachDemand();
  }

  reachDeep(): number {
    return this.interaction.reachDeep();
  }

  isStepping(): boolean {
    return this.interaction.isStepping();
  }

  isReachActive(): boolean {
    return this.interaction.isReachActive();
  }

  takeReachStep(): { x: number; z: number } | null {
    return this.interaction.takeReachStep();
  }

  physicsStats(): ObjectPhysicsStats | null {
    return this.physics?.stats() ?? null;
  }

  /** Once the avatar is loaded and in its bind pose. */
  attach(): void {
    this.carry.attach();
  }

  /**
   * One step, after the arms have their final pose: the tray opens while its
   * gesture is held and the left hand is empty, the miniatures are laid out,
   * then grab, carry and summon run against them.
   */
  update(step: ObjectStep & { trayHeld: boolean }): void {
    const vrActive = step.vrActive;
    // Desktop has one carrying arm (the right); in a headset handedness picks the hands.
    const handedness = this.deps.getHandedness();
    const holder = vrActive ? nonDominantHand(handedness) : 'left';
    const summoner = vrActive ? dominantHand(handedness) : 'right';
    const held = this.trayGesture.update({ vrActive, deltaSec: step.deltaSec, desktopHeld: step.trayHeld, hand: holder });
    this.tray.update(held && !this.interaction.isHolding(holder), { vrActive, bodyYaw: step.bodyYaw, hand: holder });
    const summonsBefore = this.tray.snapshot().summons.length;
    this.lastTimeSec = step.timeSec;
    this.interaction.update({ ...step, summoner });
    const letGoOverTray = this.interaction.takePutBack();
    if (letGoOverTray) this.putBack(letGoOverTray);
    this.interaction.stepPhysics(step.deltaSec);
    // A grab by the holding hand closes the tray at once.
    if (this.interaction.isHolding(holder) && this.tray.isOpen()) this.tray.update(false, { vrActive, bodyYaw: step.bodyYaw, hand: holder });
    const palm = vrActive ? this.interaction.palmPosition(summoner, this.palm) : undefined;
    this.publishTrayLive(vrActive, summoner, palm);
    this.lastAuthoring = {
      // Desktop tray motion moves no arm, so it has no hands-in-menu spans.
      trayOpen: vrActive && this.tray.isOpen(),
      empty: { left: !this.interaction.isHolding('left'), right: !this.interaction.isHolding('right') },
      holder,
      summonerNearTray: Boolean(palm && this.tray.inZone(palm)),
      summoned: this.tray.snapshot().summons.length > summonsBefore,
      removed: this.takeRemoved(),
      tracked: {
        left: !vrActive || TRACKED_SOURCES.has(this.deps.tracking.getHandPoseSource('left')),
        right: !vrActive || TRACKED_SOURCES.has(this.deps.tracking.getHandPoseSource('right'))
      }
    };
  }

  private takeRemoved(): boolean {
    const removed = this.removedSinceFrame;
    this.removedSinceFrame = false;
    return removed;
  }

  /** What the tray and hands did this step, for the recorder; consumed, so a step objects skipped reads as none. */
  authoringFrame(): AuthoringFrame | undefined {
    const frame = this.lastAuthoring ?? undefined;
    this.lastAuthoring = null;
    return frame;
  }

  loadUrl(url: string): Promise<boolean> {
    return this.load(() => fetchSuppliedObject(url));
  }

  loadFile(file: File): Promise<boolean> {
    return this.load(() => readSuppliedObjectFile(file));
  }

  loadTrayUrls(urls: readonly string[]): Promise<boolean> {
    return this.loadTray(urls.map((url) => () => fetchSuppliedObject(url)));
  }

  loadTrayFiles(files: readonly File[]): Promise<boolean> {
    return this.loadTray(files.map((file) => () => readSuppliedObjectFile(file)));
  }

  /**
   * Puts `object` back into the tray (docs/features/archive/tray-remove.md): it leaves
   * the scene on this step, so a take's track for it ends at the frame
   * before, and the slot it came from lights briefly. It does not animate: a
   * shrink would be recorded as a resize. False when it is not in the scene.
   */
  putBack(object: SceneObject, timeSec = this.lastTimeSec): boolean {
    if (object.layer !== 'event' || this.exporting() || !this.registry.all().includes(object)) return false;
    const slot = this.tray.logPutBack(object, timeSec);
    this.interaction.forget(object);
    this.registry.remove(object);
    // The `?object=` prop was the prepared object: the picker no longer has one.
    if (object.origin === 'prepared') this.deps.ui.setObjectState({ status: 'none', name: null, message: null });
    if (slot !== null) this.returnFlash = { slot, untilMs: performance.now() + RETURN_FLASH_MS };
    this.publishTray();
    return true;
  }

  /** Puts back the prop in the hand (Backspace, the dock's Put back); false when nothing is held. */
  putBackHeld(): boolean {
    const held = this.interaction.heldObject();
    return held ? this.putBack(held) : false;
  }

  /**
   * Takes tray slot `slot`'s item off the tray (docs/features/archive/tray-remove.md).
   * The rest close up and keep their thumbnails. Objects summoned from it
   * stay in the scene, sharing its model.
   */
  removeTraySlot(slot: number): boolean {
    const item = this.tray.getItems().find((candidate) => candidate.slot === slot);
    if (!item || this.exporting() || !this.tray.remove(item)) return false;
    this.thumbnails.delete(item);
    this.removedItems.push(item);
    this.removedSinceFrame = true;
    if (this.returnFlash?.slot === slot) this.returnFlash = null;
    this.publishTray();
    this.onTrayChanged?.();
    return true;
  }

  /** The tray's slots were renumbered: a slot number queued before now names another item. */
  onTrayChanged: (() => void) | null = null;

  private exporting(): boolean {
    return this.deps.ui.getState().recordingState === 'exporting';
  }

  /**
   * The bytes a take could export: the tray's items, and items taken off it
   * whose copies are still in the scene (they share the item's model).
   */
  private budgetBytes(): number {
    const inScene = new Set(this.registry.eventObjects().map((object) => this.tray.originOf(object)));
    this.removedItems = this.removedItems.filter((item) => inScene.has(item));
    return this.tray.totalBytes() + this.removedItems.reduce((sum, item) => sum + item.bytes, 0);
  }

  /** The tray's slots changed outside a load. */
  private publishTray(): void {
    const current = this.deps.ui.getState().tray;
    this.deps.ui.setTrayState({ ...this.trayState(), loading: current.loading, message: null });
  }

  /**
   * A take starts. Nothing leaves the scene (the user, 2026-10-28): what is in
   * it now is in the take from its first frame. Only the summon log restarts.
   */
  startTake(): void {
    this.tray.resetSummonLog();
    this.lastAuthoring = null;
  }

  /**
   * The phone camera author's summon (docs/features/archive/tray-everywhere.md): a new
   * full-size object from tray slot `slot`, standing with its base on `point`
   * (the world group's frame) and turned to `yaw`, present from this step.
   * No hand, no physics: it stays where it is put.
   */
  placeFromTray(slot: number, point: THREE.Vector3, yaw: number, timeSec: number): SceneObject | null {
    const item = this.tray.getItems().find((candidate) => candidate.slot === slot);
    if (!item) return null;
    const object = this.tray.summon(item, timeSec);
    const wrapper = object.wrapper;
    wrapper.scale.setScalar(1);
    wrapper.quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
    wrapper.position.copy(point);
    wrapper.updateMatrixWorld(true);
    // The wrapper is centred on the model's bounds: lift it until the bounds' bottom meets the point.
    const bounds = new THREE.Box3().setFromObject(wrapper);
    // Measured in the world group's frame, which a recenter may have moved.
    const bottom = this.deps.worldGroup.worldToLocal(bounds.getCenter(new THREE.Vector3()).setY(bounds.min.y));
    wrapper.position.y += point.y - bottom.y;
    wrapper.updateMatrixWorld(true);
    object.placed = true;
    return object;
  }

  /** The scene the world group is drawn in (a structural check: three copies may differ). */
  private liveScene(): THREE.Scene | undefined {
    let root: THREE.Object3D = this.deps.worldGroup;
    while (root.parent) root = root.parent;
    return (root as THREE.Scene).isScene ? (root as THREE.Scene) : undefined;
  }

  /** A tray item's thumbnail, for a UIKit texture in a headset or phone AR. */
  trayThumbnail(slot: number): TrayThumbnail | null {
    const item = this.tray.getItems().find((candidate) => candidate.slot === slot);
    return item ? (this.thumbnails.get(item) ?? null) : null;
  }

  /**
   * Adds items to the tray, before or during a take. All of a pick is refused
   * together when it would pass five items or the size budget, or when any
   * item is refused; capture, and a take, keep going with the tray it had.
   */
  private loadTray(reads: Array<() => Promise<SuppliedObjectInput>>): Promise<boolean> {
    this.trayLoadsPending += 1;
    const run = this.trayLoads.then(() => this.loadTrayNow(reads)).finally(() => {
      this.trayLoadsPending -= 1;
      this.deps.ui.setTrayState({ ...this.deps.ui.getState().tray, loading: this.trayLoadsPending > 0 });
    });
    this.trayLoads = run.catch(() => undefined);
    return run;
  }

  private async loadTrayNow(reads: Array<() => Promise<SuppliedObjectInput>>): Promise<boolean> {
    const { ui } = this.deps;
    const fail = (message: string) => {
      console.warn(message);
      ui.setTrayState({ ...this.trayState(), message });
      return false;
    };
    if (this.tray.getItems().length + reads.length > MAX_TRAY_ITEMS) return fail(`The tray holds at most ${MAX_TRAY_ITEMS} items.`);
    const seq = ++this.trayLoadSeq;
    ui.setTrayState({ ...this.trayState(), loading: true, message: null });
    try {
      const inputs = await Promise.all(reads.map((read) => read()));
      trayMark('fetched');
      const total = this.budgetBytes() + inputs.reduce((sum, input) => sum + input.bytes.byteLength, 0);
      if (total > MAX_TRAY_BYTES) throw new SuppliedObjectError(`The tray would be ${(total / 1048576).toFixed(1)} MB; the limit is ${MAX_TRAY_BYTES / 1048576} MB.`);
      const loaded = await Promise.all(inputs.map(async (input) => ({ input, item: await parseTrayItem(this.deps.loader, input) })));
      trayMark('parsed');
      if (seq !== this.trayLoadSeq) return false;
      if (this.tray.getItems().length + loaded.length > MAX_TRAY_ITEMS) throw new SuppliedObjectError(`The tray holds at most ${MAX_TRAY_ITEMS} items.`);
      // Everything costly about an item happens here, a task at a time, before it
      // joins the tray: its thumbnail (which also uploads its textures and compiles
      // its shaders), and the hull a summoned copy's body will use.
      const prepared = [];
      for (const entry of loaded) {
        const name = entry.item.credit?.title ?? entry.item.source.name;
        const thumbnail = await this.thumbnailer.render(entry.item.model, this.liveScene()).catch((error: unknown) => {
          console.warn(`[tray] no thumbnail for ${name}: ${(error as Error).message}`);
          return null;
        });
        await prepareHull(entry.item.model, nextTask);
        trayMark('hull');
        prepared.push({ ...entry, name, thumbnail });
      }
      if (this.tray.getItems().length + prepared.length > MAX_TRAY_ITEMS) throw new SuppliedObjectError(`The tray holds at most ${MAX_TRAY_ITEMS} items.`);
      for (const { input, item, name, thumbnail } of prepared) {
        const added = this.tray.add(item.model, { name, source: item.source, kind: item.kind, bytes: input.bytes.byteLength, credit: item.credit });
        if (thumbnail) this.thumbnails.set(added, thumbnail);
      }
      ui.setTrayState({ ...this.trayState(), message: null });
      return true;
    } catch (error) {
      if (seq !== this.trayLoadSeq) return false;
      ui.setTrayState({ ...this.trayState(), loading: false });
      return fail(error instanceof SuppliedObjectError ? error.message : `Could not load the tray: ${(error as Error).message}`);
    }
  }

  private trayState(): TrayUiState {
    const items = this.tray.getItems();
    return {
      names: items.map((item) => item.object.name),
      slots: items.map((item) => ({ slot: item.slot, name: item.object.name, kind: item.kind, thumbnail: this.thumbnails.get(item)?.url ?? null })),
      loading: this.trayLoadsPending > 0,
      message: null,
      ...this.trayLive
    };
  }

  /** The tray's open state, whether a summon would be refused, and (headset) the item in reach; published on change. */
  private publishTrayLive(vrActive: boolean, summoner: 'left' | 'right', palm: THREE.Vector3 | null | undefined): void {
    const open = this.tray.isOpen();
    const blocked = this.interaction.isHolding(summoner) || this.interaction.isReachActive();
    const reachableSlot = open && vrActive && palm && !blocked ? (this.tray.nearestItem(palm, VR_REACH_M)?.slot ?? null) : null;
    const held = this.interaction.heldObject();
    const holding = held !== null;
    // The slot a held prop would go back into if let go now (headset, over the arc), or one a put-back just went into.
    let returnSlot = vrActive && held && this.interaction.isOverTray(summoner) ? (this.tray.sourceOf(held)?.slot ?? null) : null;
    if (returnSlot === null && this.returnFlash) {
      if (performance.now() < this.returnFlash.untilMs) returnSlot = this.returnFlash.slot;
      else this.returnFlash = null;
    }
    const live = this.trayLive;
    if (live.open === open && live.blocked === blocked && live.reachableSlot === reachableSlot && live.holding === holding && live.returnSlot === returnSlot) return;
    this.trayLive = { open, blocked, reachableSlot, holding, returnSlot };
    const current = this.deps.ui.getState().tray;
    this.deps.ui.setTrayState({ ...current, ...this.trayLive });
  }

  /** Replaces the prepared object. A failed load keeps capture working without one. */
  private async load(read: () => Promise<SuppliedObjectInput>): Promise<boolean> {
    const { ui } = this.deps;
    if (this.deps.isTakeActive()) {
      ui.setObjectState({ status: 'error', name: null, message: 'Choose the object before recording.' });
      return false;
    }
    const seq = ++this.loadSeq;
    ui.setObjectState({ status: 'loading', name: null, message: null });
    try {
      const input = await read();
      const loaded = await parseSuppliedObject(this.deps.loader, input);
      // A newer pick, or a take that started meanwhile, wins.
      if (seq !== this.loadSeq) return false;
      if (this.deps.isTakeActive()) throw new SuppliedObjectError('Choose the object before recording.');
      this.registry.clearPrepared();
      this.registry.add(loaded.model, { name: loaded.source.name, source: loaded.source, credit: loaded.credit, origin: 'prepared', layer: 'event' });
      ui.setObjectState({ status: 'ready', name: loaded.source.name, message: null });
      return true;
    } catch (error) {
      if (seq !== this.loadSeq) return false;
      const message = error instanceof SuppliedObjectError ? error.message : `Could not load the object: ${(error as Error).message}`;
      console.warn(message);
      ui.setObjectState({ status: 'error', name: null, message });
      return false;
    }
  }
}
