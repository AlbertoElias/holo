import { defineConfig } from 'vite';
import basicSsl from '@vitejs/plugin-basic-ssl';
import { optimizeGLTF } from '@iwsdk/vite-plugin-gltf-optimizer';
import { injectIWER } from '@iwsdk/vite-plugin-iwer';

export default defineConfig({
  plugins: [
    basicSsl(),
    injectIWER({
      activation: 'localhost',
      device: 'metaQuest3'
    }),
    optimizeGLTF({
      level: 'medium',
      include: /\/gltf\/.*\.(gltf|glb)$/i
    })
  ],
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
});
