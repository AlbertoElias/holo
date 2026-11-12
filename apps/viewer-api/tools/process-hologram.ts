// Runs the hologram-budgets Q4 processing on a GLB and prints its report
// (sizes, encode times, animation error and savings). Measurement tool:
//   pnpm --filter @holoim/api exec tsx tools/process-hologram.ts <in.glb> <out-dir>
import { mkdir } from "node:fs/promises";
import path from "node:path";

import { processHologram } from "../src/services/hologram-process.js";

const [input, outDir] = process.argv.slice(2);
if (!input || !outDir) {
  console.error("usage: tsx tools/process-hologram.ts <in.glb> <out-dir>");
  process.exit(2);
}
await mkdir(outDir, { recursive: true });
let peak = 0;
const timer = setInterval(() => (peak = Math.max(peak, process.memoryUsage().rss)), 50);
const result = await processHologram(path.resolve(input), path.resolve(outDir));
clearInterval(timer);
peak = Math.max(peak, process.memoryUsage().rss);
console.log(JSON.stringify({ ...result, nodePeakRssMb: Math.round(peak / 1e6) }, null, 2));
