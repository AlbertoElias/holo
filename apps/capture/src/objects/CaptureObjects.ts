import { dominantHand, nonDominantHand, type Handedness } from '@holoim/xr-ui-core';
import * as THREE from 'three';

import type { AuthoringFrame } from '../recording/authoringSpans';
import type { HandPoseSource } from '../types/contracts';
import type { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

import type { AvatarRig } from '../avatar/AvatarRig';
import type { UIStateStore } from '../ui/UIStateStore';
import type { XrTracking } from '../xr/XrTracking';
import { DesktopCarryPose } from './DesktopCarryPose';
import { ObjectGrabInput } from './ObjectGrabInput';
import { ObjectInteraction, type ObjectStep } from './ObjectInteraction';
import { MAX_TRAY_BYTES, MAX_TRAY_ITEMS, ObjectTray } from './ObjectTray';
import { SceneObjectRegistry } from './SceneObjectRegistry';
import { fetchSuppliedObject, parseSuppliedObject, readSuppliedObjectFile, type SuppliedObjectInput, SuppliedObjectError } from './suppliedObject';
import { TrayGestureInput } from './TrayGestureInput';
import { parseTrayItem } from './trayItem';

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

/** Capture's objects: the registry, the supplied-model loader, grab/carry, and the PRD-045 tray. */
export class CaptureObjects {
  readonly registry: SceneObjectRegistry;
  readonly grabInput: ObjectGrabInput;
  readonly carry: DesktopCarryPose;
  readonly tray: ObjectTray;
  readonly trayGesture: TrayGestureInput;
  readonly interaction: ObjectInteraction;
  private loadSeq = 0;
  private trayLoadSeq = 0;
  private lastAuthoring: AuthoringFrame | null = null;
  private readonly palm = new THREE.Vector3();

  constructor(private readonly deps: CaptureObjectsDeps) {
    this.registry = new SceneObjectRegistry(deps.worldGroup);
    this.grabInput = new ObjectGrabInput(deps.renderer, deps.tracking);
    this.carry = new DesktopCarryPose(deps.avatar);
    this.tray = new ObjectTray(this.registry, deps.avatar, deps.embodyOffset);
    this.trayGesture = new TrayGestureInput(deps.renderer, deps.tracking);
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
    this.interaction.update({ ...step, summoner });
    // A grab by the holding hand closes the tray at once.
    if (this.interaction.isHolding(holder) && this.tray.isOpen()) this.tray.update(false, { vrActive, bodyYaw: step.bodyYaw, hand: holder });
    const palm = vrActive ? this.interaction.palmPosition(summoner, this.palm) : undefined;
    this.lastAuthoring = {
      // Desktop tray motion moves no arm, so it has no hands-in-menu spans.
      trayOpen: vrActive && this.tray.isOpen(),
      empty: { left: !this.interaction.isHolding('left'), right: !this.interaction.isHolding('right') },
      holder,
      summonerNearTray: Boolean(palm && this.tray.inZone(palm)),
      summoned: this.tray.snapshot().summons.length > summonsBefore,
      tracked: {
        left: !vrActive || TRACKED_SOURCES.has(this.deps.tracking.getHandPoseSource('left')),
        right: !vrActive || TRACKED_SOURCES.has(this.deps.tracking.getHandPoseSource('right'))
      }
    };
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

  /** A take starts: summoned objects from the last one leave the scene. */
  startTake(): void {
    this.tray.clearSummoned();
    this.lastAuthoring = null;
  }

  /**
   * Adds items to the tray, before recording. All of a pick is refused
   * together when it would pass five items or the size budget, or when any
   * item is refused; capture keeps working with the tray it had.
   */
  private async loadTray(reads: Array<() => Promise<SuppliedObjectInput>>): Promise<boolean> {
    const { ui } = this.deps;
    const fail = (message: string) => {
      console.warn(message);
      ui.setTrayState({ ...this.trayState(), message });
      return false;
    };
    if (this.deps.isTakeActive()) return fail('Prepare the tray before recording.');
    if (this.tray.getItems().length + reads.length > MAX_TRAY_ITEMS) return fail(`The tray holds at most ${MAX_TRAY_ITEMS} items.`);
    const seq = ++this.trayLoadSeq;
    ui.setTrayState({ ...this.trayState(), loading: true, message: null });
    try {
      const inputs = await Promise.all(reads.map((read) => read()));
      const total = this.tray.totalBytes() + inputs.reduce((sum, input) => sum + input.bytes.byteLength, 0);
      if (total > MAX_TRAY_BYTES) throw new SuppliedObjectError(`The tray would be ${(total / 1048576).toFixed(1)} MB; the limit is ${MAX_TRAY_BYTES / 1048576} MB.`);
      const loaded = await Promise.all(inputs.map(async (input) => ({ input, item: await parseTrayItem(this.deps.loader, input) })));
      if (seq !== this.trayLoadSeq) return false;
      if (this.deps.isTakeActive()) throw new SuppliedObjectError('Prepare the tray before recording.');
      if (this.tray.getItems().length + loaded.length > MAX_TRAY_ITEMS) throw new SuppliedObjectError(`The tray holds at most ${MAX_TRAY_ITEMS} items.`);
      for (const { input, item } of loaded) this.tray.add(item.model, { name: item.credit?.title ?? item.source.name, source: item.source, kind: item.kind, bytes: input.bytes.byteLength, credit: item.credit });
      ui.setTrayState({ ...this.trayState(), message: null });
      return true;
    } catch (error) {
      if (seq !== this.trayLoadSeq) return false;
      ui.setTrayState({ ...this.trayState(), loading: false });
      return fail(error instanceof SuppliedObjectError ? error.message : `Could not load the tray: ${(error as Error).message}`);
    }
  }

  private trayState(): { names: string[]; loading: boolean; message: string | null } {
    return { names: this.tray.getItems().map((item) => item.object.name), loading: false, message: null };
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
      this.registry.add(loaded.model, { name: loaded.source.name, source: loaded.source, origin: 'prepared', layer: 'event' });
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
