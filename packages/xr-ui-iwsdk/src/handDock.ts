import { apxToMeters, hitAreaMeters, tokens } from "@holoim/design-tokens";
import { PokeInteractable, RayInteractable, UIKit, UIKitDocument, type Entity, type World } from "@iwsdk/core";
import { glyphGapApx, markChrome, type DockAction } from "@holoim/xr-ui-core";
import { Matrix4, Quaternion, Vector3, type Material, type Mesh, type Object3D } from "three";

import { createGlyph, type GlyphElement, type GlyphName } from "./glyphs.js";
import { POKE } from "./pointers.js";
import { phoneClearance, readSafeAreaInsets, type SafeAreaInsets } from "./safeArea.js";
import { CHIP, CHIP_OPACITY, COLOR, GLYPH, HIT, withAlpha } from "./tokens.js";

// The hand dock (styleguide §1.2, §9.1): glyphs on the non-dominant wrist or
// controller in a headset, within reach and so without text; on a phone, the
// bottom dock in the thumb zone. IWSDK has no DOM overlay in phone AR, so the
// phone dock is a strip attached to the camera, the one exemption from "no
// interactive UI follows the head": on a phone the screen is the hand. Over the
// camera image its row sits on a chip fitted to the controls showing (§5.2,
// §9.2): the Android AR chip, padded as a control row (§2.3), with no shade.
//
// Commits come from IWSDK's pointers only: a ray (or a phone tap) on click,
// a poke on contact (pointerdown), and only for a fingertip that arrived from
// in front of the glyph's face. Each poke approach commits once.

/** Phone dock depth in front of the camera: inside the near view, clear of the scene. */
export const PHONE_DOCK_DEPTH_M = 0.3;

/** In a headset the row is read at arm's reach (§6.1: 45 cm). */
const ARM_REACH_M = tokens.placement.armReachM;

export type HandDockMount =
  /**
   * `ownPointerIds`: the pointers of the hand the dock rides on, which must reach past it.
   * `palm`: the direction out of the palm in `space`'s axes; the row sits on the inside of the wrist (the user, 2026-10-25).
   */
  | { kind: "hand"; space: Object3D; ownPointerIds: readonly number[]; palm: readonly [number, number, number] }
  | { kind: "phone"; camera: Object3D; verticalFovRad: number; viewportHeightCss: number; viewportWidthCss: number };

export interface HandDockOptions {
  /** Headset hit areas: "poke" for a tracked pressing hand, "ray" for a controller (§6.1). Default poke. */
  input?: "poke" | "ray";
  /** Draws over everything, for a wrist inside the wearer's own avatar sleeve. */
  drawOverBody?: boolean;
  /** Whether this commit may run now (a held select owned by something else, a take still exporting). */
  canCommit?(action: DockAction, pointerId: number): boolean;
  /** After a commit ran, for feedback: a tick for a poke, a pulse for a ray. */
  onCommit?(action: DockAction, pointerId: number, kind: "poke" | "ray"): void;
  /** A pointer came onto or left a glyph. */
  onHover?(action: DockAction, pointerId: number, hovered: boolean): void;
}

/** A rectangle in CSS px from the screen's top left (a phone dock's chip). */
export interface ScreenRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface HandDockProbe {
  mount: HandDockMount["kind"];
  input: "poke" | "ray" | "touch";
  visible: boolean;
  metresPerApx: number;
  /** The dock's largest hit area and glyph (its ring when it has one). */
  hitApx: number;
  glyphApx: number;
  /** Drawn and hit sizes in metres (ring or icon; hit area per input). */
  drawnSizeM: number;
  hitSizeM: number;
  buttons: Record<string, { worldPosition: [number, number, number]; hovered: boolean; recording: boolean; shown: boolean; glyphApx: number; hitApx: number }>;
  /** Phone only: the chip's rectangle on the screen (null while no control shows), and the clearances it keeps. */
  chip: ScreenRect | null;
  safeArea: { insets: SafeAreaInsets; bottomClearApx: number } | null;
}

interface DockButton {
  action: DockAction;
  hit: InstanceType<typeof UIKit.Container>;
  /** This action's own sizes: the Record ring is bigger than the icons beside it. */
  size: DockSize;
  /** False while its action is hidden; the chip refits around the rest. */
  shown: boolean;
  glyph: GlyphElement;
  /** Rays (or taps) resting on it. */
  hovering: Set<number>;
  /** Fingertips within the poke's proximity in front of it. */
  near: Set<number>;
  pressed: boolean;
  recording: boolean;
}

