import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Uploads built showcase holograms through the viewer API's normal upload
// route, so they appear in the feed like any recorded take.
//
//   node scripts/showcase/upload.mjs --api http://127.0.0.1:3001 <scene> [<scene> ...]
//
// Build first (build.mjs). `--api` is required: there is no default target,
// so nothing is published anywhere by accident.

const here = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.resolve(here, '../../../../output/showcase');

const args = process.argv.slice(2);
const apiIndex = args.indexOf('--api');
const api = apiIndex >= 0 ? args[apiIndex + 1] : undefined;
const names = args.filter((arg, index) => !arg.startsWith('--') && index !== apiIndex + 1);
if (!api || names.length === 0) {
  console.error('usage: upload.mjs --api <origin> <scene> [<scene> ...]');
  process.exit(1);
}

for (const name of names) {
  const { meta } = await import(`./${name}.mjs`);
  const bytes = await readFile(path.join(outDir, `${meta.slug}.glb`));
  const form = new FormData();
  form.set('hologramName', meta.name);
  form.set('submittedBy', meta.submittedBy);
  form.set('file', new Blob([bytes], { type: 'model/gltf-binary' }), `${meta.slug}.glb`);
  const response = await fetch(new URL('/api/holograms', api), { method: 'POST', body: form });
  const body = await response.text();
  if (!response.ok) {
    console.error(`${name}: ${response.status} ${body}`);
    process.exit(1);
  }
  const dto = JSON.parse(body);
  console.log(JSON.stringify({ scene: name, id: dto.id, hologramName: dto.hologramName, sizeBytes: dto.sizeBytes, url: dto.url }));
}
