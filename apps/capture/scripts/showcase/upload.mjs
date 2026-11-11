import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

// Uploads built showcase holograms through the viewer API's normal upload
// route, so they appear in the feed like any recorded take.
//
//   node scripts/showcase/upload.mjs --api http://127.0.0.1:3001 <scene> [<scene> ...] [--no-quick-look]
//
// Build first (build.mjs). `--api` is required: there is no default target,
// so nothing is published anywhere by accident.
//
// Quick Look (the iPhone AR preview) is opt-in per upload, like the upload
// panel's checkbox: the API converts a GLB to USDZ only when the upload asks
// for it, and nothing can turn it on afterwards. This script asks for it by
// default (`--no-quick-look` does not), waits for the conversion and prints
// how it ended. The converter carries these pieces' vertex colours since
// B-042; an API whose converter predates that converts them white. A piece
// whose preview fails is still uploaded; the script then exits 2, and
// uploading it again would only add a duplicate.

const here = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.resolve(here, '../../../../output/showcase');
// A piece converts in under a minute on a laptop and in several on
// production's shared CPU, where a timed-out conversion is retried later.
const PREVIEW_WAIT_MS = 300_000;
const PREVIEW_POLL_MS = 2_000;

const args = process.argv.slice(2);
const apiIndex = args.indexOf('--api');
const api = apiIndex >= 0 ? args[apiIndex + 1] : undefined;
const quickLook = !args.includes('--no-quick-look');
const names = args.filter((arg, index) => !arg.startsWith('--') && index !== apiIndex + 1);
if (!api || names.length === 0) {
  console.error('usage: upload.mjs --api <origin> <scene> [<scene> ...] [--no-quick-look]');
  process.exit(1);
}

/** The preview's last status: `ready`, `failed`, or what it still was when the wait ran out. */
async function waitForPreview(id) {
  const deadline = Date.now() + PREVIEW_WAIT_MS;
  for (;;) {
    const response = await fetch(new URL(`/api/holograms/${id}`, api));
    if (!response.ok) throw new Error(`reading hologram ${id}: ${response.status} ${await response.text()}`);
    const dto = await response.json();
    if (dto.usdzStatus === 'ready' || dto.usdzStatus === 'failed' || Date.now() >= deadline) return dto;
    await sleep(PREVIEW_POLL_MS);
  }
}

const withoutPreview = [];
for (const name of names) {
  const { meta } = await import(`./${name}.mjs`);
  const bytes = await readFile(path.join(outDir, `${meta.slug}.glb`));
  const form = new FormData();
  form.set('hologramName', meta.name);
  form.set('submittedBy', meta.submittedBy);
  form.set('quickLookEnabled', String(quickLook));
  form.set('file', new Blob([bytes], { type: 'model/gltf-binary' }), `${meta.slug}.glb`);
  const response = await fetch(new URL('/api/holograms', api), { method: 'POST', body: form });
  const body = await response.text();
  if (!response.ok) {
    console.error(`${name}: ${response.status} ${body}`);
    process.exit(1);
  }
  const dto = JSON.parse(body);
  const report = { scene: name, id: dto.id, hologramName: dto.hologramName, sizeBytes: dto.sizeBytes, url: dto.url };
  if (quickLook) {
    const preview = await waitForPreview(dto.id);
    Object.assign(report, { usdzStatus: preview.usdzStatus, usdzUrl: preview.usdzUrl });
    if (preview.usdzStatus !== 'ready') withoutPreview.push(`${name} (${preview.usdzStatus})`);
  }
  console.log(JSON.stringify(report));
}

if (withoutPreview.length > 0) {
  console.error(`uploaded, but without a Quick Look preview: ${withoutPreview.join(', ')}. The API log has the reason; do not upload these again.`);
  process.exit(2);
}
