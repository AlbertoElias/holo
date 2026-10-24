import type * as THREE from 'three';
import type { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

import type { AvatarRig } from '../avatar/AvatarRig';
import type { UIStateStore } from '../ui/UIStateStore';
import type { XrTracking } from '../xr/XrTracking';
import { DesktopCarryPose } from './DesktopCarryPose';
import { ObjectGrabInput } from './ObjectGrabInput';
import { ObjectInteraction } from './ObjectInteraction';
import { SceneObjectRegistry } from './SceneObjectRegistry';
import { fetchSuppliedObject, parseSuppliedObject, readSuppliedObjectFile, type SuppliedObjectInput, SuppliedObjectError } from './suppliedObject';

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
}

/** Capture's objects: the registry, the supplied-model loader, and grab/carry. */
export class CaptureObjects {
  readonly registry: SceneObjectRegistry;
  readonly grabInput: ObjectGrabInput;
  readonly carry: DesktopCarryPose;
  readonly interaction: ObjectInteraction;
  private loadSeq = 0;

  constructor(private readonly deps: CaptureObjectsDeps) {
    this.registry = new SceneObjectRegistry(deps.worldGroup);
    this.grabInput = new ObjectGrabInput(deps.renderer, deps.tracking);
    this.carry = new DesktopCarryPose(deps.avatar);
    this.interaction = new ObjectInteraction({
      registry: this.registry,
      avatar: deps.avatar,
      tracking: deps.tracking,
      grabInput: this.grabInput,
      carry: this.carry,
      embodyOffset: deps.embodyOffset
    });
  }

  /** Once the avatar is loaded and in its bind pose. */
  attach(): void {
    this.carry.attach();
  }

  loadUrl(url: string): Promise<boolean> {
    return this.load(() => fetchSuppliedObject(url));
  }

  loadFile(file: File): Promise<boolean> {
    return this.load(() => readSuppliedObjectFile(file));
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
