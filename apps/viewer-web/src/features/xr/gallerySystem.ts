import { createSystem } from "@iwsdk/core";
import type { GalleryTileState } from "@holoim/xr-ui-core";
import { GALLERY_PAGE_SIZE, GalleryShelf, SHELF_PREVIEW_HEIGHT_M, SHELF_RADIUS_M, FOOT_REFERENCE_DISTANCE_M } from "@holoim/xr-ui-iwsdk";
import type { Object3D } from "three";

import { clonePreview, disposeClone, type HologramAssetCache } from "./hologramAssets";
import type { HologramSpace } from "./hologramSpace";
import { viewerContext } from "./viewerContext";

// The gallery (step 4): the feed as small paused previews on the shelf
// (@holoim/xr-ui-iwsdk GalleryShelf), a page at a time. Paging past the
// loaded feed fetches the next page with the feed cursor. Selecting a tile
// places its hologram and focuses it; selecting the tile of a placed one
// sends it back to the gallery. A tile whose hologram fails to load shows
// the error and changes nothing else.

/**
 * A second select of the same tile this soon after the first is the same
 * press repeated: once the model is cached, placing finishes before it lands
 * and would otherwise send the hologram straight back.
 */
const REPEAT_SELECT_MS = 400;

export interface GalleryItem {
  id: string;
  title: string;
  /** Resolved model URL. */
  url: string;
}

export interface GalleryFeed {
  items: GalleryItem[];
  nextCursor: string | null;
}

export interface GalleryOptions {
  feed: GalleryFeed;
  space: HologramSpace;
  cache: HologramAssetCache;
  /** The next feed page after `cursor` (the feed's `fetchHolograms`). */
  loadMore(cursor: string): Promise<GalleryFeed>;
}

interface SlotPreview {
  id: string;
  url: string;
  preview: Object3D | null;
}

export class GallerySystem extends createSystem() {
  private options: GalleryOptions | null = null;
  private shelf: GalleryShelf | null = null;
  private page = 0;
  private fetching: Promise<void> | null = null;
  private readonly errors = new Set<string>();
  private readonly slots: Array<SlotPreview | null> = Array.from({ length: GALLERY_PAGE_SIZE }, () => null);
  private placedStage = false;
  /** Bumps on every page change, so late preview loads for an old page are dropped. */
  private generation = 0;
  private lastSelect: { index: number; result: string; at: number } | null = null;

  init(): void {
    const onSessionEnd = (): void => this.teardown();
    this.xrManager.addEventListener("sessionend", onSessionEnd);
    this.cleanupFuncs.push(() => this.xrManager.removeEventListener("sessionend", onSessionEnd), () => this.teardown());
  }

  configure(options: GalleryOptions): void {
    this.options = options;
    options.space.onChange = () => this.renderTiles();
  }

  get currentPage(): number {
    return this.page;
  }

  update(): void {
    const c = viewerContext(this.world);
    if (!this.options || !this.xrFrame || !c.target) return;
    if (!this.shelf) {
      this.shelf = new GalleryShelf(this.world, {
        target: c.target,
        // A phone draws flat sizes: CSS pixels at the reference distance, here at the shelf's.
        ...(c.phoneMetresPerApx ? { metresPerApx: c.phoneMetresPerApx * (SHELF_RADIUS_M / FOOT_REFERENCE_DISTANCE_M) } : {}),
        onSelectTile: (index) => void this.select(index),
        onPage: (direction) => void this.turnPage(direction === "older" ? 1 : -1)
      });
      this.showPage(this.page);
    }
    // The shelf stands around the viewer once the first hologram fixes the stage's front.
    if (c.stage && !this.placedStage) {
      this.placedStage = true;
      this.shelf.place(c.stage.origin, c.stage.forward);
      this.shelf.setVisible(true);
    }
  }

  /** Selects tile `index`: place its hologram, or send a placed one back. */
  async select(index: number): Promise<string> {
    const now = performance.now();
    const repeat = this.lastSelect?.index === index && now - this.lastSelect.at < REPEAT_SELECT_MS;
    this.lastSelect = { index, result: "pending", at: now };
    const result = repeat ? "ignored-repeat" : await this.selectTile(index);
    this.lastSelect = { index, result, at: now };
    return result;
  }

  async turnPage(delta: 1 | -1): Promise<void> {
    if (!this.options || this.fetching) return;
    const next = this.page + delta;
    if (next < 0) return;
    const feed = this.options.feed;
    // Past the loaded feed: fetch the next page with its cursor.
    if (feed.items.length < (next + 1) * GALLERY_PAGE_SIZE && feed.nextCursor) {
      const cursor = feed.nextCursor;
      this.fetching = this.options.loadMore(cursor).then(
        (more) => {
          const known = new Set(feed.items.map((item) => item.id));
          feed.items.push(...more.items.filter((item) => !known.has(item.id)));
          feed.nextCursor = more.nextCursor;
        },
        (error: unknown) => console.warn("[xr-viewer] Failed to load more of the feed.", error)
      );
      await this.fetching;
      this.fetching = null;
    }
    if (next * GALLERY_PAGE_SIZE >= feed.items.length) {
      this.renderPaging();
      return;
    }
    this.showPage(next);
  }

