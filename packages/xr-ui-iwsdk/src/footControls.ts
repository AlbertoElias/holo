import { PokeInteractable, RayInteractable, UIKit, UIKitDocument, type Entity, type World } from "@iwsdk/core";
import {
  createAttentionState,
  elapsedTotalLabel,
  playbackLabel,
  scaleChipLabel,
  updateAttention,
  type AttentionReading,
  type AttentionState,
  type HologramControlActions,
  type HologramControlState
} from "@holoim/xr-ui-core";
import { Vector3, type Camera, type Object3D, type PerspectiveCamera } from "three";

import { FONT_FAMILIES, FONT_FAMILY } from "./fonts.js";
import { createGlyph, type GlyphElement, type GlyphName } from "./glyphs.js";
import {
  CHIP,
  COLOR,
  FOOT_REFERENCE_DISTANCE_M,
  GLYPH,
  LABEL_MIN_DISTANCE_M,
  MOTION,
  TYPE,
  metresPerApx,
  targetMetrics,
  type TargetMetrics,
  withAlpha,
  type XrUiTarget
} from "./tokens.js";

// One glyph control set at a placed hologram's foot (styleguide §1.2, §6,
// §9.2; docs/features/viewer-xr-interface.md). Play/Pause with its timecode is
// always there and dims when unused; restart, the timeline, recenter and the
// scale chip appear when something comes near and leave afterwards. The chip
// keeps its world size whatever the hologram's grab scale, sits 2 cm above
// the anchor in front of the feet, and turns to face the viewer only when the
// hologram is placed or recentered.

/** Brief: a hand within 0.3 m or the head's forward ray within 15° brings the controls. */
export const NEAR_HAND_DISTANCE_M = 0.3;
export const NEAR_HEAD_RAY_DEG = 15;
const CHIP_LIFT_M = 0.02;
/** Timeline length in apx before the target scale; no token yet. */
const TIMELINE_LENGTH = 160;
/** On a phone the timeline gives way so the reach row fits the screen; it stays at least this long to scrub. */
const PHONE_TIMELINE_MIN = 48;
/** Phone screen gutter each side of the reach row (CSS px; the lead's decision, 2026-10-24). */
const PHONE_GUTTER = 16;
/** The row is laid out and kept half a pixel inside the gutter, so settling never leaves it on the line. */
const PHONE_ROW_INSET = PHONE_GUTTER + 0.5;

const tmp = new Vector3();
const tmp2 = new Vector3();

type UIKitComponent = InstanceType<typeof UIKit.Container>;
type UIKitText = InstanceType<typeof UIKit.Text>;

interface Button {
  id: string;
  hit: UIKitComponent;
  glyph: GlyphElement;
  hovered: boolean;
  pressed: boolean;
}

export interface FootControlsOptions {
  target: XrUiTarget;
  actions: HologramControlActions;
  /** Only the phone needs it: world metres per CSS pixel at the reference distance (see `phoneMetresPerApx`). */
  metresPerApx?: number;
  /** Only the phone needs it: the screen width the reach row must fit (CSS px). */
  viewportWidthCss?: number;
}

export interface FootControlsInput {
  now: number;
  /** World position and forward direction of the head (camera). */
  head: Object3D;
  /** Hands or controllers that bring the controls when within 0.3 m. */
  hands: readonly Object3D[];
  /** Distance from the head to the hologram, for the 1 m label rule (§7.3). */
  hologramDistanceM: number;
}

export interface FootControlsProbe {
  target: XrUiTarget;
  worldPosition: [number, number, number];
  worldScale: number;
  yaw: number;
  /** Always-there set opacity (1, or 0.4 when idle). */
  opacity: number;
  dimInMs: number;
  revealed: boolean;
  /** Opacity of the on-reach set, while it fades. */
  reachOpacity: number;
  near: { hover: boolean; hand: boolean; headRay: boolean };
  labelOpacity: number;
  chipOpacity: number;
  metresPerApx: number;
  sizes: { glyphIconApx: number; ringApx: number; strokeApx: number; hitApx: number };
  text: { playback: string; elapsedTotal: string; scale: string };
  buttons: Record<string, { worldPosition: [number, number, number]; visible: boolean }>;
  timeline: { worldStart: [number, number, number]; worldEnd: [number, number, number]; fraction: number; lengthApx: number };
  /** The on-reach chip's left and right edges (world), and its laid-out width. */
  reachRow: { worldLeft: [number, number, number]; worldRight: [number, number, number]; widthApx: number };
}

