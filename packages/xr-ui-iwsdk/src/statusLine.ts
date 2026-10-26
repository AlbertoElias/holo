import { tokens } from "@holoim/design-tokens";
import { markChrome, startLazyFollow, stepLazyFollow, type LazyFollow } from "@holoim/xr-ui-core";
import { RayInteractable, UIKit, UIKitDocument, type Entity, type World } from "@iwsdk/core";
import { Euler, MathUtils, Quaternion, Vector3, type Object3D } from "three";

import { FONT_FAMILIES, FONT_FAMILY } from "./fonts.js";
import { PHONE_DOCK_DEPTH_M, type ScreenRect } from "./handDock.js";
import { phoneClearance, readSafeAreaInsets } from "./safeArea.js";
import { CHIP, CHIP_OPACITY, COLOR, GLYPH, HEADSET_SCALE, TYPE, metresPerApx, withAlpha } from "./tokens.js";

// The periphery status line (styleguide §1.2): the one thing that follows the
// head, lazily, at the upper edge of view: 1.5 m away, 20° above the line of
// sight, staying put until the head turns more than 20° from it, then easing
// back (240 ms) until it is within 1° (`stepLazyFollow`). It shows state such
// as "Recording 0:12" or "Paused · 0:08", bare in both apps (the user,
// 2026-10-25), and never holds a control: a headset's line takes no pointer
// events, and a phone's chip takes them only to shield the scene behind it.
//
// On a phone the line is a screen's top status line instead (§1.2, §9.2): at
// the top centre, inside the top safe area, hung on the camera like the bottom
// dock, in flat CSS-pixel sizes and on the Android AR chip, since over the
// camera image every label sits on the chip. The 20°, 1.5 m and lazy-follow
// values are a headset's spatial placement and play no part there.

const DISTANCE_M = tokens.placement.statusLine.distanceM;

export interface StatusLineProbe {
  visible: boolean;
  text: string;
  worldPosition: [number, number, number];
  interactive: boolean;
  /** Phone only: the chip's rectangle on the screen, once laid out (CSS px from the top left). */
  chip: ScreenRect | null;
}

export interface StatusLineOptions {
  /** The camera's view and the screen, to stand the line on a phone's top centre. */
  phone?: { verticalFovRad: number; viewportHeightCss: number; viewportWidthCss: number };
}

const headPosition = new Vector3();
const headQuaternion = new Quaternion();
const headScale = new Vector3();
const headEuler = new Euler();
const direction = new Vector3();

export class StatusLine {
  readonly entity: Entity;
  private readonly document: UIKitDocument;
  private readonly root: InstanceType<typeof UIKit.Container>;
  private readonly prefix: InstanceType<typeof UIKit.Text>;
  private readonly separator: InstanceType<typeof UIKit.Container>;
  private readonly body: InstanceType<typeof UIKit.Text>;
  private current = "";
  private follow: LazyFollow | null = null;

  private readonly phone: StatusLineOptions["phone"];
  private readonly metresPerApx: number;
  private readonly topApx: number;

