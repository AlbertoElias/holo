import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import { tokens } from '@holoim/design-tokens';

import { loadTake, objectNodes, readGlb } from './object-glb.mjs';
import { clickButton, openCapture, readState, saveDownload, setupPage } from './object-take.mjs';
import { PIXEL_PNG, STEP_MS, enterIwer, reach, shooter, stepper, summonedItems } from './summon-take.mjs';

// Find an object by asking in a headset (PRD-060 slice 2), in IWER, through
// capture's real input paths, with the registry, GLB and transcription
// routes fulfilled from the credited bracket fixture:
//   - headset-find: a controller ray on the wrist's Find glyph opens the
//     panel 1.5 m ahead with no text within 1 m; the in-world keyboard (IWER
//     has no system keyboard) types a query; a category searches at once;
//     the top result's GLB is prefetched and a pick lands in the tray from
//     that cache; Find leaves the wrist during the take; the summoned object
//     exports with its credit.
//   - headset-voice: Speak held on the panel records the (fake) mic where
//     the Web Speech API is absent, as on Quest Browser; the transcript is
//     searched; a 503 says to type instead.
//   - desktop-voice: the desktop field's Speak with the browser's own
//     speech API (failing in headless Chromium, so it falls back) logs its path.

const REST = { left: [-0.3, 0.9, -0.1], right: [0.3, 0.9, -0.1] };
const AIM_FROM = [0.15, 1.35, -0.15];

function fixtureResults(credit, bytes, { title = credit.title, id = 'test_bracket' } = {}) {
  return { id, source: credit.source, title, author: credit.author, licence: credit.licence, sourceUrl: credit.sourceUrl, thumbnailUrl: PIXEL_PNG, glbPath: `/api/objects/polyhaven/${id}.glb`, dimensionsM: [0.85, 0.77, 1.07], bytes };
}

async function routeRegistry(page, fixture, credit) {
  const queries = [];
  const glbFetches = [];
  await page.route('**/api/objects/search*', (route) => {
    const q = new URL(route.request().url()).searchParams.get('q');
    queries.push(q);
    const results = q === 'nothing' ? [] : [fixtureResults(credit, fixture.length), fixtureResults(credit, fixture.length, { title: `${credit.title} (second)`, id: 'test_bracket_2' })];
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ results }) });
  });
  await page.route('**/api/objects/polyhaven/*.glb', (route) => {
    glbFetches.push(new URL(route.request().url()).pathname);
    return route.fulfill({ status: 200, contentType: 'model/gltf-binary', body: fixture });
  });
  return { queries, glbFetches };
}

/** Puts a controller at `from` (world) and turns its −Z toward a world point (as ci-capture-ui's `aim`). */
async function aim(page, side, from, target) {
  await page.evaluate(({ side, from, target }) => {
    const device = window.IWER_DEVICE;
    const head = window.__sampleChrome().vr.head;
    const offset = [head[0] - device.position.x, head[1] - device.position.y, head[2] - device.position.z];
    const controller = device.controllers[side];
    controller.position.set(from[0] - offset[0], from[1] - offset[1], from[2] - offset[2]);
    const d = [target[0] - from[0], target[1] - from[1], target[2] - from[2]];
    const length = Math.hypot(...d);
    const [x, y, z] = d.map((v) => v / length);
    const w = 1 - z;
    if (w < 1e-6) controller.quaternion.set(0, 1, 0, 0);
    else {
      const half = Math.hypot(y, -x, w);
      controller.quaternion.set(y / half, -x / half, 0, w / half);
    }
  }, { side, from, target });
}

