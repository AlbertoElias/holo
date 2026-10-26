import { iwsdkDev } from "@iwsdk/vite-plugin-dev";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const hmrClientPort = Number(process.env.VITE_HMR_CLIENT_PORT ?? "3174");
const apiProxyTarget = process.env.VITE_API_PROXY_TARGET ?? "http://127.0.0.1:3001";
const semScene = process.env.VITE_IWER_SEM_SCENE;
const validSemScenes = [
  "living_room",
  "meeting_room",
  "music_room",
  "office_large",
  "office_small"
 ] as const;

type SemScene = (typeof validSemScenes)[number];

function isSemScene(value: string): value is SemScene {
  return validSemScenes.includes(value as SemScene);
}

const semConfig = semScene && isSemScene(semScene)
  ? { defaultScene: semScene }
  : undefined;

// Vendor packages the feed needs for its first render; long-lived chunks that
// stay cached across app deploys.
const reactVendor = new Set(["react", "react-dom", "scheduler", "react-router", "react-router-dom"]);
const threeVendor = new Set(["three", "super-three", "@react-three/fiber", "@react-three/drei", "three-stdlib"]);

function packageName(id: string): string | undefined {
  const match = /.*\/node_modules\/((?:@[^/]+\/)?[^/]+)/.exec(id);
  return match?.[1];
}

export default defineConfig({
  resolve: {
    // @holoim/xr-ui-iwsdk resolves its own pnpm copy of @iwsdk/core (no React
    // peer); one World needs one copy of IWSDK, UIKit and three.
    dedupe: ["@iwsdk/core", "@pmndrs/uikit", "@pmndrs/pointer-events", "three"]
  },
  plugins: [
    react(),
    iwsdkDev({
      emulator: {
        activation: "localhost",
        device: "metaQuest3",
        ...(semConfig ? { environment: semConfig.defaultScene } : {})
      }
    })
  ],
  build: {
    rollupOptions: {
      output: {
        // Group by exact package name, never by path substring: pnpm paths
        // carry peer names (".../iwer@x_super-three@y/..."), so a substring
        // match on "three" pulled the IWER emulator into the eager chunk.
        // Anything unlisted (the AR-only @react-three/xr, the emulator that
        // @pmndrs/xr imports only when `emulate` is on) stays in whichever
        // lazy chunk imports it.
        manualChunks(id) {
          const name = packageName(id);
          if (name && reactVendor.has(name)) {
            return "react-vendor";
          }
          // three's core only: its examples/jsm addons follow whichever
          // chunk imports them (most belong to the lazy IWSDK view).
          if (name && threeVendor.has(name) && !id.includes("/examples/jsm/")) {
            return "three-vendor";
          }
        }
      }
    }
  },
  server: {
    port: 3174,
    strictPort: true,
    host: "0.0.0.0",
    // Allow dynamic ngrok hostnames during local mobile testing.
    allowedHosts: true,
    hmr: {
      // Local HTTPS uses 3174; ngrok-style tunnels can override this to 443.
      clientPort: Number.isFinite(hmrClientPort) ? hmrClientPort : 3174
    },
    proxy: {
      "/api": {
        target: apiProxyTarget,
        changeOrigin: true
      },
      "/uploads": {
        target: apiProxyTarget,
        changeOrigin: true
      }
    },
    headers: {
      "Access-Control-Allow-Origin": "*"
    }
  },
  define: {
    __VITE_IS_MODERN_BROWSER__: true
  }
});
