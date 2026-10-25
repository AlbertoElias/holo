import { RayInteractable, UIKit, UIKitDocument, type Entity, type World } from "@iwsdk/core";
import { GALLERY_LABELS, galleryTileLabel, type GalleryTileState } from "@holoim/xr-ui-core";
import { Color, DoubleSide, Group, Mesh, MeshStandardMaterial, RingGeometry, Vector3, type Object3D } from "three";

import { FONT_FAMILIES, FONT_FAMILY } from "./fonts.js";
import { CHIP, COLOR, TYPE, metresPerApx, targetMetrics, withAlpha, type XrUiTarget } from "./tokens.js";

// The gallery (docs/features/viewer-xr-interface.md, step 4): feed holograms
// as small paused previews on a curved shelf around the viewer, in two wings
// at their sides, so the space in front stays free for placed holograms and
// a wing never stands between the eyes and a placed hologram's feet. Each
// tile's title sits above its preview on the chip (it is in front of the sky
// or the camera image, §5.2); "Newer" and "Older" at the wings' ends page
// the feed. The viewer supplies the previews; the shelf lays them out.

/** Wing tiles at these yaws from the stage's forward direction, left to right (degrees, + is right). */
const TILE_YAWS_DEG = [-125, -105, -85, 85, 105, 125] as const;
const PAGE_YAWS_DEG = { newer: -145, older: 145 } as const;
/** Far enough that its text may be read (labels 1 m away or more, §7.3), near enough to aim at. */
export const SHELF_RADIUS_M = 1.2;
/** Board height: below the eyes, above the sight line to a placed hologram's feet. */
const SHELF_HEIGHT_M = 0.9;
const SHELF_DEPTH_M = 0.22;
/** Previews stand this tall on the board. */
export const SHELF_PREVIEW_HEIGHT_M = 0.28;
const TILE_WIDTH_M = 0.34;
/** The boards under the wings, as yaw ranges (degrees). */
const BOARD_YAWS_DEG = [[-135, -75], [75, 135]] as const;
/**
 * The shelf's nearest edge to the stage's forward direction, boards and tiles
 * alike (degrees). Seen from the stage's origin, a placed hologram stays inside
 * it, so no wing stands in front of or through one.
 */
export const SHELF_CLEAR_YAW_DEG = Math.min(
  ...BOARD_YAWS_DEG.map(([from, to]) => Math.min(Math.abs(from), Math.abs(to))),
  ...TILE_YAWS_DEG.map((deg) => Math.abs(deg) - (Math.atan(TILE_WIDTH_M / 2 / SHELF_RADIUS_M) * 180) / Math.PI)
);
const TILE_LABEL_GAP_M = 0.03;
/** The pointer panel stands just behind the preview, so a ray at the figure selects its tile. */
const TILE_PANEL_BEHIND_M = 0.08;

export const GALLERY_PAGE_SIZE = TILE_YAWS_DEG.length;

export interface GalleryShelfOptions {
  target: XrUiTarget;
  /** World metres per apx at the shelf; defaults to the headset value at its radius. */
  metresPerApx?: number;
  onSelectTile(index: number): void;
  onPage(direction: "newer" | "older"): void;
}

export interface GalleryShelfProbe {
  visible: boolean;
  tiles: Array<{ index: number; title: string | null; label: string; status: GalleryTileState["status"] | "empty"; hasPreview: boolean; worldPosition: [number, number, number]; panelPosition: [number, number, number] }>;
  paging: Record<"newer" | "older", { visible: boolean; worldPosition: [number, number, number] }>;
}

interface Tile {
  index: number;
  group: Group;
  groupEntity: Entity;
  entity: Entity;
  document: UIKitDocument;
  root: InstanceType<typeof UIKit.Container>;
  chip: InstanceType<typeof UIKit.Container>;
  label: InstanceType<typeof UIKit.Text>;
  state: GalleryTileState | null;
  preview: Object3D | null;
  hovered: boolean;
}

