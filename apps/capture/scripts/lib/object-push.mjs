import * as THREE from 'three';

import {
  createXrContext,
  enterIwerSessionFromButton,
  freezePageClock,
  waitForIwerRuntime,
  waitForPageFunctions,
  waitForTextContentPrefix,
  waitForXrRenderLoop,
  wireXrConsoleErrors
} from '@holoim/tooling-testing/xr-env';

import { OBJECT_URL, openCapture, readState, setupPage } from './object-take.mjs';

// Push, pull and fetch (docs/features/object-resize-and-move.md, slice 2), by
// capture's real input paths. Each run returns pass/fail `rows` with numbers.
//   pushDesktop / fetchDesktop: Shift+wheel and a mouse press from a distance
//     (the pointer lock is stood in at the DOM API, as the mouse check does).
//   pushPhone / fetchPhone: a two-finger pan and a lone tap (CDP touch).
//   pushIwer / fetchIwer: the right stick's Y and a squeeze with the
//     controller's ray on a prop beyond reach.

const STEP_MS = 1000 / 60;
const SURFACES_Y = [0.01, 0.29];
const round = (value, digits = 4) => Number(Number(value).toFixed(digits));
const centreOf = (item) => [0, 1, 2].map((a) => (item.boundsMin[a] + item.boundsMax[a]) / 2);
const surfaceGap = (y) => Math.min(...SURFACES_Y.map((s) => Math.abs(y - s)));
const dist = (a, b) => Math.hypot(...a.map((v, k) => v - b[k]));

function makeRows(failures) {
  const rows = [];
  const row = (name, ok, values = {}) => {
    rows.push({ name, pass: Boolean(ok), ...values });
    if (!ok) failures.push(`${name}: ${JSON.stringify(values)}`);
  };
  return { rows, row };
}

async function openFlat(browser, baseUrl, consoleErrors, label, { viewport, touch = false, scene } = {}) {
  const context = await createXrContext(browser, { viewport, acceptDownloads: true, ...(touch ? { hasTouch: true, isMobile: true, deviceScaleFactor: 2 } : {}) });
  const page = await context.newPage();
  wireXrConsoleErrors(page, consoleErrors, { label });
  await page.route('**/__holoim/input-recordings*', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '{"path":"object-push-input.json"}' }));
  await openCapture(page, baseUrl, { object: OBJECT_URL, ...(scene ? { scene } : {}) });
  await waitForPageFunctions(page, ['__projectToScreen', '__loadObjectUrl', '__setMockInput', '__sampleHolds']);
  await waitForTextContentPrefix(page, '#status', 'loaded');
  const s = { context, page, viewport };
  s.advance = (seconds) => page.evaluate((ms) => window.advanceTime(ms), Math.max(1, Math.round(seconds * 60)) * STEP_MS);
  s.state = () => readState(page);
  s.item = async () => (await readState(page)).objects.items[0];
  s.stats = async () => (await readState(page)).objects.physics;
  s.reload = async () => {
    if (!(await page.evaluate((url) => window.__loadObjectUrl(url), OBJECT_URL))) throw new Error('the object did not reload');
    await s.advance(0.5);
  };
  s.until = async (test, maxSec = 4) => {
    let current = await s.item();
    for (let i = 0; i < Math.round(maxSec * 60) && !test(current); i += 1) {
      await s.advance(1 / 60);
      current = await s.item();
    }
    return current;
  };
  s.rest = (maxSec = 4) => s.until((it) => it.body === 'asleep', maxSec);
  /** Releases (the caller has already asked) and reports the last held and first free state. */
  s.letGo = async (maxSec = 3) => {
    let last = await s.item();
    let free = last;
    const heldTrace = [];
    for (let i = 0; i < Math.round(maxSec * 60); i += 1) {
      await s.advance(1 / 60);
      free = await s.item();
      if (!free.heldBy) break;
      heldTrace.push(round(free.boundsMin[1]));
      last = free;
    }
    return { last, free, heldTrace, steps: heldTrace.length };
  };
  return s;
}


const SCAN = (() => {
  const points = [];
  for (let x = -16; x <= 16; x += 4) for (let y = -16; y <= 16; y += 4) points.push([x, y]);
  return points.sort((p, q) => Math.hypot(...p) - Math.hypot(...q));
})();

