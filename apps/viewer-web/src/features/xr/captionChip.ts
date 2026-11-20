import { UIKit, UIKitDocument, type Entity, type World } from "@iwsdk/core";
import { activeCue, FIRST_PERFORMER } from "@holoim/contracts";
import { headsetTextVisible, markChrome, VIEW_TARGETS, type ViewTarget } from "@holoim/xr-ui-core";
import { CHIP, COLOR, FONT_FAMILIES, FONT_FAMILY, FOOT_REFERENCE_DISTANCE_M, MOTION, TYPE, metresPerApx, targetMetrics, withAlpha, type XrUiTarget } from "@holoim/xr-ui-iwsdk";
import { Box3, Vector3, type Object3D } from "three";

import { HologramPlayback } from "./hologramPlayback";
import type { PlacedHologram } from "./viewerContext";

// Speech captions in WebXR (docs/features/sound-voice-captions.md, slice 3):
// a chip by the speaker's head, facing the viewer, in the hologram's caption
// type (40 apx in a headset) on the target's chip. AR and the headset have
// no mute, so which holograms show them is one choice, recorded in the brief
// as the agent's in the owner's absence (2026-11-19, choice 1): only those
// not heard, since only the focused hologram is.

/** When captions show in XR: "unheard" (holograms without audio focus) or "always". */
export const XR_CAPTIONS_WHEN: "unheard" | "always" = "unheard";
/** The chip's foot stands this far above the speaker's head (m, at recorded scale). */
const ABOVE_HEAD_M = 0.22;
/** The widest a caption chip lays out before it wraps (apx, before the headset scale). */
const MAX_WIDTH_APX = 360;

const head = new Vector3();
const at = new Vector3();
const anchor = new Vector3();
const bounds = new Box3();

export interface CaptionChipProbe {
  id: string;
  text: string;
  visible: boolean;
  opacity: number;
  worldPosition: [number, number, number];
  speaker: string | null;
}

const VIEW: Record<XrUiTarget, ViewTarget> = { vr: VIEW_TARGETS.vr, "ar-quest": VIEW_TARGETS.questPassthrough, "ar-phone": VIEW_TARGETS.androidChrome };

/** The speaker's head: the head bone under their wrapper node, else the top of their body. */
function speakerHead(model: Object3D, speaker: string, out: Vector3): boolean {
  const wrapper = model.getObjectByName(speaker) ?? (speaker === FIRST_PERFORMER ? model : null);
  if (!wrapper) return false;
  let bone: Object3D | null = null;
  wrapper.traverse((child) => {
    if (!bone && (child as { isBone?: boolean }).isBone && /(^|[:_])head$/i.test(child.name)) bone = child;
  });
  if (bone) {
    (bone as Object3D).getWorldPosition(out);
    return true;
  }
  bounds.setFromObject(wrapper);
  if (bounds.isEmpty()) return false;
  bounds.getCenter(out);
  out.y = bounds.max.y;
  return true;
}

class CaptionChip {
  readonly entity: Entity;
  private readonly document: UIKitDocument;
  private readonly root: InstanceType<typeof UIKit.Container>;
  private readonly text: InstanceType<typeof UIKit.Text>;
  private current = "";
  speaker: string | null = null;
  opacity = 0;

  constructor(world: World, target: XrUiTarget, pixelSize: number) {
    const metrics = targetMetrics(target);
    const s = metrics.scale;
    this.text = new UIKit.Text({
      text: "",
      fontSize: TYPE.captionOnHologram.size * s,
      fontWeight: TYPE.captionOnHologram.weight,
      lineHeight: `${TYPE.captionOnHologram.lineHeight * 100}%`,
      color: COLOR.text,
      textAlign: "center",
      pointerEvents: "none"
    });
    this.root = new UIKit.Container({
      pixelSize,
      fontFamilies: FONT_FAMILIES,
      fontFamily: FONT_FAMILY,
      anchorX: "center",
      anchorY: "bottom",
      maxWidth: MAX_WIDTH_APX * s,
      paddingTop: CHIP.paddingBlock * s,
      paddingBottom: CHIP.paddingBlock * s,
      paddingLeft: CHIP.paddingInline * s,
      paddingRight: CHIP.paddingInline * s,
      borderRadius: CHIP.radius * s,
      backgroundColor: withAlpha(COLOR.deepSea, metrics.chipOpacity),
      pointerEvents: "none"
    });
    this.chipOpacity = metrics.chipOpacity;
    this.root.add(this.text);
    this.document = new UIKitDocument(this.root);
    this.entity = world.createTransformEntity(undefined, { parent: world.activeLevel.value });
    this.entity.object3D!.name = "CaptionChip";
    markChrome(this.entity.object3D!);
    this.entity.object3D!.add(this.document);
    this.entity.object3D!.visible = false;
  }

