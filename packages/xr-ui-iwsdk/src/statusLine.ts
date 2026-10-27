import { tokens } from "@holoim/design-tokens";
import { startLazyFollow, stepLazyFollow, type LazyFollow } from "@holoim/xr-ui-core";
import { UIKit, UIKitDocument, type Entity, type World } from "@iwsdk/core";
import { Euler, MathUtils, Quaternion, Vector3, type Object3D } from "three";

import { FONT_FAMILIES, FONT_FAMILY } from "./fonts.js";
import { COLOR, HEADSET_SCALE, TYPE, metresPerApx } from "./tokens.js";

// The periphery status line (styleguide §1.2): the one thing that follows the
// head, lazily, at the upper edge of view: 1.5 m away, 20° above the line of
// sight, staying put until the head turns more than 20° from it, then easing
// back (240 ms) until it is within 1° (`stepLazyFollow`). It shows state such
// as "Recording 0:12" or "Paused · 0:08", bare in both apps (the user,
// 2026-10-25), and never holds a control: it takes no pointer events.

const DISTANCE_M = tokens.placement.statusLine.distanceM;

export interface StatusLineProbe {
  visible: boolean;
  text: string;
  worldPosition: [number, number, number];
  interactive: boolean;
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

  constructor(world: World, private readonly head: Object3D) {
    const s = HEADSET_SCALE;
    const text = (): InstanceType<typeof UIKit.Text> =>
      new UIKit.Text({ text: "", fontSize: TYPE.timecode.size * s, fontWeight: TYPE.timecode.weight, color: COLOR.textMuted, wordBreak: "keep-all", flexShrink: 0, pointerEvents: "none" });
    this.root = new UIKit.Container({
      pixelSize: metresPerApx(DISTANCE_M),
      fontFamilies: FONT_FAMILIES,
      fontFamily: FONT_FAMILY,
      flexDirection: "row",
      alignItems: "center",
      gap: 4 * s,
      pointerEvents: "none"
    });
    this.prefix = text();
    this.separator = new UIKit.Container({ width: 3 * s, height: 3 * s, borderRadius: 1.5 * s, backgroundColor: COLOR.textMuted });
    this.body = text();
    this.root.add(this.prefix, this.separator, this.body);
    this.document = new UIKitDocument(this.root);
    this.entity = world.createTransformEntity(undefined, { parent: world.activeLevel.value });
    this.entity.object3D!.name = "StatusLine";
    this.entity.object3D!.add(this.document);
    this.entity.object3D!.visible = false;
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
      interactive: false
    };
  }

  dispose(): void {
    this.document.dispose();
    this.entity.destroy();
  }
}
