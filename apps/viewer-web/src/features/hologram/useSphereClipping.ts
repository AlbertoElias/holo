/**
 * React hook that enables sphere-based clipping on a loaded hologram scene.
 *
 * It locates the `RecordedBubbleSphere` mesh exported by webxr-capture,
 * patches every other material in the scene with a sphere-clip fragment
 * shader injection, replaces the bubble mesh's material with a Fresnel
 * glass shader, and tracks the animated sphere centre each frame.
 *
 * If no `RecordedBubbleSphere` is found the hook is a no-op so it is
 * safe to call unconditionally on any GLTF scene.
 */

import { useFrame } from "@react-three/fiber";
import { useCallback, useLayoutEffect, useRef } from "react";
import { SphereGeometry, Vector3 } from "three";
import type { Material, Mesh, Object3D, WebGLProgramParametersWithUniforms, WebGLRenderer } from "three";

import { isInsideRecordedObject } from "../objects/recordedObjects";
import { createBubbleGlassMaterial, isBubbleGlassMaterial } from "./BubbleGlassMaterial";
import {
  SPHERE_CLIP_FRAGMENT_MAIN,
  SPHERE_CLIP_FRAGMENT_PARS,
  SPHERE_CLIP_VERTEX_MAIN,
  SPHERE_CLIP_VERTEX_PARS
} from "./sphereClipShader";

/* ------------------------------------------------------------------ */
/*  Public types                                                       */
/* ------------------------------------------------------------------ */

export type SphereClipConfig = {
  /** Width (world units) of the soft fade zone inside the sphere edge. */
  falloffWidth: number;
  /** If true, recover gracefully if setup fails instead of throwing. */
  safeMode?: boolean;
  /** Optional callback for setup/runtime errors. */
  onError?: (error: Error) => void;
  /** Optional callback for setup status. */
  onStatus?: (status: SphereClipStatus) => void;
};

export type SphereClipStatus = "enabled" | "missing-bubble" | "error";

export type SphereClipResult = {
  /** Whether a bubble sphere was found and clipping is active. */
  active: boolean;
  /** Sphere radius in world units (0 when inactive). */
  radius: number;
  /**
   * Live sphere centre — updated every frame by the hook.
   * Read this in `useFrame` for camera framing.
   */
  center: Vector3;
};

const BUBBLE_MESH_NAME = "RecordedBubbleSphere";
const DEFAULT_BUBBLE_RADIUS = 6;
const CACHE_KEY = "sphere-clip-v2";

/* ------------------------------------------------------------------ */
/*  Internal helpers                                                   */
/* ------------------------------------------------------------------ */

type SphereClipUniforms = {
  u_sphereCenter: { value: Vector3 };
  u_sphereRadius: { value: number };
  u_sphereFalloff: { value: number };
};

function createUniforms(center: Vector3, radius: number, falloff: number): SphereClipUniforms {
  return {
    u_sphereCenter: { value: center },
    u_sphereRadius: { value: radius },
    u_sphereFalloff: { value: falloff }
  };
}

function toError(error: unknown): Error {
  if (error instanceof Error) {
    return error;
  }

  return new Error(typeof error === "string" ? error : "Unknown sphere clipping error");
}

function findBubbleMesh(root: Object3D): Mesh | null {
  let found: Mesh | null = null;

  root.traverse((child) => {
    if (found) {
      return;
    }

    const mesh = child as Mesh;
    if (mesh.isMesh && mesh.name === BUBBLE_MESH_NAME) {
      found = mesh;
    }
  });

  return found;
}

function readSphereRadius(mesh: Mesh): number {
  const geo = mesh.geometry;
  if (geo instanceof SphereGeometry) {
    const params = geo.parameters as { radius?: number };
    if (typeof params.radius === "number" && params.radius > 0) {
      return params.radius;
    }
  }

  // Fallback: derive from bounding sphere
  geo.computeBoundingSphere();
  return geo.boundingSphere?.radius ?? DEFAULT_BUBBLE_RADIUS;
}

function patchMaterial(material: Material, uniforms: SphereClipUniforms): void {
  material.transparent = true;

  // Preserve existing opacity for materials that were already transparent
  // The sphere clip alpha is multiplied with gl_FragColor.a in the shader.

  const prevOnBeforeCompile = material.onBeforeCompile?.bind(material);

  material.onBeforeCompile = (shader: WebGLProgramParametersWithUniforms, renderer: WebGLRenderer) => {
    // Chain any pre-existing onBeforeCompile (unlikely for GLTF imports but safe)
    if (prevOnBeforeCompile) {
      prevOnBeforeCompile(shader, renderer);
    }

    // Merge our uniforms into the shader's uniform map
    shader.uniforms.u_sphereCenter = uniforms.u_sphereCenter;
    shader.uniforms.u_sphereRadius = uniforms.u_sphereRadius;
    shader.uniforms.u_sphereFalloff = uniforms.u_sphereFalloff;

    // --- Vertex ---
    shader.vertexShader = shader.vertexShader.replace(
      "void main() {",
      `${SPHERE_CLIP_VERTEX_PARS}\nvoid main() {`
    );
    shader.vertexShader = shader.vertexShader.replace(
      "#include <project_vertex>",
      `#include <project_vertex>\n${SPHERE_CLIP_VERTEX_MAIN}`
    );

    // --- Fragment ---
    shader.fragmentShader = shader.fragmentShader.replace(
      "void main() {",
      `${SPHERE_CLIP_FRAGMENT_PARS}\nvoid main() {`
    );
    // Inject just before the closing brace of main()
    shader.fragmentShader = shader.fragmentShader.replace(
      "#include <dithering_fragment>",
      `#include <dithering_fragment>\n${SPHERE_CLIP_FRAGMENT_MAIN}`
    );
  };

  material.customProgramCacheKey = () => CACHE_KEY;
}

