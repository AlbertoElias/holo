import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { deflateSync } from 'node:zlib';

// Writes fixtures/objects/diagram.png: the image tray item the summon check
// and the viewer's summon spec record with (PRD-045). A 256×160 card whose
// quadrants have different colors (red top left, blue top right, yellow
// bottom left, green bottom right) inside a dark border, so its orientation
// reads in a screenshot. About 1 KB. Load it with
// ?tray=/fixtures/objects/diagram.png.

const OUT = path.resolve('fixtures/objects/diagram.png');
const WIDTH = 256;
const HEIGHT = 160;
const BORDER = 8;

function pixel(x, y) {
  if (x < BORDER || y < BORDER || x >= WIDTH - BORDER || y >= HEIGHT - BORDER) return [32, 36, 44];
  const left = x < WIDTH / 2;
  const top = y < HEIGHT / 2;
  if (top) return left ? [214, 52, 40] : [40, 90, 220];
  return left ? [240, 205, 30] : [40, 170, 90];
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

const header = Buffer.alloc(13);
header.writeUInt32BE(WIDTH, 0);
header.writeUInt32BE(HEIGHT, 4);
header[8] = 8; // bit depth
header[9] = 2; // RGB
const rows = [];
for (let y = 0; y < HEIGHT; y += 1) {
  rows.push(Buffer.from([0]));
  rows.push(Buffer.from(Array.from({ length: WIDTH }, (_, x) => pixel(x, y)).flat()));
}
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', header),
  chunk('IDAT', deflateSync(Buffer.concat(rows), { level: 9 })),
  chunk('IEND', Buffer.alloc(0))
]);
await mkdir(path.dirname(OUT), { recursive: true });
await writeFile(OUT, png);
console.log(`wrote ${OUT} (${png.length} bytes)`);