/** Points the first-person view so the prop's bounds centre sits at `offset` from the view centre (the bracket is an L: some points of it are model, some are not). */
function makeAimer(s, viewport) {
  const centre = { x: viewport.width / 2, y: viewport.height / 2 };
  const FOCAL_PX = viewport.height / 2 / Math.tan((35 * Math.PI) / 180);
  let view = null;
  const aim = async (offset = { x: 0, y: 0 }) => {
    if (!view) {
      const st = await s.state();
      const eye = st.heightAdaptation.eyeWorld;
      const c = centreOf(st.objects.items[0]);
      const d = [c[0] - eye.x, c[1] - eye.y, c[2] - eye.z];
      view = { yaw: Math.atan2(-d[0], -d[2]), pitch: Math.asin(d[1] / Math.hypot(...d)) };
    }
    let error = Infinity;
    for (let i = 0; i < 8; i += 1) {
      await s.page.evaluate((arg) => window.__setMockInput(arg), { lookYaw: view.yaw, aimPitch: view.pitch });
      await s.advance(0.1);
      const at = await s.page.evaluate((p) => window.__projectToScreen(p), centreOf(await s.item()));
      if (!at) return Infinity;
      const ex = at.x - (centre.x + offset.x);
      const ey = at.y - (centre.y + offset.y);
      error = Math.hypot(ex, ey);
      if (error < 2) break;
      view = { yaw: view.yaw - Math.atan(ex / FOCAL_PX), pitch: view.pitch - Math.atan(ey / FOCAL_PX) };
    }
    return error;
  };
  /** Presses at the view centre with the prop at each scan offset until one holds it; returns the offset (the button stays down), or null. */
  const pressScan = async () => {
    for (const [x, y] of SCAN) {
      await aim({ x: -x, y: -y });
      await s.page.mouse.move(centre.x, centre.y);
      await s.page.mouse.down();
      await s.advance(3 / 60);
      if ((await s.item()).heldBy) return { x, y };
      await s.page.mouse.up();
      await s.advance(1 / 60);
    }
    return null;
  };
  return { aim, pressScan, centre, reset: () => { view = null; } };
}

// ---------------------------------------------------------------- desktop push

export async function runDesktopPush({ browser, baseUrl, consoleErrors }) {
  const label = 'push-desktop';
  const failures = [];
  const { rows, row } = makeRows(failures);
  const s = await openFlat(browser, baseUrl, consoleErrors, label, { viewport: { width: 960, height: 540 } });
  const { page, advance } = s;
  try {
    await advance(1);
    await page.keyboard.press('KeyV');
    const canvas = page.locator('canvas').first();
    await canvas.focus();
    const box = await canvas.boundingBox();
    const centre = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    const wheel = async (deltaY, shift = true) => {
      await page.mouse.move(centre.x, centre.y);
      if (shift) await page.keyboard.down('Shift');
      await page.mouse.wheel(0, deltaY);
      if (shift) await page.keyboard.up('Shift');
      await advance(1 / 60);
    };
    const grab = async () => {
      await page.keyboard.press('KeyG');
      await s.until((it) => it.heldBy, 3);
      await advance(0.8);
      return s.item();
    };

    const held = await grab();
    row('G grabs the prop', held.heldBy === 'right' && held.pushM === 0, { heldBy: held.heldBy, pushM: held.pushM });
    const yaw = (await s.state()).avatar.yaw;
    const facing = [-Math.sin(yaw), 0, -Math.cos(yaw)];
    const p0 = held.position;
    const hand0 = (await s.state()).objects.hands.right.position;

    await wheel(-400);
    const out1 = await item2(s);
    const moved = out1.position.map((v, k) => v - p0[k]);
    const cos = (moved[0] * facing[0] + moved[2] * facing[2]) / Math.hypot(...moved);
    row('Shift+wheel 4 notches up pushes 1.0 m (+-0.03)', Math.abs(out1.pushM - 1) <= 0.03, { pushM: round(out1.pushM) });
    row('prop moved by pushM along the view (distance +-0.05, horizontal cosine > 0.7)', Math.abs(Math.hypot(...moved) - out1.pushM) <= 0.05 && cos > 0.7, { movedM: round(Math.hypot(...moved)), cosFacing: round(cos, 3) });
    row('Shift+wheel does not resize', out1.size === 1, { size: out1.size });

    await wheel(400);
    const back = await s.item();
    row('Shift+wheel down pulls it back to the hand', back.pushM === 0 && dist(back.position, p0) <= 0.03, { pushM: back.pushM, offHandM: round(dist(back.position, p0), 3) });
    await wheel(400);
    row('pull clamps at 0', (await s.item()).pushM === 0, { pushM: (await s.item()).pushM });
    await wheel(-1800);
    const far = await s.item();
    row('push clamps at 4 m', far.pushM === 4 && Math.abs(dist(far.position, p0) - 4) <= 0.06, { pushM: far.pushM, movedM: round(dist(far.position, p0), 3) });
    await wheel(800);
    const two = await s.item();
    row('pulled back to 2 m', Math.abs(two.pushM - 2) <= 0.03, { pushM: round(two.pushM) });

    // Release pushed out: the prop is lowered by itself, the hand stays, then it is let go on the surface.
    const before = await s.item();
    const beforeCentre = centreOf(before);
    await page.keyboard.press('KeyG');
    const out = await s.letGo();
    const handNow = (await s.state()).objects.hands.right.position;
    const gap = surfaceGap(out.free.boundsMin[1]);
    const speed = Math.hypot(out.free.linvel[0], out.free.linvel[2]);
    row('a pushed release is held through a short lowering, then let go', out.steps >= 5 && out.steps <= 60 && !out.free.heldBy, { heldSteps: out.steps, loweredFromM: round(before.boundsMin[1] - out.last.boundsMin[1], 3) });
    row('the prop (not the hand) was lowered', out.last.boundsMin[1] < before.boundsMin[1] - 0.05 && dist(handNow, hand0) <= 0.05, { propLoweredM: round(before.boundsMin[1] - out.last.boundsMin[1], 3), handMovedM: round(dist(handNow, hand0), 3) });
    row('let go just above a surface, not thrown', gap <= 0.03 && speed <= 0.05 && Math.abs(out.free.linvel[1]) <= 0.3, { gapM: round(gap, 4), sidewaysMps: round(speed, 3), fallMps: round(out.free.linvel[1], 3), boundsMinY: round(out.free.boundsMin[1]) });
    const resting = await s.rest();
    const drift = Math.hypot(centreOf(resting)[0] - centreOf(out.free)[0], centreOf(resting)[2] - centreOf(out.free)[2]);
    const fromPushed = Math.hypot(centreOf(resting)[0] - beforeCentre[0], centreOf(resting)[2] - beforeCentre[2]);
    row('at rest on the surface below where it was pushed', resting.body === 'asleep' && surfaceGap(resting.boundsMin[1]) <= 0.01 && fromPushed <= 0.08, { body: resting.body, boundsMinY: round(resting.boundsMin[1]), afterLetGoDriftM: round(drift, 3), fromPushedSpotM: round(fromPushed, 3) });
    row('no bounds reset', (await s.stats())?.resets === 0, { resets: (await s.stats())?.resets });

    // A wall stops the push (reach-wall: a wall left of the avatar, between it and x -0.72).
    await page.close();
    return { label, status: failures.length ? 'fail' : 'pass', failures, rows, wall: await wallPush({ browser, baseUrl, consoleErrors, row }) };
  } finally {
    await s.context.close();
  }
}