interface PageLabel {
  entity: Entity;
  document: UIKitDocument;
  root: InstanceType<typeof UIKit.Container>;
  text: InstanceType<typeof UIKit.Text>;
  visible: boolean;
  hovered: boolean;
}

const yawDirection = (deg: number): Vector3 => {
  const a = (deg * Math.PI) / 180;
  return new Vector3(Math.sin(a), 0, -Math.cos(a));
};

export class GalleryShelf {
  readonly group = new Group();
  /** IWSDK re-parents an entity that sits under a plain object, so the shelf and its tiles are entities. */
  private readonly entity: Entity;
  private readonly tiles: Tile[] = [];
  private readonly pages: Record<"newer" | "older", PageLabel>;
  private readonly boards: Mesh<RingGeometry, MeshStandardMaterial>[] = [];
  private readonly metresPerApx: number;
  private readonly scale: number;
  private readonly chipOpacity: number;

  constructor(world: World, private readonly options: GalleryShelfOptions) {
    const metrics = targetMetrics(options.target);
    this.scale = metrics.scale;
    this.chipOpacity = metrics.chipOpacity;
    this.metresPerApx = options.metresPerApx ?? metresPerApx(SHELF_RADIUS_M);
    this.group.name = "GalleryShelf";
    this.entity = world.createTransformEntity(this.group, { parent: world.activeLevel.value });
    this.group.visible = false;

    // Two curved boards (deep sea, like the floor) under the wings.
    const material = new MeshStandardMaterial({ color: new Color(COLOR.deepSea), roughness: 0.9, metalness: 0, side: DoubleSide });
    for (const [from, to] of BOARD_YAWS_DEG) {
      // RingGeometry sweeps from +X toward +Y; laid flat that is +X toward -Z, so yaw a sits at 90° − a.
      const start = ((90 - to) * Math.PI) / 180;
      const board = new Mesh(new RingGeometry(SHELF_RADIUS_M - SHELF_DEPTH_M / 2, SHELF_RADIUS_M + SHELF_DEPTH_M / 2, 32, 1, start, ((to - from) * Math.PI) / 180), material);
      board.rotation.x = -Math.PI / 2;
      board.position.y = SHELF_HEIGHT_M;
      board.name = "GalleryBoard";
      this.group.add(board);
      this.boards.push(board);
    }

    TILE_YAWS_DEG.forEach((deg, index) => this.tiles.push(this.buildTile(world, index, deg)));
    this.pages = {
      newer: this.buildPageLabel(world, "newer"),
      older: this.buildPageLabel(world, "older")
    };
  }

  /** Stands the shelf around a point on the floor, its open front toward `forward` (horizontal). */
  place(origin: Vector3, forward: Vector3): void {
    this.group.position.set(origin.x, origin.y, origin.z);
    this.group.rotation.set(0, Math.atan2(-forward.x, -forward.z), 0);
    this.group.updateMatrixWorld(true);
  }

  setVisible(visible: boolean): void {
    this.group.visible = visible;
    for (const tile of this.tiles) tile.entity.object3D!.visible = visible && tile.state !== null;
    for (const page of Object.values(this.pages)) page.entity.object3D!.visible = visible && page.visible;
  }

  get visible(): boolean {
    return this.group.visible;
  }

  /** Shows a feed item on tile `index`, or empties the tile. */
  setTile(index: number, state: GalleryTileState | null): void {
    const tile = this.tiles[index];
    if (!tile) return;
    tile.state = state;
    tile.entity.object3D!.visible = this.group.visible && state !== null;
    if (!state) {
      this.setPreview(index, null);
      return;
    }
    this.renderTile(tile);
  }

  /** Puts a preview on tile `index` (standing on the board, facing the viewer), replacing any; returns the old one. */
  setPreview(index: number, preview: Object3D | null): Object3D | null {
    const tile = this.tiles[index];
    if (!tile) return null;
    const old = tile.preview;
    if (old) tile.group.remove(old);
    tile.preview = preview;
    if (preview) {
      tile.group.add(preview);
      preview.position.set(0, 0, 0);
      preview.rotation.set(0, 0, 0);
    }
    return old;
  }

