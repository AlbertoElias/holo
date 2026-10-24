import { Follower, FollowBehavior, UIKit, UIKitDocument, type Entity, type World } from "@iwsdk/core";
import { Vector3, type Object3D } from "three";

import { CHIP, COLOR, HEADSET_SCALE, TYPE, metresPerApx, withAlpha } from "./tokens.js";

// The periphery status line (styleguide §1.2): the one thing that follows the
// head, lazily (IWSDK Follower), at the upper edge of view. It shows state
// such as "Recording 0:12" or "Paused · 0:08" and never holds a control: it
// is not interactable and takes no pointer events.

/** Ahead and up from the eyes: 1 m away or more, so its text is readable (§7.3). */
const OFFSET: [number, number, number] = [0, 0.32, -1.4];
const DISTANCE_M = Math.hypot(OFFSET[1], OFFSET[2]);

export interface StatusLineProbe {
  visible: boolean;
  text: string;
  worldPosition: [number, number, number];
  interactive: boolean;
}

export class StatusLine {
  readonly entity: Entity;
  private readonly document: UIKitDocument;
  private readonly root: InstanceType<typeof UIKit.Container>;
  private readonly prefix: InstanceType<typeof UIKit.Text>;
  private readonly separator: InstanceType<typeof UIKit.Container>;
  private readonly body: InstanceType<typeof UIKit.Text>;
  private current = "";

  constructor(world: World, head: Object3D, chipOpacity: number) {
    const s = HEADSET_SCALE;
    const text = (): InstanceType<typeof UIKit.Text> =>
      new UIKit.Text({ text: "", fontSize: TYPE.timecode.size * s, fontWeight: TYPE.timecode.weight, color: COLOR.textMuted, pointerEvents: "none" });
    this.root = new UIKit.Container({
      pixelSize: metresPerApx(DISTANCE_M),
      flexDirection: "row",
      alignItems: "center",
      gap: 4 * s,
      paddingTop: CHIP.paddingBlock * s,
      paddingBottom: CHIP.paddingBlock * s,
      paddingLeft: CHIP.paddingInline * s,
      paddingRight: CHIP.paddingInline * s,
      borderRadius: CHIP.radius * s,
      backgroundColor: withAlpha(COLOR.deepSea, chipOpacity),
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
    this.entity.addComponent(Follower, { target: head, offsetPosition: OFFSET, behavior: FollowBehavior.FaceTarget });
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