export function phoneMetresPerApx(verticalFovRad: number, viewportHeightCss: number): number {
  // On a phone, flat sizes mean CSS pixels on screen (§9.2): at the reference
  // distance one apx is one CSS pixel of the camera image.
  return (2 * FOOT_REFERENCE_DISTANCE_M * Math.tan(verticalFovRad / 2)) / viewportHeightCss;
}

export class FootControls {
  readonly entity: Entity;
  readonly document: UIKitDocument;
  readonly target: XrUiTarget;
  private readonly metrics: TargetMetrics;
  private readonly metresPerApx: number;
  private readonly root: UIKitComponent;
  private readonly reachRow: UIKitComponent;
  private readonly alwaysRow: UIKitComponent;
  private readonly buttons = new Map<string, Button>();
  private readonly playButton: Button;
  private readonly pausedText: UIKitText;
  private readonly separator: UIKitComponent;
  private readonly timeText: UIKitText;
  private readonly elapsedTotalText: UIKitText;
  private readonly scaleButton: UIKitComponent;
  private readonly scaleText: UIKitText;
  private readonly timelineHit: UIKitComponent;
  private readonly timelineFill: UIKitComponent;
  private readonly attention: AttentionState;
  private readonly hovering = new Set<number>();
  private used = false;
  private scrubbing = false;
  private yaw = 0;
  private pitch = 0;
  private reachOpacity = 0;
  private lastNow = 0;
  private reading: AttentionReading = { opacity: 1, revealed: false, dimInMs: GLYPH.idleAfterMs };
  private nearFlags = { hover: false, hand: false, headRay: false };
  private labelOpacity = 1;
  private state: HologramControlState = { playing: false, clipTime: 0, duration: 0, scale: 1 };
  private readonly strings = { playback: "", elapsedTotal: "", scale: "" };
  private readonly actions: HologramControlActions;
  private timelineApx: number;
  private readonly rowBudgetApx: number | null;
  private readonly viewportWidthCss: number | null;
  /** How far the phone's reach row slides along its chip to stay inside the gutters (apx). */
  private rowShiftApx = 0;