async function item2(s) {
  await s.advance(0.1);
  return s.item();
}

async function wallPush({ browser, baseUrl, consoleErrors, row }) {
  const s = await openFlat(browser, baseUrl, consoleErrors, 'push-desktop-wall', { viewport: { width: 960, height: 540 }, scene: '/fixtures/scenes/reach-wall.gltf' });
  const { page, advance } = s;
  try {
    await advance(1);
    await s.reload();
    await page.keyboard.press('KeyV');
    const canvas = page.locator('canvas').first();
    await canvas.focus();
    await page.keyboard.press('KeyG');
    await s.until((it) => it.heldBy, 3);
    await advance(0.8);
    // Carry it 2.5 m east, away from the wall, then face the wall (-x).
    await page.keyboard.down('KeyD');
    for (let i = 0; i < 120 && (await s.state()).avatar.x < 2.5; i += 1) await advance(1 / 6);
    await page.keyboard.up('KeyD');
    await advance(0.5);
    await page.evaluate(() => window.__setMockInput({ lookYaw: Math.PI / 2, aimPitch: 0 }));
    await advance(0.5);
    const st = await s.state();
    const yaw = st.avatar.yaw;
    const held = await s.item();
    const box = await canvas.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.keyboard.down('Shift');
    for (let i = 0; i < 20; i += 1) {
      await page.mouse.wheel(0, -400);
      await advance(1 / 60);
    }
    await page.keyboard.up('Shift');
    await advance(0.3);
    const pushed = await s.item();
    const probeA = pushed.pushM;
    await page.keyboard.down('Shift');
    await page.mouse.wheel(0, -400);
    await page.keyboard.up('Shift');
    await advance(0.2);
    const after = await s.item();
    row('(reach-wall) facing the wall 2.5 m off, an 8 m push stops short of it', held.heldBy === 'right' && probeA > 0.5 && probeA < 3.5 && after.pushM <= probeA + 1e-6, { avatarX: round(st.avatar.x, 2), yaw: round(yaw, 3), pushM: round(probeA, 3), afterMorePushM: round(after.pushM, 3), movedM: round(dist(pushed.position, held.position), 3), propMinX: round(pushed.boundsMin[0], 3) });
    return { pushM: probeA };
  } finally {
    await s.context.close();
  }
}

// ---------------------------------------------------------------- desktop fetch

