import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { AnimationAction, AnimationClip, Object3D } from "three";
import { AnimationMixer } from "three";

/**
 * drei's `useAnimations` without its own frame tick: the caller advances
 * `mixer` where it needs to in the frame. The feed advances it first, so the
 * dome, its rim, the shell and the scene's clip all read the bubble where
 * this frame draws it (styleguide 3.4).
 */
export function useTakeAnimations(clips: AnimationClip[], root: Object3D): { actions: Record<string, AnimationAction | null>; mixer: AnimationMixer } {
  const [mixer] = useState(() => new AnimationMixer(root));
  const lazy = useRef<Record<string, AnimationAction>>({});
  useLayoutEffect(() => {
    (mixer as unknown as { _root: Object3D })._root = root;
  });
  const actions = useMemo(() => {
    const out: Record<string, AnimationAction | null> = {};
    for (const clip of clips) {
      Object.defineProperty(out, clip.name, {
        enumerable: true,
        configurable: true,
        get: () => (lazy.current[clip.name] ??= mixer.clipAction(clip, root))
      });
    }
    return out;
  }, [clips, mixer, root]);
  useEffect(() => () => {
    lazy.current = {};
    mixer.stopAllAction();
    for (const clip of clips) mixer.uncacheAction(clip, root);
  }, [clips, mixer, root]);
  return { actions, mixer };
}