  constructor(world: World, options: FootControlsOptions) {
    this.actions = options.actions;
    this.metrics = targetMetrics(options.target);
    this.target = options.target;
    this.metresPerApx = options.metresPerApx ?? metresPerApx(FOOT_REFERENCE_DISTANCE_M);
    this.attention = createAttentionState(performance.now());
    const s = this.metrics.scale;
    this.timelineApx = TIMELINE_LENGTH * s;
    this.rowBudgetApx = options.target === "ar-phone" && options.viewportWidthCss ? options.viewportWidthCss - 2 * PHONE_ROW_INSET : null;
    this.viewportWidthCss = this.rowBudgetApx !== null ? options.viewportWidthCss! : null;

    // Each row sits on its own chip; the on-reach row unfolds above, so the
    // always-there row never moves under a reaching hand.
    this.root = new UIKit.Container({
      pixelSize: this.metresPerApx,
      fontFamilies: FONT_FAMILIES,
      fontFamily: FONT_FAMILY,
      anchorX: "center",
      anchorY: "bottom",
      flexDirection: "column",
      alignItems: "center",
      gap: GLYPH.gap * s,
      // Controls are pressed, never grabbed.
      pointerEventsType: { deny: "grab" }
    });
    const chipRow = (): ConstructorParameters<typeof UIKit.Container>[0] => ({
      flexDirection: "row",
      alignItems: "center",
      gap: GLYPH.gap * s,
      // A chip that holds a control row: 3 apx top, bottom and start, 14 apx at the end (§2.3).
      paddingTop: CHIP.controlRowPaddingStart * s,
      paddingBottom: CHIP.controlRowPaddingStart * s,
      paddingLeft: CHIP.controlRowPaddingStart * s,
      paddingRight: CHIP.paddingInline * s,
      borderRadius: CHIP.radius * s,
      backgroundColor: withAlpha(COLOR.deepSea, this.metrics.chipOpacity)
    });

    this.reachRow = new UIKit.Container({ ...chipRow(), display: "none" });
    this.addButton(this.reachRow, "restart", "restart", () => this.actions.restart());

    this.timelineHit = new UIKit.Container({
      width: this.timelineApx,
      height: this.metrics.hitMin,
      justifyContent: "center",
      flexDirection: "column"
    });
    // The styleguide has no track token; the closest is gold at 40% under a gold fill (brief).
    const track = new UIKit.Container({
      width: "100%",
      height: GLYPH.stroke * s,
      borderRadius: GLYPH.stroke * s,
      backgroundColor: withAlpha(COLOR.gold, 0.4),
      pointerEvents: "none"
    });
    this.timelineFill = new UIKit.Container({ width: "0%", height: "100%", borderRadius: GLYPH.stroke * s, backgroundColor: COLOR.gold, pointerEvents: "none" });
    track.add(this.timelineFill);
    this.timelineHit.add(track);
    this.reachRow.add(this.timelineHit);
    this.elapsedTotalText = this.text(TYPE.timecode, COLOR.textMuted);
    this.reachRow.add(this.elapsedTotalText);
    this.addButton(this.reachRow, "recenter", "recenter", () => this.actions.recenter());

    this.scaleButton = new UIKit.Container({
      height: this.metrics.hitMin,
      minWidth: this.metrics.hitMin,
      alignItems: "center",
      justifyContent: "center",
      paddingLeft: CHIP.paddingInline * s * 0.5,
      paddingRight: CHIP.paddingInline * s * 0.5
    });
    this.scaleText = this.text(TYPE.controlLabel, COLOR.gold);
    this.scaleButton.add(this.scaleText);
    this.reachRow.add(this.scaleButton);
    this.bindPress(this.scaleButton, () => this.actions.resetScale(), (hovered) => this.scaleText.setProperties({ color: hovered ? COLOR.highlight : COLOR.gold }));

    this.alwaysRow = new UIKit.Container(chipRow());
    const alwaysRow = this.alwaysRow;
    this.playButton = this.addButton(alwaysRow, "play", "play", () => this.actions.togglePlay(), true);
    this.pausedText = this.text(TYPE.timecode, COLOR.textMuted);
    this.separator = new UIKit.Container({ width: 3 * s, height: 3 * s, borderRadius: 1.5 * s, backgroundColor: COLOR.textMuted });
    this.timeText = this.text(TYPE.timecode, COLOR.textMuted);
    const label = new UIKit.Container({ flexDirection: "row", alignItems: "center", gap: 4 * s, pointerEvents: "none" });
    label.add(this.pausedText, this.separator, this.timeText);
    alwaysRow.add(label);

    this.root.add(this.reachRow, alwaysRow);
    this.bindScrub();
    this.root.addEventListener("pointerenter" as never, ((event: { pointerId: number }) => this.hovering.add(event.pointerId)) as never);
    this.root.addEventListener("pointerleave" as never, ((event: { pointerId: number }) => this.hovering.delete(event.pointerId)) as never);

    this.document = new UIKitDocument(this.root);
    this.entity = world.createTransformEntity(undefined, { parent: world.activeLevel.value });
    this.entity.object3D!.name = "FootControls";
    this.entity.object3D!.add(this.document);
    this.entity.addComponent(RayInteractable);
    this.entity.addComponent(PokeInteractable);
  }