interface DockSize {
  glyphApx: number;
  hitApx: number;
  drawnSizeM: number;
  hitSizeM: number;
}

/** Out of the palm in WebXR grip space: the back of the right hand is +X, of the left −X. */
export const GRIP_PALM = { left: [1, 0, 0], right: [-1, 0, 0] } as const;

// 4 cm out of the inside of the wrist, faces looking out of the palm (§1.2).
function wristOffset(palm: readonly [number, number, number]): Matrix4 {
  const out = new Vector3(...palm).normalize();
  return new Matrix4().compose(out.clone().multiplyScalar(tokens.placement.wristOffsetM), new Quaternion().setFromUnitVectors(new Vector3(0, 0, 1), out), new Vector3(1, 1, 1));
}
const followMatrix = new Matrix4();

const tipLocal = new Vector3();
const faceCentre = new Vector3();
const faceNormal = new Vector3();
const faceRotation = new Quaternion();

export class HandDock {
  readonly entity: Entity;
  private readonly document: UIKitDocument;
  private readonly buttons: DockButton[] = [];
  private readonly mount: HandDockMount;
  private readonly options: HandDockOptions;
  private readonly metresPerApx: number;
  /** The largest button's sizes: what the probe and `sizes` report. */
  private readonly largest: DockSize;
  /** Touch pointers seen in front of a glyph's face since their last commit. */
  private readonly armed = new Set<number>();
  private pressedUntilMs = 0;
  /** Phone only: the chip the row sits on, and where it stands. */
  private chip: InstanceType<typeof UIKit.Container> | null = null;
  private chipRect: ScreenRect | null = null;
  private readonly insets: SafeAreaInsets;
  private readonly bottomClearApx: number;
  /** A wrist space outside IWSDK's entity tree, whose pose the dock copies each frame. */
  private follows: Object3D | null = null;
  private readonly wristOffset: Matrix4 | null;