async function standInPointerLock(page) {
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

export async function runDesktopFetch({ browser, baseUrl, consoleErrors }) {
  const label = 'fetch-desktop';
  const failures = [];
  const { rows, row } = makeRows(failures);
  const viewport = { width: 960, height: 540 };
  const s = await openFlat(browser, baseUrl, consoleErrors, label, { viewport });
  const { page, advance } = s;
  try {
    await advance(1);
    await s.reload();
    await page.keyboard.press('KeyV');
    await standInPointerLock(page);
    const aimer = makeAimer(s, viewport);
    const { centre } = aimer;
    const eyeDist = async () => {
      const st = await s.state();
      return dist(centreOf(st.objects.items[0]), [st.heightAdaptation.eyeWorld.x, st.heightAdaptation.eyeWorld.y, st.heightAdaptation.eyeWorld.z]);
    };
    await aimer.aim();
    await page.mouse.click(centre.x, centre.y); // takes the pointer lock; grabs nothing
    await advance(0.3);
    const afterLock = await s.item();
    row('the lock-acquiring click took the lock and grabbed nothing', !afterLock.heldBy && (await page.evaluate(() => document.pointerLockElement === document.querySelector('canvas'))), { heldBy: afterLock.heldBy });
    await page.keyboard.down('KeyS');
    await advance(1.5);
    await page.keyboard.up('KeyS');
    await advance(0.3);
    aimer.reset();
    const d = await eyeDist();
    const handBefore = (await s.state()).objects.hands.right.position;
    row('the prop is out of reach of the hand and within 8 m of the eye', d > 2 && d <= 8 && dist(centreOf(await s.item()), handBefore) > 2, { eyeToPropM: round(d, 2) });
    const hand = async () => dist((await s.item()).position, (await s.state()).objects.hands.right.position);
    const startedFar = await hand();
    const hit = await aimer.pressScan();
    const early = await s.item();
    const earlyHand = await hand();
    row('a press on a prop out of reach fetches it at once (held within 3 steps)', hit !== null && early.heldBy === 'right', { hitOffsetPx: hit, handDistanceM: round(earlyHand, 2), startedFromM: round(startedFar, 2) });
    await advance(0.5);
    const landed = await s.item();
    const landedHand = await hand();
    row('it glides into the hand within 0.5 s', landed.heldBy === 'right' && landedHand <= 0.15 && landedHand < earlyHand, { handDistanceM: round(landedHand, 3), carryWeight: (await s.state()).objects.carryWeight });
    await page.mouse.up();
    await advance(1);
    const stays = await s.item();
    row('it stays held after the button lifts', stays.heldBy === 'right', { heldBy: stays.heldBy });
    // The next press lets it go (a still release sets it down).
    await page.mouse.down();
    await advance(0.2);
    await page.mouse.up();
    const freed = await s.until((it) => !it.heldBy, 4);
    const resting = await s.rest();
    row('the next press lets it go, and it comes to rest on a surface', !freed.heldBy && resting.body === 'asleep' && surfaceGap(resting.boundsMin[1]) <= 0.01, { heldBy: freed.heldBy, body: resting.body, boundsMinY: round(resting.boundsMin[1]) });

    // Beyond 8 m: a fresh prop, and the avatar walks diagonally to the far corner of the floor. The same press that fetched it nearby (same scan) fetches nothing.
    await s.reload();
    aimer.reset();
    await aimer.aim();
    let far8 = 0;
    await page.keyboard.down('KeyS');
    await page.keyboard.down('KeyD');
    for (let i = 0; i < 900 && far8 <= 8.4; i += 1) {
      await advance(1 / 6);
      far8 = await eyeDist();
    }
    await page.keyboard.up('KeyS');
    await page.keyboard.up('KeyD');
    await advance(0.4);
    far8 = await eyeDist();
    aimer.reset();
    if (far8 > 8.2) {
      const px = await aimer.aim();
      const beyond = await aimer.pressScan();
      const it = await s.item();
      await page.mouse.up();
      await advance(0.3);
      row('a press on a prop beyond 8 m fetches nothing (whole scan)', beyond === null && !it.heldBy && px <= 40, { eyeToPropM: round(far8, 2), aimedPx: round(px, 1), scanPoints: SCAN.length, heldBy: it.heldBy });
    } else row('beyond-8 m case could not be set up (floor too small)', false, { eyeToPropM: round(far8, 2) });

    return { label, status: failures.length ? 'fail' : 'pass', failures, rows, wall: await wallFetch({ browser, baseUrl, consoleErrors, row }) };
  } finally {
    await s.context.close();
  }
}

async function wallFetch({ browser, baseUrl, consoleErrors, row }) {
  const viewport = { width: 960, height: 540 };
  const s = await openFlat(browser, baseUrl, consoleErrors, 'fetch-desktop-wall', { viewport, scene: '/fixtures/scenes/reach-wall.gltf' });
  const { page, advance } = s;
  try {
    await advance(1);
    await s.reload();
    await page.keyboard.press('KeyV');
    await standInPointerLock(page);
    const walkUntil = async (key, test, maxSec = 12) => {
      await page.keyboard.down(key);
      for (let i = 0; i < maxSec * 6; i += 1) {
        await advance(1 / 6);
        if (test(await s.state())) break;
      }
      await page.keyboard.up(key);
      await advance(0.3);
    };
    await walkUntil('KeyS', (st) => st.avatar.z >= 1.0);
    await walkUntil('KeyA', (st) => st.avatar.x <= -0.72);
    await walkUntil('KeyW', (st) => st.avatar.z <= -0.2);
    const aimer = makeAimer(s, viewport);
    const it0 = await s.item();
    const error = await aimer.aim();
    await page.mouse.click(aimer.centre.x, aimer.centre.y);
    await advance(0.3);
    const hit = await aimer.pressScan();
    const behind = await s.item();
    await page.mouse.up();
    await advance(0.2);
    const st = await s.state();
    // The scan puts the prop under the view centre at every scan point; none of them may fetch it through the wall.
    row('(reach-wall) a press on a prop behind the wall fetches nothing (whole scan)', hit === null && !behind.heldBy && error <= 40 && st.avatar.x < -0.6, { aimedPx: round(error, 1), avatarX: round(st.avatar.x, 2), scanPoints: SCAN.length, heldBy: behind.heldBy, propMovedM: round(dist(behind.position, it0.position), 4) });
    return {};
  } finally {
    await s.context.close();
  }
}

// ---------------------------------------------------------------- touch

function touchRig(page) {
  return page.context().newCDPSession(page).then((cdp) => {
    const active = new Map();
    const send = (type, points) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: points.map(([id, x, y]) => ({ x, y, id, radiusX: 4, radiusY: 4, force: 1 })) });
    const all = () => [...active].map(([i, [x, y]]) => [i, x, y]);
    return {
      active,
      down: async (id, x, y) => { active.set(id, [x, y]); await send('touchStart', all()); },
      move: async (id, x, y) => { active.set(id, [x, y]); await send('touchMove', all()); },
      up: async (id) => { const [x, y] = active.get(id); await send('touchEnd', [[id, x, y]]); active.delete(id); }
    };
  });
}

