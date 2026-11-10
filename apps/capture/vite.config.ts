import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { defineConfig, type Connect, type Plugin } from 'vite';
import { iwsdkDev, type AiMode } from '@iwsdk/vite-plugin-dev';
import { optimizeGLTF } from '@iwsdk/vite-plugin-gltf-optimizer';

const apiProxyTarget = process.env.VITE_API_PROXY_TARGET ?? 'http://127.0.0.1:3001';

function getAiMode(): AiMode | undefined {
  const mode = process.env.IWSDK_DEV_AI_MODE;
  return mode === 'agent' || mode === 'collaborate' ? mode : undefined;
}

// Dev-only sink for raw headset input recorded during a capture session
// (see src/debug/inputRecording.ts). A headset on the LAN posts here and the
// file lands in the repo, ready to commit as a replay fixture.
const INPUT_RECORDING_LIMIT_BYTES = 50 * 1024 * 1024;

function inputRecordingSinkPlugin(outputDir: string): Plugin {
  // The dev server and `vite preview` of the e2e test build both take them.
  const install = (server: { middlewares: Connect.Server }): void => {
    server.middlewares.use('/__holoim/input-recordings', (req, res) => {
      const fail = (status: number, message: string): void => {
        res.statusCode = status;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ error: message }));
      };
      if (req.method !== 'POST') return fail(405, 'POST only');
      const chunks: Buffer[] = [];
      let size = 0;
      req.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > INPUT_RECORDING_LIMIT_BYTES) req.destroy();
        else chunks.push(chunk);
      });
      req.on('end', () => {
        void (async () => {
          let recording: { schema?: unknown; frames?: unknown };
          try {
            recording = JSON.parse(Buffer.concat(chunks).toString('utf8')) as typeof recording;
          } catch {
            return fail(400, 'Body is not JSON');
          }
          if (!Array.isArray(recording.schema) || !Array.isArray(recording.frames)) {
            return fail(400, 'Expected an ActionRecorder recording with schema and frames');
          }
          const requested = new URL(req.url ?? '', 'http://localhost').searchParams.get('name') ?? 'recording';
          const safeName = requested.replace(/[^a-z0-9._-]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'recording';
          await fs.mkdir(outputDir, { recursive: true });
          const filePath = path.join(outputDir, `${safeName}.json`);
          await fs.writeFile(filePath, JSON.stringify(recording));
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({ path: path.relative(process.cwd(), filePath) }));
        })().catch((error: unknown) => fail(500, error instanceof Error ? error.message : String(error)));
      });
    });
  };
  return {
    name: 'holoim-input-recording-sink',
    apply: 'serve',
    configureServer: install,
    configurePreviewServer: install
  };
}

// `vite preview` serves only the build, but the browser checks load scenes
// and objects from fixtures/ by URL (?scene=/fixtures/...) and avatars they
// generate into output/ (?avatar=/output/...), which the dev server served
// from the app root. Preview of the e2e test build serves both too; the
// deployed app never runs under preview.
const FIXTURE_TYPES: Record<string, string> = {
  '.gltf': 'model/gltf+json',
  '.glb': 'model/gltf-binary',
  '.bin': 'application/octet-stream',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ktx2': 'image/ktx2'
};

