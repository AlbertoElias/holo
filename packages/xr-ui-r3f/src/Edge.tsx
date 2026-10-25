// A hologram's golden edge in 3D (styleguide 3, 8.5): the seeded outline
// drawn as soot, halo, core and highlight, flickering by target. While
// recording in a headset the edge is not drawn at all.
import { edgeFrame, type SootInput, type ViewTarget } from "@holoim/xr-ui-core";
import { ThreeEdge } from "@holoim/xr-ui-three";
import { useFrame, useThree } from "@react-three/fiber";
import { useCallback, useEffect, useLayoutEffect, useMemo } from "react";

import { useLatest, useStable } from "./internal.js";

export interface EdgeProps {
  /** The hologram's id (Q10): one hologram keeps the same tears everywhere. */
  seed: string;
  /** The card's size in metres. */
  width: number;
  height: number;
  target: ViewTarget;
  /** A take is running: flat screens quiet the edge, headsets draw none (8.5). */
  recording: boolean;
  /** The hologram nearest the middle or the forward ray: sparks and the stage light are its alone (8.2). */
  inFocus: boolean;
  reducedMotion: boolean;
  /** What the soot rule reads: the ground's luminance, or AR's bright-room state (3.2). */
  soot: SootInput;
  position?: readonly [number, number, number];
}

/** Mount it as a child of the hologram's group; it lies in the hologram's plane, centred. */
export function Edge({ seed, width, height, target: targetProp, recording, inFocus, reducedMotion, soot, position }: EdgeProps) {
  const target = useStable(targetProp);
  const edge = useMemo(() => new ThreeEdge({ seed, width, height }), [seed, width, height]);
  useEffect(() => () => edge.dispose(), [edge]);

  const clock = useThree((state) => state.clock);
  const invalidate = useThree((state) => state.invalidate);
  const inputs = useLatest({ target, recording, inFocus, reducedMotion, soot });
  const paint = useCallback(
    (timeMs: number) => {
      const { target: at, ...rest } = inputs.current;
      edge.update(edgeFrame(at, { timeMs, ...rest }));
    },
    [edge, inputs]
  );

  // A change of props shows at once, not on the next frame.
  useLayoutEffect(() => {
    paint(clock.elapsedTime * 1000);
    invalidate();
  }, [paint, target, recording, inFocus, reducedMotion, soot, clock, invalidate]);
  useFrame((state) => paint(state.clock.elapsedTime * 1000));

  return <primitive key={edge.group.uuid} object={edge.group} {...(position ? { position } : {})} />;
}
