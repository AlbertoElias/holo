import type { WebGLRenderer } from "three";
import { KTX2Loader } from "three/examples/jsm/loaders/KTX2Loader.js";

// KTX2 (Basis) textures (docs/features/hologram-budgets.md, Q4 C): the API
// stores a hologram's textures as KTX2, and every glTF loader in the viewer
// decodes them through this one loader, so one transcoder worker pool serves
// the feed, AR and XR. The transcoder files are served from `/basis/`
// (vite.config.ts) and match the three that decodes with them.

let shared: KTX2Loader | null = null;

/**
 * The GPU's compressed formats, probed once on a throwaway WebGL2 context:
 * the loader needs them before any glTF loads, and a glTF may be preloaded
 * before a canvas exists. Same device, same formats as the real renderer.
 */
function probeRenderer(): Pick<WebGLRenderer, "extensions"> {
  const canvas = document.createElement("canvas");
  const gl = canvas.getContext("webgl2") ?? canvas.getContext("webgl");
  const found = new Set<string>();
  // KTX2Loader also reads the ASTC profiles (for HDR) through `extensions.get`
  // whenever ASTC is present (Apple GPUs, Quest, most phones), so keep them
  // before the context is released.
  let astcProfiles: string[] = [];
  if (gl) {
    for (const name of gl.getSupportedExtensions() ?? []) found.add(name);
    if (found.has("WEBGL_compressed_texture_astc")) {
      astcProfiles = gl.getExtension("WEBGL_compressed_texture_astc")?.getSupportedProfiles() ?? [];
    }
    gl.getExtension("WEBGL_lose_context")?.loseContext();
  }
  const extensions = {
    has: (name: string) => found.has(name),
    get: (name: string) =>
      found.has(name) && name === "WEBGL_compressed_texture_astc" ? { getSupportedProfiles: () => astcProfiles } : null
  };
  return { extensions } as unknown as Pick<WebGLRenderer, "extensions">;
}

export function ktx2Loader(): KTX2Loader {
  if (!shared) {
    shared = new KTX2Loader().setTranscoderPath(`${import.meta.env.BASE_URL}basis/`);
    shared.detectSupport(probeRenderer() as WebGLRenderer);
  }
  return shared;
}

/** For drei's `useGLTF(url, draco, meshopt, extendLoader)`: three-stdlib's loader takes three's KTX2Loader as is. */
export function withKtx2(loader: { setKTX2Loader: (loader: never) => unknown }): void {
  loader.setKTX2Loader(ktx2Loader() as never);
}