export async function runPhoneFetchAndPush({ browser, baseUrl, consoleErrors }) {
  const label = 'push-fetch-phone';
  const failures = [];
  const { rows, row } = makeRows(failures);
  const s = await openFlat(browser, baseUrl, consoleErrors, label, { viewport: { width: 390, height: 844 }, touch: true });
  const { page, advance } = s;
  try {
    const t = await touchRig(page);
    const yawOf = async () => (await s.state()).avatar.yaw;
    const where = async () => page.evaluate((p) => window.__projectToScreen(p), centreOf(await s.item()));
    const handDist = async () => dist((await s.item()).position, (await s.state()).objects.hands.right.position);
    const GRID = SCAN;
    const setupFar = async () => {
      await advance(1);
      await s.reload();
      // Walk back with the stick until the prop is well out of reach.
      await t.down(9, 60, 600);
      await t.move(9, 60, 660);
      await t.move(9, 60, 700);
      await advance(0.7);
      await t.up(9);
      await advance(0.5);
    };
    await setupFar();
    const at = await where();
    const first = await s.item();
    const palm = (await s.state()).objects.hands.right.position;
    row('the prop is out of reach (> 1.2 m) and on screen', Boolean(at) && at.x > 156 && dist(first.position, palm) > 1.2, { screen: at && [round(at.x, 1), round(at.y, 1)], handDistanceM: round(dist(first.position, palm), 2) });
    if (!at) return { label, status: 'fail', failures, rows };

    // A lone tap fetches it: scan points around the prop's centre until one lands on the model.
    let P = null;
    let early = null;
    let earlyHand = null;
    for (const [dx, dy] of GRID) {
      await t.down(1, at.x + dx, at.y + dy);
      await advance(1 / 60);
      await t.up(1);
      await advance(2 / 60);
      early = await s.item();
      if (early.heldBy) { P = { x: at.x + dx, y: at.y + dy, dx, dy }; break; }
      await advance(0.1);
    }
    earlyHand = await handDist();
    row('a lone tap on it fetches it at once', P !== null, { tapAt: P, heldBy: early?.heldBy, handDistanceM: round(earlyHand, 2) });
    if (!P) return { label, status: 'fail', failures, rows };
    await advance(0.6);
    const landed = await s.item();
    const landedHand = await handDist();
    row('it glides into the hand and stays held with no finger down', landed.heldBy === 'right' && landedHand <= 0.15 && landedHand < earlyHand && t.active.size === 0, { handDistanceM: round(landedHand, 3) });

    // Two-finger pan up pushes it away, never looking, never resizing.
    const yaw0 = await yawOf();
    const p0 = landed.position;
    const a = [300, 520];
    const b = [350, 520];
    await t.down(1, ...a);
    await advance(1 / 60);
    await t.down(2, ...b);
    await advance(1 / 60);
    for (let i = 1; i <= 12; i += 1) {
      await t.move(1, a[0], a[1] - 10 * i);
      await t.move(2, b[0], b[1] - 10 * i);
      await advance(1 / 60);
    }
    await page.waitForTimeout(150);
    await advance(0.2);
    const pushed = await s.item();
    row('a two-finger pan up 120 px pushes it ~1.2 m (+-0.15)', Math.abs(pushed.pushM - 1.2) <= 0.15 && Math.abs(dist(pushed.position, p0) - pushed.pushM) <= 0.06, { pushM: round(pushed.pushM), movedM: round(dist(pushed.position, p0), 3) });
    row('the pan did not resize or look', pushed.size === 1 && Math.abs((await yawOf()) - yaw0) <= 0.01, { size: pushed.size, yawDeltaRad: round((await yawOf()) - yaw0, 5) });
    for (let i = 1; i <= 6; i += 1) {
      await t.move(1, a[0], a[1] - 120 + 10 * i);
      await t.move(2, b[0], b[1] - 120 + 10 * i);
      await advance(1 / 60);
    }
    await page.waitForTimeout(150);
    await advance(0.2);
    const pulled = await s.item();
    row('sliding down 60 px pulls it back ~0.6 m (+-0.15)', Math.abs(pulled.pushM - 0.6) <= 0.15 && pulled.heldBy === 'right', { pushM: round(pulled.pushM) });
    // Push out again, then lift both fingers: still held at 1.2 m.
    for (let i = 1; i <= 6; i += 1) {
      await t.move(1, a[0], a[1] - 60 - 10 * i);
      await t.move(2, b[0], b[1] - 60 - 10 * i);
      await advance(1 / 60);
    }
    await page.waitForTimeout(150);
    await advance(0.1);
    await t.up(2);
    await t.up(1);
    await advance(0.3);
    const parked = await s.item();
    row('lifting both fingers keeps it held, pushed out', parked.heldBy === 'right' && parked.pushM > 0.8, { heldBy: parked.heldBy, pushM: round(parked.pushM) });

    // A lone tap on it releases: it is lowered onto the surface and let go there.
    const parkedCentre = centreOf(parked);
    const here = (await where()) ?? { x: 200, y: 400 };
    let tapped = false;
    for (const [ox, oy] of [[0, 0], [6, 0], [-6, 0], [0, 6], [0, -6], [12, 0], [-12, 0], [0, 12], [0, -12], [10, 10], [-10, -10], [10, -10], [-10, 10]]) {
      await t.down(3, here.x + ox, here.y + oy);
      await advance(1 / 60);
      await t.up(3);
      await advance(2 / 60);
      const st = await s.state();
      if (!st.objects.items[0].heldBy || st.objects.reach.settling) { tapped = true; break; }
      await advance(0.1);
    }
    const out = await s.letGo();
    const speed = Math.hypot(out.free.linvel[0], out.free.linvel[2]);
    row('a lone tap on the pushed prop lets it go after a short lowering', tapped && !out.free.heldBy, { tapped, heldSteps: out.steps });
    row('let go just above a surface, not thrown', surfaceGap(out.free.boundsMin[1]) <= 0.03 && speed <= 0.05 && Math.abs(out.free.linvel[1]) <= 0.3, { gapM: round(surfaceGap(out.free.boundsMin[1]), 4), sidewaysMps: round(speed, 3), fallMps: round(out.free.linvel[1], 3) });
    const resting = await s.rest();
    const fromPushed = Math.hypot(centreOf(resting)[0] - parkedCentre[0], centreOf(resting)[2] - parkedCentre[2]);
    row('it rests on the surface below where it was pushed', resting.body === 'asleep' && surfaceGap(resting.boundsMin[1]) <= 0.01 && fromPushed <= 0.08, { body: resting.body, boundsMinY: round(resting.boundsMin[1]), fromPushedSpotM: round(fromPushed, 3) });
    row('no bounds reset', (await s.stats())?.resets === 0, { resets: (await s.stats())?.resets });

    // The same spot on a fresh far prop: touch-and-hold points and fetches nothing; the tap there then fetches.
    await setupFar();
    const at2 = (await where()) ?? at;
    // The same spot on the prop: its offset from the prop's projected centre, as when the tap landed.
    const P2 = { x: at2.x + P.dx, y: at2.y + P.dy };
    await t.down(1, P2.x, P2.y);
    await page.waitForTimeout(500);
    await advance(0.1);
    const phase = (await page.evaluate(() => window.__sampleHolds())).touch;
    const during = await s.item();
    await t.up(1);
    await advance(0.4);
    const afterHold = await s.item();
    await t.down(1, P2.x, P2.y);
    await advance(1 / 60);
    await t.up(1);
    await advance(3 / 60);
    const refetched = await s.item();
    row('touch-and-hold on the prop points and fetches nothing (a tap on the same spot does fetch)', phase === 'held' && !during.heldBy && !afterHold.heldBy && refetched.heldBy === 'right', { holdPhase: phase, heldDuring: during.heldBy, heldAfterLift: afterHold.heldBy, thenTapHeldBy: refetched.heldBy, propScreen: at2 && [round(at2.x, 1), round(at2.y, 1)] });

    return { label, status: failures.length ? 'fail' : 'pass', failures, rows };
  } finally {
    await s.context.close();
  }
}

