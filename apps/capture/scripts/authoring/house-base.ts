/**
 * Makes the house base avatar (slice 2c of docs/features/directed-performance.md)
 * from CC0 parts, every value from `house-base/base.json`, so the base is
 * re-made by this command and never edited by hand.
 *
 *   node --conditions=development --import tsx scripts/authoring/house-base.ts [--params file] [--out file.glb] [--blender path] [--install-mpfb]
 *
 * It fetches the pinned parts into the ignored `output/authoring/house-base/cache/`
 * and checks their sha256: MPFB 2.0.18 (the Blender add-on that makes the
 * MakeHuman human; GPL-3.0, its output CC0) and the faceunits01 pack (ARKit
 * face shapes, CC0; the base keeps its jaw and cheek units, and its stylised
 * face's other shapes are built in `build.py`). Blender (5.x) runs `house-base/build.py`
 * headless; MPFB must be installed in it as the `user_default` extension at
 * the pinned version (`--install-mpfb` installs it from the checked zip).
 * The credits `build.py` records go into `asset.copyright` and the scene's
 * `holoimAvatar` extras. Writes `public/gltf/models/house-base.glb` (or
 * `--out`) and `<out>.report.json` beside it in the cache folder.
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../../../..');
const CACHE = join(ROOT, 'apps/capture/output/authoring/house-base/cache');

const PARTS = {
  mpfb: {
    url: 'https://extensions.blender.org/download/sha256:c075b3e9b94b8e5556a5f03f4653602d02ea306de08126e8f55ed6dee28a2dad/add-on-mpfb-v2.0.18.zip',
    sha256: 'c075b3e9b94b8e5556a5f03f4653602d02ea306de08126e8f55ed6dee28a2dad',
    file: 'mpfb-2.0.18.zip',
    version: '2.0.18'
  },
  faceunits: {
    url: 'https://files2.makehumancommunity.org/functional/faceunits01.zip',
    sha256: 'd113107bd7eb59f3af4df6fc0ec29bfcc593f496d0b336aec14f086a80ce7146',
    file: 'faceunits01.zip'
  }
} as const;

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
}

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

/** The part from the cache, fetched once; its sha256 must match the pin. */
async function part(p: { url: string; sha256: string; file: string }): Promise<string> {
  const path = join(CACHE, p.file);
  let bytes: Uint8Array;
  try { bytes = new Uint8Array(await readFile(path)); } catch {
    const res = await fetch(p.url);
    if (!res.ok) throw new Error(`${p.url}: HTTP ${res.status}`);
    bytes = new Uint8Array(await res.arrayBuffer());
    await mkdir(CACHE, { recursive: true });
    await writeFile(path, bytes);
  }
  const got = sha256(bytes);
  if (got !== p.sha256) throw new Error(`${p.file}: sha256 ${got}, pinned ${p.sha256} (delete ${path} to fetch again)`);
  return path;
}

const blender = arg('--blender') ?? process.env.BLENDER ?? '/Applications/Blender.app/Contents/MacOS/Blender';
const params = resolve(arg('--params') ?? join(HERE, 'house-base/base.json'));
const out = resolve(arg('--out') ?? join(ROOT, 'apps/capture/public/gltf/models/house-base.glb'));
const report = join(CACHE, `${basename(out, '.glb')}.report.json`);

const mpfbZip = await part(PARTS.mpfb);
const fuZip = await part(PARTS.faceunits);
const fuDir = join(CACHE, 'faceunits01');
await rm(fuDir, { recursive: true, force: true });
execFileSync('unzip', ['-q', fuZip, '-d', fuDir]);
const faceunits = join(fuDir, 'targets/faceunits');
await stat(faceunits);

// MPFB as Blender's user_default extension, at the pinned version.
// An extension has no bl_info, so the version is read from its manifest.
const probe = 'import importlib, os, re; m = importlib.import_module("bl_ext.user_default.mpfb"); t = open(os.path.join(os.path.dirname(m.__file__), "blender_manifest.toml")).read(); print("MPFB_VERSION", re.search(r"^version\\s*=\\s*\\"([^\\"]+)\\"", t, re.M).group(1))';
const installedVersion = () => {
  try {
    const text = execFileSync(blender, ['-b', '--factory-startup', '--python-expr', probe], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return /MPFB_VERSION (\S+)/.exec(text)?.[1] ?? null;
  } catch { return null; }
};
const mpfbVersion = installedVersion();
if (mpfbVersion !== PARTS.mpfb.version) {
  if (!process.argv.includes('--install-mpfb')) {
    throw new Error(`MPFB ${mpfbVersion ?? 'is not installed'}${mpfbVersion ? ' is installed' : ''} in ${blender}, not the pinned ${PARTS.mpfb.version}; run again with --install-mpfb to install it from ${mpfbZip}`);
  }
  execFileSync(blender, ['--command', 'extension', 'install-file', '-r', 'user_default', '-e', mpfbZip], { stdio: 'inherit' });
}

const tmp = join(CACHE, `${basename(out, '.glb')}.blender.glb`);
const log = execFileSync(blender, ['-b', '--python', join(HERE, 'house-base/build.py'), '--', params, faceunits, tmp, report], { encoding: 'utf8', maxBuffer: 64 << 20 });
if (!log.includes('HOUSE_BASE_DONE')) throw new Error(`build.py did not finish:\n${log.slice(-4000)}`);

// Credits into asset.copyright; the scene's holoimAvatar extras already carry them (build.py).
const glb = new Uint8Array(await readFile(tmp));
const view = new DataView(glb.buffer, glb.byteOffset, glb.byteLength);
const jsonLength = view.getUint32(12, true);
const json = JSON.parse(new TextDecoder().decode(glb.subarray(20, 20 + jsonLength))) as {
  asset: { copyright?: string; generator?: string };
  scenes?: { extras?: { holoimAvatar?: string } }[];
};
const avatar = JSON.parse(json.scenes?.[0]?.extras?.holoimAvatar ?? 'null') as { credits: { title: string; author: string; source: string; licence: string }[] } | null;
if (!avatar?.credits?.length) throw new Error('build.py wrote no credits');
json.asset.copyright = avatar.credits.map((c) => `“${c.title}” by ${c.author}, ${c.source}, ${c.licence}`).join('; ');
// The JSON chunk is padded in bytes (the credits hold non-ASCII quotes), with spaces, to a multiple of 4.
const encoded = new TextEncoder().encode(JSON.stringify(json));
const head = new Uint8Array(encoded.length + ((4 - (encoded.length % 4)) % 4)).fill(0x20);
head.set(encoded);
const rest = glb.subarray(20 + jsonLength);
const outBytes = new Uint8Array(12 + 8 + head.length + rest.length);
const w = new DataView(outBytes.buffer);
w.setUint32(0, 0x46546c67, true);
w.setUint32(4, 2, true);
w.setUint32(8, outBytes.length, true);
w.setUint32(12, head.length, true);
w.setUint32(16, 0x4e4f534a, true);
outBytes.set(head, 20);
outBytes.set(rest, 20 + head.length);
await mkdir(dirname(out), { recursive: true });
await writeFile(out, outBytes);
await rm(tmp, { force: true });
console.log(`house base: ${out} (${(outBytes.length / 1e6).toFixed(2)} MB, sha256 ${sha256(outBytes)}); report ${report}`);
