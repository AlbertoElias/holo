import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { defineConfig, type Plugin } from 'vite';
import basicSsl from '@vitejs/plugin-basic-ssl';
import { optimizeGLTF } from '@iwsdk/vite-plugin-gltf-optimizer';
import { injectIWER } from '@iwsdk/vite-plugin-iwer';

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
  const buildPlugins = [
    basicSsl(),
    injectIWER({
      activation: 'localhost',
      device: 'metaQuest3'
    }),
    preserveAvatarAssetPlugin(sourcePublicDir, tempPublicDir),
    optimizeGLTF({
      level: 'medium'
    })
  ];

  return {
    plugins: buildPlugins,
    publicDir: tempPublicDir,
    server: {
      host: '0.0.0.0',
      https: true
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
