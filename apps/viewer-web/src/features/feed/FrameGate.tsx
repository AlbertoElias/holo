import { useEffect, useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";

/**
 * Draws the card only when the GPU has finished the last frame.
 *
 * The browser asks for a frame about 60 times a second, whether or not the
 * GPU keeps up. On a slow GPU (a software rasteriser such as SwiftShader on a
 * hosted runner, or a weak phone) each frame of a close framing can take
 * hundreds of milliseconds, so the frames queue without a limit. The queue
 * delays everything after it: leaving the feed for AR waits until the card's
 * context loss has drained it (B-083). A fence after each frame tells when the
 * GPU is done; until it signals, this skips the draw, and the take, the
 * camera and the other frame callbacks still advance. On WebGL 1 (no fences)
 * every frame draws as before.
 *
 * A `useFrame` with a positive priority takes over R3F's own render, so this
 * is the one place the card's scene is drawn.
 */
export function FrameGate() {
  const gl = useThree((state) => state.gl);
  const invalidate = useThree((state) => state.invalidate);
  const fence = useRef<WebGLSync | null>(null);
  const context = gl.getContext();
  const gl2 = typeof WebGL2RenderingContext !== "undefined" && context instanceof WebGL2RenderingContext ? context : null;

  useEffect(
    () => () => {
      if (gl2 && fence.current) gl2.deleteSync(fence.current);
      fence.current = null;
    },
    [gl2]
  );

  useFrame(({ scene, camera }) => {
    if (gl2 && fence.current) {
      if (gl2.getSyncParameter(fence.current, gl2.SYNC_STATUS) !== gl2.SIGNALED) {
        // The last frame is still on the GPU: try again on the next frame
        // (a demand frame loop would otherwise keep the stale picture).
        invalidate();
        return;
      }
      gl2.deleteSync(fence.current);
      fence.current = null;
    }
    gl.render(scene, camera);
    if (gl2) {
      fence.current = gl2.fenceSync(gl2.SYNC_GPU_COMMANDS_COMPLETE, 0);
      gl2.flush();
    }
  }, 1);

  return null;
}
