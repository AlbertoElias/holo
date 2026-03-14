import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 3174,
    strictPort: true,
    host: "0.0.0.0",
    // Allow dynamic ngrok hostnames during local mobile testing.
    allowedHosts: true,
    hmr: {
      clientPort: 443 // Use HTTPS port for ngrok
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