// ---------------------------------------------------------------- headset

async function openIwer({ browser, baseUrl, consoleErrors, label }) {
  const { context, page } = await setupPage(browser, { iwer: true, consoleErrors, label });
  await openCapture(page, baseUrl, { object: OBJECT_URL });
  await page.evaluate(() => {
    window.__setManualClock(true, false);
    window.IWER_DEVICE.primaryInputMode = 'controller';
  });
  await waitForIwerRuntime(page);
  await enterIwerSessionFromButton(page, '#VRButton', { readyCheck: () => JSON.parse(window.render_game_to_text()).mode === 'vr' });
  await page.evaluate(() => {
    window.IWER_DEVICE.controlMode = 'programmatic';
  });
  await freezePageClock(page);
  await waitForXrRenderLoop(page);
  await page.evaluate(() => window.__setFrameStepping(true, false));
  const s = { context, page };
  s.step = async (count = 1) => {
    for (let i = 0; i < count; i += 1) await page.clock.runFor(STEP_MS);
  };
  s.controller = (side, position, quaternion) => page.evaluate(({ sd, p, q }) => {
    const c = window.IWER_DEVICE.controllers[sd];
    c.position.set(...p);
    if (q) c.quaternion.set(...q);
  }, { sd: side, p: position, q: quaternion });
  s.button = (side, id, value) => page.evaluate(({ sd, i, v }) => window.IWER_DEVICE.controllers[sd].updateButtonValue(i, v), { sd: side, i: id, v: value });
  s.stick = (side, x, y) => page.evaluate(({ sd, px, py }) => window.IWER_DEVICE.controllers[sd].updateAxes('thumbstick', px, py), { sd: side, px: x, py: y });
  s.state = () => readState(page);
  s.item = async () => (await readState(page)).objects.items[0];
  const rest = { left: [-0.3, 0.9, -0.1], right: [0.3, 0.9, -0.1] };
  await s.controller('left', rest.left, [0, 0, 0, 1]);
  await s.controller('right', rest.right, [0, 0, 0, 1]);
  await s.step(20);
  s.rest = rest;
  s.rigYaw = (await s.state()).thumbstick.rigYaw;
  s.toTracking = (delta) => {
    const c = Math.cos(-s.rigYaw);
    const sn = Math.sin(-s.rigYaw);
    return [delta[0] * c + delta[2] * sn, delta[1], -delta[0] * sn + delta[2] * c];
  };
  s.grip = [...rest.right];
  s.settled = async (maxSec = 4) => {
    let it = await s.item();
    for (let i = 0; i < maxSec * 60 && it.body !== 'asleep'; i += 1) {
      await s.step(1);
      it = await s.item();
    }
    return it;
  };
  return s;
}

