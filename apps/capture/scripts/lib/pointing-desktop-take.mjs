import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { waitForPageFunctions, waitForTextContentPrefix, wireXrConsoleErrors, createXrContext } from '@holoim/tooling-testing/xr-env';
import { writeContactSheet } from '@holoim/tooling-testing/preview';

import { HOLOIM_MEANING_EXTENSION, validateHoloimMeaning } from '../../../../packages/meaning/src/index.ts';
import { TARGETS } from './pointing-scene.mjs';
import { readGlbJson } from './pointing-score.mjs';

// Self-resolving pointing, desktop side. A scripted desktop take in the
// generated pointing-targets scene, driven through capture's real desktop
// input path where headless Chromium allows and through the mock input hook
// (`point`, `lookYaw`, `aimPitch`) elsewhere:
//   phase 0 (not recording): every way a hold ends — mouseup, keyup, blur,
//     page hidden, pointer lock lost — plus the context menu being cancelled;
//   phase 1 (recording): hold on A (third person, mock point), release, turn,
//     hold on B (first person, a REAL right-button hold under pointer lock),
//     release, turn, hold at the sky (third person, real F key), release.
// Expects two `recorded` links, A then B, three inferred motion spans (one
// per hold) and nothing linked for the sky; the crosshair lands on the target
// and the avatar's index finger lines up with the aim.

const STEP_MS = 1000 / 60;
const TOLERANCE_SEC = 0.35;
const AIM_TOLERANCE_DEG = 12;
const LANDING_TOLERANCE_M = 0.35;
const REST_TOLERANCE_M = 0.06;
const SCENE = '/fixtures/scenes/pointing-targets.gltf';
const VIEWPORT = { width: 960, height: 540 };

const sub = (a, b) => a.map((v, i) => v - b[i]);
const norm = (v) => v.map((x) => x / Math.hypot(...v));
const angleDeg = (a, b) => (Math.acos(Math.max(-1, Math.min(1, norm(a).reduce((sum, v, i) => sum + v * norm(b)[i], 0)))) * 180) / Math.PI;
const round = (value, digits = 2) => Number(value.toFixed(digits));