  /** Faces the chip toward the head; call when the hologram is placed or recentered, never per frame. */
  faceViewer(anchor: Vector3, head: Vector3): void {
    this.yaw = Math.atan2(head.x - anchor.x, head.z - anchor.z);
    const horizontal = Math.hypot(head.x - anchor.x, head.z - anchor.z);
    // Tilt back toward the eyes so the row reads from where the viewer stands.
    this.pitch = -Math.atan2(head.y - anchor.y - CHIP_LIFT_M, Math.max(horizontal, 0.1)) * 0.5;
  }

  /**
   * Keeps the chip at the hologram's anchor: 2 cm up and `frontM` toward the
   * viewer it faced at placement, outside the hologram's pointer box.
   */
  follow(anchor: Vector3, frontM: number): void {
    const object = this.entity.object3D!;
    object.position.set(anchor.x + Math.sin(this.yaw) * frontM, anchor.y + CHIP_LIFT_M, anchor.z + Math.cos(this.yaw) * frontM);
    object.rotation.set(this.pitch, this.yaw, 0, "YXZ");
  }

  setVisible(visible: boolean): void {
    this.entity.object3D!.visible = visible;
  }

  update(state: HologramControlState, input: FootControlsInput): AttentionReading {
    this.state = state;
    const delta = this.lastNow ? input.now - this.lastNow : 0;
    this.lastNow = input.now;
    const near = this.readNear(input);
    this.reading = updateAttention(this.attention, input.now, near || this.scrubbing, this.used, {
      idleAfterMs: GLYPH.idleAfterMs,
      idleOpacity: GLYPH.idleOpacity,
      holdMs: CHIP.vrMinHoldMs
    });
    this.used = false;
    if (this.target === "ar-phone") {
      // Flat sizes are CSS pixels on screen (§9.2) at any distance: scale by the
      // controls' depth in view (the reach row's, where the widest row sits).
      const object = this.entity.object3D!;
      const at = (this.reachOpacity > 0 ? this.reachRow : this.alwaysRow).getWorldPosition(new Vector3());
      const depth = -at.applyMatrix4(input.head.matrixWorld.clone().invert()).z;
      if (depth > 0.05) object.scale.setScalar(depth / FOOT_REFERENCE_DISTANCE_M);
    }

    // Chrome unfolds 240 ms in and 400 ms out (§8.4).
    const step = this.reading.revealed ? delta / MOTION.chromeInMs : -delta / MOTION.chromeOutMs;
    this.reachOpacity = Math.min(1, Math.max(0, this.reachOpacity + step));
    this.reachRow.setProperties({ display: this.reachOpacity > 0 ? "flex" : "none" });
    // No text within 1 m of the hologram (§7.3); glyphs stay.
    this.labelOpacity = input.hologramDistanceM >= LABEL_MIN_DISTANCE_M ? 1 : 0;

    this.render();
    this.fitPhoneRow();
    this.keepPhoneRowOnScreen(input.head);
    return this.reading;
  }

  /** Shortens (or restores) the phone's timeline until the laid-out reach row fits the screen's gutters. */
  private fitPhoneRow(): void {
    const width = this.rowBudgetApx !== null ? this.reachRow.size.value?.[0] : undefined;
    if (width === undefined || this.reachOpacity === 0) return;
    const next = Math.min(TIMELINE_LENGTH, Math.max(PHONE_TIMELINE_MIN, this.timelineApx - (width - this.rowBudgetApx!)));
    if (Math.abs(next - this.timelineApx) < 0.5) return;
    this.timelineApx = next;
    this.timelineHit.setProperties({ width: next });
  }

