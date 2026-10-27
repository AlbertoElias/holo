import { tokens } from "@holoim/design-tokens";
import { RayInteractable, UIKit, UIKitDocument, type Entity, type World } from "@iwsdk/core";
import { Euler, Quaternion, Vector3, type Object3D } from "three";

import { markChrome } from "@holoim/xr-ui-core";
import { FONT_FAMILIES, FONT_FAMILY } from "./fonts.js";
import { CHIP, CHIP_OPACITY, COLOR, GLYPH, HEADSET_SCALE, HIT, LABEL_MIN_DISTANCE_M, TYPE, metresPerApx, withAlpha } from "./tokens.js";

// The world panel (styleguide §1.2, §9.1): lists and settings in a headset,
// as text rows on the chip, opened 1.5 m straight ahead and level, then left
// in the world; it never follows the head. Its rows take rays only (a poke
// cannot reach 1.5 m), each as tall as a ray's minimum (§6.1), and a row's
// label hides, and takes no hits, while the head is within 1 m of it (§7.3).

export interface WorldPanelRow {
  id: string;
  text: string;
  onSelect(): void;
}

export interface WorldPanelOptions {
  /** Whether this commit may run now (a held select owned by something else). */
  canCommit?(rowId: string, pointerId: number): boolean;
  onCommit?(rowId: string, pointerId: number): void;
  onHover?(rowId: string, pointerId: number, hovered: boolean): void;
}

export interface WorldPanelProbe {
  visible: boolean;
  worldPosition: [number, number, number];
  rows: Array<{ id: string; text: string; visible: boolean; enabled: boolean; worldPosition: [number, number, number]; hitHeightM: number; hovered: boolean }>;
}

interface Row {
  row: WorldPanelRow;
  hit: InstanceType<typeof UIKit.Container>;
  label: InstanceType<typeof UIKit.Text>;
  text: string;
  enabled: boolean;
  /** Its label shows: the head is 1 m away or more. */
  readable: boolean;
  hovering: Set<number>;
}

const DISTANCE_M = tokens.placement.worldPanelDefaultM;

const headPosition = new Vector3();
const headQuaternion = new Quaternion();
const headScale = new Vector3();
const level = new Euler();
const forward = new Vector3();
const scratch = new Vector3();

export class WorldPanel {
  readonly entity: Entity;
  private readonly document: UIKitDocument;
  private readonly rows: Row[] = [];
  private readonly pixelSize = metresPerApx(DISTANCE_M);
  private readonly rowHeightApx: number;

  constructor(world: World, rows: readonly WorldPanelRow[], private readonly options: WorldPanelOptions = {}) {
    const s = HEADSET_SCALE;
    const fontSize = TYPE.controlLabel.size * s;
    // A ray's minimum is never scaled (§6.1); the label's line is drawn at 2.5×.
    this.rowHeightApx = Math.max(HIT.ray, fontSize * tokens.type.controlLabel.lineHeight);
    const root = new UIKit.Container({
      pixelSize: this.pixelSize,
      fontFamilies: FONT_FAMILIES,
      fontFamily: FONT_FAMILY,
      flexDirection: "column",
      alignItems: "stretch",
      paddingTop: CHIP.paddingBlock * s,
      paddingBottom: CHIP.paddingBlock * s,
      paddingLeft: CHIP.paddingInline * s,
      paddingRight: CHIP.paddingInline * s,
      borderRadius: CHIP.radius * s,
      // A panel is a container for text: it is on the chip from the start (§5.2).
      backgroundColor: withAlpha(COLOR.deepSea, CHIP_OPACITY.vr)
    });
    for (const row of rows) {
      const hit = new UIKit.Container({ height: this.rowHeightApx, alignItems: "center", justifyContent: "center" });
      const label = new UIKit.Text({ text: row.text, fontSize, fontWeight: TYPE.controlLabel.weight, color: COLOR.gold, wordBreak: "keep-all", pointerEvents: "none" });
      hit.add(label);
      root.add(hit);
      const entry: Row = { row, hit, label, text: row.text, enabled: true, readable: true, hovering: new Set() };
      hit.addEventListener("pointerenter" as never, ((event: { pointerId: number }) => {
        entry.hovering.add(event.pointerId);
        this.options.onHover?.(row.id, event.pointerId, true);
      }) as never);
      hit.addEventListener("pointerleave" as never, ((event: { pointerId: number }) => {
        if (entry.hovering.delete(event.pointerId)) this.options.onHover?.(row.id, event.pointerId, false);
      }) as never);
      hit.addEventListener("click" as never, ((event: { pointerId: number }) => {
        if (!this.takesHits(entry) || this.options.canCommit?.(row.id, event.pointerId) === false) return;
        row.onSelect();
        this.options.onCommit?.(row.id, event.pointerId);
      }) as never);
      this.rows.push(entry);
    }
    this.document = new UIKitDocument(root);
    this.entity = world.createTransformEntity(undefined, { parent: world.activeLevel.value });
    this.entity.object3D!.name = "WorldPanel";
    markChrome(this.entity.object3D!);
    this.entity.object3D!.add(this.document);
    this.entity.addComponent(RayInteractable);
  }

