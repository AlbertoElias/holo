// Prints the inventory table (Markdown) from each app's manifest.json, for
// pasting into docs/product/design/inventory/README.md after a capture run.
// Usage: node scripts/ui-inventory/readme-table.mjs
/* global console */

import { readFileSync } from 'node:fs';
import path from 'node:path';

import { inventoryDir } from './lib.mjs';

const SURFACE_ORDER = ['Desktop', 'Mobile', 'VR', 'AR'];
const surfaceRank = (surface) => {
  const index = SURFACE_ORDER.findIndex((prefix) => surface.startsWith(prefix));
  return index === -1 ? SURFACE_ORDER.length : index;
};
const cell = (value = '') => String(value).replaceAll('|', '\\|').replaceAll('\n', ' ');

for (const app of ['viewer-web', 'capture']) {
  const entries = JSON.parse(readFileSync(path.join(inventoryDir, app, 'manifest.json'), 'utf8'))
    .sort((a, b) => surfaceRank(a.surface) - surfaceRank(b.surface) || a.screen.localeCompare(b.screen) || a.file.localeCompare(b.file));
  const counts = {};
  for (const entry of entries) {
    const key = SURFACE_ORDER[surfaceRank(entry.surface)] ?? 'Other';
    counts[key] = (counts[key] ?? 0) + 1;
  }
  console.log(`\n### ${app} (${entries.length}: ${Object.entries(counts).map(([key, count]) => `${key} ${count}`).join(', ')})\n`);
  console.log('| App | Surface | Route or entry | Screen | State | File | Component | Notes |');
  console.log('|---|---|---|---|---|---|---|---|');
  for (const entry of entries) {
    console.log(`| ${app} | ${cell(entry.surface)} | \`${cell(entry.route)}\` | ${cell(entry.screen)} | ${cell(entry.state)} | [${path.basename(entry.file)}](${entry.file}) | ${cell(entry.component)} | ${cell(entry.notes)} |`);
  }
}