  /**
   * Slides the phone's reach row along its chip until its edges, as drawn on
   * screen, sit inside the gutters: a hologram off the screen's centre would
   * otherwise push the row past the edge. It slides back when there is room.
   */
  private keepPhoneRowOnScreen(head: Object3D): void {
    const camera = head as PerspectiveCamera;
    if (this.viewportWidthCss === null || this.reachOpacity === 0 || !camera.isPerspectiveCamera) return;
    const { worldLeft, worldRight, widthApx } = this.reachRowEdges();
    const width = this.viewportWidthCss;
    const toPx = (point: [number, number, number]): number | null => {
      const ndc = new Vector3(...point).project(camera);
      return ndc.z > 1 ? null : ((ndc.x + 1) / 2) * width;
    };
    const [left, right] = [toPx(worldLeft), toPx(worldRight)];
    if (left === null || right === null || right - left < 1 || widthApx <= 0) return;
    const apxPerPx = widthApx / (right - left);
    // Where the row would be drawn unshifted, and the shift that brings it inside.
    const shiftPx = this.rowShiftApx / apxPerPx;
    const [unshiftedLeft, unshiftedRight] = [left - shiftPx, right - shiftPx];
    const inset = PHONE_ROW_INSET;
    let wantPx = 0;
    if (unshiftedLeft < inset) wantPx = inset - unshiftedLeft;
    else if (unshiftedRight > width - inset) wantPx = width - inset - unshiftedRight;
    const next = wantPx * apxPerPx;
    if (Math.abs(next - this.rowShiftApx) < 0.25) return;
    this.rowShiftApx = next;
    this.reachRow.setProperties({ transformTranslateX: next });
  }

  probe(): FootControlsProbe {
    const object = this.entity.object3D!;
    object.updateWorldMatrix(true, true);
    const buttons: FootControlsProbe["buttons"] = {};
    for (const [id, button] of this.buttons) {
      buttons[id] = { worldPosition: button.hit.getWorldPosition(new Vector3()).toArray() as [number, number, number], visible: this.isShown(button.hit) };
    }
    buttons.scale = { worldPosition: this.scaleButton.getWorldPosition(new Vector3()).toArray() as [number, number, number], visible: this.isShown(this.scaleButton) };
    const [start, end] = this.timelineEnds();
    const s = this.metrics.scale;
    return {
      target: this.target,
      worldPosition: object.getWorldPosition(new Vector3()).toArray() as [number, number, number],
      worldScale: object.getWorldScale(new Vector3()).x,
      yaw: this.yaw,
      opacity: this.reading.opacity,
      dimInMs: this.reading.dimInMs,
      revealed: this.reading.revealed,
      reachOpacity: this.reachOpacity,
      near: { ...this.nearFlags },
      labelOpacity: this.labelOpacity,
      chipOpacity: this.metrics.chipOpacity,
      metresPerApx: this.metresPerApx,
      sizes: { glyphIconApx: GLYPH.icon * s, ringApx: GLYPH.ring * s, strokeApx: GLYPH.stroke * s, hitApx: this.metrics.hitMin },
      text: { ...this.strings },
      buttons,
      timeline: { worldStart: start.toArray() as [number, number, number], worldEnd: end.toArray() as [number, number, number], fraction: this.fraction(), lengthApx: this.timelineApx },
      reachRow: this.reachRowEdges()
    };
  }

  dispose(): void {
    for (const button of this.buttons.values()) button.glyph.dispose();
    this.document.dispose();
    this.entity.destroy();
  }

  private isShown(component: UIKitComponent): boolean {
    let node: Object3D | null = component;
    while (node) {
      if (!node.visible) return false;
      node = node.parent;
    }
    return this.reachRowShown(component);
  }

  private reachRowShown(component: UIKitComponent): boolean {
    let node: Object3D | null = component;
    while (node) {
      if (node === this.reachRow) return this.reachOpacity > 0;
      node = node.parent;
    }
    return true;
  }

  private reachRowEdges(): FootControlsProbe["reachRow"] {
    const widthApx = this.reachRow.size.value?.[0] ?? 0;
    const object = this.entity.object3D!;
    const half = (widthApx * this.metresPerApx * object.getWorldScale(new Vector3()).x) / 2;
    const centre = this.reachRow.getWorldPosition(new Vector3());
    const right = new Vector3(1, 0, 0).transformDirection(object.matrixWorld);
    const edge = (sign: number) => centre.clone().addScaledVector(right, sign * half).toArray() as [number, number, number];
    return { worldLeft: edge(-1), worldRight: edge(1), widthApx };
  }

