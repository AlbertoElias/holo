import { injectIWER } from "@iwsdk/vite-plugin-iwer";
import basicSsl from "@vitejs/plugin-basic-ssl";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const hmrClientPort = Number(process.env.VITE_HMR_CLIENT_PORT ?? "3174");
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

export default defineConfig({
  plugins: [
    react(),
    basicSsl(),
    injectIWER({
      activation: "localhost",
      device: "metaQuest3",
      ...(semConfig ? { sem: semConfig } : {})
      })
  ],
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes("node_modules")) {
            if (
              id.includes("@react-three/fiber") ||
              id.includes("@react-three/drei") ||
              id.includes("@react-three/xr") ||
              id.includes("three") ||
              id.includes("react-dom") ||
              id.includes("react-router-dom") ||
              id.includes("react")
            ) {
              return "react-three-vendor";
            }

            if (id.includes("@react-three/uikit") || id.includes("@holoim/ui-dom")) {
              return "ui-vendor";
            }

            if (id.includes("@holoim/xr-runtime") || id.includes("@holoim/xr-ui-core") || id.includes("@holoim/xr-ui-r3f")) {
              return "xr-vendor";
            }
          }
        }
      }
    }
  },
  server: {
    port: 3174,
    strictPort: true,
    host: "0.0.0.0",
    https: {},
    // Allow dynamic ngrok hostnames during local mobile testing.
    allowedHosts: true,
    hmr: {
      // Local HTTPS uses 3174; ngrok-style tunnels can override this to 443.
      clientPort: Number.isFinite(hmrClientPort) ? hmrClientPort : 3174
    },
    proxy: {
      "/api": {
        target: "http://127.0.0.1:3001",
        changeOrigin: true
      },
      "/uploads": {
        target: "http://127.0.0.1:3001",
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
