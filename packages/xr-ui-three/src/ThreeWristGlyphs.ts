// The non-dominant wrist's row of glyphs (styleguide 9.1; brief Q11): the
// actions of a headset, on the back of the wrist so they are reachable before
// placement and with the hologram out of view. Glyphs only, no text, sized
// for a headset at arm's reach.
import { apxToMeters, tokens, type HitInput } from "@holoim/design-tokens";
import { glyphGapApx, nonDominantHand, type GlyphId, type Hand, type Handedness } from "@holoim/xr-ui-core";
import { Group, Quaternion, Vector3, type Object3D } from "three";

import { finishChrome } from "./chrome.js";
import { ThreeGlyph } from "./ThreeGlyph.js";

export interface ThreeWristGlyphsOptions {
  handedness: Handedness;
  /** null draws an empty ring, for an action with no drawing yet. */
  glyphs: readonly (GlyphId | null)[];
  /** "poke" for tracked hands, "ray" for controllers: sets every hit area. */
  input: Extract<HitInput, "poke" | "ray">;
}

const worldPosition = new Vector3();
const worldQuaternion = new Quaternion();
const worldScale = new Vector3();
const toBack = new Vector3();

export class ThreeWristGlyphs {
  /** Add this to the scene root: `update` places it in world space beside the wrist. */
  readonly group = new Group();
  /** The glyphs lie on this child, turned so their faces look along the wrist's +Y (out of the back of the wrist). */
  readonly row = new Group();
  /** The non-dominant hand: the one that carries the row. */
  readonly hand: Hand;
  readonly input: HitInput;
  readonly glyphs: ThreeGlyph[];
  /** Space between neighbouring hit areas, metres: the glyph gap at arm's reach. */
  readonly gapM: number;

  constructor({ handedness, glyphs, input }: ThreeWristGlyphsOptions) {
    this.hand = nonDominantHand(handedness);
    this.input = input;
    const distanceM = tokens.placement.armReachM;
    // `glyphGapApx` already carries the headset factor, so convert flat.
    this.gapM = apxToMeters(glyphGapApx(input, { headset: true }), distanceM, { headset: false });
    this.glyphs = glyphs.map((id) => new ThreeGlyph({ id, input, distanceM, headset: true }));
    // Centres are spaced from hit area to hit area, so neighbours never overlap and keep the gap.
    const widths = this.glyphs.map((glyph) => glyph.hitSizeM);
    const total = widths.reduce((sum, width) => sum + width, 0) + this.gapM * Math.max(0, widths.length - 1);
    let left = -total / 2;
    this.glyphs.forEach((glyph, index) => {
      const width = widths[index]!;
      glyph.group.position.set(left + width / 2, 0, 0);
      this.row.add(glyph.group);
      left += width + this.gapM;
    });
    this.row.rotation.x = -Math.PI / 2;
    this.row.name = "wrist-row";
    this.group.name = `wrist-glyphs-${this.hand}`;
    this.group.add(this.row);
    finishChrome(this.group);
  }

  glyph(id: GlyphId): ThreeGlyph | undefined {
    return this.glyphs.find((candidate) => candidate.id === id);
  }

  /** Record turns into Stop: the rose shape alone carries the state (8.5); no text within arm's reach. */
  setRecording(recording: boolean): void {
    this.glyph("record")?.setRecording(recording);
    finishChrome(this.group);
  }

  /** Follows the wrist: 4 cm out of its back (local +Y), with its orientation. The wrist is a joint or controller; the row is world-space. */
  update(wrist: Object3D): void {
    wrist.updateWorldMatrix(true, false);
    wrist.matrixWorld.decompose(worldPosition, worldQuaternion, worldScale);
    toBack.set(0, tokens.placement.wristOffsetM, 0).applyQuaternion(worldQuaternion);
    this.group.position.copy(worldPosition).add(toBack);
    this.group.quaternion.copy(worldQuaternion);
  }

  dispose(): void {
    for (const glyph of this.glyphs) glyph.dispose();
  }
}