  private takesHits(row: Row): boolean {
    return row.enabled && row.readable && this.isShown();
  }

  private isShown(): boolean {
    for (let node: Object3D | null = this.entity.object3D!; node; node = node.parent) if (!node.visible) return false;
    return true;
  }

  /** Opens 1.5 m straight ahead of the head and level with it, facing it. After this it stays put. */
  place(head: Object3D): void {
    head.updateWorldMatrix(true, false);
    head.matrixWorld.decompose(headPosition, headQuaternion, headScale);
    // A head pitched at that moment must not set the panel high or low.
    level.setFromQuaternion(headQuaternion, "YXZ");
    forward.set(-Math.sin(level.y), 0, -Math.cos(level.y));
    const object = this.entity.object3D!;
    const at = scratch.copy(headPosition).addScaledVector(forward, DISTANCE_M);
    object.parent?.updateWorldMatrix(true, false);
    object.position.copy(object.parent ? object.parent.worldToLocal(at.clone()) : at);
    object.lookAt(headPosition);
  }

  setVisible(visible: boolean): void {
    this.entity.object3D!.visible = visible;
  }

  /** A row's text and whether it takes a select (a disabled row shows at the pressed 55%). */
  setRow(id: string, { text, enabled }: { text?: string; enabled?: boolean }): void {
    const row = this.rows.find((candidate) => candidate.row.id === id);
    if (!row) return;
    if (text !== undefined && text !== row.text) {
      row.text = text;
      row.label.setProperties({ text });
    }
    if (enabled !== undefined) row.enabled = enabled;
  }

  /** Hides each label within 1 m of the head, and paints hover and disabled states. */
  update(head: Object3D): void {
    head.getWorldPosition(headPosition);
    for (const row of this.rows) {
      row.readable = row.hit.getWorldPosition(scratch).distanceTo(headPosition) >= LABEL_MIN_DISTANCE_M;
      const hovered = row.hovering.size > 0 && this.takesHits(row);
      row.label.setProperties({
        color: hovered ? COLOR.highlight : COLOR.gold,
        opacity: !row.readable ? 0 : row.enabled ? 1 : GLYPH.pressedOpacity
      });
      row.hit.setProperties({ pointerEvents: row.readable && row.enabled ? "auto" : "none" });
    }
  }

  hitTarget(id: string): Object3D | null {
    return this.rows.find((row) => row.row.id === id)?.hit ?? null;
  }

  isHoveredBy(id: string, pointerId: number): boolean {
    const row = this.rows.find((candidate) => candidate.row.id === id);
    return Boolean(row && row.hovering.has(pointerId) && this.takesHits(row));
  }

  /** Every row whose label shows now, with its text. */
  readableRows(): Array<{ id: string; text: string; object: Object3D }> {
    if (!this.isShown()) return [];
    return this.rows.filter((row) => row.readable && row.text.trim() !== "").map((row) => ({ id: row.row.id, text: row.text, object: row.hit }));
  }

  probe(): WorldPanelProbe {
    return {
      visible: this.isShown(),
      worldPosition: this.entity.object3D!.getWorldPosition(new Vector3()).toArray() as [number, number, number],
      rows: this.rows.map((row) => ({
        id: row.row.id,
        text: row.text,
        visible: this.isShown() && row.readable,
        enabled: row.enabled,
        worldPosition: row.hit.getWorldPosition(new Vector3()).toArray() as [number, number, number],
        hitHeightM: this.rowHeightApx * this.pixelSize,
        hovered: row.hovering.size > 0
      }))
    };
  }

  dispose(): void {
    this.entity.object3D!.removeFromParent();
    this.document.dispose();
    this.entity.destroy();
  }
}
