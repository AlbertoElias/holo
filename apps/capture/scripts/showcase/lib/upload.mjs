import { execFileSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

// The upload path every authored hologram takes, shared by upload.mjs (a
// showcase scene) and authoring/publish.ts (a directed take): which credential
// to send, who the API says it is, the upload itself, and the wait for the
// Quick Look preview. Nothing here prints a token.

// A piece converts in under a minute on a laptop and in several on
// production's shared CPU, where a timed-out conversion is retried later.
const PREVIEW_WAIT_MS = 300_000;
const PREVIEW_POLL_MS = 2_000;

const KEYCHAIN_SERVICE = process.env.HOLOIM_KEYCHAIN_SERVICE || 'holoim-agent-upload';

export const isLoopback = (apiUrl) => ['localhost', '127.0.0.1', '[::1]'].includes(apiUrl.hostname.toLowerCase());

/** The Keychain's agent token for this host, or null. Read into memory only. */
function keychainToken(apiHost) {
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

/**
 * The credential to upload with, or null: HOLOIM_SESSION, else (when
 * `envNames` lists more, those first) the Keychain entry for the host.
 */
export function findCredential(apiUrl, envNames = ['HOLOIM_SESSION']) {
  for (const name of envNames) if (process.env[name]) return { token: process.env[name], source: name };
  const token = keychainToken(apiUrl.host.toLowerCase());
  return token ? { token, source: `the Keychain (${KEYCHAIN_SERVICE}, ${apiUrl.host.toLowerCase()})` } : null;
}

export const setupHint = (apiUrl) => `scripts/agent-upload-token.sh setup ${apiUrl.origin} --email <agent account email>`;

/** Refuses a token over plain http to a remote host. Returns an error text, or null. */
export function insecureTarget(apiUrl, credential) {
  return credential && apiUrl.protocol !== 'https:' && !isLoopback(apiUrl) ? `refusing to send a token to ${apiUrl.origin} over plain http; use https.` : null;
}

/** Asks the API who the credential is. Returns `{ account }` or `{ error }` (nothing is printed). */
export async function checkAccount(apiUrl, credential) {
  const response = await fetch(new URL('/api/auth/me', apiUrl), { headers: { authorization: `Bearer ${credential.token}` }, redirect: 'error' });
  if (response.status === 401) {
    return {
      error: credential.source.startsWith('HOLOIM_')
        ? `The API refused ${credential.source} (signed out, revoked or expired). Nothing was uploaded.`
        : `The API refused the agent token from ${credential.source} (revoked or never registered). Nothing was uploaded. Set up a new one with: scripts/agent-upload-token.sh revoke ${apiUrl.origin}; ${setupHint(apiUrl)}`
    };
  }
  if (!response.ok) return { error: `checking the account: ${response.status} ${await response.text()}` };
  return { account: await response.json() };
}

/** The preview's last status: `ready`, `failed`, or what it still was when the wait ran out. */
export async function waitForPreview(api, id) {
  const deadline = Date.now() + PREVIEW_WAIT_MS;
  for (;;) {
    const response = await fetch(new URL(`/api/holograms/${id}`, api));
    if (!response.ok) throw new Error(`reading hologram ${id}: ${response.status} ${await response.text()}`);
    const dto = await response.json();
    if (dto.usdzStatus === 'ready' || dto.usdzStatus === 'failed' || Date.now() >= deadline) return dto;
    await sleep(PREVIEW_POLL_MS);
  }
}

/** POST /api/holograms. Returns `{ dto }` or `{ error }`. */
export async function uploadHologram({ api, authHeaders, name, submittedBy, bytes, filename, quickLook }) {
  const form = new FormData();
  form.set('hologramName', name);
  form.set('submittedBy', submittedBy);
  form.set('quickLookEnabled', String(quickLook));
  form.set('file', new Blob([bytes], { type: 'model/gltf-binary' }), filename);
  const response = await fetch(new URL('/api/holograms', api), { method: 'POST', body: form, headers: authHeaders, redirect: 'error' });
  const body = await response.text();
  if (!response.ok) return { error: `${response.status} ${body}` };
  return { dto: JSON.parse(body) };
}

/**
 * What the USDZ conversion has to evaluate for its extents, split as the
 * converter splits it (apps/viewer-api/tools/glb_to_usdz.py): deformed
 * meshes (morph targets) cost their points at every frame of the whole
 * scene; rigid meshes cost their points at every frame of their own node
 * chain when the node or an ancestor is animated, and once otherwise. A
 * node's frames are the 30 Hz grid over the clip, its own key times, and a
 * pre-sample 10 µs before each of its STEP keys after the first; the
 * scene's are the union of all of them. `channels` are `{ node, path, times,
 * interpolation }`.
 */
export function quickLookLoad(json, channels) {
  const { nodes, meshes, accessors } = json;
  if (channels.length === 0) return { deformed: 0, rigid: 0, frames: 1 };
  const key = (t) => Math.round(t * 1e5);
  const duration = channels.reduce((most, ch) => Math.max(most, ch.times[ch.times.length - 1]), 0);
  const grid = new Set([key(duration)]);
  for (let i = 0; i * 30 < duration * 30 - 1e-6; i += 1) grid.add(key(i / 30));
  const own = new Map();
  for (const ch of channels) {
    if (!own.has(ch.node)) own.set(ch.node, new Set());
    const times = own.get(ch.node);
    for (const t of ch.times) times.add(key(t));
    if (ch.interpolation === 'STEP') for (const t of [...ch.times].slice(1)) times.add(key(Math.max(0, t - 1e-5)));
  }
  const all = new Set(grid);
  for (const times of own.values()) for (const t of times) all.add(t);
  const frames = all.size;
  const moving = new Set(channels.filter((ch) => ch.path !== 'weights').map((ch) => ch.node));
  let deformed = 0;
  let rigid = 0;
  const walk = (i, chain) => {
    const node = nodes[i];
    const here = moving.has(i) ? new Set([...(chain ?? grid), ...own.get(i)]) : chain;
    if (node.mesh !== undefined) {
      for (const prim of meshes[node.mesh].primitives) {
        const points = accessors[prim.attributes.POSITION].count;
        if (prim.targets?.length) deformed += points * frames;
        else rigid += points * (here ? here.size : 1);
      }
    }
    for (const c of node.children ?? []) walk(c, here);
  };
  for (const i of json.scenes[0].nodes) walk(i, null);
  return { deformed, rigid, frames };
}

/** The converter's extent budgets in point-frames (glb_to_usdz.py `extents`). */
export const QUICK_LOOK_BUDGET = { deformed: 100e6, rigid: 500e6 };