  probe(): unknown {
    const feed = this.options?.feed;
    return {
      page: this.page,
      pageSize: GALLERY_PAGE_SIZE,
      loadedItems: feed?.items.length ?? 0,
      nextCursor: feed?.nextCursor ?? null,
      fetching: Boolean(this.fetching),
      errors: [...this.errors],
      lastSelect: this.lastSelect,
      slots: this.slots.map((slot) => slot?.id ?? null),
      shelf: this.shelf?.probe() ?? null
    };
  }

  private async selectTile(index: number): Promise<string> {
    const item = this.itemAt(index);
    const space = this.options?.space;
    if (!item || !space) return "empty";
    if (this.errors.has(item.id)) return "error";
    if (space.isLoading(item.id)) return "ignored-loading";
    if (space.isPlaced(item.id)) {
      space.remove(item.id);
      return "removed";
    }
    try {
      return await space.place({ id: item.id, url: item.url });
    } catch (error) {
      console.warn(`[xr-viewer] Hologram ${item.id} failed to load.`, error);
      this.errors.add(item.id);
      this.renderTiles();
      return "error";
    }
  }

  private itemAt(index: number): GalleryItem | null {
    return this.options?.feed.items[this.page * GALLERY_PAGE_SIZE + index] ?? null;
  }

  private showPage(page: number): void {
    if (!this.shelf || !this.options) return;
    this.page = page;
    this.generation += 1;
    for (let index = 0; index < GALLERY_PAGE_SIZE; index++) {
      const item = this.itemAt(index);
      const slot = this.slots[index];
      if (slot && slot.id === item?.id) continue;
      this.clearSlot(index);
      if (item) this.loadPreview(index, item, this.generation);
    }
    this.renderTiles();
  }

  private loadPreview(index: number, item: GalleryItem, generation: number): void {
    const cache = this.options!.cache;
    const slot: SlotPreview = { id: item.id, url: item.url, preview: null };
    this.slots[index] = slot;
    if (this.errors.has(item.id)) {
      slot.url = "";
      return;
    }
    cache.acquire(item.url).then(
      (loaded) => {
        if (generation !== this.generation || this.slots[index] !== slot || !this.shelf) {
          // The page moved on while it loaded.
          cache.release(item.url);
          return;
        }
        slot.preview = clonePreview(loaded, SHELF_PREVIEW_HEIGHT_M);
        this.shelf.setPreview(index, slot.preview);
        this.renderTiles();
      },
      (error: unknown) => {
        console.warn(`[xr-viewer] Preview of ${item.id} failed to load.`, error);
        this.errors.add(item.id);
        if (this.slots[index] === slot) slot.url = "";
        this.renderTiles();
      }
    );
  }

  private clearSlot(index: number): void {
    const slot = this.slots[index];
    this.slots[index] = null;
    if (!slot) return;
    if (slot.preview) {
      this.shelf?.setPreview(index, null);
      disposeClone(slot.preview);
      this.options?.cache.release(slot.url);
    }
    // A preview still loading releases itself when it lands (the slot check).
  }

  private renderTiles(): void {
    if (!this.shelf || !this.options) return;
    const space = this.options.space;
    for (let index = 0; index < GALLERY_PAGE_SIZE; index++) {
      const item = this.itemAt(index);
      if (!item) {
        this.shelf.setTile(index, null);
        continue;
      }
      const slot = this.slots[index];
      let status: GalleryTileState["status"];
      if (this.errors.has(item.id)) status = "error";
      else if (space.isLoading(item.id)) status = "placing";
      else if (space.isPlaced(item.id)) status = "placed";
      else if (!slot?.preview) status = "loading";
      else status = "ready";
      this.shelf.setTile(index, { title: item.title, status });
      // A placed hologram is out in the space: its preview leaves the shelf until it comes back.
      const preview = this.shelf.preview(index);
      if (preview) preview.visible = status !== "placed" && status !== "placing";
    }
    this.renderPaging();
  }

  private renderPaging(): void {
    if (!this.shelf || !this.options) return;
    const feed = this.options.feed;
    this.shelf.setPaging({
      newer: this.page > 0,
      older: feed.items.length > (this.page + 1) * GALLERY_PAGE_SIZE || Boolean(feed.nextCursor)
    });
  }

  private teardown(): void {
    for (let index = 0; index < GALLERY_PAGE_SIZE; index++) this.clearSlot(index);
    this.generation += 1;
    this.shelf?.dispose();
    this.shelf = null;
    this.placedStage = false;
  }
}