function previewTestFilesPlugin(appRoot: string, directories: readonly string[]): Plugin {
  return {
    name: 'holoim-preview-test-files',
    configurePreviewServer(server) {
      for (const directory of directories) {
        const root = path.join(appRoot, directory);
        server.middlewares.use(`/${directory}`, (req, res, next) => {
          const file = path.join(root, decodeURIComponent(new URL(req.url ?? '/', 'http://files').pathname));
          if (!file.startsWith(root + path.sep)) return next();
          fs.readFile(file).then((body) => {
            res.setHeader('content-type', FIXTURE_TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream');
            res.end(body);
          }, () => next());
        });
      }
    }
  };
}

// IWSDK's World bootstrap always imports UIKitML. Its component kits build
// zod schemas for every Horizon component and import every lucide icon at
// startup: about 1 MB gzipped and 25 MB of retained heap. Capture never
// renders UIKitML (its headset chrome builds UIKit components directly), so builds and dev give
// UIKitML empty kits and resolve lucide to the two icons Horizon imports.
// Dev needs the same boundary: unbundled, the kits issue ~1600 icon module
// requests, and one (Fingerprint.js) matches content-blocker rules, which
// fails the whole module graph and leaves a blank page.
const UIKITML_EMPTY_KITS = '\0holoim-uikitml-empty-kits';
const LUCIDE_SUBSET = '\0holoim-lucide-subset:';

function uikitmlBoundaryPlugin(): Plugin {
  return {
    name: 'holoim-uikitml-boundary',
    enforce: 'pre',
    async resolveId(source, importer, options) {
      if (!importer || importer.startsWith(LUCIDE_SUBSET)) return null;
      if (source === './kits.js' && importer.includes('/@drawcall/uikitml/dist/')) return UIKITML_EMPTY_KITS;
      if (source !== '@pmndrs/uikit-lucide') return null;
      const resolved = await this.resolve(source, importer, { ...options, skipSelf: true });
      return resolved ? `${LUCIDE_SUBSET}${path.dirname(resolved.id)}` : null;
    },
    load(id) {
      if (id === UIKITML_EMPTY_KITS) {
        return 'export const lucideComponentSet = {};\nexport const horizonComponentSet = {};\nexport function resolveKitComponentSets() { return []; }';
      }
      if (!id.startsWith(LUCIDE_SUBSET)) return null;
      const dist = id.slice(LUCIDE_SUBSET.length);
      return [
        `export { Check, CheckIcon } from ${JSON.stringify(path.join(dist, 'Check.js'))};`,
        `export { ChevronDown, ChevronDownIcon } from ${JSON.stringify(path.join(dist, 'ChevronDown.js'))};`
      ].join('\n');
    }
  };
}

// @drawcall/uikitml ships .js.map files that reference ../src/*.ts sources
// it does not publish and carries no sourcesContent. Vite extracts those
// maps while loading each dist file, tries to read the missing sources,
// and warns once per file. The maps are unusable, so serve the files
// without their sourceMappingURL comments and let them map to themselves.
// This must hook load: Vite extracts the map before transforms run.
const UIKITML_DIST_RE = /\/@drawcall\/uikitml\/dist\/[^?]*\.js$/;

function stripUikitmlSourcemapsPlugin(): Plugin {
  return {
    name: 'holoim-strip-uikitml-sourcemaps',
    enforce: 'pre',
    async load(id) {
      const file = id.split('?')[0] ?? '';
      if (!UIKITML_DIST_RE.test(file.replaceAll('\\', '/'))) return null;
      const code = await fs.readFile(file, 'utf-8');
      const stripped = code.replace(/^[ \t]*\/\/[#@]\s*sourceMappingURL=.*\r?$/gm, '');
      return { code: stripped, map: null };
    }
  };
}

// Assets the GLB optimizer must not rewrite. Its public-dir path ignores
// `exclude`, so these are filtered out of the temp public dir and copied
// verbatim at closeBundle (the optimizer's output also lands there).
// - avatar.glb: optimization breaks the skinned avatar.
// - scene.glb: optimization flips triangle winding (and mirrors some
//   meshes), corrupting the physics trimesh built from the scene — floors
//   become ceilings and the avatar falls through.
// - locomotion.glb: the clip library retargeted onto avatars without clips;
//   the optimizer writes it out unreadable, and its keys must stay exact.
const PRESERVED_MODEL_ASSETS = ['gltf/models/avatar.glb', 'gltf/models/scene.glb', 'gltf/animations/locomotion.glb'] as const;

function preserveModelAssetsPlugin(sourcePublicDir: string, tempPublicDir: string): Plugin {
  let outDir = path.resolve('dist');
  return {
    name: 'capture-preserve-model-assets',
    configResolved(config) {
      outDir = path.resolve(config.root, config.build.outDir);
    },
    async buildEnd(error) {
      if (error && tempPublicDir !== sourcePublicDir) {
        await fs.rm(tempPublicDir, { recursive: true, force: true });
      }
    },
    async closeBundle() {
      for (const asset of PRESERVED_MODEL_ASSETS) {
        const distPath = path.resolve(outDir, asset);
        await fs.mkdir(path.dirname(distPath), { recursive: true });
        await fs.copyFile(path.resolve(sourcePublicDir, asset), distPath);
      }
      if (tempPublicDir !== sourcePublicDir) {
        await fs.rm(tempPublicDir, { recursive: true, force: true });
      }
    }
  };
}

export default defineConfig(async ({ command }) => {
  const sourcePublicDir = path.resolve('public');
  const tempPublicDir =
    command === 'build'
      ? await (async () => {
          const filteredPublicDir = await fs.mkdtemp(path.join(os.tmpdir(), 'holoim-capture-public-'));
          await fs.cp(sourcePublicDir, filteredPublicDir, {
            recursive: true,
            filter: (src) => !PRESERVED_MODEL_ASSETS.some((asset) => src === path.resolve(sourcePublicDir, asset))
          });
          return filteredPublicDir;
        })()
      : sourcePublicDir;
  const aiMode = getAiMode();
  // The e2e test build (packages/tooling-testing/src/test-build.mjs): the
  // production build plus the IWER emulator and dev-only test features.
  const testBuild = process.env.HOLOIM_TEST_BUILD === '1';
  const buildPlugins = [
    iwsdkDev({
      emulator: {
        activation: 'localhost',
        // The face check emulates a Quest Pro, the profile with eye gaze.
        device: process.env.CAPTURE_IWER_DEVICE === 'metaQuestPro' ? 'metaQuestPro' : 'metaQuest3',
        injectOnBuild: testBuild
      },
      ...(aiMode
        ? {
            ai: {
              mode: aiMode,
              screenshotSize: { width: 640, height: 640 }
            }
          }
        : {})
    }),
    uikitmlBoundaryPlugin(),
    stripUikitmlSourcemapsPlugin(),
    preserveModelAssetsPlugin(sourcePublicDir, tempPublicDir),
    inputRecordingSinkPlugin(path.resolve('fixtures/input-recordings')),
    previewTestFilesPlugin(path.resolve('.'), ['fixtures', 'output']),
    optimizeGLTF({
      level: 'medium'
    })
  ];

  return {
    resolve: {
      // @holoim/xr-ui-iwsdk resolves its own pnpm copy of @iwsdk/core (no React
      // peer); one World needs one copy of IWSDK, UIKit and three.
      dedupe: ['@iwsdk/core', '@pmndrs/uikit', '@pmndrs/pointer-events', 'three']
    },
    plugins: buildPlugins,
    publicDir: tempPublicDir,
    define: {
      __HOLOIM_TEST_HOOKS__: JSON.stringify(command === 'serve' || testBuild)
    },
    // Object search and its GLBs come from viewer-api (PRD-060).
    server: {
      host: '0.0.0.0',
      proxy: { '/api': { target: apiProxyTarget, changeOrigin: true } }
    },
    preview: {
      proxy: { '/api': { target: apiProxyTarget, changeOrigin: true } }
    },
    build: {
      rollupOptions: {
        output: {
          manualChunks(id: string) {
            if (id.includes('/src/physics/')) return 'physics';
            if (id.includes('/src/xr/')) return 'xr';
            if (id.includes('/src/debug/')) return 'debug';
            // Leaves shared by xr and debug: left to rollup, they land in one of
            // those chunks and the two import each other (a TDZ error at startup).
            if (/\/node_modules\/(three|super-three)\//.test(id)) return 'three';
            if (id.includes('/packages/design-tokens/') || id.includes('/packages/xr-ui-core/')) return 'design';
            return undefined;
          }
        }
      }
    }
  };
});
