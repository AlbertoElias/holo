/**
 * React hook that enables sphere-based clipping on a loaded hologram scene
 * (`applySphereClipping`), and tracks the animated sphere centre each frame.
 *
 * If no `RecordedBubbleSphere` is found the hook is a no-op so it is
 * safe to call unconditionally on any GLTF scene.
 */

import { useFrame } from "@react-three/fiber";
import { useLayoutEffect, useRef } from "react";
import { Vector3 } from "three";
import type { Object3D } from "three";

import { applySphereClipping, type SphereClipConfig, type SphereClipping, type SphereClipResult } from "./sphereClipping";

export type { SphereClipConfig, SphereClipResult, SphereClipStatus } from "./sphereClipping";

export function useSphereClipping(scene: Object3D, config: SphereClipConfig): SphereClipResult {
  const clippingRef = useRef<SphereClipping | null>(null);
  // Stable across setups, so callers may hold it; each setup fills it.
  const resultRef = useRef<SphereClipResult>({ active: false, radius: 0, center: new Vector3() });
  const falloffWidth = config.falloffWidth;
  const safeMode = config.safeMode ?? true;
  const callbacksRef = useRef(config);
  callbacksRef.current = config;

  useFrame(() => clippingRef.current?.sync());

  useLayoutEffect(() => {
    const result = resultRef.current;
    const clipping = applySphereClipping(scene, {
      falloffWidth,
      safeMode,
      onStatus: (status) => callbacksRef.current.onStatus?.(status),
      onError: (error) => callbacksRef.current.onError?.(error)
    }, result);
    clippingRef.current = clipping;

    return () => {
      clipping.dispose();
      clippingRef.current = null;
      result.active = false;
      result.radius = 0;
    };
  }, [falloffWidth, safeMode, scene]);

  return resultRef.current;
}
