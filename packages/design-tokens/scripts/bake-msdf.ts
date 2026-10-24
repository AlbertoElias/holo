/**
 * Bakes the MSDF atlases that 3D text uses (styleguide section 7) from the
 * self-hosted variable fonts in src/fonts: Fraunces 600 and Figtree 400, 500, 600.
 *
 *   pnpm --filter @holoim/design-tokens run bake:msdf
 *
 * 1. scripts/instance-font.py pins each variable WOFF2 to fixed axis values
 *    (fontTools; needs `python3` with `fonttools` and `brotli`, or set
 *    HOLOIM_PYTHON to such an interpreter).
 * 2. @zappar/msdf-generator (msdfgen compiled to WASM) rasterises the charset
 *    into an MSDF atlas. It is written for a browser Worker, so it runs here
 *    inside a Node worker thread with a minimal ImageData, fetch and
 *    message-port shim; no browser is involved.
 * 3. The atlas is written as <face>-<weight>.png plus BMFont JSON in the shape
 *    @pmndrs/uikit reads. Output is deterministic: re-running changes nothing.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import { deflateSync } from "node:zlib";

interface Job {
  face: "fraunces" | "figtree";
  family: string;
  weight: number;
  source: string;
  /** Extra axis pins besides wght. */
  axes: Record<string, number>;
}

const JOBS: readonly Job[] = [
  // Titles. Optical size is pinned at 32, near the desktop title's 41.6px (31pt).
  { face: "fraunces", family: "Fraunces", weight: 600, source: "fraunces-latin-opsz-normal.woff2", axes: { opsz: 32 } },
  { face: "figtree", family: "Figtree", weight: 400, source: "figtree-latin-wght-normal.woff2", axes: {} },
  { face: "figtree", family: "Figtree", weight: 500, source: "figtree-latin-wght-normal.woff2", axes: {} },
  { face: "figtree", family: "Figtree", weight: 600, source: "figtree-latin-wght-normal.woff2", axes: {} }
];

const FONT_SIZE = 42;
const FIELD_RANGE = 4;
const TEXTURE_SIZES = [512, 1024] as const;

/** Printable ASCII, Latin-1 Supplement, and the typographic marks the styleguide uses. */
function wantedCodePoints(): number[] {
  const wanted = new Set<number>();
  for (let cp = 0x20; cp <= 0x7e; cp += 1) wanted.add(cp);
  for (let cp = 0xa0; cp <= 0xff; cp += 1) wanted.add(cp);
  // ‘ ’ “ ” – — … · • × ½ ¼ ¾ (the last four are Latin-1 and already in)
  for (const cp of [0x2018, 0x2019, 0x201c, 0x201d, 0x2013, 0x2014, 0x2026, 0xb7, 0x2022, 0xd7]) wanted.add(cp);
  return [...wanted].sort((a, b) => a - b);
}

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fontsDir = path.join(packageRoot, "src", "fonts");
const outDir = path.join(fontsDir, "msdf");

// --- generator in a Node worker thread -------------------------------------

// The package's "exports" map has no package.json entry, so locate it through the symlink.
const generatorDir = realpathSync(path.join(packageRoot, "node_modules", "@zappar", "msdf-generator"));
const generatorWorker = path.join(generatorDir, "dist", "worker.js");
const requireFromGenerator = createRequire(generatorWorker);
const comlinkUrl = pathToFileURL(requireFromGenerator.resolve("comlink/dist/esm/comlink.mjs")).href;
const nodeAdapterUrl = pathToFileURL(requireFromGenerator.resolve("comlink/dist/esm/node-adapter.mjs")).href;

/** Gives the browser-targeted worker the few globals it touches, then loads it. */
const WORKER_BOOTSTRAP = `
const { parentPort, workerData } = require("node:worker_threads");
const { readFile } = require("node:fs/promises");
const { fileURLToPath } = require("node:url");

globalThis.ImageData = class ImageData {
  constructor(data, width, height) { this.data = data; this.width = width; this.height = height; }
};
const nativeFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = String(input);
  if (!url.startsWith("file:")) return nativeFetch(input, init);
  return new Response(await readFile(fileURLToPath(url)), { headers: { "content-type": "application/wasm" } });
};
const listeners = new Map();
globalThis.addEventListener = (type, listener) => {
  const wrapped = (data) => listener({ data });
  listeners.set(listener, wrapped);
  parentPort.on(type, wrapped);
};
globalThis.removeEventListener = (type, listener) => {
  parentPort.off(type, listeners.get(listener));
  listeners.delete(listener);
};
globalThis.postMessage = (message, transfer) => parentPort.postMessage(message, transfer);

import(workerData.workerUrl);
`;

interface GlyphChar {
  id: number;
  char: string;
  x: number;
  y: number;
  width: number;
  height: number;
  [key: string]: unknown;
}

interface AtlasJson {
  pages: string[];
  chars: GlyphChar[];
  info: Record<string, unknown>;
  common: Record<string, unknown>;
  distanceField: Record<string, unknown>;
  kernings: Record<string, unknown>[];
}

interface Atlas {
  texture: { data: Uint8ClampedArray; width: number; height: number };
  glyphs: { atlasPosition: [number, number]; atlasSize: [number, number] }[];
  textureSize: [number, number];
}