  constructor(world: World, mount: HandDockMount, actions: readonly DockAction[], options: HandDockOptions = {}) {
    this.mount = mount;
    this.options = options;
    const phone = mount.kind === "phone";
    const input = options.input ?? "poke";
    if (phone) {
      // A phone draws flat sizes in CSS pixels at the dock's depth.
      this.metresPerApx = (2 * PHONE_DOCK_DEPTH_M * Math.tan(mount.verticalFovRad / 2)) / mount.viewportHeightCss;
    } else {
      // A headset dock is read at arm's reach, drawn at 2.5×; hit areas are per input and never scaled.
      this.metresPerApx = apxToMeters(1, ARM_REACH_M, { headset: false });
    }
    // Record sits in the 36 apx ring; the other actions are 16 apx icons, each with its own hit area.
    const sizeOf = (drawnApx: number): DockSize => {
      if (phone) {
        const hitApx = Math.max(HIT.touch, drawnApx);
        return { glyphApx: drawnApx, hitApx, drawnSizeM: drawnApx * this.metresPerApx, hitSizeM: hitApx * this.metresPerApx };
      }
      const drawnSizeM = apxToMeters(drawnApx, ARM_REACH_M, { headset: true });
      const hitSizeM = hitAreaMeters(input, drawnApx * tokens.size.headsetScale, ARM_REACH_M, { headset: false });
      return { glyphApx: drawnSizeM / this.metresPerApx, hitApx: hitSizeM / this.metresPerApx, drawnSizeM, hitSizeM };
    };
    const ringed = actions.some((action) => action.glyph === "record");
    this.largest = sizeOf(ringed ? GLYPH.ring : GLYPH.icon);
    this.insets = phone ? readSafeAreaInsets() : { top: 0, right: 0, bottom: 0, left: 0 };
    // The row's bottom edge (the chip's) clears the home bar and the system's inset, plus a glyph gap (§6.1, §9.3).
    this.bottomClearApx = phoneClearance(this.insets).bottom + GLYPH.gap;

    const root = new UIKit.Container({
      pixelSize: this.metresPerApx,
      flexDirection: "row",
      alignItems: "center",
      gap: phone ? GLYPH.gap : glyphGapApx(input, { headset: true }),
      anchorX: "center",
      anchorY: phone ? "bottom" : "center",
      pointerEventsType: this.pointerFilter()
    });
    // A phone's row sits on its chip (§9.2): the Android AR chip, padded as a control row (§2.3).
    if (phone) {
      this.chip = new UIKit.Container({
        flexDirection: "row",
        alignItems: "center",
        gap: GLYPH.gap,
        paddingTop: CHIP.controlRowPaddingStart,
        paddingBottom: CHIP.controlRowPaddingStart,
        paddingLeft: CHIP.controlRowPaddingStart,
        paddingRight: CHIP.paddingInline,
        borderRadius: CHIP.radius,
        backgroundColor: withAlpha(COLOR.deepSea, CHIP_OPACITY.arAndroidChrome)
      });
      root.add(this.chip);
    }
    for (const action of actions) {
      const record = action.glyph === "record";
      const size = sizeOf(record ? GLYPH.ring : GLYPH.icon);
      const hit = new UIKit.Container({ width: size.hitApx, height: size.hitApx, alignItems: "center", justifyContent: "center" });
      const glyph = createGlyph(record ? "recordIdle" : (action.glyph as GlyphName), {
        size: size.glyphApx,
        color: COLOR.gold,
        // Record: rose shapes inside the gold ring, at the ring's full 16-unit box (§6).
        ...(record ? { ring: { innerSize: GLYPH.icon }, fill: COLOR.record } : {})
      });
      glyph.element.setProperties({ pointerEvents: "none" });
      hit.add(glyph.element);
      (this.chip ?? root).add(hit);
      const button: DockButton = { action, hit, size, shown: true, glyph, hovering: new Set(), near: new Set(), pressed: false, recording: false };
      this.bindPointer(button);
      this.buttons.push(button);
    }

    this.document = new UIKitDocument(root);
    this.entity = world.createTransformEntity(undefined, { parent: world.activeLevel.value });
    const object = this.entity.object3D!;
    object.name = "HandDock";
    // The dock and its chip are chrome (touches that begin on it never become marks), not the recorded scene.
    markChrome(object);
    object.add(this.document);
    this.entity.addComponent(RayInteractable);
    if (!phone) this.entity.addComponent(PokeInteractable);

    this.wristOffset = mount.kind === "hand" ? wristOffset(mount.palm) : null;
    if (mount.kind === "hand") {
      // IWSDK's TransformSystem moves an entity back under the level unless its
      // parent is an entity too, so a plain three space (capture's wrist) is
      // followed instead of parented.
      if ((mount.space as Object3D & { entityIdx?: number }).entityIdx !== undefined) {
        mount.space.add(object);
        this.wristOffset!.decompose(object.position, object.quaternion, object.scale);
      } else {
        this.follows = mount.space;
        this.follow();
      }
    } else {
      mount.camera.add(object);
      // Bottom centre, the chip's bottom edge above the home bar and safe area (§6.1, §9.3).
      const halfHeight = PHONE_DOCK_DEPTH_M * Math.tan(mount.verticalFovRad / 2);
      object.position.set(0, -halfHeight + this.bottomClearApx * this.metresPerApx, -PHONE_DOCK_DEPTH_M);
      this.fitChip();
    }
  }

  private bindPointer(button: DockButton): void {
    const { action, hit } = button;
    type DockPointerEvent = { pointerId: number; pointerType: string; pointerPosition: Vector3 };
    hit.addEventListener("pointerenter" as never, ((event: DockPointerEvent) => {
      // A touch pointer hovers from 20 cm away; it counts as near only within the poke's proximity.
      if (event.pointerType === "touch") return;
      button.hovering.add(event.pointerId);
      this.options.onHover?.(action, event.pointerId, true);
    }) as never);
    hit.addEventListener("pointerleave" as never, ((event: DockPointerEvent) => {
      button.near.delete(event.pointerId);
      button.pressed = false;
      if (event.pointerType === "touch" || !button.hovering.delete(event.pointerId)) return;
      this.options.onHover?.(action, event.pointerId, false);
    }) as never);
    hit.addEventListener("pointermove" as never, ((event: DockPointerEvent) => {
      if (event.pointerType !== "touch") return;
      // Armed only from in front of the face: a tip arriving from the side or behind never commits.
      const depth = this.depthInFront(hit, event.pointerPosition);
      if (depth > POKE.rearmM) this.armed.add(event.pointerId);
      if (depth <= POKE.proximityM && depth >= -POKE.throughM) button.near.add(event.pointerId);
      else button.near.delete(event.pointerId);
    }) as never);
    hit.addEventListener("pointerdown" as never, ((event: DockPointerEvent) => {
      button.pressed = true;
      if (event.pointerType !== "touch" || !this.armed.has(event.pointerId)) return;
      this.armed.delete(event.pointerId);
      this.commit(button, event.pointerId, "poke");
    }) as never);
    hit.addEventListener("pointerup" as never, (() => (button.pressed = false)) as never);
    hit.addEventListener("click" as never, ((event: DockPointerEvent) => {
      if (event.pointerType === "touch") return;
      this.commit(button, event.pointerId, "ray");
    }) as never);
  }

