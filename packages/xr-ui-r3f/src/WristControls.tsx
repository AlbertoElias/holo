// The non-dominant wrist's row of glyphs (styleguide 1.2, 9.1; brief Q11): the
// headset's actions, reachable before placement and with the hologram out of
// view. Glyphs only, no text, sized for arm's reach. Exit AR and the placing
// hint on Quest live here.
import type { HitInput } from "@holoim/design-tokens";
import type { Hand, Handedness } from "@holoim/xr-ui-core";
import { ThreeWristGlyphs } from "@holoim/xr-ui-three";
import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useLayoutEffect, useMemo } from "react";
import type { Object3D } from "three";

import { GlyphHit, setHitEnabled, useLatest, useStable, type GlyphSpec } from "./internal.js";

export interface WristControlsProps {
  /** The dominant hand, from the setting; the row sits on the other one. */
  handedness: Handedness;
  /** In order along the wrist. `label` is each glyph's accessible name. */
  glyphs: readonly GlyphSpec[];
  /** "poke" for tracked hands, "ray" for controllers: sets every hit area (6.1). */
  input: Extract<HitInput, "poke" | "ray">;
  /** The non-dominant wrist joint or grip space, or null while it is not tracked (the row hides). */
  wrist: Object3D | null;
  /** The hand that carries the row, so the app can hold its other hand-bound things to the same setting. */
  onHand?: (hand: Hand) => void;
}

/**
 * Mount this at the scene root: the row's group is in world space and
 * follows `wrist` frame by frame. It is hidden, and its hit areas off, while
 * `wrist` is null.
 */
export function WristControls({ handedness, glyphs, input, wrist, onHand }: WristControlsProps) {
  const ids = useStable(glyphs.map((glyph) => glyph.id));
  const invalidate = useThree((state) => state.invalidate);
  const row = useMemo(() => new ThreeWristGlyphs({ handedness, glyphs: ids, input }), [handedness, ids, input]);
  useEffect(() => () => row.dispose(), [row]);

  const hand = row.hand;
  const latestOnHand = useLatest(onHand);
  useEffect(() => {
    latestOnHand.current?.(hand);
  }, [hand, latestOnHand]);

  const recording = glyphs.some((glyph) => glyph.id === "record" && glyph.recording === true);
  useLayoutEffect(() => {
    row.setRecording(recording);
    invalidate();
  }, [row, recording, invalidate]);

  // Placed the moment the wrist appears, not a frame later at the origin.
  useLayoutEffect(() => {
    row.group.visible = wrist !== null;
    for (const glyph of row.glyphs) setHitEnabled(glyph.hitTarget, wrist !== null);
    if (wrist) row.update(wrist);
    invalidate();
  }, [row, wrist, invalidate]);

  const current = useLatest(wrist);
  useFrame(() => {
    if (current.current) row.update(current.current);
  });

  return (
    <primitive key={row.group.uuid} object={row.group}>
      {glyphs.map((spec, index) => {
        const glyph = row.glyphs[index];
        return glyph ? <GlyphHit key={`${index}-${spec.id}`} glyph={glyph} label={spec.label} onSelect={spec.onSelect} /> : null;
      })}
    </primitive>
  );
}
