import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

// Writes fixtures/objects/credited-bracket.glb: bracket.glb with the credit
// the API writes into a packed Poly Haven model (PRD-060), `asset.copyright`
// and `asset.extras.holoimCredit`, so the Find check can pick a "found"
// object without the live registry. Run generate-object-fixture.mjs first if
// bracket.glb changes.

const SOURCE = path.resolve('fixtures/objects/bracket.glb');
const OUT = path.resolve('fixtures/objects/credited-bracket.glb');
const credit = {
  source: 'Poly Haven',
  sourceUrl: 'https://polyhaven.com/a/test_bracket',
  title: 'Test Bracket',
  author: 'Test Author',
  licence: 'CC0-1.0'
};

const GLB_HEADER_BYTES = 12;
const CHUNK_HEADER_BYTES = 8;
const glb = await readFile(SOURCE);
const jsonLength = glb.readUInt32LE(GLB_HEADER_BYTES);
const jsonStart = GLB_HEADER_BYTES + CHUNK_HEADER_BYTES;
const json = JSON.parse(glb.subarray(jsonStart, jsonStart + jsonLength).toString('utf8'));
json.asset = { ...json.asset, copyright: `“${credit.title}” by ${credit.author}, ${credit.source}, CC0`, extras: { holoimCredit: credit } };
let jsonBytes = Buffer.from(JSON.stringify(json), 'utf8');
jsonBytes = Buffer.concat([jsonBytes, Buffer.alloc((4 - (jsonBytes.length % 4)) % 4, 0x20)]);
const rest = glb.subarray(jsonStart + jsonLength);
const header = Buffer.from(glb.subarray(0, jsonStart));
header.writeUInt32LE(jsonBytes.length, GLB_HEADER_BYTES);
const out = Buffer.concat([header, jsonBytes, rest]);
out.writeUInt32LE(out.length, 8);
await writeFile(OUT, out);
console.log(`wrote ${OUT} (${out.length} bytes)`);