  private commit(button: DockButton, pointerId: number, kind: "poke" | "ray"): void {
    if (!button.shown || !this.isShown() || this.options.canCommit?.(button.action, pointerId) === false) return;
    this.pressedUntilMs = performance.now() + PRESSED_SHOW_MS;
    button.action.onSelect();
    this.options.onCommit?.(button.action, pointerId, kind);
  }

  /** How far a world point sits in front of a glyph's face, along its normal (metres; negative behind). */
  private depthInFront(hit: Object3D, point: Vector3): number {
    hit.getWorldPosition(faceCentre);
    faceNormal.set(0, 0, 1).applyQuaternion(hit.getWorldQuaternion(faceRotation));
    return tipLocal.copy(point).sub(faceCentre).dot(faceNormal);
  }

  /**
   * The other hand pokes or points at the dock; the hand it rides on never
   * does. Its touch pointer would otherwise hover the dock all the time, and
   * IWSDK prefers touch over grab, so that hand could never grab.
   */
  private pointerFilter(): (id: number, type: string) => boolean {
    const own = new Set(this.mount.kind === "hand" ? this.mount.ownPointerIds : []);
    return (id, type) => type !== "grab" && !own.has(id);
  }

  private isShown(): boolean {
    for (let node: Object3D | null = this.entity.object3D!; node; node = node.parent) if (!node.visible) return false;
    return true;
  }

  setVisible(visible: boolean): void {
    this.entity.object3D!.visible = visible;
  }

  /**
   * Shows or hides one action. On a phone the chip refits around the actions
   * showing, and the ring (Record) stays at the middle of the screen whatever
   * else shows, Recenter and Exit standing a glyph pitch either side of it (a
   * lone action is centred too).
   */
  setActionVisible(actionId: string, visible: boolean): void {
    const button = this.buttons.find((candidate) => candidate.action.id === actionId);
    if (!button || button.shown === visible) return;
    button.shown = visible;
    button.hit.setProperties({ display: visible ? "flex" : "none" });
    if (!visible) {
      button.hovering.clear();
      button.near.clear();
      button.pressed = false;
    }
    this.fitChip();
  }

  /** Phone only: the chip's width and the row's x on the screen, from the actions showing (all in apx; fixed sizes, so exact). */
  private fitChip(): void {
    if (this.mount.kind !== "phone" || !this.chip) return;
    const { viewportWidthCss: screenWidth, viewportHeightCss: screenHeight } = this.mount;
    const shown = this.buttons.filter((button) => button.shown);
    this.chip.setProperties({ display: shown.length > 0 ? "flex" : "none" });
    if (shown.length === 0) {
      this.chipRect = null;
      return;
    }
    const start = CHIP.controlRowPaddingStart;
    const height = Math.max(...shown.map((button) => button.size.hitApx)) + 2 * CHIP.controlRowPaddingStart;
    const width = start + shown.reduce((sum, button) => sum + button.size.hitApx, 0) + GLYPH.gap * (shown.length - 1) + CHIP.paddingInline;
    // Where the primary's centre falls along the chip: the ring (Record), else a lone action; with neither, the chip itself is centred.
    let offset = width / 2;
    let along = start;
    for (const button of shown) {
      if (button.action.glyph === "record" || shown.length === 1) offset = along + button.size.hitApx / 2;
      along += button.size.hitApx + GLYPH.gap;
    }
    // The root is centred on the dock's origin, so shifting it puts the ring on the screen's middle line.
    let shift = width / 2 - offset;
    // Never into a gesture zone or an inset at either side (§6.1); only a very narrow screen moves the ring.
    const clear = phoneClearance(this.insets).side;
    shift = Math.min(Math.max(shift, -(screenWidth / 2 - clear.left - width / 2)), screenWidth / 2 - clear.right - width / 2);
    this.entity.object3D!.position.x = shift * this.metresPerApx;
    this.chipRect = { left: screenWidth / 2 + shift - width / 2, top: screenHeight - this.bottomClearApx - height, width, height };
  }