/** What the headset sees (not the spectator), with the page's DOM chrome hidden. */
function headsetShooter(page, step, artifactDir, label) {
  return async (name) => {
    await page.evaluate(() => {
      window.__setFrameStepping(true, true);
      for (const element of document.querySelectorAll('#ui-root, #VRButton, #ARButton, [data-webxr_runtime] > div')) element.style.visibility = 'hidden';
    });
    await step(2);
    const file = path.join(artifactDir, `${label}-${name}.png`);
    await page.screenshot({ path: file });
    await page.evaluate(() => {
      window.__setFrameStepping(true, false);
      for (const element of document.querySelectorAll('#ui-root, #VRButton, #ARButton, [data-webxr_runtime] > div')) element.style.visibility = '';
    });
    return file;
  };
}

const chrome = (page) => page.evaluate(() => window.__sampleChrome().vr);
const search = (page) => page.evaluate(() => window.__sampleObjectSearch());

/** Waits (stepping frames) until `predicate(chrome, search, state)` holds. */
async function until(page, step, predicate, label, fail, maxSteps = 600) {
  for (let i = 0; i < maxSteps; i += 6) {
    const [vr, found] = await Promise.all([chrome(page), search(page)]);
    if (predicate(vr, found)) return true;
    await step(6);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  fail(`timed out waiting for ${label}`);
  return false;
}

/** Aims the right controller's ray at a chrome target and pulls the trigger; returns what the ray rested on. */
async function selectTarget(page, step, target, { hold = 0 } = {}) {
  // UIKit lays the panel out again when its content changes (tiles, keyboard), so re-aim until the ray rests on the target.
  let hit = null;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const at = await page.evaluate((t) => window.__chromeTarget(t), target);
    if (!at) return { target, hit: null, missing: true };
    await aim(page, 'right', AIM_FROM, at);
    await step(3);
    hit = (await chrome(page)).rays.find((ray) => ray.side === 'right')?.hit ?? null;
    if (hit === target) break;
  }
  await page.evaluate(() => window.IWER_DEVICE.controllers.right.updateButtonValue('trigger', 1));
  await step(2);
  if (hold) await hold();
  await page.evaluate(() => window.IWER_DEVICE.controllers.right.updateButtonValue('trigger', 0));
  await step(2);
  return { target, hit };
}

async function openFindPanel(page, step, fail) {
  for (let i = 0; i < 60 && !(await page.evaluate(() => window.__chromeTarget('find'))); i += 1) await step(5);
  const dock = await selectTarget(page, step, 'find');
  if (dock.hit !== 'find') fail(`the right ray rested on ${dock.hit}, not the wrist's Find glyph`);
  await until(page, step, (vr) => vr.find?.visible, 'the Find panel to open', fail, 120);
  return chrome(page);
}

