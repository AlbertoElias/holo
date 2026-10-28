import * as THREE from 'three';

import type { ObjectCredit, ObjectSource } from '@holoim/objects';

import type { VrHandSide } from '../types/contracts';

/**
 * How an object entered the event: `prepared` objects are in the scene
 * before the take; `summoned` ones (PRD-045) are placed during it.
 */
export type SceneObjectOrigin = 'prepared' | 'summoned';

/**
 * `event` objects are part of the recording; `authoring` objects (a PRD-045
 * tray) are seen only by the author and never sampled or exported.
 */
export type SceneObjectLayer = 'event' | 'authoring';

export interface SceneObject {
  readonly id: string;
  readonly name: string;
  readonly source: ObjectSource;
  /** Who made a found model (PRD-060); exported on its node's extras, not in `HOLOIM_objects`. */
  readonly credit?: ObjectCredit | undefined;
  readonly origin: SceneObjectOrigin;
  readonly layer: SceneObjectLayer;
  /** The rigid wrapper the object system moves (a tray miniature's is scaled down). */
  readonly wrapper: THREE.Group;
  /** Between the wrapper and the model: carries the object's size, about the model's center. */
  readonly sizer: THREE.Group;
  /** Keeps its own transform under the sizer. */
  readonly model: THREE.Object3D;
  /** Placed in front of the avatar once the spawn resolves. */
  placed: boolean;
  heldBy: VrHandSide | null;
  /** Uniform size against the model as loaded (1): the sizer's scale. */
  size: number;
}

/**
 * The take's objects. PRD-043 adds one prepared event object; PRD-045 adds
 * authoring (tray) objects and summons new event objects from them. Objects
 * live under the world group, never under the world model, so the scene
 * bubble never samples them. `ObjectSystem` is the only writer of their
 * transforms.
 */
export class SceneObjectRegistry {
  private readonly objects: SceneObject[] = [];
  private nextId = 1;
  /** Called as an object leaves, so its physics body goes with it. */
  onRemove: ((object: SceneObject) => void) | null = null;

  constructor(private readonly parent: THREE.Object3D) {}

  add(model: THREE.Object3D, options: { name: string; source: ObjectSource; credit?: ObjectCredit | undefined; origin: SceneObjectOrigin; layer: SceneObjectLayer }): SceneObject {
    const wrapper = new THREE.Group();
    wrapper.name = `SceneObject_${options.name}`;
    const sizer = new THREE.Group();
    sizer.name = 'SceneObjectSize';
    wrapper.add(sizer);
    sizer.add(model);
    // The wrapper's origin is the model's center, so grabs and turns pivot there.
    wrapper.updateMatrixWorld(true);
    model.position.sub(new THREE.Box3().setFromObject(model).getCenter(new THREE.Vector3()));
    this.parent.add(wrapper);
    const object: SceneObject = { id: `object-${this.nextId++}`, ...options, wrapper, sizer, model, placed: false, heldBy: null, size: 1 };
    this.objects.push(object);
    return object;
  }

  remove(object: SceneObject): void {
    const index = this.objects.indexOf(object);
    if (index < 0) return;
    this.objects.splice(index, 1);
    this.onRemove?.(object);
    object.wrapper.removeFromParent();
  }

  /** Removes every prepared event object: the single-object picker replaces its object. Tray items stay. */
  clearPrepared(): void {
    for (const object of this.objects.filter((o) => o.origin === 'prepared' && o.layer === 'event')) this.remove(object);
  }

  /**
   * A new event object from a tray item (PRD-045): a new id and a clone of
   * the item's model, which shares its geometry, materials and textures. The
   * item stays, so it can be summoned again. The caller places it; the
   * sample store starts its presence at its first sampled frame.
   */
  summon(item: SceneObject): SceneObject {
    const model = item.model.clone(true);
    model.position.copy(item.model.position);
    const object = this.add(model, { name: item.name, source: item.source, credit: item.credit, origin: 'summoned', layer: 'event' });
    object.wrapper.visible = true;
    return object;
  }

  clearSummoned(): void {
    for (const object of this.objects.filter((o) => o.origin === 'summoned')) this.remove(object);
  }

  all(): readonly SceneObject[] {
    return this.objects;
  }

  /** The objects the recorder samples and the exporter writes. */
  eventObjects(): SceneObject[] {
    return this.objects.filter((object) => object.layer === 'event');
  }
}
