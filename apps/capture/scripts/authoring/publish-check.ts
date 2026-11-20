/**
 * End-to-end check of `publish.ts` against a local test API that refuses
 * anonymous uploads (TEST_OPEN_UPLOADS=false): a take directed from
 * sheets/goodbye.json is published with a real agent token (registered in the
 * test database through the API's own agent-token CLI) and read back from the
 * feed; then every refusal is shown. Writes
 * output/authoring/publish-check/report.json; exits 1 if any row fails.
 *
 *   node --conditions=development --import tsx scripts/authoring/publish-check.ts
 *
 * Port: PUBLISH_CHECK_API_PORT (3355). Never touches production.
 */
import { createHash, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from './direct.ts';
import { LOCAL_API, publish, publishTarget, PRODUCTION_API, Refusal } from './publish.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '../../../..');
const OUT = join(HERE, '../../output/authoring/publish-check');
const PORT = Number(process.env.PUBLISH_CHECK_API_PORT ?? 3355);

type Row = { id: string; pass: boolean; detail: string };
const rows: Row[] = [];
const row = (id: string, pass: boolean, detail: string) => { rows.push({ id, pass, detail }); console.log(`${pass ? 'ok  ' : 'FAIL'} ${id}: ${detail.split('\n')[0]}`); };

/** Rewrites a GLB's JSON chunk. */
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
function editGlb(glb: Buffer, edit: (json: Json) => void): Buffer {
  const jsonLen = glb.readUInt32LE(12);
  const json = JSON.parse(glb.subarray(20, 20 + jsonLen).toString('utf8'));
  edit(json);
  let text = Buffer.from(JSON.stringify(json));
  text = Buffer.concat([text, Buffer.alloc((4 - (text.length % 4)) % 4, 0x20)]);
  const rest = glb.subarray(20 + jsonLen);
  const head = Buffer.alloc(20);
  head.write('glTF', 0); head.writeUInt32LE(2, 4); head.writeUInt32LE(20 + text.length + rest.length, 8);
  head.writeUInt32LE(text.length, 12); head.writeUInt32LE(0x4e4f534a, 16);
  return Buffer.concat([head, text, rest]);
}

const stripKey = (value: unknown, key: string): void => {
  if (!value || typeof value !== 'object') return;
  delete (value as Json)[key];
  for (const v of Object.values(value)) stripKey(v, key);
};

async function refused(name: string, run: () => Promise<unknown>, expect: RegExp): Promise<void> {
  try { await run(); row(name, false, 'was published'); } catch (e) {
    const text = (e as Error).message;
    row(name, e instanceof Refusal && expect.test(text), text);
  }
}

await mkdir(OUT, { recursive: true });
process.env.TEST_OPEN_UPLOADS = 'false';
process.env.USDZ_WORKER_ENABLED = 'false';
// The root script is CommonJS to Node: its named export sits on `default`.
type TestApi = { baseUrl: string; databasePath: string; stop: () => Promise<void> };
const testApi = (await import('../../../../scripts/test-api.ts')) as { launchTestApi?: (o: object) => Promise<TestApi>; default?: { launchTestApi: (o: object) => Promise<TestApi> } };
const api = await (testApi.launchTestApi ?? testApi.default!.launchTestApi)({ port: PORT, webOrigin: 'https://localhost:3174' });
try {
  const origin = api.baseUrl;
  const sheet = join(HERE, 'sheets/goodbye.json');
  const { out: takeFile } = await build(sheet, join(OUT, 'goodbye.glb'));
  const take = await readFile(takeFile);

  // An agent token, registered the way production's is: only its hash reaches the API's database.
  const token = `holoim_at_${randomBytes(24).toString('hex')}`;
  execFileSync('pnpm', ['--dir', join(ROOT, 'apps/viewer-api'), 'exec', 'tsx', 'src/agent-token.ts', 'register', '--email', 'agent@example.test', '--name', 'Claude (agent-authored)', '--hash', createHash('sha256').update(token).digest('hex')],
    { env: { ...process.env, DATABASE_URL: `file:${api.databasePath}` }, stdio: 'pipe' });

  // Refusals first: nothing may reach the API.
  delete process.env.HOLOIM_SESSION; delete process.env.HOLOIM_AGENT_TOKEN;
  const before = ((await (await fetch(`${origin}/api/holograms?limit=20`)).json()) as { items: unknown[] }).items.length;
  await refused('no token', () => publish({ input: takeFile, api: origin, quickLook: false }), /no agent upload token/);
  process.env.HOLOIM_AGENT_TOKEN = 'holoim_at_wrong';
  await refused('wrong token', () => publish({ input: takeFile, api: origin, quickLook: false }), /refused the agent token|refused HOLOIM_AGENT_TOKEN/);
  process.env.HOLOIM_AGENT_TOKEN = token;
  row('the default target is production, --local the local API', publishTarget({}).origin === PRODUCTION_API && publishTarget({ local: true }).origin === LOCAL_API && publishTarget({ api: origin, local: true }).origin === origin, `${publishTarget({}).origin}; --local ${publishTarget({ local: true }).origin}`);
  await refused('a remote host that is not production (a trailing dot)', () => publish({ input: takeFile, api: 'https://holoim-api.fly.dev.', quickLook: false }), /neither production/);
  const undeclared = join(OUT, 'undeclared.glb');
  await writeFile(undeclared, editGlb(take, (j) => stripKey(j, 'HOLOIM_humanoid')));
  await refused('no declared performer', () => publish({ input: undeclared, api: origin, title: 'x', quickLook: false }), /no declared performer/);
  const heavy = join(OUT, 'over-budget.glb');
  await writeFile(heavy, editGlb(take, (j) => {
    const mesh = j.meshes.find((m: Json) => m.primitives.some((p: Json) => p.targets?.length));
    j.accessors[mesh.primitives[0].attributes.POSITION].count = 2e9;
  }));
  await refused('over the Quick Look budget', () => publish({ input: heavy, api: origin, title: 'x', quickLook: true }), /Quick Look deformed load/);
  const big = join(OUT, 'oversize.glb');
  await writeFile(big, Buffer.concat([take, Buffer.alloc(100 * 1048576)]));
  await refused('over the size cap', () => publish({ input: big, api: origin, title: 'x', quickLook: false }), /at most 100 MB/);
  await refused('credit too long', () => publish({ input: takeFile, api: origin, credit: 'x'.repeat(81), quickLook: false }), /credit must be/);
  const untitled = join(OUT, 'untitled.glb');
  await writeFile(untitled, take);
  await refused('no title', () => publish({ input: untitled, api: origin, quickLook: false }), /no title/);
  const after = ((await (await fetch(`${origin}/api/holograms?limit=20`)).json()) as { items: unknown[] }).items.length;
  row('refusals uploaded nothing', before === 0 && after === 0, `${after} holograms on the feed after every refusal`);

  // The take, from the sheet to the feed.
  const result = await publish({ input: sheet, api: origin, quickLook: false, description: 'A goodbye, directed from a beat sheet.', credit: 'HoloIM direction' });
  if ('checked' in result) throw new Error('unexpected');
  const feed = (await (await fetch(`${origin}/api/holograms?limit=20`)).json()) as { items: { id: string; hologramName: string; submittedBy: string; submittedByVerified: boolean; url: string }[] };
  const card = feed.items.find((i) => i.id === result.id);
  row('published take is on the feed', Boolean(card) && result.appearsOnFeed, `${result.title} as ${card?.submittedBy} (verified ${card?.submittedByVerified}), ${(result.sizeBytes / 1e6).toFixed(2)} MB`);
  row('feed URL printed', Boolean(result.feedUrl?.endsWith(`/h/${result.id}`)), String(result.feedUrl));
  const glb = await fetch(result.glbUrl.startsWith('http') ? result.glbUrl : `${origin}${result.glbUrl}`);
  row('stored GLB is the take', glb.ok && (await glb.arrayBuffer()).byteLength === take.byteLength, `${glb.status}`);
  const anonymous = await fetch(`${origin}/api/holograms`, { method: 'POST', body: new FormData() });
  row('the test API really refuses anonymous uploads', anonymous.status === 401, `anonymous POST: ${anonymous.status}`);

  await writeFile(join(OUT, 'report.json'), `${JSON.stringify({ api: origin, rows, published: { ...result, glbUrl: undefined } }, null, 2)}\n`);
} finally {
  await api.stop();
}
const failed = rows.filter((r) => !r.pass);
console.log(`${rows.length - failed.length}/${rows.length} rows pass; report: ${join(OUT, 'report.json')}`);
process.exit(failed.length ? 1 : 0);