interface GeneratorApi {
  initialize(wasmBinaryUrl?: string): Promise<void>;
  loadFont(font: Uint8Array): Promise<void>;
  generateAtlas(options: {
    font: Uint8Array;
    charset: string;
    fontSize: number;
    textureSize: [number, number];
    fieldRange: number;
    fixOverlaps: boolean;
  }): Promise<Atlas>;
  exportJSON(options: { atlas: Atlas; fontSize: number }): Promise<AtlasJson>;
  dispose(): Promise<void>;
}

// --- helpers ---------------------------------------------------------------

function instanceFont(job: Job, scratch: string): { ttf: Uint8Array; codePoints: Set<number> } {
  const python = process.env.HOLOIM_PYTHON ?? "python3";
  const out = path.join(scratch, `${job.face}-${job.weight}.ttf`);
  const pins = Object.entries({ wght: job.weight, ...job.axes }).map(([axis, value]) => `${axis}=${value}`);
  const stdout = execFileSync(
    python,
    ["-I", path.join(packageRoot, "scripts", "instance-font.py"), path.join(fontsDir, job.source), out, ...pins],
    { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] }
  );
  return { ttf: new Uint8Array(readFileSync(out)), codePoints: new Set(JSON.parse(stdout) as number[]) };
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** 8-bit RGB PNG. The atlas alpha is always 255, so it is not stored. */
function encodePng(rgba: Uint8ClampedArray, width: number, height: number): Buffer {
  const raw = Buffer.alloc(height * (1 + width * 3));
  for (let y = 0; y < height; y += 1) {
    const row = y * (1 + width * 3);
    raw[row] = 0;
    for (let x = 0; x < width; x += 1) {
      const src = (y * width + x) * 4;
      const dst = row + 1 + x * 3;
      raw[dst] = rgba[src]!;
      raw[dst + 1] = rgba[src + 1]!;
      raw[dst + 2] = rgba[src + 2]!;
    }
  }
  const chunk = (type: string, data: Buffer): Buffer => {
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0))
  ]);
}

function fits(atlas: Atlas): boolean {
  const [width, height] = atlas.textureSize;
  return atlas.glyphs.every(
    ({ atlasPosition: [x, y], atlasSize: [w, h] }) => x + w <= width && y + h <= height
  );
}

/** Fixed key order, no timestamps: the same inputs give the same bytes. */
function stableJson(json: AtlasJson, job: Job, pageName: string): string {
  const { info, common, distanceField } = json;
  const ordered: AtlasJson = {
    pages: [pageName],
    chars: json.chars.map((c) => ({
      id: c.id,
      index: c["index"],
      char: c.char,
      width: c.width,
      height: c.height,
      xoffset: c["xoffset"],
      yoffset: c["yoffset"],
      xadvance: c["xadvance"],
      chnl: c["chnl"],
      x: c.x,
      y: c.y,
      page: c["page"]
    })),
    info: { ...info, face: job.family },
    common,
    distanceField,
    kernings: json.kernings
  };
  return `${JSON.stringify(ordered, null, 2)}\n`;
}

// --- main ------------------------------------------------------------------

async function main(): Promise<void> {
  const scratch = mkdtempSync(path.join(tmpdir(), "holoim-msdf-"));
  mkdirSync(outDir, { recursive: true });

  const worker = new Worker(WORKER_BOOTSTRAP, { eval: true, workerData: { workerUrl: pathToFileURL(generatorWorker).href } });
  try {
    const { wrap } = (await import(comlinkUrl)) as { wrap: <T>(endpoint: unknown) => T };
    const { default: nodeEndpoint } = (await import(nodeAdapterUrl)) as { default: (worker: Worker) => unknown };
    const api = wrap<GeneratorApi>(nodeEndpoint(worker));
    await api.initialize();

    const wanted = wantedCodePoints();
    for (const job of JOBS) {
      const { ttf, codePoints } = instanceFont(job, scratch);
      const present = wanted.filter((cp) => codePoints.has(cp));
      const missing = wanted.filter((cp) => !codePoints.has(cp));
      const charset = String.fromCodePoint(...present);

      await api.loadFont(ttf);
      let atlas: Atlas | undefined;
      for (const size of TEXTURE_SIZES) {
        const candidate = await api.generateAtlas({
          font: new Uint8Array(0),
          charset,
          fontSize: FONT_SIZE,
          textureSize: [size, size],
          fieldRange: FIELD_RANGE,
          fixOverlaps: true
        });
        if (fits(candidate)) {
          atlas = candidate;
          break;
        }
      }
      if (!atlas) throw new Error(`${job.face}-${job.weight}: charset does not fit ${TEXTURE_SIZES.at(-1)}px`);

      const json = await api.exportJSON({ atlas, fontSize: FONT_SIZE });
      const name = `${job.face}-${job.weight}`;
      const png = encodePng(atlas.texture.data, atlas.texture.width, atlas.texture.height);
      writeFileSync(path.join(outDir, `${name}.png`), png);
      writeFileSync(path.join(outDir, `${name}.json`), stableJson(json, job, `${name}.png`));
      const gaps = missing.length > 0 ? `, not in font: ${missing.map((cp) => cp.toString(16)).join(" ")}` : "";
      console.log(`${name}: ${present.length} glyphs, ${atlas.textureSize[0]}px, ${(png.length / 1024).toFixed(1)} KB${gaps}`);
    }
    await api.dispose();
  } finally {
    await worker.terminate();
    rmSync(scratch, { recursive: true, force: true });
  }
}

await main();
