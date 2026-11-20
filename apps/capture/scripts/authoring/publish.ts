/**
 * Publishes a directed take: validates it, uploads it through the normal
 * upload route and prints where it appears in the feed.
 *
 *   node --conditions=development --import tsx scripts/authoring/publish.ts <take.glb | sheet.json>
 *        [--title t] [--description d] [--credit c] [--api <origin>] [--web <origin>]
 *        [--local] [--no-quick-look] [--check]
 *
 * A `.json` sheet is built first (as `direct.ts` does). A `.glb` takes its
 * title, description and credit from the sheet beside it (`<take>.beats.json`),
 * if any; flags win. `--check` validates and stops, with no network call.
 *
 * The target is production (https://holoim-api.fly.dev) unless `--local` (the
 * local API, http://127.0.0.1:3001) or `--api <origin>` says otherwise. A
 * remote host that is not production is refused. Credential: HOLOIM_AGENT_TOKEN (the agent upload token) or
 * HOLOIM_SESSION from the environment, else the Keychain entry for the host
 * (`scripts/agent-upload-token.sh setup`); with none the command refuses.
 * The upload code is `scripts/showcase/lib/upload.mjs`, shared with
 * `showcase/upload.mjs`.
 *
 * Exit 0 published; 1 refused (nothing uploaded) or failed; 2 uploaded, but
 * its Quick Look preview did not become ready.
 */
import { readFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

import { MAX_HOLOGRAM_BYTES } from '@holoim/contracts';

import { checkAccount, findCredential, insecureTarget, isLoopback, QUICK_LOOK_BUDGET, quickLookLoad, setupHint, uploadHologram, waitForPreview } from '../showcase/lib/upload.mjs';
import { build, objectLines } from './direct.ts';
import { parseSheetText } from './lib/beats.ts';
import { findPerformers, parseGlb, readChannels } from './lib/gltf-read.ts';

export const LOCAL_API = 'http://127.0.0.1:3001';
export const LOCAL_WEB = 'https://localhost:3174';
export const PRODUCTION_API = 'https://holoim-api.fly.dev';
export const PRODUCTION_WEB = 'https://holoim-viewer.pages.dev';

/** Where a publish goes: `--api` if given, else the local API with `--local`, else production. */
export function publishTarget(options: { readonly api?: string | undefined; readonly local?: boolean | undefined }): URL {
  return new URL(options.api ?? (options.local ? LOCAL_API : PRODUCTION_API));
}
const FEED_WAIT_MS = 60_000;

export interface TakeFacts {
  readonly bytes: number;
  readonly performers: number;
  readonly declaredPerformer: string | null;
  readonly seconds: number;
  readonly quickLook: { deformed: number; rigid: number; frames: number };
}

/** Everything that would make the viewer or the converter refuse or misread the take; empty when it is fit to publish. */
export function validateTake(glb: Uint8Array, { quickLook }: { quickLook: boolean }): { problems: string[]; facts: TakeFacts | null } {
  const problems: string[] = [];
  if (glb.byteLength > MAX_HOLOGRAM_BYTES) {
    problems.push(`the file is ${(glb.byteLength / 1048576).toFixed(1)} MB; a hologram may be at most ${MAX_HOLOGRAM_BYTES / 1048576} MB`);
  }
  let doc;
  try { doc = parseGlb(glb); } catch (e) { return { problems: [...problems, `not a readable GLB: ${(e as Error).message}`], facts: null }; }
  const channels = readChannels(doc);
  const performers = findPerformers(doc);
  const declared = performers.find((p) => p.declared);
  if (performers.length === 0) problems.push('no performer: no skinned humanoid in the file');
  else if (!declared) problems.push('no declared performer: the file lacks HOLOIM_humanoid, so the viewer cannot anchor on a performer (build it with direct.ts, which declares it)');
  for (const p of performers) {
    if (!channels.some((c) => p.joints.has(c.node))) problems.push(`performer ${p.name} never moves: no animation reaches its joints`);
  }
  const load = quickLookLoad(doc.json, channels);
  if (quickLook) {
    for (const kind of ['deformed', 'rigid'] as const) {
      if (load[kind] > QUICK_LOOK_BUDGET[kind]) {
        problems.push(`Quick Look ${kind} load ${load[kind].toExponential(2)} point-frames is over the converter's budget of ${QUICK_LOOK_BUDGET[kind].toExponential(2)} (shorten the take, or publish with --no-quick-look)`);
      }
    }
  }
  const seconds = channels.reduce((most, c) => Math.max(most, c.times[c.times.length - 1] ?? 0), 0);
  return { problems, facts: { bytes: glb.byteLength, performers: performers.length, declaredPerformer: declared?.name ?? null, seconds, quickLook: load } };
}

export interface PublishOptions {
  readonly input: string;
  readonly title?: string | undefined;
  readonly description?: string | undefined;
  readonly credit?: string | undefined;
  readonly api?: string | undefined;
  readonly web?: string | undefined;
  /** The local API instead of production; `api` wins. */
  readonly local?: boolean;
  readonly quickLook?: boolean;
  /** Validate and stop. */
  readonly checkOnly?: boolean;
}

export interface PublishReport {
  readonly id: string;
  readonly title: string;
  readonly description: string | null;
  readonly credit: string | null;
  readonly uploadedAs: string | null;
  readonly sizeBytes: number;
  readonly seconds: number;
  readonly quickLook: string;
  readonly api: string;
  readonly glbUrl: string;
  readonly feedUrl: string | null;
  readonly appearsOnFeed: boolean;
}

export class Refusal extends Error {}

type SheetMeta = { title?: string | undefined; description?: string | undefined; credit?: string | undefined };

async function readSheetMeta(file: string): Promise<SheetMeta> {
  try {
    const raw = parseSheetText(await readFile(file, 'utf8'), file) as unknown as Record<string, unknown>;
    const text = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
    return { title: text(raw.title), description: text(raw.description), credit: text(raw.credit) };
  } catch { return {}; }
}

/** Publishes; throws `Refusal` (nothing uploaded) or Error. */
export async function publish(options: PublishOptions): Promise<PublishReport | { checked: TakeFacts }> {
  const quickLook = options.quickLook ?? true;
  const apiUrl = publishTarget(options);

  // 1. The target, before anything is read.
  // A remote host must be production exactly: any other spelling (a trailing dot, an alias, a typo) would send the token elsewhere.
  if (!isLoopback(apiUrl) && apiUrl.origin !== PRODUCTION_API) {
    throw new Refusal(`${apiUrl.origin} is neither production (${PRODUCTION_API}) nor a local API. Nothing was uploaded.`);
  }

  // 2. The take.
  const input = resolve(options.input);
  let glbFile = input;
  let sheetMeta: SheetMeta;
  if (input.endsWith('.json') || input.endsWith('.jsonc')) {
    const built = await build(input);
    const missed = objectLines(built.take.objects).filter((l) => l.failed);
    if (missed.length) throw new Refusal(`${basename(input)} builds, but an object misses its mark; nothing was uploaded:\n  - ${missed.map((l) => l.text).join('\n  - ')}`);
    glbFile = built.out;
    sheetMeta = await readSheetMeta(input);
  } else {
    sheetMeta = await readSheetMeta(join(dirname(input), `${basename(input, '.glb')}.beats.json`));
  }
  let bytes: Buffer;
  try { bytes = await readFile(glbFile); } catch { throw new Refusal(`cannot read ${glbFile}`); }
  const { problems, facts } = validateTake(bytes, { quickLook });
  if (problems.length) throw new Refusal(`${basename(glbFile)} is not fit to publish; nothing was uploaded:\n  - ${problems.join('\n  - ')}`);
  if (options.checkOnly) return { checked: facts! };

  const title = options.title ?? sheetMeta.title;
  if (!title) throw new Refusal('no title: pass --title, or publish from a sheet that has one. Nothing was uploaded.');
  const credit0 = options.credit ?? sheetMeta.credit;
  const fieldProblems = [
    ...(title.length > 120 ? [`the title is ${title.length} characters; the API accepts at most 120`] : []),
    ...(credit0 !== undefined && (credit0.trim() === '' || credit0.length > 80) ? ['the credit must be 1 to 80 characters'] : [])
  ];
  if (fieldProblems.length) throw new Refusal(`${fieldProblems.join('; ')}. Nothing was uploaded.`);
  const description = options.description ?? sheetMeta.description ?? null;
  const credit = options.credit ?? sheetMeta.credit ?? null;

  // 3. The credential.
  const credential = findCredential(apiUrl, ['HOLOIM_AGENT_TOKEN', 'HOLOIM_SESSION']);
  if (!credential) {
    throw new Refusal(`no agent upload token for ${apiUrl.host}: set HOLOIM_AGENT_TOKEN (or HOLOIM_SESSION), or store one with ${setupHint(apiUrl)}. Nothing was uploaded.`);
  }
  const insecure = insecureTarget(apiUrl, credential);
  if (insecure) throw new Refusal(insecure);
  const account = await checkAccount(apiUrl, credential);
  if (account.error !== undefined) throw new Refusal(account.error);
  console.error(`publishing "${title}" to ${apiUrl.origin} as ${account.account.displayName} (token from ${credential.source})`);

  // 4. Upload, then wait until it is readable and on the feed.
  const authHeaders = { authorization: `Bearer ${credential.token}` };
  const uploaded = await uploadHologram({ api: apiUrl, authHeaders, name: title, submittedBy: credit ?? account.account.displayName, bytes, filename: basename(glbFile), quickLook });
  if (uploaded.error !== undefined) throw new Error(`upload refused: ${uploaded.error}`);
  const dto = uploaded.dto;
  let appearsOnFeed = false;
  for (const deadline = Date.now() + FEED_WAIT_MS; !appearsOnFeed && Date.now() < deadline; await sleep(500)) {
    // The feed's search caps its query at 100 characters.
    const feed = await fetch(new URL(`/api/holograms?limit=20&q=${encodeURIComponent(title.slice(0, 100))}`, apiUrl)).catch(() => null);
    if (feed?.ok) appearsOnFeed = ((await feed.json()) as { items: { id: string }[] }).items.some((i) => i.id === dto.id);
  }
  let previewStatus = 'not requested';
  if (quickLook) previewStatus = (await waitForPreview(apiUrl, dto.id)).usdzStatus;
  const web = options.web ?? (isLoopback(apiUrl) ? LOCAL_WEB : PRODUCTION_WEB);
  return {
    id: dto.id, title: dto.hologramName, description, credit, uploadedAs: account.account.displayName, sizeBytes: dto.sizeBytes,
    seconds: facts!.seconds, quickLook: previewStatus, api: apiUrl.origin, glbUrl: dto.url,
    feedUrl: web ? `${web.replace(/\/$/, '')}/h/${dto.id}` : null, appearsOnFeed
  };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const flag = (name: string): string | undefined => { const i = args.indexOf(name); return i === -1 ? undefined : args.splice(i, 2)[1]; };
  const bool = (name: string): boolean => { const i = args.indexOf(name); if (i !== -1) args.splice(i, 1); return i !== -1; };
  const options = {
    title: flag('--title'), description: flag('--description'), credit: flag('--credit'), api: flag('--api'), web: flag('--web'),
    local: bool('--local'), quickLook: !bool('--no-quick-look'), checkOnly: bool('--check')
  };
  const input = args[0];
  if (!input || args.some((a) => a.startsWith('--'))) {
    console.error('usage: publish.ts <take.glb | sheet.json> [--title t] [--description d] [--credit c] [--api <origin>] [--web <origin>] [--local] [--no-quick-look] [--check]');
    process.exit(1);
  }
  try {
    const result = await publish({ input, ...options });
    if ('checked' in result) {
      console.log(JSON.stringify({ valid: true, ...result.checked }));
      return;
    }
    console.log(JSON.stringify(result));
    if (result.feedUrl) console.error(`feed: ${result.feedUrl}`);
    if (!result.appearsOnFeed) { console.error('uploaded, but not on the feed within 60 s; check the API, and do not publish it again'); process.exit(1); }
    if (options.quickLook && result.quickLook !== 'ready') {
      console.error(`uploaded, but its Quick Look preview is ${result.quickLook}; the API log has the reason; do not publish it again.`);
      process.exit(2);
    }
  } catch (e) {
    console.error(e instanceof Refusal ? `refused: ${e.message}` : `failed: ${(e as Error).message}`);
    process.exit(1);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main();
