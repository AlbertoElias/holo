// The Halo in 3D (brief Q20, Q21; design-language concept 4): one radial menu
// with eight directions that never change. A novice holds and the ring draws
// after the hold delay; an expert flicks and nothing ever draws. Sizes are the
// headset's, from `haloLayout`, in metres at a distance.
import { apxToMeters, tokens, type HitInput } from "@holoim/design-tokens";
import {
  HALO_CLOSED,
  haloLayout,
  haloSlotGlyph,
  stepHalo,
  type HaloAction,
  type HaloDirection,
  type HaloEvent,
  type HaloLayout,
  type HaloState,
  type HaloStep
} from "@holoim/xr-ui-core";
import { Group, Mesh, RingGeometry, Vector3, type MeshBasicMaterial } from "three";

import { createChromeMaterial, finishChrome } from "./chrome.js";
import { ThreeGlyph } from "./ThreeGlyph.js";

export interface ThreeHaloOptions {
  /** The actions this app has (`CAPTURE_HALO_ACTIONS`); other directions stay reserved and empty. */
  actions: readonly HaloAction[];
  distanceM: number;
  /** The input pointing at the slots: sets their hit areas. Default `ray`. */
  input?: HitInput;
}

/** A direction that has an action: its glyph (Record, Undo, Redo) or an empty gold ring until its drawing is decided. */
export interface HaloSlotObject {
  direction: HaloDirection;
  action: HaloAction;
  glyph: ThreeGlyph;
  /** The slot's invisible hit square. */
  hitTarget: Mesh;
  hitSizeM: number;
}

const RING_SEGMENTS = 96;

export class ThreeHalo {
  readonly group = new Group();
  readonly layout: HaloLayout;
  readonly distanceM: number;
  readonly input: HitInput;
  /** The thin gold ring at the slot radius; drawn only while the Halo is held past the delay. */
  readonly ring: Mesh;
  private readonly slotsGroup = new Group();
  private readonly objects = new Map<HaloDirection, HaloSlotObject>();
  private state: HaloState = HALO_CLOSED;
  private highlighted: HaloDirection | null = null;

  constructor({ actions, distanceM, input = "ray" }: ThreeHaloOptions) {
    this.distanceM = distanceM;
    this.input = input;
    this.layout = haloLayout(actions, { headset: true });
    // `haloLayout` already carries the headset factor, so convert flat.
    const radiusM = this.metres(this.layout.radiusApx);
    const strokeM = apxToMeters(tokens.glyph.stroke, distanceM, { headset: true });
    this.ring = new Mesh(new RingGeometry(radiusM - strokeM / 2, radiusM + strokeM / 2, RING_SEGMENTS), createChromeMaterial({ color: tokens.glyph.color }));
    this.ring.name = "halo-ring";
    this.group.add(this.ring);
    this.group.add(this.slotsGroup);
    for (const slot of this.layout.slots) {
      if (slot.action === null) continue;
      const glyph = new ThreeGlyph({ id: slot.action === "record" ? "record" : haloSlotGlyph(slot.action), input, distanceM, headset: true, ringed: true });
      glyph.group.position.set(this.metres(slot.x), this.metres(slot.y), 0);
      this.slotsGroup.add(glyph.group);
      this.objects.set(slot.direction, { direction: slot.direction, action: slot.action, glyph, hitTarget: glyph.hitTarget, hitSizeM: glyph.hitSizeM });
    }
    this.group.name = "halo";
    this.setDrawn(false);
    finishChrome(this.group);
  }

  private metres(apx: number): number {
    return apxToMeters(apx, this.distanceM, { headset: false });
  }

  /** Converts a movement in metres (y up) to the layout's apx, for `HaloEvent`s. */
  apxFromMetres(metres: number): number {
    return metres / (tokens.size.radiansPerApx * this.distanceM);
  }

  /** The centre of a direction's slot, metres from the Halo's centre, y up; defined for empty directions too. */
  slotPositionM(direction: HaloDirection): Vector3 {
    const slot = this.layout.slots.find((candidate) => candidate.direction === direction)!;
    return new Vector3(this.metres(slot.x), this.metres(slot.y), 0);
  }

  /** The object in a direction; undefined where the direction is empty (nothing is drawn there). */
  slotObject(direction: HaloDirection): HaloSlotObject | undefined {
    return this.objects.get(direction);
  }

  /** Whether the ring and slots are drawn. */
  get drawn(): boolean {
    return this.ring.visible;
  }

  /** One event of the hold: draws the ring after the delay, highlights the slot the movement points at, never draws for a flick. */
  handle(event: HaloEvent): HaloStep {
    const step = stepHalo(this.state, event, this.layout);
    this.state = step.state;
    this.setDrawn(step.ringDrawn);
    const highlighted = step.ringDrawn ? step.highlighted : null;
    if (highlighted !== this.highlighted) {
      if (this.highlighted) this.objects.get(this.highlighted)?.glyph.setState({});
      if (highlighted) this.objects.get(highlighted)?.glyph.setState({ hovered: true });
      this.highlighted = highlighted;
    }
    return step;
  }

  private setDrawn(drawn: boolean): void {
    this.ring.visible = drawn;
    this.slotsGroup.visible = drawn;
  }

  dispose(): void {
    this.ring.geometry.dispose();
    (this.ring.material as MeshBasicMaterial).dispose();
    for (const object of this.objects.values()) object.glyph.dispose();
  }
}