export async function runIwerPush({ browser, baseUrl, consoleErrors }) {
  const label = 'push-iwer';
  const failures = [];
  const { rows, row } = makeRows(failures);
  const s = await openIwer({ browser, baseUrl, consoleErrors, label });
  try {
    // Glide the right hand in until the palm is 7 cm from the prop, and grab it: a palm driven into a hovering prop would knock it
    // down (props collide with the avatar).
    let error = Infinity;
    for (let i = 0; i < 150; i += 1) {
      const st = await s.state();
      error = st.objects.reach.palmToPropM ?? Infinity;
      if (error <= 0.07) break;
      const toCenter = st.objects.items[0].position.map((v, k) => v - st.objects.hands.right.position[k]);
      const length = Math.hypot(...toCenter);
      const move = Math.min(0.012, Math.max(0.002, (error - 0.07) * 0.5));
      const delta = s.toTracking(toCenter.map((v) => (v / length) * move));
      s.grip = s.grip.map((v, k) => v + delta[k]);
      await s.controller('right', s.grip);
      await s.step(1);
    }
    await s.button('right', 'squeeze', 1);
    await s.step(3);
    const held = await s.item();
    row('right squeeze grabs the prop', held.heldBy === 'right' && held.pushM === 0, { heldBy: held.heldBy, pushM: held.pushM, palmToPropM: round(error, 3) });
    await s.step(20);
    const base = await s.state();
    const p0 = base.objects.items[0].position;
    // The push follows where the right controller points (its target ray's −Z); the rig is not turned yet.
    const q = await s.page.evaluate(() => {
      const { x, y, z, w } = window.IWER_DEVICE.controllers.right.quaternion;
      return [x, y, z, w];
    });
    const line = new THREE.Vector3(0, 0, -1).applyQuaternion(new THREE.Quaternion(...q)).toArray();
    const lineLen = Math.hypot(...line);
    const snaps0 = base.thumbstick.snapCount;
    const yaw0 = base.thumbstick.turnYaw;

    // Stick forward 0.5 s at 2 m/s.
    await s.stick('right', 0, -1);
    await s.step(30);
    await s.stick('right', 0, 0);
    await s.step(6);
    const st1 = await s.state();
    const out = st1.objects.items[0];
    const moved = out.position.map((v, k) => v - p0[k]);
    const cos = moved.reduce((acc, v, k) => acc + (v * line[k]) / lineLen, 0) / Math.hypot(...moved);
    row('stick forward 0.5 s pushes ~1 m (+-0.1)', Math.abs(out.pushM - 1) <= 0.1, { pushM: round(out.pushM) });
    row('prop moved along the controller ray', cos >= 0.97 && Math.abs(Math.hypot(...moved) - out.pushM) <= 0.08, { cosRay: round(cos, 4), movedM: round(Math.hypot(...moved), 3) });
    row('the push did not snap-turn', st1.thumbstick.snapCount === snaps0 && st1.thumbstick.turnYaw === yaw0 && out.heldBy === 'right', { snapCount: st1.thumbstick.snapCount, turnYaw: st1.thumbstick.turnYaw, heldBy: out.heldBy });
    row('the push is not a throw: speed while pushed is small', Math.hypot(...out.linvel) <= 0.05, { speedMps: round(Math.hypot(...out.linvel), 3) });

    // A mostly-sideways stick still snap-turns and does not push.
    const before = (await s.item()).pushM;
    await s.stick('right', 1, -0.3);
    await s.step(20);
    await s.stick('right', 0, 0);
    await s.step(10);
    const st2 = await s.state();
    row('a mostly-sideways stick still snap-turns and does not push', st2.thumbstick.snapCount === snaps0 + 1 && Math.abs(st2.objects.items[0].pushM - before) < 0.01, { snapCount: st2.thumbstick.snapCount, pushM: round(st2.objects.items[0].pushM) });

    // Pull in: stick back clamps at 0.
    await s.stick('right', 0, 1);
    await s.step(100);
    await s.stick('right', 0, 0);
    await s.step(6);
    const pulled = await s.item();
    row('stick back pulls it to the hand and clamps at 0', pulled.pushM === 0, { pushM: pulled.pushM });

    // Push 1 m, then release: a plain drop with no throw.
    await s.stick('right', 0, -1);
    await s.step(30);
    await s.stick('right', 0, 0);
    await s.step(6);
    const pushed = await s.item();
    await s.button('right', 'squeeze', 0);
    await s.step(2);
    const dropped = await s.item();
    const rested = await s.settled();
    const lateral = Math.hypot(dropped.linvel[0], dropped.linvel[2]);
    const driftXZ = Math.hypot(centreOf(rested)[0] - centreOf(pushed)[0], centreOf(rested)[2] - centreOf(pushed)[2]);
    row('releasing the hand while pushed is a plain drop (no throw)', !dropped.heldBy && lateral <= 0.3 && driftXZ <= 0.2, { pushedM: round(pushed.pushM), lateralSpeedMps: round(lateral, 3), driftM: round(driftXZ, 3) });
    row('the dropped prop comes to rest on a surface', rested.body === 'asleep' && surfaceGap(rested.boundsMin[1]) <= 0.01, { body: rested.body, boundsMinY: round(rested.boundsMin[1]) });
    return { label, status: failures.length ? 'fail' : 'pass', failures, rows };
  } finally {
    await s.context.close();
  }
}

