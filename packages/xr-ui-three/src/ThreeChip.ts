// The chip (styleguide 2.3, 5.2, 8.4): the one text container, flat deep sea,
// no blur and no rim, at an opacity set by how the target composites. In VR
// it fades in over 0.3 s, holds at least 2 s after the background last asked
// for it, and leaves over 0.4 s; in AR it is always there.
import { apxToMeters } from "@holoim/design-tokens";
import {
  chipOpacity,
  chipStyle,
  isHeadset,
  stepVrChipFade,
  VR_CHIP_HIDDEN,
  type ChipStyle,
  type ViewTarget,
  type VrChipFade
} from "@holoim/xr-ui-core";
import { Group, Mesh, type MeshBasicMaterial, Shape, ShapeGeometry } from "three";

import { createChromeMaterial, finishChrome, setChromeOpacity } from "./chrome.js";

export interface ThreeChipOptions {
  target: ViewTarget;
  distanceM: number;
  /** Content size in metres; the chip adds its padding. Default 0 × 0. */
  contentWidthM?: number;
  contentHeightM?: number;
  /** Text over the hologram's own picture on a flat screen. */
  overPicture?: boolean;
  /** Whether presence follows the VR hysteresis. Default: in VR only. */
  fade?: boolean;
}

const CORNER_SEGMENTS = 12;

function roundedRectangle(width: number, height: number, radius: number): ShapeGeometry {
  const w = width / 2;
  const h = height / 2;
  const r = Math.max(0, Math.min(radius, w, h));
  const shape = new Shape();
  shape.moveTo(-w + r, -h);
  shape.lineTo(w - r, -h);
  shape.absarc(w - r, -h + r, r, -Math.PI / 2, 0, false);
  shape.lineTo(w, h - r);
  shape.absarc(w - r, h - r, r, 0, Math.PI / 2, false);
  shape.lineTo(-w + r, h);
  shape.absarc(-w + r, h - r, r, Math.PI / 2, Math.PI, false);
  shape.lineTo(-w, -h + r);
  shape.absarc(-w + r, -h + r, r, Math.PI, Math.PI * 1.5, false);
  return new ShapeGeometry(shape, CORNER_SEGMENTS);
}

export class ThreeChip {
  readonly group = new Group();
  readonly mesh: Mesh;
  readonly material: MeshBasicMaterial;
  readonly target: ViewTarget;
  readonly distanceM: number;
  /** The look on this target (apx already carry the headset's 2.5×). */
  readonly style: ChipStyle;
  /** The chip's own opacity before presence: `chipOpacity(target)`. */
  readonly baseOpacity: number;
  readonly radiusM: number;
  readonly paddingBlockM: number;
  readonly paddingInlineM: number;
  private readonly fades: boolean;
  private fade: VrChipFade;
  private contentWidthM: number;
  private contentHeightM: number;

  constructor({ target, distanceM, contentWidthM = 0, contentHeightM = 0, overPicture = false, fade }: ThreeChipOptions) {
    const style = chipStyle(target, { overPicture });
    const opacity = chipOpacity(target, { overPicture });
    if (style === null || opacity === null) throw new RangeError("ThreeChip: Quick Look holds no chip (styleguide 5.2)");
    this.target = target;
    this.distanceM = distanceM;
    this.style = style;
    this.baseOpacity = opacity;
    // `chipStyle` already scaled by the headset factor, so convert flat.
    const metres = (apx: number) => apxToMeters(apx, distanceM, { headset: false });
    this.radiusM = metres(style.radiusApx);
    this.paddingBlockM = metres(style.paddingBlockApx);
    this.paddingInlineM = metres(style.paddingInlineApx);
    this.fades = fade ?? target.kind === "vr";
    this.fade = this.fades ? VR_CHIP_HIDDEN : { presence: 1, sinceWantedMs: 0 };
    this.contentWidthM = contentWidthM;
    this.contentHeightM = contentHeightM;
    this.material = createChromeMaterial({ color: style.color, opacity: this.fade.presence * opacity });
    this.mesh = new Mesh(roundedRectangle(1, 1, 0), this.material);
    this.mesh.name = "chip";
    this.group.name = "chip";
    this.group.add(this.mesh);
    this.rebuild();
    this.applyPresence();
  }

  /** The chip's opacity multiplier: 0 to 1 in VR, always 1 elsewhere. */
  get presence(): number {
    return this.fade.presence;
  }

  get widthM(): number {
    return this.contentWidthM + 2 * this.paddingInlineM;
  }

  get heightM(): number {
    return this.contentHeightM + 2 * this.paddingBlockM;
  }

  /** The content's size; the chip grows by its padding around it. */
  setSize(contentWidthM: number, contentHeightM: number): void {
    this.contentWidthM = contentWidthM;
    this.contentHeightM = contentHeightM;
    this.rebuild();
  }

  private rebuild(): void {
    this.mesh.geometry.dispose();
    this.mesh.geometry = roundedRectangle(this.widthM, this.heightM, this.radiusM);
    finishChrome(this.group);
  }

  /** One frame. `wanted`: the background behind the content asks for the chip (VR only; elsewhere ignored). */
  update(dtMs: number, wanted: boolean): void {
    if (this.fades) this.fade = stepVrChipFade(this.fade, wanted, dtMs);
    this.applyPresence();
  }

  private applyPresence(): void {
    setChromeOpacity(this.material, this.baseOpacity * this.fade.presence);
    this.mesh.visible = this.fade.presence > 0;
  }

  get headset(): boolean {
    return isHeadset(this.target);
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.material.dispose();
  }
}