  constructor(world: World, private readonly head: Object3D, options: StatusLineOptions = {}) {
    this.phone = options.phone;
    const phone = this.phone;
    // A phone shows flat sizes in CSS pixels of the camera image; a headset's line is read at 1.5 m.
    const s = phone ? 1 : HEADSET_SCALE;
    this.metresPerApx = phone ? (2 * PHONE_DOCK_DEPTH_M * Math.tan(phone.verticalFovRad / 2)) / phone.viewportHeightCss : metresPerApx(DISTANCE_M);
    this.topApx = phone ? phoneClearance(readSafeAreaInsets()).top + GLYPH.gap : 0;
    const text = (): InstanceType<typeof UIKit.Text> =>
      new UIKit.Text({ text: "", fontSize: TYPE.timecode.size * s, fontWeight: TYPE.timecode.weight, color: COLOR.textMuted, wordBreak: "keep-all", flexShrink: 0, pointerEvents: "none" });
    this.root = new UIKit.Container({
      pixelSize: this.metresPerApx,
      fontFamilies: FONT_FAMILIES,
      fontFamily: FONT_FAMILY,
      flexDirection: "row",
      alignItems: "center",
      gap: 4 * s,
      // A headset's line is never hit. A phone's chip is a shield: a finger that goes down on it hits chrome and does nothing,
      // so a hold that begins there cannot mark the scene behind it (`ScreenInputSystem` reads `beganOnChrome` from the hit).
      pointerEvents: phone ? "auto" : "none",
      ...(phone
        ? {
            anchorX: "center" as const,
            anchorY: "top" as const,
            paddingTop: CHIP.paddingBlock,
            paddingBottom: CHIP.paddingBlock,
            paddingLeft: CHIP.paddingInline,
            paddingRight: CHIP.paddingInline,
            borderRadius: CHIP.radius,
            backgroundColor: withAlpha(COLOR.deepSea, CHIP_OPACITY.arAndroidChrome)
          }
        : {})
    });
    this.prefix = text();
    this.separator = new UIKit.Container({ width: 3 * s, height: 3 * s, borderRadius: 1.5 * s, backgroundColor: COLOR.textMuted });
    this.body = text();
    this.root.add(this.prefix, this.separator, this.body);
    this.document = new UIKitDocument(this.root);
    this.entity = world.createTransformEntity(undefined, { parent: world.activeLevel.value });
    this.entity.object3D!.name = "StatusLine";
    markChrome(this.entity.object3D!);
    this.entity.object3D!.add(this.document);
    this.entity.object3D!.visible = false;
    if (phone) {
      // Top centre, inside the top safe area, on the camera (the one thing besides the dock that rides the screen).
      head.add(this.entity.object3D!);
      // Hit by the screen pointer, which visits only interactables (a headset's line stays out of it).
      this.entity.addComponent(RayInteractable);
      const halfHeight = PHONE_DOCK_DEPTH_M * Math.tan(phone.verticalFovRad / 2);
      this.entity.object3D!.position.set(0, halfHeight - this.topApx * this.metresPerApx, -PHONE_DOCK_DEPTH_M);
    }
  }

  /** Shows "prefix · body", or hides the line when there is nothing to report. */
  set(state: { prefix: string | null; body: string } | null): void {
    const text = state ? (state.prefix ? `${state.prefix} · ${state.body}` : state.body) : "";
    this.entity.object3D!.visible = Boolean(state);
    if (text === this.current || !state) return;
    this.current = text;
    this.prefix.setProperties({ text: state.prefix ?? "", display: state.prefix ? "flex" : "none" });
    this.separator.setProperties({ display: state.prefix ? "flex" : "none" });
    this.body.setProperties({ text: state.body });
  }

  /** One frame of the lazy follow, in world space around the head, facing it. */
  update(dtMs: number): void {
    // A phone's line is fixed on the screen: nothing to follow.
    if (this.phone) return;
    this.head.updateWorldMatrix(true, false);
    this.head.matrixWorld.decompose(headPosition, headQuaternion, headScale);
    headEuler.setFromQuaternion(headQuaternion, "YXZ");
    const yaw = MathUtils.radToDeg(headEuler.y);
    const pitch = MathUtils.radToDeg(headEuler.x);
    this.follow = this.follow === null ? startLazyFollow(yaw, pitch) : stepLazyFollow(this.follow, yaw, pitch, dtMs);
    const yawRad = MathUtils.degToRad(this.follow.yaw);
    const pitchRad = MathUtils.degToRad(this.follow.pitch);
    direction.set(-Math.sin(yawRad) * Math.cos(pitchRad), Math.sin(pitchRad), -Math.cos(yawRad) * Math.cos(pitchRad));
    const object = this.entity.object3D!;
    const world = headPosition.addScaledVector(direction, DISTANCE_M);
    object.parent?.updateWorldMatrix(true, false);
    object.position.copy(object.parent ? object.parent.worldToLocal(world) : world);
    this.head.getWorldPosition(headPosition);
    object.lookAt(headPosition);
  }

  /** Starts the follow afresh, straight ahead of the head (a new session). */
  reset(): void {
    this.follow = null;
  }

  probe(): StatusLineProbe {
    const object = this.entity.object3D!;
    return {
      visible: object.visible,
      text: object.visible ? this.current : "",
      worldPosition: object.getWorldPosition(new Vector3()).toArray() as [number, number, number],
      interactive: false,
      chip: this.phone ? this.chipRect() : null
    };
  }

  /** The laid-out chip on the screen (CSS px = apx on a phone), null until UIKit has measured it. */
  private chipRect(): ScreenRect | null {
    const phone = this.phone!;
    const size = this.root.size.value;
    if (!size || !(size[0]! > 0) || !(size[1]! > 0)) return null;
    return { left: (phone.viewportWidthCss - size[0]!) / 2, top: this.topApx, width: size[0]!, height: size[1]! };
  }

  dispose(): void {
    this.entity.object3D!.removeFromParent();
    this.document.dispose();
    this.entity.destroy();
  }
}