  preview(index: number): Object3D | null {
    return this.tiles[index]?.preview ?? null;
  }

  setPaging(available: { newer: boolean; older: boolean }): void {
    for (const key of ["newer", "older"] as const) {
      const page = this.pages[key];
      page.visible = available[key];
      page.entity.object3D!.visible = this.group.visible && page.visible;
    }
  }

  probe(): GalleryShelfProbe {
    this.group.updateMatrixWorld(true);
    return {
      visible: this.group.visible,
      tiles: this.tiles.map((tile) => ({
        index: tile.index,
        title: tile.state?.title ?? null,
        label: tile.state ? galleryTileLabel(tile.state) : "",
        status: tile.state?.status ?? "empty",
        hasPreview: Boolean(tile.preview?.visible),
        worldPosition: tile.group.getWorldPosition(new Vector3()).add(new Vector3(0, SHELF_PREVIEW_HEIGHT_M / 2, 0)).toArray() as [number, number, number],
        panelPosition: tile.entity.object3D!.getWorldPosition(new Vector3()).toArray() as [number, number, number]
      })),
      // Each label's centre: its root stands on its bottom edge.
      paging: {
        newer: this.pageProbe(this.pages.newer),
        older: this.pageProbe(this.pages.older)
      }
    };
  }

  private pageProbe(page: PageLabel): GalleryShelfProbe["paging"]["newer"] {
    const object = page.entity.object3D!;
    const heightApx = page.root.size.value?.[1] ?? targetMetrics(this.options.target).hitMin;
    const centre = object.getWorldPosition(new Vector3()).add(new Vector3(0, (heightApx * this.metresPerApx) / 2, 0));
    return { visible: object.visible, worldPosition: centre.toArray() as [number, number, number] };
  }

  dispose(): void {
    for (const tile of this.tiles) {
      tile.document.dispose();
      tile.entity.destroy();
      tile.groupEntity.destroy();
    }
    for (const page of Object.values(this.pages)) {
      page.document.dispose();
      page.entity.destroy();
    }
    for (const board of this.boards) board.geometry.dispose();
    this.boards[0]?.material.dispose();
    this.entity.destroy();
    this.group.removeFromParent();
  }

  private buildTile(world: World, index: number, deg: number): Tile {
    const s = this.scale;
    const group = new Group();
    group.name = `GalleryTile${index}`;
    const groupEntity = world.createTransformEntity(group, { parent: this.entity });
    group.position.copy(yawDirection(deg).multiplyScalar(SHELF_RADIUS_M)).setY(SHELF_HEIGHT_M);
    // Facing the shelf's centre, where the viewer stands.
    group.rotation.set(0, (-deg * Math.PI) / 180, 0);

    // One panel per tile: the pointer target (preview and label) with the title on the chip at its top.
    const widthApx = TILE_WIDTH_M / this.metresPerApx;
    const heightApx = (SHELF_PREVIEW_HEIGHT_M + TILE_LABEL_GAP_M) / this.metresPerApx;
    const root = new UIKit.Container({
      pixelSize: this.metresPerApx,
      fontFamilies: FONT_FAMILIES,
      fontFamily: FONT_FAMILY,
      anchorX: "center",
      anchorY: "bottom",
      width: widthApx,
      flexDirection: "column-reverse",
      alignItems: "center",
      pointerEventsType: { deny: "grab" }
    });
    const body = new UIKit.Container({ width: widthApx, height: heightApx });
    const chip = new UIKit.Container({
      paddingTop: CHIP.paddingBlock * s,
      paddingBottom: CHIP.paddingBlock * s,
      paddingLeft: CHIP.paddingInline * s,
      paddingRight: CHIP.paddingInline * s,
      borderRadius: CHIP.radius * s,
      backgroundColor: withAlpha(COLOR.deepSea, this.chipOpacity),
      maxWidth: widthApx,
      pointerEvents: "none"
    });
    const label = new UIKit.Text({ text: "", fontSize: TYPE.controlLabel.size * s, fontWeight: TYPE.controlLabel.weight, color: COLOR.gold, wordBreak: "keep-all", pointerEvents: "none" });
    chip.add(label);
    root.add(body, chip);
    const document = new UIKitDocument(root);
    // The panel is its own entity (pointers need one) and rides the tile's pose.
    const entity = world.createTransformEntity(undefined, { parent: groupEntity });
    entity.object3D!.name = `GalleryTilePanel${index}`;
    entity.object3D!.add(document);
    entity.object3D!.visible = false;
    entity.addComponent(RayInteractable);
    entity.object3D!.position.set(0, 0, -TILE_PANEL_BEHIND_M);

    const tile: Tile = { index, group, groupEntity, entity, document, root, chip, label, state: null, preview: null, hovered: false };
    root.addEventListener("pointerenter" as never, () => {
      tile.hovered = true;
      this.renderTile(tile);
    });
    root.addEventListener("pointerleave" as never, () => {
      tile.hovered = false;
      this.renderTile(tile);
    });
    root.addEventListener("click" as never, () => {
      if (tile.state && tile.entity.object3D!.visible) this.options.onSelectTile(index);
    });
    return tile;
  }