/** IWER controllers: Find on the wrist, in-world keyboard, a category, a pick from the prefetch, a summon, the credit in the export. */
export async function runIwerFindTake({ browser, baseUrl, captureRoot, artifactDir, consoleErrors }) {
  const label = 'headset-find';
  const failures = [];
  const fail = (message) => failures.push(message);
  await mkdir(artifactDir, { recursive: true });
  const fixture = await readFile(path.join(captureRoot, 'fixtures/objects/credited-bracket.glb'));
  const credit = readGlb(fixture).json.asset.extras.holoimCredit;
  const { context, page } = await setupPage(browser, { iwer: true, consoleErrors, label });
  try {
    // Readable evidence of the panel (FIND_VIEWPORT=WxH, default 960x540).
    const [w, h] = (process.env.FIND_VIEWPORT ?? '960x540').split('x').map(Number);
    await page.setViewportSize({ width: w, height: h });
    const registry = await routeRegistry(page, fixture, credit);
    await openCapture(page, baseUrl, {});
    await enterIwer(page, 'controller');
    const clock = stepper(page);
    const { step } = clock;
    const shot = headsetShooter(page, step, artifactDir, label);
    const spectatorShot = shooter(page, step, artifactDir, label);
    const controller = (side, position, quaternion) => page.evaluate(({ s, p, q }) => {
      const c = window.IWER_DEVICE.controllers[s];
      c.position.set(...p);
      if (q) c.quaternion.set(...q);
    }, { s: side, p: position, q: quaternion });
    const button = (side, id, value) => page.evaluate(({ s, i, v }) => window.IWER_DEVICE.controllers[s].updateButtonValue(i, v), { s: side, i: id, v: value });
    await controller('left', REST.left, [0, 0, 0, 1]);
    await controller('right', REST.right, [0, 0, 0, 1]);
    await step(20);

    // Find on the wrist opens the panel ahead; the settings panel steps aside.
    const opened = await openFindPanel(page, step, fail);
    const panel = {
      distanceFromHeadM: Number(opened.find?.distanceFromHeadM.toFixed(3)),
      settingsVisible: opened.panel?.visible ?? null,
      keyboard: opened.find?.keyboard,
      nearestLabelM: Math.min(...opened.labels.map((l) => l.distanceFromHeadM)),
      smallestHitM: Math.min(...(opened.find?.targets ?? []).filter((t) => t.visible).map((t) => Math.min(t.hitWidthM, t.hitHeightM))),
      categories: (opened.find?.targets ?? []).filter((t) => t.id.startsWith('category:')).map((t) => t.text)
    };
    if (Math.abs(panel.distanceFromHeadM - tokens.placement.worldPanelDefaultM) > 0.05) fail(`the Find panel opened ${panel.distanceFromHeadM} m away`);
    if (panel.settingsVisible) fail('the settings panel stayed open beside Find');
    if (panel.nearestLabelM < tokens.type.headsetLabelMinDistanceM) fail(`text shows ${panel.nearestLabelM} m from the head`);
    // A ray's minimum, 56 apx at 1.5 m (6.1).
    const rayMinM = tokens.hit.ray * tokens.size.radiansPerApx * tokens.placement.worldPanelDefaultM;
    if (panel.smallestHitM < rayMinM - 1e-4) fail(`a Find target is ${panel.smallestHitM} m, under the ray minimum ${rayMinM} m`);
    if (panel.categories.join(',') !== 'Chairs,Plants,Lamps,Food,Tools') fail(`categories: ${panel.categories}`);
    const shots = { opened: await shot('1-opened') };

    // The query line raises the in-world keyboard here (IWER has no system keyboard); typed keys fill it.
    await selectTarget(page, step, 'find:query');
    let vr = await chrome(page);
    const keyboard = vr.find?.keyboard;
    if (keyboard !== 'in-world') fail(`the query line raised the ${keyboard} keyboard, expected in-world`);
    for (const key of ['b', 'r', 'a', 'c']) await selectTarget(page, step, `find:key:${key}`);
    await selectTarget(page, step, 'find:key:delete');
    shots.keyboard = await shot('2-keyboard');
    await selectTarget(page, step, 'find:key:done');
    await until(page, step, (v) => v.find?.results.length > 0, 'typed results', fail);
    const typed = { query: (await search(page)).headset.query, searched: registry.queries.at(-1) };
    if (typed.query !== 'bra' || typed.searched !== 'bra') fail(`typing b r a c ⌫ searched ${JSON.stringify(typed)}`);

    // A category searches at once.
    const category = await selectTarget(page, step, 'find:category:chairs');
    if (category.hit !== 'find:category:chairs') fail(`the ray rested on ${category.hit}, not Chairs`);
    await until(page, step, (v, s) => s.headset.finding.status === 'done' && s.headset.finding.q === 'chairs' && v.find?.results.length > 0, 'category results', fail);
    vr = await chrome(page);
    const results = vr.find?.results ?? [];
    if (results.length !== 2 || results[0].title !== credit.title || results[0].byline !== `${credit.author} · CC0`) fail(`results: ${JSON.stringify(results)}`);
    await until(page, step, (_v, s) => s.prefetch.started >= 1, 'the top result prefetch', fail, 60);
    shots.results = await shot('3-results');

    // A pick lands in the tray from the prefetch: no second GLB request.
    const fetchesBeforePick = registry.glbFetches.length;
    await selectTarget(page, step, 'find:result:0');
    await until(page, step, (v) => v.find?.status === `In the tray: ${credit.title}`, 'the pick in the tray', fail);
    const found = await search(page);
    let state = await readState(page);
    const picked = { tray: state.objects.tray.items.map((item) => item.name), status: (await chrome(page)).find?.status, prefetchHits: found.prefetch.hits, glbFetchesAfterPick: registry.glbFetches.length - fetchesBeforePick };
    if (picked.tray[0] !== credit.title) fail(`tray holds ${JSON.stringify(picked.tray)}`);
    if (picked.prefetchHits < 1 || picked.glbFetchesAfterPick !== 0) fail(`the pick did not load from the prefetch (${JSON.stringify(picked)})`);
    shots.picked = await shot('4-picked');

    await selectTarget(page, step, 'find:close');
    await step(4);
    vr = await chrome(page);
    if (vr.find?.visible || !vr.panel?.visible) fail(`Close left find=${vr.find?.visible} settings=${vr.panel?.visible}`);

    // The take: Find leaves the wrist, the tray summons the found object.
    await controller('right', REST.right, [0, 0, 0, 1]);
    await clickButton(page, 'Start Recording');
    await page.getByRole('button', { name: 'Stop Recording', exact: true }).waitFor({ timeout: 10_000 });
    await step(10);
    vr = await chrome(page);
    const duringTake = { dockGlyph: vr.find?.dockGlyph, findVisible: vr.find?.visible };
    if (duringTake.dockGlyph || duringTake.findVisible) fail(`Find shows during the take (${JSON.stringify(duringTake)})`);
    state = await readState(page);
    const rigYaw = state.thumbstick.rigYaw;
    await controller('left', [-0.12, 1.1, -0.32]);
    await step(20);
    await button('left', 'y-button', 1);
    await step(4);
    const reached = await reach(page, step, { move: (p) => controller('right', p), start: REST.right, target: (s) => s.objects.tray.items[0].position, rigYaw });
    if (reached.error > 0.06) fail(`the right hand never reached the found object in the tray (${reached.error.toFixed(3)} m)`);
    await button('right', 'squeeze', 1);
    await step(4);
    state = await readState(page);
    const summoned = summonedItems(state).map((item) => item.name);
    if (summoned[0] !== credit.title) fail(`the squeeze summoned ${JSON.stringify(summoned)}`);
    shots.summoned = await spectatorShot('5-summoned');
    await button('right', 'squeeze', 0);
    await button('left', 'y-button', 0);
    await step(20);
    const glb = path.join(artifactDir, `${label}.glb`);
    await saveDownload(page, async () => {
      await clickButton(page, 'Stop Recording');
      for (let i = 0; i < 20; i += 1) await step(1);
    }, glb);
    const take = loadTake(await readFile(glb));
    const nodes = objectNodes(take);
    const extras = nodes.map((node) => take.json.nodes[node]?.extras ?? null);
    const copyright = take.json.asset.copyright ?? null;
    const exported = { objectNodes: nodes.length, credit: extras[0]?.holoimCredit ?? null, copyright, valid: take.validation?.ok ?? false };
    if (!exported.valid) fail(`HOLOIM_objects invalid: ${take.validation?.errors?.join('; ') ?? 'absent'}`);
    if (nodes.length !== 1) fail(`${nodes.length} RecordedObject nodes, expected 1`);
    if (JSON.stringify(exported.credit) !== JSON.stringify(credit)) fail(`node extras credit ${JSON.stringify(exported.credit)}, expected the fixture credit`);
    if (!copyright?.includes(`“${credit.title}” by ${credit.author}, ${credit.source}, CC0`)) fail(`asset.copyright is ${JSON.stringify(copyright)}`);
    return { label, status: failures.length ? 'fail' : 'pass', failures, glb, shots, panel, keyboard, typed, queries: registry.queries, results, picked, duringTake, summoned, export: exported };
  } finally {
    await context.close();
  }
}