  private readonly chipOpacity: number;

  get shown(): string {
    return this.entity.object3D!.visible ? this.current : "";
  }

  /** Steps the fade toward `want` (the chrome timings) and sets the text while it shows. */
  step(text: string | null, want: boolean, dtMs: number): void {
    if (text && text !== this.current) {
      this.current = text;
      this.text.setProperties({ text });
    }
    const target = want && text ? 1 : 0;
    const rate = target > this.opacity ? dtMs / MOTION.chromeInMs : -dtMs / MOTION.chromeOutMs;
    this.opacity = Math.min(1, Math.max(0, this.opacity + rate));
    const object = this.entity.object3D!;
    object.visible = this.opacity > 0;
    if (!object.visible) return;
    this.root.setProperties({ backgroundColor: withAlpha(COLOR.deepSea, this.chipOpacity * this.opacity) });
    this.text.setProperties({ opacity: this.opacity });
  }

  place(position: Vector3, viewer: Vector3): void {
    const object = this.entity.object3D!;
    object.parent?.updateWorldMatrix(true, false);
    object.position.copy(object.parent ? object.parent.worldToLocal(position.clone()) : position);
    // Upright, turned to the viewer about the vertical.
    at.set(viewer.x, position.y, viewer.z);
    object.lookAt(at);
  }

  dispose(): void {
    this.entity.object3D!.removeFromParent();
    this.document.dispose();
    this.entity.destroy();
  }
}

/** One caption chip per placed hologram that carries captions. */
export class CaptionChips {
  private readonly chips = new Map<Entity, CaptionChip>();
  private readonly pixelSize: number;

  constructor(private readonly world: World, private readonly target: XrUiTarget, phoneMetresPerApx: number | null) {
    this.pixelSize = phoneMetresPerApx ?? metresPerApx(FOOT_REFERENCE_DISTANCE_M);
  }

  update(placed: readonly PlacedHologram[], viewer: Object3D, dtMs: number): void {
    for (const [entity, chip] of this.chips) {
      if (placed.some((record) => record.entity === entity)) continue;
      chip.dispose();
      this.chips.delete(entity);
    }
    viewer.getWorldPosition(head);
    for (const record of placed) {
      if (!record.captions) continue;
      let chip = this.chips.get(record.entity);
      if (!chip) {
        chip = new CaptionChip(this.world, this.target, this.pixelSize);
        this.chips.set(record.entity, chip);
      }
      const object = record.entity.object3D;
      const heard = Boolean(record.entity.getValue(HologramPlayback, "audible"));
      const placedAndShown = Boolean(object?.visible) && record.placement.stage !== "searching";
      const clipTime = record.entity.getValue(HologramPlayback, "clipTime") ?? 0;
      const cue = placedAndShown && (XR_CAPTIONS_WHEN === "always" || !heard) ? activeCue(record.captions, clipTime) : null;
      let want = false;
      if (cue && object) {
        const speaker = cue.speaker ?? FIRST_PERFORMER;
        chip.speaker = speaker;
        if (speakerHead(record.model, speaker, anchor)) {
          anchor.y += ABOVE_HEAD_M * object.getWorldScale(at).y;
          chip.place(anchor, head);
          object.getWorldPosition(at);
          // A hologram's caption fades within 1 m of it, like its other text (choice 3; styleguide 7.3).
          want = headsetTextVisible(VIEW[this.target], "caption", { fromHeadM: anchor.distanceTo(head), toHologramM: Math.hypot(head.x - at.x, head.z - at.z) });
        }
      }
      chip.step(cue?.text ?? null, want, dtMs);
    }
  }

  probe(placed: readonly PlacedHologram[]): CaptionChipProbe[] {
    return placed.flatMap((record) => {
      const chip = this.chips.get(record.entity);
      if (!chip) return [];
      const object = chip.entity.object3D!;
      return [{ id: record.id, text: chip.shown, visible: object.visible, opacity: chip.opacity, worldPosition: object.getWorldPosition(new Vector3()).toArray() as [number, number, number], speaker: chip.speaker }];
    });
  }

  dispose(): void {
    for (const chip of this.chips.values()) chip.dispose();
    this.chips.clear();
  }
}
