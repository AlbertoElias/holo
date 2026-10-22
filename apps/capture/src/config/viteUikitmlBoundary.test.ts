import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";
import type { Plugin } from "vite";

import viteConfig from "../../vite.config";

type ResolveId = (
  this: { resolve: (source: string) => Promise<{ id: string } | null> },
  source: string,
  importer: string | undefined,
) => Promise<string | null>;

// Regression: in dev, UIKitML's kits pulled in ~1600 unbundled lucide icon
// modules, and Fingerprint.js is blocked by common content blockers. One
// blocked module failed the whole graph and left the capture page blank.
// The boundary plugin must therefore run in serve as well as build.
describe("holoim-uikitml-boundary plugin", () => {
  async function boundaryPlugin(): Promise<Plugin> {
    const config = await (viteConfig as (env: { command: "serve"; mode: string }) => Promise<{ plugins?: Plugin[] }>)({
      command: "serve",
      mode: "development",
    });
    const plugin = config.plugins?.find((candidate) => candidate.name === "holoim-uikitml-boundary");
    if (!plugin) throw new Error("holoim-uikitml-boundary plugin missing from vite config");
    return plugin;
  }

  it("is not restricted to build, so dev gets the boundary too", async () => {
    const plugin = await boundaryPlugin();
    expect(plugin.apply).toBeUndefined();
  });

  it("replaces the UIKitML kits with the empty stub", async () => {
    const plugin = await boundaryPlugin();
    const resolveId = plugin.resolveId as unknown as ResolveId;
    const kitsId = await resolveId.call(
      { resolve: async () => null },
      "./kits.js",
      "/node_modules/@drawcall/uikitml/dist/index.js",
    );
    expect(kitsId).toContain("holoim-uikitml-empty-kits");

    const load = plugin.load as unknown as (id: string) => string | null;
    const stub = load(kitsId as string);
    expect(stub).toContain("resolveKitComponentSets");
    expect(stub).toContain("lucideComponentSet = {}");
  });

  it("strips uikitml's unusable sourcemap comments so Vite stops warning", async () => {
    const config = await (viteConfig as (env: { command: "serve"; mode: string }) => Promise<{ plugins?: Plugin[] }>)({
      command: "serve",
      mode: "development",
    });
    const plugin = config.plugins?.find((candidate) => candidate.name === "holoim-strip-uikitml-sourcemaps");
    if (!plugin) throw new Error("holoim-strip-uikitml-sourcemaps plugin missing from vite config");
    const load = plugin.load as unknown as (id: string) => Promise<{ code: string; map: null } | null>;

    // Serve a real file from a uikitml-shaped path: load must return the
    // code with its sourceMappingURL comment gone and no map attached.
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "uikitml-dist-"));
    const file = path.join(dir, "@drawcall", "uikitml", "dist", "index.js");
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, "export const a = 1;\n//# sourceMappingURL=index.js.map\n");
    try {
      const result = await load(file);
      expect(result?.code).toBe("export const a = 1;\n\n");
      expect(result?.code).not.toContain("sourceMappingURL");
      expect(result?.map).toBeNull();

      // Other packages are left to Vite's normal loading.
      expect(await load("/node_modules/three/build/three.module.js")).toBeNull();
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("resolves lucide to the two-icon subset, never the full icon set", async () => {
    const plugin = await boundaryPlugin();
    const resolveId = plugin.resolveId as unknown as ResolveId;
    const subsetId = await resolveId.call(
      {
        resolve: async () => ({
          id: "/node_modules/@pmndrs/uikit-lucide/dist/index.js",
        }),
      },
      "@pmndrs/uikit-lucide",
      "/node_modules/@drawcall/uikitml/dist/kits.js",
    );
    expect(subsetId).toContain("holoim-lucide-subset:");

    const load = plugin.load as unknown as (id: string) => string | null;
    const subset = load(subsetId as string);
    expect(subset).toContain("Check");
    expect(subset).toContain("ChevronDown");
    expect(subset).not.toContain("Fingerprint");
  });
});