export async function runDesktopPointingCheck({ browser, baseUrl, artifactDir, consoleErrors }) {
  const label = 'desktop-pointing-targets';
  const failures = [];
  const fail = (message) => failures.push(message);
  const context = await createXrContext(browser, { viewport: VIEWPORT, acceptDownloads: true });
  const page = await context.newPage();
  wireXrConsoleErrors(page, consoleErrors, { label });
  await page.route('**/__holoim/input-recordings*', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '{}' }));
  const url = new URL(baseUrl);
  url.searchParams.set('scene', SCENE);
  url.searchParams.set('sceneScale', '1');
  url.searchParams.set('manualClock', '1');
  await page.goto(url.href, { waitUntil: 'networkidle' });
  await waitForPageFunctions(page, ['advanceTime', 'render_game_to_text', '__setMockInput', '__sampleHands', '__setManualClock']);
  await waitForTextContentPrefix(page, '#status', 'loaded');

  const state = () => page.evaluate(() => JSON.parse(window.render_game_to_text()));
  let elapsed = 0;
  let recording = false;
  const advance = async (seconds) => {
    const steps = Math.max(1, Math.round((seconds * 1000) / STEP_MS));
    await page.evaluate((ms) => window.advanceTime(ms), steps * STEP_MS);
    if (recording) elapsed += steps * STEP_MS / 1000;
  };
  const mock = (payload) => page.evaluate((arg) => window.__setMockInput(arg), payload);
  const held = async () => (await state()).point.held;
  const canvasCenter = { x: VIEWPORT.width / 2, y: VIEWPORT.height / 2 };

  // --- Pointer lock: confirm early whether headless Chromium grants it. ---
  await page.evaluate(() => {
    window.__lockEvents = [];
    document.addEventListener('pointerlockchange', () => window.__lockEvents.push('change'));
    document.addEventListener('pointerlockerror', () => window.__lockEvents.push('error'));
  });
  await page.mouse.click(canvasCenter.x, canvasCenter.y);
  await page.waitForTimeout(400);
  const realLock = await page.evaluate(() => ({ granted: document.pointerLockElement === document.querySelector('canvas'), events: window.__lockEvents }));
  // Chromium (headless shell, --headless=new, even a headed Chrome driven over
  // CDP) rejects the request with "WrongDocumentError: The root document of
  // this element is not valid for pointer lock". The lock is then simulated at
  // the DOM API boundary: capture's own click handler still calls
  // requestPointerLock and its handlers still read document.pointerLockElement,
  // while the right button, F key and mouse movement are real CDP input.
  if (!realLock.granted) {
    await page.evaluate(() => {
      const canvas = document.querySelector('canvas');
      let locked = false;
      Object.defineProperty(document, 'pointerLockElement', { configurable: true, get: () => (locked ? canvas : null) });
      canvas.requestPointerLock = () => {
        locked = true;
        document.dispatchEvent(new Event('pointerlockchange'));
        return Promise.resolve();
      };
      document.exitPointerLock = () => {
        locked = false;
        document.dispatchEvent(new Event('pointerlockchange'));
      };
    });
  }
  const pointerLock = { headlessGrants: realLock.granted, realEvents: realLock.events, simulated: !realLock.granted };
  await page.mouse.click(canvasCenter.x, canvasCenter.y);
  await page.waitForTimeout(100);
  if (!(await page.evaluate(() => document.pointerLockElement === document.querySelector('canvas')))) throw new Error('the pointer lock stand-in did not engage');
  const relock = async () => {
    if (await page.evaluate(() => document.pointerLockElement === document.querySelector('canvas'))) return;
    await page.mouse.click(canvasCenter.x, canvasCenter.y);
    await page.waitForTimeout(300);
  };

  // --- Phase 0: release paths (not recording, so nothing is exported). ---
  await advance(1.0);
  const baseline = (await page.evaluate(() => window.__sampleHands())).right.avatar.wrist;
  const releasePaths = [];
  const expectHeld = async (name, expected) => {
    await advance(0.1);
    const actual = await held();
    releasePaths.push({ path: name, held: actual, expected, ok: actual === expected });
    if (actual !== expected) fail(`release path ${name}: held is ${actual}, expected ${expected}`);
  };
  await relock();
  await page.mouse.down({ button: 'right' });
  await expectHeld('mousedown (right, locked)', true);
  await advance(0.4);
  await page.mouse.up({ button: 'right' });
  await expectHeld('mouseup', false);
  await page.keyboard.down('KeyF');
  await expectHeld('keydown F', true);
  await page.keyboard.up('KeyF');
  await expectHeld('keyup F', false);
  await page.keyboard.down('KeyF');
  await advance(0.1);
  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  await expectHeld('blur', false);
  await page.keyboard.up('KeyF');
  await page.keyboard.down('KeyF');
  await advance(0.1);
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    document.dispatchEvent(new Event('visibilitychange'));
    delete document.hidden;
  });
  await expectHeld('page hidden', false);
  await page.keyboard.up('KeyF');
  await relock();
  await page.mouse.down({ button: 'right' });
  await advance(0.1);
  await page.evaluate(() => document.exitPointerLock());
  await advance(0.1);
  await expectHeld('pointer lock lost', false);
  await page.mouse.up({ button: 'right' });
  const menuPrevented = await page.evaluate(() => {
    const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    document.querySelector('canvas').dispatchEvent(event);
    return event.defaultPrevented;
  });
  releasePaths.push({ path: 'contextmenu cancelled', ok: menuPrevented });
  if (!menuPrevented) fail('the context menu opened on the canvas');
  // Mouse-up with the cursor off the canvas still ends it (document listener).
  await advance(0.6);
  const settled = (await page.evaluate(() => window.__sampleHands())).right.avatar.wrist;
  const restDrift = Math.hypot(...sub(settled, baseline));
  if (restDrift > REST_TOLERANCE_M) fail(`arm did not return to its locomotion pose after release: wrist is ${round(restDrift, 3)} m from baseline (limit ${REST_TOLERANCE_M})`);

  // --- Phase 1: the recorded take. ---
  await page.getByRole('button', { name: 'Start Recording' }).evaluate((el) => el.click());
  await page.getByRole('button', { name: 'Stop Recording' }).waitFor();
  recording = true;
  await advance(1.0);

  const frameDir = path.join(artifactDir, `${label}-frames`);
  await mkdir(frameDir, { recursive: true });
  let shotIndex = 0;
  const shoot = async (name) => {
    // The scene and crosshair only: no app chrome. Close in on the avatar.
    await page.evaluate(() => {
      document.getElementById('ui-root').style.display = 'none';
      window.__setManualClock(true, true);
    });
    await new Promise((resolve) => setTimeout(resolve, 150));
    await page.screenshot({ path: path.join(frameDir, `${String(shotIndex).padStart(2, '0')}-${name}.png`), clip: { x: 200, y: 60, width: 560, height: 360 } });
    shotIndex += 1;
    await page.evaluate(() => {
      document.getElementById('ui-root').style.display = '';
      window.__setManualClock(true, false);
    });
  };
  await shoot('idle');

  const aimAt = (point, eye) => {
    const d = sub(point, eye);
    return { lookYaw: Math.atan2(-d[0], -d[2]), aimPitch: Math.asin(d[1] / Math.hypot(...d)) };
  };
  const holds = [];
  const takeHold = async ({ name, view, target, sky, press, release }) => {
    const wantFirst = view === 'first';
    if ((await state()).mode === 'first' !== wantFirst) {
      await page.keyboard.press('KeyV');
      await advance(0.3);
    }
    const eyeNow = async () => {
      const eye = (await state()).heightAdaptation.eyeWorld;
      return [eye.x, eye.y, eye.z];
    };
    const aimFor = async () => (sky ? { lookYaw: 0.25, aimPitch: 0.6 } : aimAt(TARGETS[target].center, await eyeNow()));
    // Face the target first; the eye shifts a little as the body turns.
    await mock(await aimFor());
    await advance(0.3);
    await mock(await aimFor());
    await advance(0.1);
    const start = elapsed;
    await press();
    await advance(0.1);
    // Pressing starts the aim level (third person); steer it onto the target.
    await mock(await aimFor());
    await advance(0.3);
    // Real vertical mouse movement under pointer lock steers the aim pitch.
    let pitchSteer;
    if (name === 'B') {
      const before = (await state()).point.aimPitch;
      await page.mouse.move(canvasCenter.x, canvasCenter.y + 12);
      await advance(0.1);
      const after = (await state()).point.aimPitch;
      pitchSteer = { before: round(before, 3), after: round(after, 3) };
      if (!(after < before)) fail('B: moving the mouse down under pointer lock did not lower the aim pitch');
      await mock(await aimFor());
    }
    await advance(0.5);
    const mid = await state();
    const crosshair = await page.evaluate(() => {
      const element = document.getElementById('point-crosshair');
      const rect = element?.getBoundingClientRect();
      return element ? { display: getComputedStyle(element).display, landed: element.dataset.landed, x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 } : null;
    });
    const hands = await page.evaluate(() => window.__sampleHands());
    const tip = hands.right.avatar['index-finger-tip'];
    const proximal = hands.right.avatar['index-finger-phalanx-proximal'];
    const direction = mid.point;
    await shoot(`${name}-${view}`);
    await advance(0.4);
    const end = elapsed;
    await release();
    await advance(0.8);
    const entry = { name, view, target: sky ? null : target, start: round(start), end: round(end), crosshair, landing: direction.landing, landed: direction.landed };
    if (!crosshair || crosshair.display !== 'block') fail(`${name}: the crosshair is not shown while the point action is held`);
    else if (crosshair.x < 0 || crosshair.y < 0 || crosshair.x > VIEWPORT.width || crosshair.y > VIEWPORT.height) fail(`${name}: the crosshair is off screen at (${round(crosshair.x)}, ${round(crosshair.y)})`);
    if (sky) {
      if (direction.landed) fail('sky: the aim ray landed on geometry');
      if (crosshair?.landed !== 'false') fail('sky: the crosshair should show the no-landing style');
    } else {
      const miss = Math.hypot(...sub(direction.landing, TARGETS[target].center));
      entry.landingErrorM = round(miss);
      if (!direction.landed || miss > LANDING_TOLERANCE_M) fail(`${name}: the aim ray lands ${round(miss)} m from ${target} (limit ${LANDING_TOLERANCE_M})`);
    }
    // The finger really lines up with the aim: tip minus proximal against the eye ray.
    const aimDir = mid.point.direction;
    if (aimDir) {
      entry.fingerAimErrorDeg = round(angleDeg(sub(tip, proximal), aimDir));
      if (entry.fingerAimErrorDeg > AIM_TOLERANCE_DEG) fail(`${name}: the index finger is ${entry.fingerAimErrorDeg}° off the aim (limit ${AIM_TOLERANCE_DEG}°)`);
    }
    if (pitchSteer) entry.pitchSteer = pitchSteer;
    holds.push(entry);
  };
  const turn = async (yaw) => {
    await mock({ lookYaw: yaw });
    await advance(0.6);
  };

  await takeHold({
    name: 'A', view: 'third', target: 'TargetA',
    press: () => mock({ point: true }), release: () => mock({ point: false })
  });
  await turn(1.1);
  await takeHold({
    name: 'B', view: 'first', target: 'TargetB',
    press: async () => {
      await relock();
      await page.mouse.down({ button: 'right' });
    },
    release: () => page.mouse.up({ button: 'right' })
  });
  await turn(-0.9);
  await takeHold({
    name: 'sky', view: 'third', sky: true,
    press: () => page.keyboard.down('KeyF'), release: () => page.keyboard.up('KeyF')
  });
  // Face the way the baseline did, so the wrist compares like for like.
  await mock({ lookYaw: 0 });
  await advance(0.8);
  await shoot('after');
  const after = (await page.evaluate(() => window.__sampleHands())).right.avatar.wrist;
  const afterDrift = Math.hypot(...sub(after, baseline));
  if (afterDrift > REST_TOLERANCE_M) fail(`arm did not return to its locomotion pose after the take: wrist is ${round(afterDrift, 3)} m from baseline (limit ${REST_TOLERANCE_M})`);

  const downloaded = page.waitForEvent('download', { timeout: 120_000 });
  await page.getByRole('button', { name: 'Stop Recording' }).evaluate((el) => el.click());
  const download = await downloaded;
  const glbPath = path.join(artifactDir, `${label}.glb`);
  await copyFile(await download.path(), glbPath);
  const gltf = readGlbJson(await readFile(glbPath));

  const score = scoreDesktop({ gltf, holds });
  failures.push(...score.failures);
  const sheet = writeContactSheet(frameDir, path.join(artifactDir, `${label}-sheet.jpg`));
  const report = {
    label,
    useFor: 'desktop point action',
    glb: glbPath,
    sheet,
    pointerLock,
    releasePaths,
    restDriftM: { afterReleasePaths: round(restDrift, 3), afterTake: round(afterDrift, 3) },
    holds,
    status: failures.length === 0 ? 'passed' : 'failed',
    failures,
    links: score.links,
    spans: score.spans
  };
  await writeFile(path.join(artifactDir, `${label}-report.json`), JSON.stringify(report, null, 2));
  await context.close();
  return report;
}