/** A Chromium whose mic is a fake device that always grants (the voice phases launch their own). */
export const VOICE_BROWSER_ARGS = ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'];

/** IWER: Speak held on the panel where the Web Speech API is absent (Quest Browser); the transcript is searched; a 503 says to type. */
export async function runIwerVoiceTake({ browser, baseUrl, captureRoot, artifactDir, consoleErrors }) {
  const label = 'headset-voice';
  const failures = [];
  const fail = (message) => failures.push(message);
  await mkdir(artifactDir, { recursive: true });
  const fixture = await readFile(path.join(captureRoot, 'fixtures/objects/credited-bracket.glb'));
  const credit = readGlb(fixture).json.asset.extras.holoimCredit;
  const { context, page } = await setupPage(browser, { iwer: true, consoleErrors, label });
  try {
    await context.grantPermissions(['microphone']);
    // As on Quest Browser: no Web Speech API.
    await page.addInitScript(() => {
      delete window.SpeechRecognition;
      delete window.webkitSpeechRecognition;
    });
    const registry = await routeRegistry(page, fixture, credit);
    const posts = [];
    let transcribe = { status: 200, body: { text: 'chair' } };
    await page.route('**/api/objects/transcribe', async (route) => {
      const request = route.request();
      posts.push({ method: request.method(), contentType: request.headers()['content-type'] ?? null, bytes: request.postDataBuffer()?.length ?? 0 });
      await route.fulfill({ status: transcribe.status, contentType: 'application/json', body: JSON.stringify(transcribe.body) });
    });
    await openCapture(page, baseUrl, {});
    await enterIwer(page, 'controller');
    const { step } = stepper(page);
    await page.evaluate(({ l, r }) => {
      window.IWER_DEVICE.controllers.left.position.set(...l);
      window.IWER_DEVICE.controllers.right.position.set(...r);
    }, { l: REST.left, r: REST.right });
    await step(20);
    await openFindPanel(page, step, fail);

    // Hold Speak while the (fake) mic records for real time, then release.
    const speakTraces = [];
    const speakFor = async (ms) => {
      const listening = [];
      const trace = [];
      const pressed = await selectTarget(page, step, 'find:speak', {
        hold: async () => {
          for (let i = 0; i < 5; i += 1) {
            const s = await search(page);
            trace.push({ voice: s.headset.voice, hit: (await chrome(page)).rays.find((ray) => ray.side === 'right')?.hit ?? null });
            await step(2);
          }
          await until(page, step, (_v, s) => s.headset.voice === 'listening', 'listening', fail, 60);
          await page.waitForTimeout(ms);
          await step(2);
          listening.push((await chrome(page)).find?.status);
        }
      });
      speakTraces.push({ pressed, trace });
      return listening[0];
    };
    const listeningStatus = await speakFor(1200);
    await until(page, step, (v, s) => s.headset.voice === 'idle' && s.headset.finding.status === 'done' && v.find?.results.length > 0, 'the spoken query searched', fail);
    let found = await search(page);
    const heard = { listeningStatus, query: found.headset.query, searched: registry.queries.at(-1), post: posts.at(-1) ?? null, path: found.voiceLog.at(-1) ?? null, results: (await chrome(page)).find?.results.length ?? 0 };
    if (heard.listeningStatus !== 'Listening…') fail(`while held the panel said ${JSON.stringify(heard.listeningStatus)}`);
    if (!heard.post || heard.post.method !== 'POST' || !/^audio\//.test(heard.post.contentType ?? '') || heard.post.bytes < 100) fail(`the recording was not posted as audio (${JSON.stringify(heard.post)})`);
    if (heard.query !== 'chair' || heard.searched !== 'chair') fail(`the transcript was not searched (${JSON.stringify(heard)})`);
    if (heard.path?.path !== 'transcribe' || heard.path.outcome !== 'heard') fail(`voice log ${JSON.stringify(heard.path)}`);
    if (heard.results !== 2) fail(`${heard.results} result tiles after voice`);

    // The holding controller drops out mid-hold: the hold ends there (6.1, holds), not at the 10 s limit.
    const postsBeforeDrop = posts.length;
    const dropped = {};
    await selectTarget(page, step, 'find:speak', {
      hold: async () => {
        await until(page, step, (_v, s) => s.headset.voice === 'listening', 'listening before the drop', fail, 60);
        await page.waitForTimeout(600);
        await page.evaluate(() => (window.IWER_DEVICE.controllers.right.connected = false));
        await until(page, step, (_v, s) => s.headset.voice !== 'listening', 'the hold ending on the drop', fail, 60);
        dropped.voiceAfterDrop = (await search(page)).headset.voice;
        // Released while away: coming back with the trigger down would be a new press.
        await page.evaluate(() => {
          window.IWER_DEVICE.controllers.right.updateButtonValue('trigger', 0);
          window.IWER_DEVICE.controllers.right.connected = true;
        });
        await step(4);
      }
    });
    await until(page, step, (_v, s) => s.headset.voice === 'idle', 'idle after the drop', fail);
    dropped.posted = posts.length - postsBeforeDrop;
    if (dropped.posted !== 1) fail(`the dropped hold posted ${dropped.posted} recordings`);

    // Not configured: a short message, and typing still works.
    transcribe = { status: 503, body: { message: 'Voice search is not configured.' } };
    await speakFor(800);
    await until(page, step, (_v, s) => s.headset.voice === 'idle' && s.headset.notice !== null, 'the 503 notice', fail);
    found = await search(page);
    // The browser logs the 503 this step asks for; it is the case under test, not a fault.
    const expected = (error) => error.startsWith(`${label} console.error: Failed to load resource: the server responded with a status of 503`);
    const expectedErrors = consoleErrors.filter(expected).length;
    for (let i = consoleErrors.length - 1; i >= 0; i -= 1) if (expected(consoleErrors[i])) consoleErrors.splice(i, 1);
    const unavailable = { expectedErrors, notice: found.headset.notice, status: (await chrome(page)).find?.status, query: found.headset.query };
    if (unavailable.notice !== 'Voice search is unavailable; type instead.') fail(`503 said ${JSON.stringify(unavailable)}`);
    if (unavailable.query !== 'chair') fail('a failed transcription cleared the query');
    return { label, status: failures.length ? 'fail' : 'pass', failures, heard, dropped, unavailable, posts, voiceLog: found.voiceLog, speakTraces };
  } finally {
    await context.close();
  }
}

/**
 * Desktop: Speak in the Find field takes the Web Speech API's path, where the
 * words appear while speaking. Headless Chromium has no speech service, so a
 * scripted recogniser stands in: "lam" interim, then "lamp" final. Then the
 * same API failing ("network") falls back to recording and transcribing.
 */
export async function runDesktopVoiceTake({ browser, baseUrl, captureRoot, artifactDir, consoleErrors }) {
  const label = 'desktop-voice';
  const failures = [];
  const fail = (message) => failures.push(message);
  await mkdir(artifactDir, { recursive: true });
  const fixture = await readFile(path.join(captureRoot, 'fixtures/objects/credited-bracket.glb'));
  const credit = readGlb(fixture).json.asset.extras.holoimCredit;
  const { context, page } = await setupPage(browser, { iwer: false, consoleErrors, label });
  try {
    await context.grantPermissions(['microphone']);
    await page.addInitScript(() => {
      // A recogniser scripted by the check: window.__speech = { interim, final } or { error }.
      class ScriptedRecognition {
        start() {
          const script = window.__speech;
          setTimeout(() => {
            if (script.error) {
              this.onerror?.({ error: script.error });
              this.onend?.();
              return;
            }
            const result = (transcript, isFinal) => Object.assign([{ transcript }], { isFinal });
            this.onresult?.({ resultIndex: 0, results: [result(script.interim, false)] });
            window.__speechInterimShown = true;
          }, 50);
        }
        stop() {
          const script = window.__speech;
          if (script.error) return;
          const result = (transcript, isFinal) => Object.assign([{ transcript }], { isFinal });
          setTimeout(() => {
            this.onresult?.({ resultIndex: 0, results: [result(script.final, true)] });
            this.onend?.();
          }, 20);
        }
        abort() {}
      }
      window.webkitSpeechRecognition = ScriptedRecognition;
      window.SpeechRecognition = ScriptedRecognition;
      window.__speech = { interim: 'lam', final: 'lamp' };
    });
    const registry = await routeRegistry(page, fixture, credit);
    const posts = [];
    await page.route('**/api/objects/transcribe', (route) => {
      posts.push({ contentType: route.request().headers()['content-type'] ?? null, bytes: route.request().postDataBuffer()?.length ?? 0 });
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ text: 'plant' }) });
    });
    await openCapture(page, baseUrl, {});
    await page.evaluate((ms) => window.advanceTime(ms), 60 * STEP_MS);
    await page.getByRole('button', { name: 'Settings' }).click();
    const capabilities = await page.getByTestId('find-capabilities').innerText().catch(() => null);
    const field = page.getByLabel('Find an object');

    // Speech recognition: interim words in the field while listening, then the final phrase searched.
    await page.getByRole('button', { name: 'Speak to find' }).click();
    await page.waitForFunction(() => window.__speechInterimShown === true);
    await page.waitForFunction(() => document.querySelector('input[aria-label="Find an object"]')?.value === 'lam', null, { timeout: 5_000 }).catch(() => fail('the interim words did not show while listening'));
    const interim = await field.inputValue();
    await page.getByRole('button', { name: 'Stop listening' }).click();
    await page.getByRole('button', { name: `Add ${credit.title} to the tray` }).waitFor({ timeout: 10_000 }).catch(() => fail('no results after speaking'));
    const recognised = { interim, query: await field.inputValue(), searched: registry.queries.at(-1), path: (await page.evaluate(() => window.__sampleObjectSearch().voiceLog)).at(-1) ?? null };
    if (recognised.query !== 'lamp' || recognised.searched !== 'lamp' || recognised.path?.path !== 'speech-recognition' || recognised.path.outcome !== 'heard') fail(`speech recognition: ${JSON.stringify(recognised)}`);

    // The API listed but broken: this and later queries record and transcribe instead.
    await page.evaluate(() => (window.__speech = { error: 'network' }));
    await page.getByRole('button', { name: 'Speak to find' }).click();
    await page.getByText('Listening…').waitFor({ timeout: 10_000 });
    await page.waitForTimeout(1200);
    await page.getByRole('button', { name: 'Stop listening' }).click();
    await page.waitForFunction(() => document.querySelector('input[aria-label="Find an object"]')?.value === 'plant', null, { timeout: 15_000 }).catch(() => fail('the fallback transcript did not reach the field'));
    const voiceLog = await page.evaluate(() => window.__sampleObjectSearch().voiceLog);
    const fallback = { query: await field.inputValue(), searched: registry.queries.at(-1), post: posts.at(-1) ?? null, log: voiceLog.slice(-2) };
    if (fallback.log[0]?.outcome !== 'fallback' || fallback.log[1]?.path !== 'transcribe' || fallback.log[1]?.outcome !== 'heard') fail(`fallback log ${JSON.stringify(fallback.log)}`);
    if (fallback.searched !== 'plant' || !/^audio\//.test(fallback.post?.contentType ?? '')) fail(`fallback: ${JSON.stringify(fallback)}`);
    if (!capabilities?.includes('webkitSpeechRecognition')) fail(`the dev capability line is missing (${capabilities})`);
    await page.screenshot({ path: path.join(artifactDir, `${label}.png`) });
    return { label, status: failures.length ? 'fail' : 'pass', failures, capabilities, recognised, fallback, voiceLog };
  } finally {
    await context.close();
  }
}
