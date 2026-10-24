// The controls at a hologram's foot, on the chip (styleguide 1.2, 5.2, 9.2;
// brief Q11): Play, Free, Return and the timecode in a row, in the hologram's
// own space. They never follow the head. In AR every row sits on the chip; in
// VR the chip follows the background's request, with its fade and hold.
import { apxToMeters, tokens, type HitInput } from "@holoim/design-tokens";
import {
  controlRowPaddingApx,
  glyphGapApx,
  isHeadset,
  type ViewTarget
} from "@holoim/xr-ui-core";
import { finishChrome, ThreeChip, ThreeGlyph, ThreeMsdfLabel } from "@holoim/xr-ui-three";
import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useLayoutEffect, useMemo } from "react";
import type { Camera } from "three";
import { Group, Vector3 } from "three";

import {
  GlyphHit,
  nextBuildId,
  useLabelFont,
  useLatest,
  useStable,
  type GlyphSpec,
  type LabelFont
} from "./internal.js";

export type { GlyphSpec, LabelFont } from "./internal.js";

export interface HologramFootControlsProps {
  /** AR or VR: sets the chip, the sizes (a headset's 2.5×) and the text rules. Quick Look holds no controls (5.2). */
  target: ViewTarget;
  /** In order, left to right. `label` is each glyph's accessible name. */
  glyphs: readonly GlyphSpec[];
  /** The input pointing at them: sets every hit area (6.1). Default `ray`. */
  input?: HitInput;
  /** The viewing distance sizes are made for, metres. Default `tokens.placement.worldPanelDefaultM`. */
  distanceM?: number;
  /** The timecode after the glyphs, e.g. `pausedText(ms)`; hides within 1 m of the hologram in a headset (7.3). */
  text?: string;
  /** The atlas for the text; else the timecode role's is loaded. */
  font?: LabelFont;
  /** VR only: the background behind the row asks for the chip; fed to the fade-in and the 2 s hold each frame. */
  chipWanted?: boolean;
  /** Where the row sits in the hologram's space (its foot). */
  position?: readonly [number, number, number];
}

const head = new Vector3();
const labelAt = new Vector3();
const hologramAt = new Vector3();

interface FootRigOptions {
  target: ViewTarget;
  input: HitInput;
  distanceM: number;
  ids: readonly ThreeGlyph["id"][];
  font: LabelFont | null;
}

/** The three.js objects of one row: a chip, the glyphs on it and, after them, the timecode. */
class FootRig {
  readonly id = nextBuildId();
  /** In the hologram's space: mount it as a child of the hologram's group. */
  readonly root = new Group();
  readonly chip: ThreeChip;
  readonly glyphs: ThreeGlyph[];
  readonly label: ThreeMsdfLabel | null;
  private readonly gapM: number;
  private readonly padding: { top: number; bottom: number; start: number; end: number };
  private text = "";
  private farEnough = true;

  constructor({ target, input, distanceM, ids, font }: FootRigOptions) {
    const headset = isHeadset(target);
    // The core already scales gaps and padding for a headset, so convert flat.
    const metres = (apx: number) => apxToMeters(apx, distanceM, { headset: false });
    this.gapM = metres(glyphGapApx(input, { headset }));
    const padding = controlRowPaddingApx(target);
    this.padding = { top: metres(padding.top), bottom: metres(padding.bottom), start: metres(padding.start), end: metres(padding.end) };
    this.chip = new ThreeChip({ target, distanceM });
    this.root.add(this.chip.group);
    this.glyphs = ids.map((id) => new ThreeGlyph({ id, input, distanceM, headset }));
    for (const glyph of this.glyphs) this.root.add(glyph.group);
    this.label = font ? new ThreeMsdfLabel({ text: "", role: "timecode", headset, distanceM, font: font.font, texture: font.texture, anchor: "left" }) : null;
    if (this.label) this.root.add(this.label.group);
    this.root.name = "foot-controls";
    this.layout();
  }

  private labelShown(): boolean {
    return this.label !== null && this.text !== "" && this.farEnough;
  }

