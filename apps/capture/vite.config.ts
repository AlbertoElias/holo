import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    host: '0.0.0.0',
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
