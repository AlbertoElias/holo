import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { defineConfig, type Plugin } from 'vite';
import { iwsdkDev, type AiMode } from '@iwsdk/vite-plugin-dev';
import { optimizeGLTF } from '@iwsdk/vite-plugin-gltf-optimizer';

function getAiMode(): AiMode | undefined {
  const mode = process.env.IWSDK_DEV_AI_MODE;
  return mode === 'agent' || mode === 'collaborate' ? mode : undefined;
}

// Dev-only sink for raw headset input recorded during a capture session
// (see src/debug/inputRecording.ts). A headset on the LAN posts here and the
// file lands in the repo, ready to commit as a replay fixture.
const INPUT_RECORDING_LIMIT_BYTES = 50 * 1024 * 1024;

function inputRecordingSinkPlugin(outputDir: string): Plugin {
  return {
    name: 'holoim-input-recording-sink',
    apply: 'serve',
    configureServer(server) {
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
    }
  };
}

// IWSDK's World bootstrap always imports UIKitML. Its component kits build
// zod schemas for every Horizon component and import every lucide icon at
// startup: about 1 MB gzipped and 25 MB of retained heap. Capture never
// renders UIKitML (World's spatial UI is off), so builds and dev give
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
const PRESERVED_MODEL_ASSETS = ['gltf/models/avatar.glb', 'gltf/models/scene.glb'] as const;

function preserveModelAssetsPlugin(sourcePublicDir: string, tempPublicDir: string): Plugin {
  return {
    name: 'capture-preserve-model-assets',
    async buildEnd(error) {
      if (error && tempPublicDir !== sourcePublicDir) {
        await fs.rm(tempPublicDir, { recursive: true, force: true });
      }
    },
    async closeBundle() {
      for (const asset of PRESERVED_MODEL_ASSETS) {
        const distPath = path.resolve('dist', asset);
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
  const buildPlugins = [
    iwsdkDev({
      emulator: {
        activation: 'localhost',
        // The face check emulates a Quest Pro, the profile with eye gaze.
        device: process.env.CAPTURE_IWER_DEVICE === 'metaQuestPro' ? 'metaQuestPro' : 'metaQuest3'
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
    optimizeGLTF({
      level: 'medium'
    })
  ];

  return {
    plugins: buildPlugins,
    publicDir: tempPublicDir,
    server: {
      host: '0.0.0.0'
    },
    build: {
      rollupOptions: {
        output: {
          manualChunks(id: string) {
            if (id.includes('/src/physics/')) return 'physics';
            if (id.includes('/src/xr/')) return 'xr';
            if (id.includes('/src/debug/')) return 'debug';
            return undefined;
          }
        }
      }
    }
  };
});