  /** Glyphs from hit area to hit area, so neighbours never overlap and keep the gap; then the text; the chip sized to the row. */
  private layout(): void {
    const { padding, gapM, label } = this;
    const showLabel = this.labelShown();
    const widths = this.glyphs.map((glyph) => glyph.hitSizeM);
    const glyphsWidth = widths.reduce((sum, width) => sum + width, 0) + gapM * Math.max(0, widths.length - 1);
    const labelWidth = showLabel && label ? label.widthM : 0;
    const rowWidth = glyphsWidth + (showLabel ? gapM + labelWidth : 0);
    const rowHeight = Math.max(0, ...widths, showLabel && label ? label.heightM : 0);
    const width = padding.start + rowWidth + padding.end;
    const height = padding.top + rowHeight + padding.bottom;
    // The chip adds its own (general) padding to the size it is given; the row wants the control row's.
    this.chip.setSize(width - 2 * this.chip.paddingInlineM, height - 2 * this.chip.paddingBlockM);
    this.chip.mesh.renderOrder = 10;
    let left = -width / 2 + padding.start;
    this.glyphs.forEach((glyph, index) => {
      const size = widths[index]!;
      // A hair in front of the chip.
      glyph.group.position.set(left + size / 2, 0, 0.001);
      left += size + gapM;
      glyph.setRenderOrder(11);
    });
    if (label) {
      label.group.position.set(left, 0, 0.001);
      label.group.visible = showLabel;
      label.mesh.renderOrder = 11;
    }
    finishChrome(this.root);
  }

  setText(text: string): void {
    this.text = text;
    this.label?.setText(text);
    this.layout();
  }

  setRecording(flags: readonly boolean[]): void {
    this.glyphs.forEach((glyph, index) => glyph.setRecording(flags[index] ?? false));
    this.layout();
  }

  /** One frame: the chip's fade, and the text's distance rule (7.3) from the camera. */
  update(camera: Camera, dtMs: number, chipWanted: boolean, target: ViewTarget): void {
    this.chip.update(dtMs, chipWanted);
    if (!this.label) return;
    camera.getWorldPosition(head);
    this.label.group.getWorldPosition(labelAt);
    (this.root.parent ?? this.root).getWorldPosition(hologramAt);
    const visible = this.label.updateVisibility(target, "timecode", { fromHeadM: head.distanceTo(labelAt), toHologramM: head.distanceTo(hologramAt) });
    const changed = visible !== this.farEnough;
    this.farEnough = visible;
    // The chip hugs what is shown, so it follows the text in and out.
    if (changed) this.layout();
    else this.label.group.visible = this.labelShown();
  }

  dispose(): void {
    this.chip.dispose();
    for (const glyph of this.glyphs) glyph.dispose();
    this.label?.dispose();
  }
}

function FootControls({
  target: targetProp,
  glyphs,
  input = "ray",
  distanceM = tokens.placement.worldPanelDefaultM,
  text,
  font,
  chipWanted = false,
  position
}: HologramFootControlsProps) {
  const target = useStable(targetProp);
  const ids = useStable(glyphs.map((glyph) => glyph.id));
  const atlas = useLabelFont(font, text !== undefined);
  const invalidate = useThree((state) => state.invalidate);
  const rig = useMemo(() => new FootRig({ target, input, distanceM, ids, font: atlas }), [target, input, distanceM, ids, atlas]);
  useEffect(() => () => rig.dispose(), [rig]);

  const recording = glyphs.map((glyph) => glyph.recording === true);
  const recordingKey = recording.join();
  useLayoutEffect(() => {
    rig.setRecording(recordingKey === "" ? [] : recordingKey.split(",").map((flag) => flag === "true"));
    invalidate();
  }, [rig, recordingKey, invalidate]);
  useLayoutEffect(() => {
    rig.setText(text ?? "");
    invalidate();
  }, [rig, text, invalidate]);

  const wanted = useLatest(chipWanted);
  useFrame((state, delta) => rig.update(state.camera, delta * 1000, wanted.current, target));

  return (
    <primitive key={rig.id} object={rig.root} {...(position ? { position } : {})}>
      {glyphs.map((spec, index) => {
        const glyph = rig.glyphs[index];
        return glyph ? <GlyphHit key={`${index}-${spec.id}`} glyph={glyph} label={spec.label} onSelect={spec.onSelect} /> : null;
      })}
    </primitive>
  );
}

/**
 * The row of controls at the hologram's foot (1.2): mount it as a child of the
 * hologram's own group so it lives in hologram space and never in head space.
 * Glyphs sit on the chip with the control row's padding; the timecode follows
 * them as a label and hides within 1 m of the hologram in a headset.
 */
export function HologramFootControls(props: HologramFootControlsProps) {
  if (props.target.kind === "quickLook") return null;
  return <FootControls {...props} />;
}
