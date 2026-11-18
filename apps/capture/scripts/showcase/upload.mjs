import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { checkAccount, findCredential, insecureTarget, setupHint as hint, uploadHologram, waitForPreview } from './lib/upload.mjs';

// Uploads built showcase holograms through the viewer API's normal upload
// route, so they appear in the feed like any recorded take.
//
//   node scripts/showcase/upload.mjs --api http://127.0.0.1:3001 <scene> [<scene> ...] [--no-quick-look]
//
//   node scripts/showcase/upload.mjs --api <origin> --whoami     (only says which account it would upload as)
//
// Build first (build.mjs). `--api` is required: there is no default target,
// so nothing is published anywhere by accident. Uploads need a signed-in
// creator. The script uses, in order:
//   1. HOLOIM_SESSION, a session token (the `token` that POST /api/auth/verify
//      returns for an emailed sign-in link);
//   2. the agent upload token for the `--api` host in the macOS Keychain
//      (service `holoim-agent-upload`, account = the host, e.g.
//      `holoim-api.fly.dev`), which `scripts/agent-upload-token.sh setup`
//      stores once (docs/features/archive/agent-upload-token.md);
//   3. nothing: an anonymous upload, which only a test API with
//      TEST_OPEN_UPLOADS accepts.
// A Keychain token goes only to the host it was stored for, never over plain
// http to a remote host, and never through a redirect. Nothing prints it.
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

const args = process.argv.slice(2);
const apiIndex = args.indexOf('--api');
const api = apiIndex >= 0 ? args[apiIndex + 1] : undefined;
const quickLook = !args.includes('--no-quick-look');
const whoamiOnly = args.includes('--whoami');
const names = args.filter((arg, index) => !arg.startsWith('--') && index !== apiIndex + 1);
if (!api || (names.length === 0 && !whoamiOnly)) {
  console.error('usage: upload.mjs --api <origin> <scene> [<scene> ...] [--no-quick-look] | --api <origin> --whoami');
  process.exit(1);
}

const apiUrl = new URL(api);
const apiHost = apiUrl.host.toLowerCase();
const credential = findCredential(apiUrl);
const insecure = insecureTarget(apiUrl, credential);
if (insecure) {
  console.error(insecure);
  process.exit(1);
}
const authHeaders = credential ? { authorization: `Bearer ${credential.token}` } : {};
const setupHint = hint(apiUrl);

if (credential) {
  const checked = await checkAccount(apiUrl, credential);
  if (checked.error) {
    console.error(checked.error);
    process.exit(1);
  }
  console.error(`uploading as ${checked.account.displayName} (token from ${credential.source})`);
} else {
  console.error(`no token for ${apiHost}: uploading anonymously, which only a test API with TEST_OPEN_UPLOADS accepts. For an account: ${setupHint}`);
}
if (whoamiOnly) process.exit(0);

const withoutPreview = [];
for (const name of names) {
  const { meta } = await import(`./${name}.mjs`);
  const bytes = await readFile(path.join(outDir, `${meta.slug}.glb`));
  const uploaded = await uploadHologram({ api, authHeaders, name: meta.name, submittedBy: meta.submittedBy, bytes, filename: `${meta.slug}.glb`, quickLook });
  if (uploaded.error) {
    console.error(`${name}: ${uploaded.error}`);
    process.exit(1);
  }
  const dto = uploaded.dto;
  const report = { scene: name, id: dto.id, hologramName: dto.hologramName, sizeBytes: dto.sizeBytes, url: dto.url };
  if (quickLook) {
    const preview = await waitForPreview(api, dto.id);
    Object.assign(report, { usdzStatus: preview.usdzStatus, usdzUrl: preview.usdzUrl });
    if (preview.usdzStatus !== 'ready') withoutPreview.push(`${name} (${preview.usdzStatus})`);
  }
  console.log(JSON.stringify(report));
}

if (withoutPreview.length > 0) {
  console.error(`uploaded, but without a Quick Look preview: ${withoutPreview.join(', ')}. The API log has the reason; do not upload these again.`);
  process.exit(2);
}
