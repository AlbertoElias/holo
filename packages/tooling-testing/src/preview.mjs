#!/usr/bin/env node
// Small JPEG previews of test images for agents to inspect. A full-size PNG
// costs hundreds of KB of context every turn after it is read; a preview
// costs a few tens. Needs ffmpeg; returns null when it is unavailable.

import { spawnSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MAX_SIDE = 800;
const SHEET_COLUMNS = 4;
const SHEET_ROWS = 3;
const TILE_WIDTH = 256;

function ffmpeg(args) {
  const result = spawnSync('ffmpeg', ['-loglevel', 'error', '-y', ...args], { stdio: 'inherit' });
  return result.status === 0;
}

/** Downscales one image so its longest side is at most 800px. */
export function writeImagePreview(imagePath, outPath = imagePath.replace(/\.\w+$/, '-preview.jpg')) {
  const scale = `scale='min(${MAX_SIDE},iw)':'min(${MAX_SIDE},ih)':force_original_aspect_ratio=decrease`;
  return ffmpeg(['-i', imagePath, '-vf', scale, '-q:v', '5', outPath]) ? outPath : null;
}

/** Tiles 12 evenly spaced frames of a PNG frame directory into one 4×3 sheet. */
export function writeContactSheet(frameDir, outPath = `${frameDir.replace(/\/$/, '')}-sheet.jpg`) {
  const frames = readdirSync(frameDir).filter((name) => name.endsWith('.png')).sort();
  if (frames.length === 0) return null;
  const step = Math.max(1, Math.floor(frames.length / (SHEET_COLUMNS * SHEET_ROWS)));
  const filter = `select='not(mod(n\\,${step}))',scale=${TILE_WIDTH}:-2,tile=${SHEET_COLUMNS}x${SHEET_ROWS}`;
  const ok = ffmpeg([
    '-pattern_type', 'glob', '-i', path.join(frameDir, '*.png'),
    '-vf', filter, '-frames:v', '1', '-q:v', '5', outPath
  ]);
  return ok ? outPath : null;
}

// CLI: node packages/tooling-testing/src/preview.mjs <image-or-frame-dir> [out.jpg]
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [input, out] = process.argv.slice(2);
  if (!input) {
    console.error('usage: preview.mjs <image-or-frame-dir> [out.jpg]');
    process.exit(2);
  }
  const written = statSync(input).isDirectory() ? writeContactSheet(input, out) : writeImagePreview(input, out);
  if (!written) {
    console.error('preview failed (is ffmpeg installed?)');
    process.exit(1);
  }
  console.log(written);
}
