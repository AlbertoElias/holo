import { useThree } from "@react-three/fiber";
import { useEffect } from "react";
import type { Material, Object3D, Texture } from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "three/examples/jsm/libs/meshopt_decoder.module.js";

import { testHooks } from "../../testHooks";
import { ktx2Loader } from "./ktx2";

// Full-size textures for the focused card (docs/features/hologram-budgets.md,
// Q4 A): the served GLB carries textures of at most 1024 px; the API keeps the
// full ones in a texture-only glTF whose `textures` line up with the served
// GLB's. Once the card has focus and the page is idle they replace the light
// ones in place (same UVs, same transform, so nothing moves); losing focus
// puts the light ones back and frees the full ones.

/** Material slots a glTF texture can fill in three's standard materials. */
const SLOTS = [
  "map", "normalMap", "roughnessMap", "metalnessMap", "emissiveMap", "aoMap", "alphaMap",
  "clearcoatMap", "clearcoatNormalMap", "clearcoatRoughnessMap", "sheenColorMap", "sheenRoughnessMap",
  "specularIntensityMap", "specularColorMap", "transmissionMap", "thicknessMap", "iridescenceMap", "iridescenceThicknessMap", "anisotropyMap"
] as const;

export type TextureDetailReport = {
  status: "waiting" | "loading" | "ready" | "failed" | "freed";
  error: string | null;
  /** Texture slots swapped to their full-size texture. */
  swapped: number;
  /** Largest texture width before and after the swap. */
  lightMaxWidth: number;
  fullMaxWidth: number;
  loadMs: number;
};

declare global {
  interface Window {
    __HOLOIM_TEXTURE_DETAIL__?: TextureDetailReport;
  }
}

type Associations = Map<object, { textures?: number } | undefined>;

function width(texture: Texture): number {
  const image = texture.image as { width?: number } | undefined;
  const mip = (texture as Texture & { mipmaps?: Array<{ width?: number }> }).mipmaps?.[0];
  return image?.width ?? mip?.width ?? 0;
}

export function useTextureDetail({ url, wanted, scene, associations }: {
  /** The DTO's `textureDetailUrl`, null when nothing was downscaled. */
  url: string | null;
  wanted: boolean;
  /** The card's scene: its materials hold the light textures. */
  scene: Object3D;
  /** The served GLB's parser associations: texture → its glTF index. */
  associations: Associations;
}): void {
  const invalidate = useThree((state) => state.invalidate);
  useEffect(() => {
    if (!url || !wanted) return undefined;
    let live = true;
    const report: TextureDetailReport = { status: "waiting", error: null, swapped: 0, lightMaxWidth: 0, fullMaxWidth: 0, loadMs: 0 };
    if (testHooks) window.__HOLOIM_TEXTURE_DETAIL__ = report;
    const restore: Array<{ material: Material; slot: (typeof SLOTS)[number]; light: Texture }> = [];
    const loaded: Texture[] = [];
    const run = async () => {
      const started = performance.now();
      report.status = "loading";
      const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).setKTX2Loader(ktx2Loader());
      const detail = await loader.loadAsync(url);
      if (!live) return;
      const count = (detail.parser.json as { textures?: unknown[] }).textures?.length ?? 0;
      const full = new Map<number, Texture>();
      const wantedIndices = new Set<number>();
      scene.traverse((node) => {
        const materials = (node as Object3D & { material?: Material | Material[] }).material;
        for (const material of Array.isArray(materials) ? materials : materials ? [materials] : []) {
          for (const slot of SLOTS) {
            const texture = (material as unknown as Record<string, Texture | null | undefined>)[slot];
            const index = texture ? associations.get(texture)?.textures : undefined;
            if (index !== undefined && index < count) wantedIndices.add(index);
          }
        }
      });
      for (const index of wantedIndices) {
        const texture = (await detail.parser.getDependency("texture", index)) as Texture;
        if (!live) {
          texture.dispose();
          return;
        }
        full.set(index, texture);
        loaded.push(texture);
      }
      scene.traverse((node) => {
        const materials = (node as Object3D & { material?: Material | Material[] }).material;
        for (const material of Array.isArray(materials) ? materials : materials ? [materials] : []) {
          const slots = material as unknown as Record<string, Texture | null | undefined>;
          for (const slot of SLOTS) {
            const light = slots[slot];
            const index = light ? associations.get(light)?.textures : undefined;
            const replacement = index === undefined ? undefined : full.get(index);
            if (!light || !replacement) continue;
            // The light texture's sampling, colour space, UV set and transform, on the full image.
            const swapped = replacement.clone();
            swapped.colorSpace = light.colorSpace;
            swapped.channel = light.channel;
            swapped.flipY = light.flipY;
            swapped.wrapS = light.wrapS;
            swapped.wrapT = light.wrapT;
            swapped.offset.copy(light.offset);
            swapped.repeat.copy(light.repeat);
            swapped.rotation = light.rotation;
            swapped.center.copy(light.center);
            swapped.needsUpdate = true;
            loaded.push(swapped);
            report.lightMaxWidth = Math.max(report.lightMaxWidth, width(light));
            report.fullMaxWidth = Math.max(report.fullMaxWidth, width(swapped));
            slots[slot] = swapped;
            restore.push({ material, slot, light });
            material.needsUpdate = true;
          }
        }
      });
      report.swapped = restore.length;
      report.loadMs = performance.now() - started;
      report.status = "ready";
      invalidate();
    };
    const idle = typeof window.requestIdleCallback === "function"
      ? (() => { const handle = window.requestIdleCallback(() => void run().catch(fail), { timeout: 2000 }); return () => window.cancelIdleCallback(handle); })()
      : (() => { const handle = window.setTimeout(() => void run().catch(fail), 200); return () => window.clearTimeout(handle); })();
    function fail(error: unknown) {
      if (!live) return;
      report.status = "failed";
      report.error = error instanceof Error ? error.message : String(error);
      console.warn("The hologram's full-size textures did not load; the light ones stay.", error);
    }
    return () => {
      live = false;
      idle();
      for (const { material, slot, light } of restore) {
        (material as unknown as Record<string, Texture>)[slot] = light;
        material.needsUpdate = true;
      }
      for (const texture of loaded) texture.dispose();
      report.status = "freed";
      invalidate();
    };
  }, [url, wanted, scene, associations, invalidate]);
}