  /** World positions of the timeline's two ends (centre line). */
  private timelineEnds(): [Vector3, Vector3] {
    this.timelineHit.updateWorldMatrix(true, false);
    const half = (this.timelineApx * this.metresPerApx * this.entity.object3D!.getWorldScale(new Vector3()).x) / 2;
    const centre = this.timelineHit.getWorldPosition(new Vector3());
    const right = new Vector3(1, 0, 0).transformDirection(this.entity.object3D!.matrixWorld);
    return [centre.clone().addScaledVector(right, -half), centre.clone().addScaledVector(right, half)];
  }

  private fraction(): number {
    return this.state.duration > 0 ? Math.min(1, Math.max(0, this.state.clipTime / this.state.duration)) : 0;
  }

  private readNear(input: FootControlsInput): boolean {
    const object = this.entity.object3D!;
    if (!object.visible) {
      this.nearFlags = { hover: false, hand: false, headRay: false };
      return false;
    }
    const centre = object.getWorldPosition(tmp);
    const hand = input.hands.some((h) => h.getWorldPosition(tmp2).distanceTo(centre) <= NEAR_HAND_DISTANCE_M);
    let headRay: boolean;
    if (this.target === "ar-phone" && (input.head as Camera).isCamera) {
      // A phone is held to frame the hologram: the controls come while its foot is
      // in the lower half of the screen, so the whole body can stay in view.
      const screen = centre.clone().project(input.head as Camera);
      headRay = screen.z < 1 && Math.abs(screen.x) <= 1 && screen.y >= -1 && screen.y <= 0;
    } else {
      const head = input.head.getWorldPosition(tmp2);
      const toChip = centre.clone().sub(head).normalize();
      const forward = new Vector3(0, 0, -1).transformDirection(input.head.matrixWorld);
      headRay = forward.angleTo(toChip) <= (NEAR_HEAD_RAY_DEG * Math.PI) / 180;
    }
    this.nearFlags = { hover: this.hovering.size > 0, hand, headRay };
    return this.nearFlags.hover || hand || headRay;
  }

  private render(): void {
    const state = this.state;
    const still = state.duration <= 0;
    const always = this.reading.opacity;
    const reach = this.reachOpacity;
    const labels = this.labelOpacity;

    this.alwaysRow.setProperties({ backgroundColor: withAlpha(COLOR.deepSea, this.metrics.chipOpacity * always) });
    this.reachRow.setProperties({ backgroundColor: withAlpha(COLOR.deepSea, this.metrics.chipOpacity * reach) });
    this.playButton.glyph.setDrawing(state.playing ? "pause" : "play");
    for (const button of this.buttons.values()) {
      const base = button === this.playButton ? always : reach;
      const disabled = still && button !== this.buttons.get("recenter");
      button.glyph.setOpacity(base * (button.pressed ? GLYPH.pressedOpacity : 1) * (disabled ? GLYPH.idleOpacity : 1));
      button.glyph.setColor(button.hovered && !disabled ? COLOR.highlight : COLOR.gold);
    }

    const playback = playbackLabel(state);
    this.setText(this.pausedText, "pausedPrefix", playback.prefix ?? "");
    this.pausedText.setProperties({ display: playback.prefix ? "flex" : "none", opacity: always * labels });
    this.separator.setProperties({ display: playback.prefix ? "flex" : "none", backgroundColor: withAlpha(COLOR.textMuted, always * labels) });
    this.setText(this.timeText, "time", playback.time);
    this.timeText.setProperties({ opacity: always * labels });
    this.strings.playback = playback.prefix ? `${playback.prefix} · ${playback.time}` : playback.time;

    this.strings.elapsedTotal = still ? "" : elapsedTotalLabel(state);
    this.setText(this.elapsedTotalText, "elapsedTotal", this.strings.elapsedTotal);
    this.elapsedTotalText.setProperties({ opacity: reach * labels });
    this.strings.scale = scaleChipLabel(state.scale);
    this.setText(this.scaleText, "scale", this.strings.scale);
    this.scaleText.setProperties({ opacity: reach * labels });

    this.timelineHit.setProperties({ display: still ? "none" : "flex" });
    this.timelineFill.setProperties({ width: `${(this.fraction() * 100).toFixed(2)}%` as `${number}%`, backgroundColor: withAlpha(COLOR.gold, reach) });
  }