function scoreDesktop({ gltf, holds }) {
  const failures = [];
  const raw = gltf.extensions?.[HOLOIM_MEANING_EXTENSION];
  if (raw === undefined) return { failures: [`no ${HOLOIM_MEANING_EXTENSION} in the desktop take's GLB`], links: [], spans: [] };
  const validation = validateHoloimMeaning(raw);
  if (!validation.ok) return { failures: [`${HOLOIM_MEANING_EXTENSION} fails the v0 schema: ${validation.errors.join('; ')}`], links: [], spans: [] };
  if (!(gltf.extensionsUsed ?? []).includes(HOLOIM_MEANING_EXTENSION)) failures.push('extension missing from extensionsUsed');
  if ((gltf.extensionsRequired ?? []).includes(HOLOIM_MEANING_EXTENSION)) failures.push('extension listed in extensionsRequired');
  const nodeNames = (gltf.nodes ?? []).map((node) => node.name ?? '');
  if (nodeNames.some((name) => /crosshair/i.test(name))) failures.push('the crosshair appears in the export');

  const links = validation.value.marks.map((mark) => ({
    from: mark.anchor.from.bone,
    to: mark.anchor.to.bone ?? gltf.nodes?.[mark.anchor.to.node]?.name ?? `node ${mark.anchor.to.node}`,
    start: round(mark.span.start),
    end: round(mark.span.end),
    provenance: mark.provenance
  }));
  const spans = (validation.value.spans ?? []).map((span) => ({ bones: span.bones, start: round(span.span.start), end: round(span.span.end), provenance: span.provenance }));

  const linked = holds.filter((hold) => hold.target);
  if (links.length !== linked.length) failures.push(`${links.length} link(s) for ${linked.length} held point(s) with a target`);
  linked.forEach((hold, index) => {
    const link = links[index];
    if (!link) return;
    if (link.to !== `${hold.target}_RecordedBubble`) failures.push(`${hold.name}: link ${index + 1} goes to ${link.to}, expected ${hold.target}`);
    if (link.provenance.value !== 'recorded') failures.push(`${hold.name}: provenance ${link.provenance.value}, expected recorded`);
    if (link.from !== 'rightIndexDistal') failures.push(`${hold.name}: from ${link.from}, expected rightIndexDistal`);
    if (Math.abs(link.start - hold.start) > TOLERANCE_SEC + 0.1 || Math.abs(link.end - hold.end) > TOLERANCE_SEC) {
      failures.push(`${hold.name}: link ${link.start}–${link.end} s is not within ${TOLERANCE_SEC} s of the hold ${hold.start}–${hold.end} s`);
    }
  });
  for (const hold of holds.filter((entry) => !entry.target)) {
    for (const link of links) {
      if (Math.min(link.end, hold.end) - Math.max(link.start, hold.start) > 0.05) failures.push(`${hold.name}: a link overlaps the sky hold`);
    }
  }
  if (spans.length !== holds.length) failures.push(`${spans.length} motion span(s) for ${holds.length} hold(s)`);
  holds.forEach((hold, index) => {
    const span = spans[index];
    if (!span) return;
    if (span.provenance.value !== 'inferred') failures.push(`${hold.name}: motion span provenance ${span.provenance.value}, expected inferred`);
    if (!span.bones.includes('rightUpperArm') || !span.bones.includes('rightHand')) failures.push(`${hold.name}: motion span bones ${span.bones.join(',')} lack the arm`);
    if (span.start > hold.start + TOLERANCE_SEC || span.end < hold.end - TOLERANCE_SEC) failures.push(`${hold.name}: motion span ${span.start}–${span.end} s does not cover the hold ${hold.start}–${hold.end} s`);
  });
  return { failures, links, spans };
}
