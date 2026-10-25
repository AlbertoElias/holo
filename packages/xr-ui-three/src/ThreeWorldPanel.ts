// The world panel (styleguide 1.2, 9.1): lists and settings in a headset, on
// a chip, at least 1 m away, opened straight ahead and then left in the
// world. It never follows the head; only the periphery status line does.
import { VIEW_TARGETS, worldPanelDistanceM, type ViewTarget } from "@holoim/xr-ui-core";
import { Group, Quaternion, Vector3, type Object3D } from "three";

import { finishChrome } from "./chrome.js";
import { ThreeChip } from "./ThreeChip.js";
import type { ThreeMsdfLabel } from "./ThreeMsdfLabel.js";

export interface ThreeWorldPanelOptions {
  /** Default VR. */
  target?: ViewTarget;
  /**
   * Where it will open; never under 1 m. The chip's padding and the rows'
   * labels are sized for `distanceM`, so build them at it; `place` with a
   * different distance only moves the panel.
   */
  requestedM?: number;
}

const headPosition = new Vector3();
const headQuaternion = new Quaternion();
const headScale = new Vector3();
const forward = new Vector3();

export class ThreeWorldPanel {
  /** Add this to the scene root: `place` puts it in world space once. */
  readonly group = new Group();
  readonly chip: ThreeChip;
  readonly target: ViewTarget;
  /** Distance from the head when placed, metres: `worldPanelDistanceM(requested)`. */
  distanceM: number;
  readonly rows: ThreeMsdfLabel[] = [];

  constructor({ target = VIEW_TARGETS.vr, requestedM }: ThreeWorldPanelOptions = {}) {
    this.target = target;
    this.distanceM = worldPanelDistanceM(requestedM);
    // A panel is a container for text: the chip is present from the start and stays.
    this.chip = new ThreeChip({ target, distanceM: this.distanceM, fade: false });
    this.group.name = "world-panel";
    this.group.add(this.chip.group);
    this.layout();
  }

  /** Adds a row below the last; rows are laid out top-down inside the chip's padding. */
  addRow(label: ThreeMsdfLabel): void {
    this.rows.push(label);
    this.group.add(label.group);
    this.layout();
  }

  /** Lays the rows out again; call after a row's text changes. */
  layout(): void {
    const contentWidth = this.rows.reduce((widest, row) => Math.max(widest, row.widthM), 0);
    const contentHeight = this.rows.reduce((sum, row) => sum + row.heightM, 0);
    this.chip.setSize(contentWidth, contentHeight);
    this.chip.mesh.renderOrder = 10;
    let top = contentHeight / 2;
    for (const row of this.rows) {
      const x = row.anchor === "left" ? -contentWidth / 2 : row.anchor === "right" ? contentWidth / 2 : 0;
      row.group.position.set(x, top - row.heightM / 2, 0.001);
      row.mesh.renderOrder = 11;
      top -= row.heightM;
    }
    finishChrome(this.group);
  }

  /**
   * Opens straight ahead of the head at `worldPanelDistanceM(requestedM)`
   * (never under 1 m), facing it. After this it stays where it is.
   */
  place(head: Object3D, requestedM?: number): void {
    this.distanceM = worldPanelDistanceM(requestedM ?? this.distanceM);
    head.updateWorldMatrix(true, false);
    head.matrixWorld.decompose(headPosition, headQuaternion, headScale);
    forward.set(0, 0, -1).applyQuaternion(headQuaternion);
    this.group.position.copy(headPosition).addScaledVector(forward, this.distanceM);
    this.group.lookAt(headPosition);
    for (const row of this.rows) row.updateVisibility(this.target, "label", { fromHeadM: this.distanceM });
  }

  dispose(): void {
    this.chip.dispose();
  }
}
