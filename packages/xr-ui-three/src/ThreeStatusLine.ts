// The periphery status line (styleguide 1.2, 8.5, 9.1): state only, never a
// control, and the one thing in a headset that follows the head. It stays put
// until the head turns more than 20 degrees away, then eases back; in VR it
// sits on the chip when the background asks for it, in AR always on the chip.
import { tokens } from "@holoim/design-tokens";
import {
  isHeadset,
  startLazyFollow,
  stepLazyFollow,
  VIEW_TARGETS,
  type LazyFollow,
  type ViewTarget
} from "@holoim/xr-ui-core";
import type { BmFont } from "@holoim/design-tokens/msdf";
import { Euler, Group, MathUtils, Quaternion, Vector3, type Camera, type Texture } from "three";

import { finishChrome } from "./chrome.js";
import { ThreeChip } from "./ThreeChip.js";
import { loadLabelAtlas, ThreeMsdfLabel } from "./ThreeMsdfLabel.js";

export interface ThreeStatusLineOptions {
  text?: string;
  font: BmFont;
  texture: Texture | null;
  /** Build the chip (VR when the background wants it; AR always). Without it the text sits bare. */
  chip: boolean;
  /** A headset target: default VR. */
  target?: ViewTarget;
}

const headEuler = new Euler(0, 0, 0, "YXZ");
const headQuaternion = new Quaternion();
const headPosition = new Vector3();
const direction = new Vector3();

export class ThreeStatusLine {
  /** Add this to the scene root: `update` places it in world space around the camera. */
  readonly group = new Group();
  /** The one object that follows the head (placement contract); state only, never a control. */
  readonly followsHead = true;
  readonly label: ThreeMsdfLabel;
  readonly chip: ThreeChip | null;
  readonly distanceM = tokens.placement.statusLine.distanceM;
  readonly target: ViewTarget;
  private follow: LazyFollow | null = null;

  constructor({ text = "", font, texture, chip, target = VIEW_TARGETS.vr }: ThreeStatusLineOptions) {
    if (!isHeadset(target)) throw new RangeError("ThreeStatusLine: the status line is a headset's; flat screens show the timecode slot");
    this.target = target;
    this.label = new ThreeMsdfLabel({ text, role: "timecode", headset: true, distanceM: this.distanceM, font, texture, anchor: "center" });
    this.label.updateVisibility(target, "status", { fromHeadM: this.distanceM });
    this.chip = chip ? new ThreeChip({ target, distanceM: this.distanceM }) : null;
    if (this.chip) {
      this.chip.mesh.renderOrder = 10;
      this.group.add(this.chip.group);
    }
    this.label.mesh.renderOrder = 11;
    // A hair in front of the chip.
    this.label.group.position.z = 0.001;
    this.group.add(this.label.group);
    this.group.name = "status-line";
    this.fitChip();
    finishChrome(this.group);
  }

  /** Loads the timecode role's atlas and builds the line. */
  static async load(options: Omit<ThreeStatusLineOptions, "font" | "texture">): Promise<ThreeStatusLine> {
    const { font, texture } = await loadLabelAtlas("timecode");
    return new ThreeStatusLine({ ...options, font, texture });
  }

  /** e.g. `recordingText(ms)`: "Recording 0:12". */
  setText(text: string): void {
    this.label.setText(text);
    this.fitChip();
  }

  private fitChip(): void {
    this.chip?.setSize(this.label.widthM, this.label.heightM);
    finishChrome(this.group);
  }

  /** The line's place: yaw and pitch of the head, degrees. */
  get state(): LazyFollow | null {
    return this.follow;
  }

  /**
   * One frame: reads the camera's yaw and pitch, eases the line toward it
   * when the head has turned beyond 20 degrees, and puts the line at that yaw
   * and pitch around the camera, facing it. `chipWanted`: the background asks
   * for the chip (VR; AR keeps it).
   */
  update(camera: Camera, dtMs: number, chipWanted = this.target.kind !== "vr"): void {
    camera.updateWorldMatrix(true, false);
    camera.matrixWorld.decompose(headPosition, headQuaternion, direction);
    headEuler.setFromQuaternion(headQuaternion, "YXZ");
    const yaw = MathUtils.radToDeg(headEuler.y);
    const pitch = MathUtils.radToDeg(headEuler.x);
    this.follow = this.follow === null ? startLazyFollow(yaw, pitch) : stepLazyFollow(this.follow, yaw, pitch, dtMs);
    const yawRad = MathUtils.degToRad(this.follow.yaw);
    const pitchRad = MathUtils.degToRad(this.follow.pitch);
    direction.set(-Math.sin(yawRad) * Math.cos(pitchRad), Math.sin(pitchRad), -Math.cos(yawRad) * Math.cos(pitchRad));
    this.group.position.copy(headPosition).addScaledVector(direction, this.distanceM);
    this.group.lookAt(headPosition);
    this.chip?.update(dtMs, chipWanted);
  }

  dispose(): void {
    this.label.dispose();
    this.chip?.dispose();
  }
}
