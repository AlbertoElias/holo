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

function preserveAvatarAssetPlugin(sourcePublicDir: string, tempPublicDir: string): Plugin {
  const avatarSourcePath = path.resolve(sourcePublicDir, 'gltf/models/avatar.glb');
  const distAvatarPath = path.resolve('dist/gltf/models/avatar.glb');

  return {
    name: 'capture-preserve-avatar-asset',
    async buildEnd(error) {
      if (error && tempPublicDir !== sourcePublicDir) {
        await fs.rm(tempPublicDir, { recursive: true, force: true });
      }
    },
    async closeBundle() {
      await fs.mkdir(path.dirname(distAvatarPath), { recursive: true });
      await fs.copyFile(avatarSourcePath, distAvatarPath);
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
            filter: (src) => src !== path.resolve(sourcePublicDir, 'gltf/models/avatar.glb')
          });
          return filteredPublicDir;
        })()
      : sourcePublicDir;
  const aiMode = getAiMode();
  const buildPlugins = [
    iwsdkDev({
      emulator: {
        activation: 'localhost',
        device: 'metaQuest3'
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
    preserveAvatarAssetPlugin(sourcePublicDir, tempPublicDir),
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
          manualChunks(id) {
            if (id.includes('/src/scene/')) return 'scene';
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
