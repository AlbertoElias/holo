import { RayInteractable, type Entity, type World } from "@iwsdk/core";
import { Box3, BoxGeometry, Mesh, MeshBasicMaterial, PointLight, Vector3 } from "three";
import type { Object3D } from "three";

import { cloneHologram, disposeClone, type HologramAssetCache } from "./hologramAssets";
import { createHologramRuntime, disposeHologramRuntime, HologramPlayback, setHologramPlaying, type HologramRuntime } from "./hologramPlayback";
import { placedRecord, searchingPlacement, viewerContext, type PlacedHologram } from "./viewerContext";

// The holograms placed in the space (step 4): each keeps its own playback,
// transform and grab. The last one selected has audio focus: only it is
// heard, and the foot controls and focus ring are on it. Placing is keyed by
// feed id, so a second select while one loads is ignored.

/** How many holograms may stand in the space at once; tune on a Quest (brief). */
export const MAX_PLACED_HOLOGRAMS = 4;

const STAGE_GLOW = 0xffb066;

export interface SpaceItem {
  id: string;
  /** Resolved model URL. */
  url: string;
}

export type PlaceResult = "placed" | "loading" | "already-placed" | "full" | "error";

export class HologramSpace {
  /** Ids loading toward a placement. */
  private readonly loading = new Set<string>();
  /** Most recently focused last, for handing focus on when one leaves. */
  private readonly focusOrder: Entity[] = [];
  /** Called when a placement or removal changes what is in the space. */
  onChange: () => void = () => undefined;

  constructor(private readonly world: World, private readonly cache: HologramAssetCache, private readonly options: { tapTogglesPlay: () => boolean; onRemove(entity: Entity): void }) {}

  isPlaced(id: string): boolean {
    return viewerContext(this.world).placed.some((record) => record.id === id);
  }

  isLoading(id: string): boolean {
    return this.loading.has(id);
  }

  get full(): boolean {
    return viewerContext(this.world).placed.length + this.loading.size >= MAX_PLACED_HOLOGRAMS;
  }

  /** Places a feed item at recorded scale in front of the viewer and focuses it. Rejects with the load error. */
  async place(item: SpaceItem): Promise<PlaceResult> {
    if (this.isPlaced(item.id)) return "already-placed";
    if (this.loading.has(item.id)) return "loading";
    if (this.full) return "full";
    this.loading.add(item.id);
    this.onChange();
    try {
      const loaded = await this.cache.acquire(item.url);
      if (!this.loading.has(item.id)) {
        // Torn down while loading.
        this.cache.release(item.url);
        return "error";
      }
      const model = cloneHologram(loaded);
      const record = this.createRecord(item, model, createHologramRuntime(model, loaded.clips, loaded.audio));
      viewerContext(this.world).placed.push(record);
      this.focus(record.entity);
      return "placed";
    } finally {
      this.loading.delete(item.id);
      this.onChange();
    }
  }

  /** Audio focus moves to `entity`: the old one goes quiet, and this one is heard from its own clock. */
  focus(entity: Entity): void {
    const c = viewerContext(this.world);
    c.focused = entity;
    const at = this.focusOrder.indexOf(entity);
    if (at >= 0) this.focusOrder.splice(at, 1);
    this.focusOrder.push(entity);
    for (const record of c.placed) record.entity.setValue(HologramPlayback, "audible", record.entity === entity);
  }

  /** Back to the gallery: takes the hologram out of the space and frees what it alone used. */
  remove(id: string): boolean {
    const c = viewerContext(this.world);
    const record = c.placed.find((placed) => placed.id === id);
    if (!record) return false;
    c.placed.splice(c.placed.indexOf(record), 1);
    const at = this.focusOrder.indexOf(record.entity);
    if (at >= 0) this.focusOrder.splice(at, 1);
    if (c.focused === record.entity) {
      const next = this.focusOrder.at(-1);
      c.focused = null;
      if (next) this.focus(next);
    }
    this.options.onRemove(record.entity);
    // The stage, and the shelf around it, stay where they are for the next placement.
    this.disposeRecord(record);
    this.onChange();
    return true;
  }

  dispose(): void {
    this.loading.clear();
    const c = viewerContext(this.world);
    for (const record of c.placed.splice(0)) this.disposeRecord(record);
    c.focused = null;
  }

  private createRecord(item: SpaceItem, model: Object3D, built: { runtime: HologramRuntime; duration: number }): PlacedHologram {
    const world = this.world;
    model.name = "HologramModel";
    const entity = world.createTransformEntity(undefined, { parent: world.activeLevel.value });
    const object = entity.object3D!;
    object.name = `Hologram-${item.id}`;
    object.add(model);
    // Each hologram lights its own stage.
    const stageLight = new PointLight(STAGE_GLOW, 1.5, 4, 2);
    stageLight.position.set(0, 0.35, 0.6);
    object.add(stageLight);
    // Taps and rays hit a body-sized box, not the skinned triangles: forgiving
    // to aim at, and cheap for pointers that move every frame.
    (model as Object3D & { pointerEvents?: string }).pointerEvents = "none";
    const size = new Box3().setFromObject(model).getSize(new Vector3());
    const hitBox = new Mesh(new BoxGeometry(size.x, size.y, Math.max(size.z, 0.3)), new MeshBasicMaterial({ visible: false }));
    hitBox.name = "HologramHitBox";
    hitBox.position.y = size.y / 2;
    // IWSDK's two-hand grab denies rays on the hologram; the box takes them back
    // for selecting it, and keeps a ray press from starting a one-hand drag.
    (hitBox as Mesh & { pointerEventsType?: unknown }).pointerEventsType = "all";
    hitBox.addEventListener("pointerdown" as never, ((event: { pointerType?: string; stopPropagation(): void }) => {
      if (event.pointerType === "ray") event.stopPropagation();
    }) as never);
    object.add(hitBox);
    entity.addComponent(HologramPlayback, { runtime: built.runtime, duration: built.duration, playing: built.duration > 0, audible: false });
    object.visible = false;
    // IWSDK pointers only intersect entities marked interactable.
    entity.addComponent(RayInteractable);
    const record: PlacedHologram = {
      id: item.id,
      url: item.url,
      entity,
      model,
      placement: searchingPlacement(),
      recenterRequested: false,
      footprintRadius: Math.hypot(size.x, Math.max(size.z, 0.3)) / 2
    };
    // Selecting a hologram focuses it; on a phone, a tap on the focused one pauses or resumes it.
    hitBox.addEventListener("click" as never, () => {
      const c = viewerContext(this.world);
      if (!placedRecord(c, entity)) return;
      if (c.focused !== entity) this.focus(entity);
      else if (this.options.tapTogglesPlay()) setHologramPlaying(entity, !entity.getValue(HologramPlayback, "playing"));
    });
    return record;
  }

  private disposeRecord(record: PlacedHologram): void {
    const runtime = record.entity.getValue(HologramPlayback, "runtime") as HologramRuntime | undefined;
    if (runtime) disposeHologramRuntime(runtime);
    const hitBox = record.entity.object3D?.getObjectByName("HologramHitBox") as Mesh<BoxGeometry, MeshBasicMaterial> | undefined;
    hitBox?.geometry.dispose();
    hitBox?.material.dispose();
    disposeClone(record.model);
    record.entity.object3D?.removeFromParent();
    record.entity.destroy();
    this.cache.release(record.url);
  }
}
