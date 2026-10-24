// The golden edge around the AR bubble (styleguide 9.2): the hologram's burnt
// outline as a circle, laid each frame on the bubble's silhouette and facing
// the viewer, so it stays on the bubble's outline from wherever they stand.
import { bubbleSilhouette, edgeFrame, type SootInput, type Vector3Like, type ViewTarget } from "@holoim/xr-ui-core";
import { ThreeEdge } from "@holoim/xr-ui-three";
import { useFrame, useThree } from "@react-three/fiber";
import { useCallback, useEffect, useLayoutEffect, useMemo } from "react";
import { Quaternion, Vector3, type Camera } from "three";

import { useLatest, useStable } from "./internal.js";

/** The bubble, read every frame: an object the caller updates in place is fine. */
export interface BubbleShape {
  /** World position of the sphere's centre, metres. */
  center: Vector3Like;
  /** World radius, metres; 0 or less draws nothing. */
  radius: number;
  /** False draws nothing. Default true. */
  active?: boolean;
}

export interface BubbleEdgeProps {
  /** The hologram's id (Q10): the same tears as its card. */
  seed: string;
  bubble: BubbleShape;
  target: ViewTarget;
  /** A take is running: headsets draw no edge (8.5). */
  recording: boolean;
  inFocus: boolean;
  reducedMotion: boolean;
  /** AR's bright-room state from the lighting estimate, or null with none (3.2). */
  soot: SootInput;
}

const FACING = new Vector3(0, 0, 1);

/** Mount it in world space (the scene root), not under the hologram's group. Its group is named `bubble-edge`. */
export function BubbleEdge({ seed, bubble, target: targetProp, recording, inFocus, reducedMotion, soot }: BubbleEdgeProps) {
  const target = useStable(targetProp);
  // A unit circle: the group's scale is the silhouette's diameter, so waves, tears and strokes stay shares of it.
  const edge = useMemo(() => {
    const ring = new ThreeEdge({ seed, width: 1, height: 1, shape: "circle" });
    ring.group.name = "bubble-edge";
    return ring;
  }, [seed]);
  useEffect(() => () => edge.dispose(), [edge]);

  const clock = useThree((state) => state.clock);
  const invalidate = useThree((state) => state.invalidate);
  const inputs = useLatest({ target, recording, inFocus, reducedMotion, soot, bubble });
  const scratch = useMemo(() => ({ eye: new Vector3(), normal: new Vector3(), quaternion: new Quaternion() }), []);

  const place = useCallback(
    (camera: Camera, viewer: Camera | null) => {
      const { bubble: shape } = inputs.current;
      const eye = (viewer ?? camera).getWorldPosition(scratch.eye);
      const silhouette = shape.active === false ? null : bubbleSilhouette(shape.center, shape.radius, eye);
      if (!silhouette) return false;
      const { group } = edge;
      group.position.set(silhouette.center.x, silhouette.center.y, silhouette.center.z);
      scratch.normal.set(silhouette.normal.x, silhouette.normal.y, silhouette.normal.z);
      group.quaternion.copy(scratch.quaternion.setFromUnitVectors(FACING, scratch.normal));
      group.scale.setScalar(silhouette.radius * 2);
      return true;
    },
    [edge, inputs, scratch]
  );

  const paint = useCallback(
    (timeMs: number, placed: boolean) => {
      const { target: at, recording: isRecording, inFocus: focus, reducedMotion: reduced, soot: sootInput } = inputs.current;
      const frame = edgeFrame(at, { timeMs, recording: isRecording, inFocus: focus, reducedMotion: reduced, soot: sootInput });
      edge.update(placed ? frame : { ...frame, drawn: false });
    },
    [edge, inputs]
  );

  const camera = useThree((state) => state.camera);
  const gl = useThree((state) => state.gl);
  const viewer = () => (gl.xr?.isPresenting ? gl.xr.getCamera() : null);

  // A change of props shows at once, not on the next frame.
  useLayoutEffect(() => {
    paint(clock.elapsedTime * 1000, place(camera, viewer()));
    invalidate();
  });
  useFrame((state) => paint(state.clock.elapsedTime * 1000, place(state.camera, viewer())));

  return <primitive key={edge.group.uuid} object={edge.group} />;
}