export async function runIwerFetch({ browser, baseUrl, consoleErrors }) {
  const label = 'fetch-iwer';
  const failures = [];
  const { rows, row } = makeRows(failures);
  const s = await openIwer({ browser, baseUrl, consoleErrors, label });
  try {
    const handToProp = async () => {
      const st = await s.state();
      return dist(st.objects.items[0].position, st.objects.hands.right.position);
    };
    const aimAt = async (yawOff = 0, pitchOff = 0, up = false) => {
      const st = await s.state();
      const world = st.objects.items[0].position.map((v, k) => v - st.objects.hands.right.position[k]);
      const dir = new THREE.Vector3(...s.toTracking(world)).normalize();
      if (up) dir.set(0, 1, 0);
      dir.applyEuler(new THREE.Euler(pitchOff, yawOff, 0, 'YXZ'));
      const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, -1), dir);
      await s.controller('right', s.rest.right, [q.x, q.y, q.z, q.w]);
      await s.step(4);
    };
    const start = await s.item();
    const startDist = await handToProp();
    row('the prop starts out of reach of the hand', startDist > 0.3 && !start.heldBy, { handToPropM: round(startDist, 3) });

    // Ray not on the prop: squeeze grabs nothing.
    await aimAt(0, 0, true);
    await s.button('right', 'squeeze', 1);
    await s.step(6);
    const miss = await s.item();
    await s.button('right', 'squeeze', 0);
    await s.step(4);
    row('a squeeze with the ray pointing at the sky fetches nothing', !miss.heldBy, { heldBy: miss.heldBy });

    // Ray on the prop (scan small offsets: the controller is not exactly at the hand bone).
    const scan = [[0, 0], [0.04, 0], [-0.04, 0], [0, 0.04], [0, -0.04], [0.08, 0], [-0.08, 0], [0, 0.08], [0, -0.08], [0.06, 0.06], [-0.06, -0.06], [0.06, -0.06], [-0.06, 0.06]];
    let hit = null;
    for (const [yaw, pitch] of scan) {
      await aimAt(yaw, pitch);
      await s.button('right', 'squeeze', 1);
      await s.step(3);
      const it = await s.item();
      if (it.heldBy === 'right') { hit = { yaw, pitch }; break; }
      await s.button('right', 'squeeze', 0);
      await s.step(3);
    }
    row('a squeeze with the ray on the prop (beyond reach) holds it at once', hit !== null, { aimOffsetRad: hit });
    if (!hit) return { label, status: 'fail', failures, rows };
    const early = await handToProp();
    await s.step(40);
    const landed = await s.item();
    const landedDist = await handToProp();
    row('it glides to just off the palm', landed.heldBy === 'right' && landedDist <= 0.3 && landedDist < early, { handToPropM: round(landedDist, 3), startedFromM: round(startDist, 3), afterFirstStepsM: round(early, 3) });
    await s.step(30);
    const stays = await s.item();
    row('it stays in the hand while squeezed', stays.heldBy === 'right' && dist(stays.position, landed.position) <= 0.05, { driftM: round(dist(stays.position, landed.position), 3) });
    await s.button('right', 'squeeze', 0);
    await s.step(2);
    const dropped = await s.item();
    const rested = await s.settled();
    row('releasing drops it, no throw, and it comes to rest on a surface', !dropped.heldBy && Math.hypot(dropped.linvel[0], dropped.linvel[2]) <= 0.3 && rested.body === 'asleep' && surfaceGap(rested.boundsMin[1]) <= 0.01, { lateralMps: round(Math.hypot(dropped.linvel[0], dropped.linvel[2]), 3), body: rested.body, boundsMinY: round(rested.boundsMin[1]) });
    return { label, status: failures.length ? 'fail' : 'pass', failures, rows };
  } finally {
    await s.context.close();
  }
}
