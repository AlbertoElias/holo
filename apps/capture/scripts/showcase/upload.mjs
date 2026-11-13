import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

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
//      stores once (docs/features/agent-upload-token.md);
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
// A piece converts in under a minute on a laptop and in several on
// production's shared CPU, where a timed-out conversion is retried later.
const PREVIEW_WAIT_MS = 300_000;
const PREVIEW_POLL_MS = 2_000;

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

const KEYCHAIN_SERVICE = process.env.HOLOIM_KEYCHAIN_SERVICE || 'holoim-agent-upload';
const apiUrl = new URL(api);
const apiHost = apiUrl.host.toLowerCase();
const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(apiUrl.hostname.toLowerCase());

/** The Keychain's agent token for this host, or null. Read into memory only. */
function keychainToken() {
  if (process.platform !== 'darwin') return null;
  try {
    const value = execFileSync('security', ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-a', apiHost, '-w'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim();
    return value || null;
  } catch {
    return null; // no entry for this host
  }
}

const credential = process.env.HOLOIM_SESSION
  ? { token: process.env.HOLOIM_SESSION, source: 'HOLOIM_SESSION' }
  : (() => {
      const token = keychainToken();
      return token ? { token, source: `the Keychain (${KEYCHAIN_SERVICE}, ${apiHost})` } : null;
    })();
if (credential && apiUrl.protocol !== 'https:' && !loopback) {
  console.error(`refusing to send a token to ${apiUrl.origin} over plain http; use https.`);
  process.exit(1);
}
const authHeaders = credential ? { authorization: `Bearer ${credential.token}` } : {};
const setupHint = `scripts/agent-upload-token.sh setup ${apiUrl.origin} --email <agent account email>`;

if (credential) {
  const response = await fetch(new URL('/api/auth/me', api), { headers: authHeaders, redirect: 'error' });
  if (response.status === 401) {
    console.error(
      credential.source === 'HOLOIM_SESSION'
        ? 'The API refused HOLOIM_SESSION (signed out or expired). Sign in again, or unset it to use the Keychain token.'
        : `The API refused the agent token from ${credential.source} (revoked or never registered). Nothing was uploaded. Set up a new one with: scripts/agent-upload-token.sh revoke ${apiUrl.origin}; ${setupHint}`
    );
    process.exit(1);
  }
  if (!response.ok) {
    console.error(`checking the account: ${response.status} ${await response.text()}`);
    process.exit(1);
  }
  const account = await response.json();
  console.error(`uploading as ${account.displayName} (token from ${credential.source})`);
} else {
  console.error(`no token for ${apiHost}: uploading anonymously, which only a test API with TEST_OPEN_UPLOADS accepts. For an account: ${setupHint}`);
}
if (whoamiOnly) process.exit(0);

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
  const response = await fetch(new URL('/api/holograms', api), {
    method: 'POST',
    body: form,
    headers: authHeaders,
    redirect: 'error'
  });
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
