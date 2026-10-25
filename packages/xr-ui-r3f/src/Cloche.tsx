// The 3D halo (styleguide 3.4): the cloche over a hologram, flickering by
// target, fading as the viewer goes inside, and moving with the hologram
// when its recorded volume moves (a bubble that follows its author).
import { edgeFrame, type ClocheShape, type SootInput, type Vector3Like, type ViewTarget } from "@holoim/xr-ui-core";
import { ThreeCloche } from "@holoim/xr-ui-three";
import { useFrame, useThree } from "@react-three/fiber";
import { useCallback, useEffect, useLayoutEffect, useMemo } from "react";
import { PerspectiveCamera, Vector2, Vector3, type Camera, type Clock, type WebGLRenderer } from "three";

import { useLatest, useStable } from "./internal.js";

export interface ClocheProps {
  /** The hologram's id (Q10): the same burns as everywhere else it appears. */
  seed: string;
  /** From `fitCloche`, once per hologram. */
  shape: ClocheShape;
  /**
   * How far the hologram's volume has moved since the shape was fitted, read
   * every frame (an object the caller updates in place is fine). Omit when it
   * stays put.
   */
  shift?: Vector3Like;
  target: ViewTarget;
  /** A take is running: flat screens quiet the edge, headsets draw none (8.5). */
  recording: boolean;
  inFocus: boolean;
  reducedMotion: boolean;
  /** The soot rule's input (3.2); the cloche turns it into char, never a shadow. */
  soot: SootInput;
}

/**
 * Mount it in the space the shape was fitted in: beside the model in world
 * space, or inside a placed hologram's group (AR), never under the camera.
 * Its group is named `cloche`.
 */
export function Cloche({ seed, shape, shift, target: targetProp, recording, inFocus, reducedMotion, soot }: ClocheProps) {
  const target = useStable(targetProp);
  const cloche = useMemo(() => new ThreeCloche({ seed, shape }), [seed, shape]);
  useEffect(() => () => cloche.dispose(), [cloche]);

  const invalidate = useThree((state) => state.invalidate);
  const inputs = useLatest({ target, recording, inFocus, reducedMotion, soot, shift });
  const scratch = useMemo(() => ({ eye: new Vector3(), centre: new Vector3(), scale: new Vector3(), buffer: new Vector2() }), []);

  const paint = useCallback(
    (state: { camera: Camera; gl: WebGLRenderer; clock: Clock }) => {
      const { target: at, recording: isRecording, inFocus: focus, reducedMotion: reduced, soot: sootInput, shift: moved } = inputs.current;
      const { group } = cloche;
      group.position.set(shape.base.x + (moved?.x ?? 0), shape.base.y + (moved?.y ?? 0), shape.base.z + (moved?.z ?? 0));
      group.updateWorldMatrix(true, false);
      const presenting = state.gl.xr?.isPresenting === true;
      const viewer = presenting ? state.gl.xr.getCamera() : state.camera;
      const eye = viewer.getWorldPosition(scratch.eye);
      // The dome's wider radius on screen, in device pixels: what the rim's widths are shares of.
      // World measures, since the group may sit in a placed, scaled hologram (AR).
      const centre = group.localToWorld(scratch.centre.set(0, shape.radii.y / 2, 0));
      const worldScale = group.getWorldScale(scratch.scale).x;
      const distance = Math.max(eye.distanceTo(centre), 1e-3);
      const projection = (presenting ? state.gl.xr.getCamera().cameras[0] ?? viewer : viewer).projectionMatrix.elements[5] ?? 1;
      const heightPx = state.gl.getDrawingBufferSize(scratch.buffer).y;
      const wider = Math.max(shape.radii.x, shape.radii.y, shape.radii.z) * worldScale;
      const radiusPx = (wider / distance) * (heightPx / 2) * projection;
      const frame = edgeFrame(at, { timeMs: state.clock.elapsedTime * 1000, recording: isRecording, inFocus: focus, reducedMotion: reduced, soot: sootInput });
      cloche.update(frame, { eye: cloche.eyeInShape(eye), radiusPx });
    },
    [cloche, inputs, scratch, shape]
  );

  const camera = useThree((state) => state.camera);
  const gl = useThree((state) => state.gl);
  const clock = useThree((state) => state.clock);
  // A change of props shows at once, not on the next frame.
  useLayoutEffect(() => {
    if (camera instanceof PerspectiveCamera || gl.xr?.isPresenting) paint({ camera, gl, clock });
    invalidate();
  });
  useFrame((state) => paint(state));

  return <primitive key={cloche.group.uuid} object={cloche.group} />;
}