  private renderTile(tile: Tile): void {
    const state = tile.state;
    if (!state) return;
    // A placed hologram's tile keeps its title, muted, until it comes back.
    const live = state.status === "ready" || state.status === "placed";
    const color = state.status === "ready" ? (tile.hovered ? COLOR.highlight : COLOR.gold) : live && tile.hovered ? COLOR.highlight : COLOR.textMuted;
    tile.label.setProperties({ text: galleryTileLabel(state), color });
  }

  private buildPageLabel(world: World, key: "newer" | "older"): PageLabel {
    const s = this.scale;
    const hitApx = targetMetrics(this.options.target).hitMin;
    const root = new UIKit.Container({
      pixelSize: this.metresPerApx,
      fontFamilies: FONT_FAMILIES,
      fontFamily: FONT_FAMILY,
      anchorX: "center",
      anchorY: "bottom",
      minHeight: hitApx,
      minWidth: hitApx,
      alignItems: "center",
      justifyContent: "center",
      paddingLeft: CHIP.paddingInline * s,
      paddingRight: CHIP.paddingInline * s,
      borderRadius: CHIP.radius * s,
      backgroundColor: withAlpha(COLOR.deepSea, this.chipOpacity),
      pointerEventsType: { deny: "grab" }
    });
    const text = new UIKit.Text({ text: GALLERY_LABELS[key], fontSize: TYPE.controlLabel.size * s, fontWeight: TYPE.controlLabel.weight, color: COLOR.gold, wordBreak: "keep-all", pointerEvents: "none" });
    root.add(text);
    const document = new UIKitDocument(root);
    const entity = world.createTransformEntity(undefined, { parent: this.entity });
    entity.object3D!.name = `GalleryPage-${key}`;
    entity.object3D!.add(document);
    entity.object3D!.visible = false;
    entity.addComponent(RayInteractable);
    const deg = PAGE_YAWS_DEG[key];
    entity.object3D!.position.copy(yawDirection(deg).multiplyScalar(SHELF_RADIUS_M)).setY(SHELF_HEIGHT_M + 0.04);
    entity.object3D!.rotation.set(0, (-deg * Math.PI) / 180, 0);
    const page: PageLabel = { entity, document, root, text, visible: false, hovered: false };
    root.addEventListener("pointerenter" as never, () => text.setProperties({ color: COLOR.highlight }));
    root.addEventListener("pointerleave" as never, () => text.setProperties({ color: COLOR.gold }));
    root.addEventListener("click" as never, () => {
      if (page.visible && this.group.visible) this.options.onPage(key);
    });
    return page;
  }
}