  /** Record turns into Stop: the rose shape alone carries the state (§8.5). */
  setRecording(recording: boolean): void {
    for (const button of this.buttons) {
      if (button.action.glyph !== "record" || button.recording === recording) continue;
      button.recording = recording;
      button.glyph.setDrawing(recording ? "recordStop" : "recordIdle");
    }
    if (this.options.drawOverBody) drawOverBody(this.entity.object3D!);
  }

  /** Copies a followed wrist space's world pose, with the wrist offset, onto the dock. */
  follow(): void {
    if (!this.follows) return;
    const object = this.entity.object3D!;
    this.follows.updateWorldMatrix(true, false);
    followMatrix.multiplyMatrices(this.follows.matrixWorld, this.wristOffset!);
    if (object.parent) {
      object.parent.updateWorldMatrix(true, false);
      followMatrix.premultiply(object.parent.matrixWorld.clone().invert());
    }
    followMatrix.decompose(object.position, object.quaternion, object.scale);
    object.updateMatrixWorld(true);
  }

  /**
   * Hover (cream) when a pointer rests on a glyph or `approached` names it
   * (a fingertip near it); pressed (55%) while held and just after a commit.
   */
  update(approached: ReadonlySet<string> = NO_IDS): void {
    this.follow();
    const justCommitted = performance.now() < this.pressedUntilMs;
    for (const button of this.buttons) {
      const hovered = button.hovering.size > 0 || button.near.size > 0 || approached.has(button.action.id);
      button.glyph.setColor(hovered ? COLOR.highlight : COLOR.gold);
      button.glyph.setOpacity(button.pressed || justCommitted ? GLYPH.pressedOpacity : 1);
    }
    if (this.options.drawOverBody) drawOverBody(this.entity.object3D!);
  }

  /** The hit area of an action's glyph: its centre is the glyph's centre, its +Z the face's normal. */
  hitTarget(actionId: string): Object3D | null {
    return this.buttons.find((button) => button.action.id === actionId)?.hit ?? null;
  }

  /** Whether a pointer rests on an action's glyph. */
  isHoveredBy(actionId: string, pointerId: number): boolean {
    return this.buttons.find((button) => button.action.id === actionId)?.hovering.has(pointerId) ?? false;
  }

  get sizes(): { drawnSizeM: number; hitSizeM: number } {
    return { drawnSizeM: this.largest.drawnSizeM, hitSizeM: this.largest.hitSizeM };
  }

  probe(): HandDockProbe {
    const buttons: HandDockProbe["buttons"] = {};
    for (const button of this.buttons) {
      buttons[button.action.id] = {
        worldPosition: button.hit.getWorldPosition(new Vector3()).toArray() as [number, number, number],
        hovered: button.hovering.size > 0,
        recording: button.recording,
        shown: button.shown,
        glyphApx: button.size.glyphApx,
        hitApx: button.size.hitApx
      };
    }
    return {
      mount: this.mount.kind,
      input: this.mount.kind === "phone" ? "touch" : (this.options.input ?? "poke"),
      visible: this.isShown(),
      metresPerApx: this.metresPerApx,
      hitApx: this.largest.hitApx,
      glyphApx: this.largest.glyphApx,
      drawnSizeM: this.largest.drawnSizeM,
      hitSizeM: this.largest.hitSizeM,
      buttons,
      chip: this.chipRect && { ...this.chipRect },
      safeArea: this.mount.kind === "phone" ? { insets: this.insets, bottomClearApx: this.bottomClearApx } : null
    };
  }

  dispose(): void {
    for (const button of this.buttons) button.glyph.dispose();
    this.entity.object3D!.removeFromParent();
    this.document.dispose();
    this.entity.destroy();
  }
}

/** How long a committed glyph shows pressed (§6 states). */
const PRESSED_SHOW_MS = 120;
const NO_IDS: ReadonlySet<string> = new Set();
/** Above the scene and the avatar, below the aim rays. */
const OVER_BODY_ORDER = 990;

/**
 * Held on a controller, the wrist glyph sits inside the avatar's sleeve and
 * cuff, and depth testing hides it there (capture, measured in IWER). Nothing
 * else comes between the eye and a wrist at arm's reach, so the dock draws
 * over everything. Glyph drawings are rebuilt when Record turns into Stop,
 * so this runs after each change.
 */
function drawOverBody(root: Object3D): void {
  root.traverse((object) => {
    const mesh = object as Mesh;
    if (!mesh.isMesh) return;
    mesh.renderOrder = OVER_BODY_ORDER;
    for (const material of (Array.isArray(mesh.material) ? mesh.material : [mesh.material]) as Material[]) {
      material.depthTest = false;
      material.depthWrite = false;
    }
  });
}