/* ------------------------------------------------------------------ */
/*  Hook                                                               */
/* ------------------------------------------------------------------ */

export function useSphereClipping(scene: Object3D, config: SphereClipConfig): SphereClipResult {
  const bubbleRef = useRef<Mesh | null>(null);
  const baseRadiusRef = useRef(0);
  const uniformsRef = useRef<SphereClipUniforms | null>(null);
  const worldScaleRef = useRef(new Vector3(1, 1, 1));
  const resultRef = useRef<SphereClipResult>({ active: false, radius: 0, center: new Vector3() });
  const falloffWidth = config.falloffWidth;
  const safeMode = config.safeMode ?? true;
  const callbacksRef = useRef(config);
  callbacksRef.current = config;

  const syncSphere = useCallback(() => {
    const bubble = bubbleRef.current;
    const uniforms = uniformsRef.current;
    if (!bubble || !uniforms) {
      return;
    }

    bubble.getWorldPosition(uniforms.u_sphereCenter.value);
    bubble.getWorldScale(worldScaleRef.current);
    const worldRadius = baseRadiusRef.current * Math.max(
      Math.abs(worldScaleRef.current.x),
      Math.abs(worldScaleRef.current.y),
      Math.abs(worldScaleRef.current.z)
    );
    uniforms.u_sphereRadius.value = worldRadius;
    resultRef.current.radius = worldRadius;

    const material = Array.isArray(bubble.material) ? bubble.material[0] : bubble.material;
    if (material && isBubbleGlassMaterial(material)) {
      material.uniforms.u_time.value = 0;
    }
  }, []);

  useFrame(syncSphere);

  useLayoutEffect(() => {
    const result = resultRef.current;
    const setInactive = (status: SphereClipStatus) => {
      bubbleRef.current = null;
      baseRadiusRef.current = 0;
      uniformsRef.current = null;
      resultRef.current.active = false;
      resultRef.current.radius = 0;
      resultRef.current.center.set(0, 0, 0);
      callbacksRef.current.onStatus?.(status);
    };

    const bubble = findBubbleMesh(scene);
    if (!bubble) {
      // No bubble sphere in this GLTF — nothing to clip.
      setInactive("missing-bubble");
      return;
    }

    const restoreFns: Array<() => void> = [];

    try {
      bubbleRef.current = bubble;

      const baseRadius = readSphereRadius(bubble);
      const uniforms = createUniforms(resultRef.current.center, baseRadius, falloffWidth);
      uniformsRef.current = uniforms;
      baseRadiusRef.current = baseRadius;

      // Replace the bubble mesh's material with glass
      const previousBubbleMaterial = bubble.material;
      const glassMaterial = createBubbleGlassMaterial();
      bubble.material = glassMaterial;
      const previousRenderOrder = bubble.renderOrder;
      bubble.renderOrder = 999;
      restoreFns.push(() => {
        glassMaterial.dispose();
        bubble.material = previousBubbleMaterial;
        bubble.renderOrder = previousRenderOrder;
      });

      // Run immediately before each draw: animation and AR placement can run
      // after our frame callback, and both eyes must use the current transform.
      const attachSync = (mesh: Mesh) => {
        const previousBeforeRender = mesh.onBeforeRender;
        mesh.onBeforeRender = function (...args) {
          previousBeforeRender.apply(this, args);
          syncSphere();
        };
        restoreFns.push(() => { mesh.onBeforeRender = previousBeforeRender; });
      };
      attachSync(bubble);

      // Patch every other mesh in the scene
      scene.traverse((child) => {
        const mesh = child as Mesh;
        // Objects the author handled stay whole: one held at arm's length
        // must not be cut by the bubble around the avatar.
        if (!mesh.isMesh || mesh === bubble || isInsideRecordedObject(mesh)) {
          return;
        }

        attachSync(mesh);
        const previousMaterial = mesh.material;
        const originals = Array.isArray(previousMaterial) ? previousMaterial : [previousMaterial];
        if (originals.length === 0 || originals.some((material) => !material)) {
          throw new Error("Mesh has no material");
        }
        const cloned = originals.map((material) => material.clone());
        mesh.material = Array.isArray(previousMaterial) ? cloned : cloned[0]!;

        restoreFns.push(() => {
          cloned.forEach((material) => material.dispose());
          mesh.material = previousMaterial;
        });
        cloned.forEach((material) => patchMaterial(material, uniforms));
      });

      // Initial sphere centre + world radius
      bubble.getWorldPosition(uniforms.u_sphereCenter.value);
      bubble.getWorldScale(worldScaleRef.current);
      const worldRadius = baseRadius * Math.max(
        Math.abs(worldScaleRef.current.x),
        Math.abs(worldScaleRef.current.y),
        Math.abs(worldScaleRef.current.z)
      );
      uniforms.u_sphereRadius.value = worldRadius;

      resultRef.current.active = true;
      resultRef.current.radius = worldRadius;
      callbacksRef.current.onStatus?.("enabled");
    } catch (unknownError) {
      while (restoreFns.length > 0) {
        restoreFns.pop()?.();
      }

      const error = toError(unknownError);
      setInactive("error");
      callbacksRef.current.onError?.(error);

      if (!safeMode) {
        throw error;
      }
    }

    return () => {
      while (restoreFns.length > 0) {
        restoreFns.pop()?.();
      }
      bubbleRef.current = null;
      uniformsRef.current = null;
      result.active = false;
      result.radius = 0;
    };
  }, [falloffWidth, safeMode, scene, syncSphere]);

  return resultRef.current;
}