  private readonly lastText = new Map<string, string>();

  private setText(text: UIKitText, key: string, value: string): void {
    if (this.lastText.get(key) === value) return;
    this.lastText.set(key, value);
    text.setProperties({ text: value });
  }

  private text(type: { size: number; weight: number }, color: string): UIKitText {
    // One line, never squeezed: a row short of width shrinks the timeline instead.
    return new UIKit.Text({ text: "", fontSize: type.size * this.metrics.scale, fontWeight: type.weight, color, wordBreak: "keep-all", flexShrink: 0, pointerEvents: "none" });
  }

  private addButton(row: UIKitComponent, id: string, glyphName: GlyphName, onSelect: () => void, ring = false): Button {
    const s = this.metrics.scale;
    const drawn = (ring ? GLYPH.ring : GLYPH.icon) * s;
    // Hit area: the larger of the drawn size and the input's minimum, centred (§6.1).
    const size = Math.max(drawn, this.metrics.hitMin);
    const hit = new UIKit.Container({ width: size, height: size, alignItems: "center", justifyContent: "center" });
    const glyph = createGlyph(glyphName, { size: drawn, color: COLOR.gold, ...(ring ? { ring: { innerSize: GLYPH.playTriangle } } : {}) });
    glyph.element.setProperties({ pointerEvents: "none" });
    hit.add(glyph.element);
    row.add(hit);
    const button: Button = { id, hit, glyph, hovered: false, pressed: false };
    this.buttons.set(id, button);
    this.bindPress(hit, onSelect, (hovered) => (button.hovered = hovered), (pressed) => (button.pressed = pressed));
    return button;
  }

  private bindPress(target: UIKitComponent, onSelect: () => void, onHover?: (hovered: boolean) => void, onPress?: (pressed: boolean) => void): void {
    target.addEventListener("pointerenter" as never, () => onHover?.(true));
    target.addEventListener("pointerleave" as never, () => {
      onHover?.(false);
      onPress?.(false);
    });
    target.addEventListener("pointerdown" as never, () => onPress?.(true));
    target.addEventListener("pointerup" as never, () => onPress?.(false));
    target.addEventListener("click" as never, () => {
      // Hidden controls take no input.
      if (!this.reachRowShown(target)) return;
      this.used = true;
      onSelect();
    });
  }

  private bindScrub(): void {
    type ScrubEvent = { pointerId: number; pointOnFace?: Vector3; point: Vector3; object: Object3D & { setPointerCapture(id: number): void; releasePointerCapture(id: number): void } };
    const seekTo = (event: ScrubEvent): void => {
      const [start, end] = this.timelineEnds();
      const point = (event as { intersection?: { pointOnFace?: Vector3 } }).intersection?.pointOnFace ?? event.point;
      const along = end.clone().sub(start);
      const t = Math.min(1, Math.max(0, point.clone().sub(start).dot(along) / along.lengthSq()));
      this.actions.seek(t * this.state.duration);
      this.used = true;
    };
    const hit = this.timelineHit as unknown as Object3D;
    hit.addEventListener("pointerdown" as never, ((event: ScrubEvent) => {
      if (this.state.duration <= 0 || this.reachOpacity <= 0) return;
      this.scrubbing = true;
      (hit as unknown as ScrubEvent["object"]).setPointerCapture(event.pointerId);
      seekTo(event);
    }) as never);
    hit.addEventListener("pointermove" as never, ((event: ScrubEvent) => {
      if (this.scrubbing) seekTo(event);
    }) as never);
    const end = ((event: ScrubEvent) => {
      if (!this.scrubbing) return;
      this.scrubbing = false;
      (hit as unknown as ScrubEvent["object"]).releasePointerCapture(event.pointerId);
    }) as never;
    hit.addEventListener("pointerup" as never, end);
    hit.addEventListener("pointercancel" as never, end);
  }
}
