import path from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { knowledgePlugin } from "./tooling/knowledge-plugin";

const appRoot = path.dirname(fileURLToPath(import.meta.url));
export default defineConfig({
  plugins: [react(), knowledgePlugin(path.resolve(appRoot, "../.."))],
  server: {
    host: "127.0.0.1",
    port: Number(process.env.KNOWLEDGE_PORT ?? 4176),
    strictPort: true,
    // Poll the small app/docs roots so edits from other agents, atomic renames,
    // and sandboxed macOS sessions do not depend on native filesystem events.
    watch: { usePolling: true, interval: 300 },
    fs: { strict: true, allow: [appRoot] },
  },
  preview: { port: 4176, strictPort: true },
});
