import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';

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

import { findNode, loadTake, objectNodes, worldAt } from './object-glb.mjs';
import { OBJECT_URL, clickButton, openCapture, readState, saveDownload, setupPage } from './object-take.mjs';

// Resize a held prop (docs/features/object-resize-and-move.md), by capture's
// real input paths. Each scenario returns pass/fail `rows` with the numbers.
//   - resizeDesktop: keys and wheel are inert with nothing held; wheel notches,
//     the detent at 1, the clamps at 4 and 1/4, 0 resets, mass follows the
//     volume, a 2x prop set down rests on its surface, a prop grown into the
//     floor is lifted out onto it without a bounds reset.
//   - resizePhone: a second finger spreads/pinches a held prop without looking
//     or pointing; lifting a finger ends the gesture; a lone tap lets go.
//   - resizeIwer: the other controller squeezes next to the held prop and
//     stretches it; a take of it exports a RecordedObjectSize node whose scale
//     track and world bounds match capture's.

const STEP_MS = 1000 / 60;
const FLOOR_TOLERANCE_M = 0.01;
const SURFACES_Y = [0.01, 0.29];
const FLOOR_Y = 0.01;
const round = (value, digits = 4) => Number(Number(value).toFixed(digits));

function makeRows(failures) {
  const rows = [];
  const row = (name, ok, values = {}) => {
    rows.push({ name, pass: Boolean(ok), ...values });
    if (!ok) failures.push(`${name}: ${JSON.stringify(values)}`);
  };
  return { rows, row };
}

const centreOf = (item) => [0, 1, 2].map((a) => (item.boundsMin[a] + item.boundsMax[a]) / 2);

// ---------------------------------------------------------------- desktop

export async function runDesktopResize({ browser, baseUrl, artifactDir, consoleErrors }) {
  const label = 'resize-desktop';
  const failures = [];
  const { rows, row } = makeRows(failures);
  await mkdir(artifactDir, { recursive: true });
  const { context, page } = await setupPage(browser, { iwer: false, consoleErrors, label });
  try {
    await openCapture(page, baseUrl, { object: OBJECT_URL });
    await waitForPageFunctions(page, ['__loadObjectUrl']);
    await waitForTextContentPrefix(page, '#status', 'loaded');
    const advance = (seconds) => page.evaluate((ms) => window.advanceTime(ms), Math.max(1, Math.round(seconds * 60)) * STEP_MS);
    const item = async () => (await readState(page)).objects.items[0];
    const stats = async () => (await readState(page)).objects.physics;
    const canvas = page.locator('canvas').first();
    await canvas.focus();
    const box = await canvas.boundingBox();
    const centre = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    const wheel = async (deltaY) => {
      await page.mouse.move(centre.x, centre.y);
      await page.mouse.wheel(0, deltaY);
      await advance(1 / 60);
    };
    const holdKey = async (code, seconds) => {
      await page.keyboard.down(code);
      await advance(seconds);
      await page.keyboard.up(code);
      await advance(1 / 60);
    };
    const rest = async (timeoutSec = 4) => {
      let current = await item();
      for (let i = 0; i < Math.round(timeoutSec * 60) && current.body !== 'asleep'; i += 1) {
        await advance(1 / 60);
        current = await item();
      }
      return current;
    };
    const grab = async () => {
      await page.keyboard.press('KeyG');
      let current = await item();
      for (let i = 0; i < 180 && !current.heldBy; i += 1) {
        await advance(1 / 60);
        current = await item();
      }
      await advance(0.8);
      return item();
    };
    const surfaceGap = (y) => Math.min(...SURFACES_Y.map((s) => Math.abs(y - s)));

    await advance(1);
    const loaded = await item();
    row('loaded: size 1, mass reported', loaded?.placed && loaded.size === 1 && loaded.mass > 0, { size: loaded?.size, mass: loaded?.mass });

    // Nothing held: keys and wheel do nothing.
    await holdKey('Equal', 1);
    await wheel(-300);
    await holdKey('Digit0', 0.1);
    const idle = await item();
    row('nothing held: Equal, wheel and 0 leave size at 1', idle.size === 1 && !idle.heldBy, { size: idle.size, heldBy: idle.heldBy });

    // Grab with G.
    const held = await grab();
    row('G grabs the prop', held.heldBy === 'right', { heldBy: held.heldBy });
    const mass1 = held.mass;
    row('held at size 1 with a mass', held.size === 1 && mass1 > 0, { size: held.size, massKg: mass1 });

    // Detent: a small wheel from 1 stays exactly 1.
    await wheel(-40);
    const small = await item();
    row('small wheel (deltaY -40) stays exactly 1', small.size === 1, { size: small.size });
    await holdKey('Digit0', 0.1);

    // Five notches up.
    for (let i = 0; i < 5; i += 1) await wheel(-100);
    const five = await item();
    const expectFive = 1.1 ** 5;
    row('wheel 5 notches up -> 1.1^5 (+-1%)', Math.abs(five.size / expectFive - 1) <= 0.01, { size: round(five.size), expected: round(expectFive) });
    await wheel(300);
    const down = await item();
    row('wheel down shrinks (3 notches down from 5 up)', Math.abs(down.size / (1.1 ** 2) - 1) <= 0.01, { size: round(down.size), expected: round(1.1 ** 2) });

    // Reset exactly to 1.
    await holdKey('Digit0', 0.1);
    const reset = await item();
    row('0 resets to exactly 1', reset.size === 1, { size: reset.size });

    // Clamps by key.
    await holdKey('Equal', 4);
    const grown = await item();
    row('Equal held long clamps at 4', grown.size === 4, { size: grown.size, heldBy: grown.heldBy });
    await holdKey('Minus', 7);
    const shrunk = await item();
    row('Minus held long clamps at 0.25', shrunk.size === 0.25, { size: shrunk.size, heldBy: shrunk.heldBy });
    // Key rate: x1.8 per second from 1.
    await holdKey('Digit0', 0.1);
    await holdKey('Equal', 1);
    const second = await item();
    row('Equal for 1 s -> x1.8 (+-3%)', Math.abs(second.size / 1.8 - 1) <= 0.03, { size: round(second.size), expected: 1.8 });
    await holdKey('Digit0', 0.1);

    // Mass follows the volume: grow to 2 with one wheel of the right length.
    await wheel(-100 * (Math.log(2) / Math.log(1.1)));
    await advance(0.2);
    const two = await item();
    row('wheel to size 2 (+-1%)', Math.abs(two.size / 2 - 1) <= 0.01, { size: round(two.size) });
    const massRatio = two.mass / mass1;
    const expectedRatio = two.size ** 3;
    row('mass ratio at size 2 is about 8 (+-5%) and follows size^3', Math.abs(massRatio / 8 - 1) <= 0.05 && Math.abs(massRatio / expectedRatio - 1) <= 0.02, { massKg: round(two.mass), mass1Kg: round(mass1), ratio: round(massRatio, 3), sizeCubed: round(expectedRatio, 3) });
    // Bounds are the model's: the 2x prop's extents are twice the 1x prop's.
    const extents = (it) => [0, 1, 2].map((a) => it.boundsMax[a] - it.boundsMin[a]);
    const e2 = extents(two);

    // Set down with G at 2x; rest; size kept; bottom on the surface.
    await page.keyboard.press('KeyG');
    let letGo = await item();
    for (let i = 0; i < 240 && letGo.heldBy; i += 1) {
      await advance(1 / 60);
      letGo = await item();
    }
    row('G releases the 2x prop', !letGo.heldBy, { heldBy: letGo.heldBy });
    const resting2 = await rest();
    row('2x prop rests (asleep)', resting2.body === 'asleep', { body: resting2.body });
    row('2x prop bottom within 1 cm of a surface', surfaceGap(resting2.boundsMin[1]) <= FLOOR_TOLERANCE_M, { boundsMinY: round(resting2.boundsMin[1]), surfacesY: SURFACES_Y });
    row('size still 2 after rest', Math.abs(resting2.size / two.size - 1) < 1e-6 && Math.abs(resting2.size - 2) <= 0.02, { size: round(resting2.size, 5) });
    const e2rest = extents(resting2);
    row('rested 2x prop extents unchanged (tip aside, volume check)', Math.abs(e2rest.reduce((a, b) => a * b, 1) / e2.reduce((a, b) => a * b, 1) - 1) < 0.5, { before: e2.map((v) => round(v, 3)), after: e2rest.map((v) => round(v, 3)) });
    row('no bounds reset after the 2x set-down', (await stats())?.resets === 0, { resets: (await stats())?.resets });

    // Grow into the floor: pick it up again, grow to 4 while held, release.
    // (Desktop cannot lower the prop first; the next case grows it while it is being lowered.)
    const resetsBefore = (await stats())?.resets ?? 0;
    const regrab = await grab();
    row('second G picks the rested prop up again', regrab.heldBy === 'right', { heldBy: regrab.heldBy, size: round(regrab.size) });
    if (regrab.heldBy === 'right') {
      await holdKey('Equal', 4);
      const four = await item();
      row('grown to 4 while held', four.size === 4, { size: four.size });
      await page.keyboard.press('KeyG');
      let released = await item();
      for (let i = 0; i < 300 && released.heldBy; i += 1) {
        await advance(1 / 60);
        released = await item();
      }
      row('G releases the 4x prop', !released.heldBy, { heldBy: released.heldBy });
      const resting4 = await rest(6);
      const resetsAfter = (await stats())?.resets ?? 0;
      row('4x prop at rest, bounds min y >= floor - 1 cm', resting4.body === 'asleep' && resting4.boundsMin[1] >= FLOOR_Y - FLOOR_TOLERANCE_M, { body: resting4.body, boundsMinY: round(resting4.boundsMin[1]), floorY: FLOOR_Y });
      row('4x prop bottom within 1 cm of a surface', surfaceGap(resting4.boundsMin[1]) <= FLOOR_TOLERANCE_M, { boundsMinY: round(resting4.boundsMin[1]) });
      row('size still 4 after rest', resting4.size === 4, { size: resting4.size });
      row('no bounds reset releasing the 4x prop', resetsAfter === resetsBefore, { resetsBefore, resetsAfter });
    }

    // Grown into the floor while being lowered: G starts the set-down, then the wheel grows the prop into the surface.
    await page.evaluate((url) => window.__loadObjectUrl(url), OBJECT_URL);
    await advance(0.5);
    const resetsMid = (await stats())?.resets ?? 0;
    const third = await grab();
    if (third.heldBy !== 'right') row('third grab for the grow-while-lowering case', false, { heldBy: third.heldBy });
    else {
      await page.keyboard.press('KeyG');
      await advance(0.15);
      const lowering = await item();
      for (let i = 0; i < 4; i += 1) await wheel(-500);
      const grownLowering = await item();
      let settled = grownLowering;
      for (let i = 0; i < 300 && settled.heldBy; i += 1) {
        await advance(1 / 60);
        settled = await item();
      }
      const resting = await rest(6);
      const resetsEnd = (await stats())?.resets ?? 0;
      row('wheel while being lowered still resizes', grownLowering.size > lowering.size * 1.5 || grownLowering.size === 4, { before: round(lowering.size), after: round(grownLowering.size), heldBy: grownLowering.heldBy });
      row('grown while being lowered: released, at rest, not below the floor', !settled.heldBy && resting.body === 'asleep' && resting.boundsMin[1] >= FLOOR_Y - FLOOR_TOLERANCE_M, { heldBy: settled.heldBy, body: resting.body, boundsMinY: round(resting.boundsMin[1]), size: round(resting.size) });
      row('grown while being lowered: no bounds reset', resetsEnd === resetsMid, { resetsMid, resetsEnd });
    }
    return { label, status: failures.length ? 'fail' : 'pass', failures, rows };
  } finally {
    await context.close();
  }
}

// ---------------------------------------------------------------- phone

export async function runPhoneResize({ browser, baseUrl, consoleErrors }) {
  const label = 'resize-phone';
  const failures = [];
  const { rows, row } = makeRows(failures);
  const viewport = { width: 390, height: 844 };
  const context = await createXrContext(browser, { viewport, acceptDownloads: true, hasTouch: true, isMobile: true, deviceScaleFactor: 2 });
  try {
    const page = await context.newPage();
    wireXrConsoleErrors(page, consoleErrors, { label });
    await page.route('**/__holoim/input-recordings*', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '{"path":"object-resize-input.json"}' }));
    await openCapture(page, baseUrl, { object: OBJECT_URL });
    await waitForPageFunctions(page, ['__projectToScreen', '__loadObjectUrl', '__sampleHolds']);
    await waitForTextContentPrefix(page, '#status', 'loaded');
    const advance = (seconds) => page.evaluate((ms) => window.advanceTime(ms), Math.max(1, Math.round(seconds * 60)) * STEP_MS);
    const item = async () => (await readState(page)).objects.items[0];
    const cdp = await page.context().newCDPSession(page);
    const active = new Map();
    const send = (type, points) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: points.map(([id, x, y]) => ({ x, y, id, radiusX: 4, radiusY: 4, force: 1 })) });
    const down = async (id, x, y) => {
      active.set(id, [x, y]);
      await send('touchStart', [...active].map(([i, [px, py]]) => [i, px, py]));
    };
    const move = async (id, x, y) => {
      active.set(id, [x, y]);
      await send('touchMove', [...active].map(([i, [px, py]]) => [i, px, py]));
    };
    const up = async (id) => {
      const [x, y] = active.get(id);
      await send('touchEnd', [[id, x, y]]);
      active.delete(id);
    };
    const holds = () => page.evaluate(() => window.__sampleHolds());
    const yawOf = async () => (await readState(page)).avatar.yaw;
    const where = async () => page.evaluate((p) => window.__projectToScreen(p), centreOf(await item()));
    const OFFSETS = [[0, 0], [10, 0], [-10, 0], [0, 10], [0, -10], [20, 0], [-20, 0], [0, 20], [0, -20], [16, 16], [-16, -16], [16, -16], [-16, 16]];
    const reload = async () => {
      if (!(await page.evaluate((url) => window.__loadObjectUrl(url), OBJECT_URL))) throw new Error('the object did not reload');
      await advance(0.5);
    };
    /** Touches the prop with finger `id` until the reach starts; `quick` lifts the finger as soon as it does. */
    const touchProp = async (id, { quick = false } = {}) => {
      const at = (await where()) ?? { x: 200, y: 400 };
      for (const [ox, oy] of OFFSETS) {
        const point = { x: at.x + ox, y: at.y + oy };
        await down(id, point.x, point.y);
        await advance(0.1);
        const st = await readState(page);
        if (st.objects.items[0].heldBy || ['step', 'reach'].includes(st.objects.reach.phase)) {
          if (quick) await up(id);
          return point;
        }
        await up(id);
        await advance(0.1);
      }
      return null;
    };
    const untilHeld = async (maxSec = 4) => {
      let current = await item();
      for (let i = 0; i < Math.round(maxSec * 60) && !current.heldBy; i += 1) {
        await advance(1 / 60);
        current = await item();
      }
      await advance(0.8);
      return item();
    };
    const untilFree = async (maxSec = 4) => {
      let current = await item();
      for (let i = 0; i < Math.round(maxSec * 60) && current.heldBy; i += 1) {
        await advance(1 / 60);
        current = await item();
      }
      return current;
    };
    const spreadTo = async (idB, from, to, steps = 12) => {
      for (let i = 1; i <= steps; i += 1) {
        await move(idB, from[0] + ((to[0] - from[0]) * i) / steps, from[1] + ((to[1] - from[1]) * i) / steps);
        await advance(1 / 60);
      }
      // Pointer moves reach the page on its next frame: give the last one real time before stepping on.
      await page.waitForTimeout(150);
      await advance(1 / 60);
    };

    await advance(1);
    const grabPoint = await touchProp(1);
    row('finger A on the prop starts a reach', grabPoint !== null, { grabPoint });
    if (!grabPoint) return { label, status: 'fail', failures, rows };
    const heldA = await untilHeld();
    row('prop held with finger A down', heldA.heldBy === 'right' && heldA.size === 1, { heldBy: heldA.heldBy, size: heldA.size });
    const yaw0 = await yawOf();

    // Finger B (on the walk-stick side, to show it does not matter) spreads to twice the distance.
    const a = [grabPoint.x, grabPoint.y];
    const b0 = [Math.max(10, a[0] - 90), a[1] - 40];
    const startDist = Math.hypot(a[0] - b0[0], a[1] - b0[1]);
    const dir = [(b0[0] - a[0]) / startDist, (b0[1] - a[1]) / startDist];
    const b1 = [a[0] + dir[0] * startDist * 2, a[1] + dir[1] * startDist * 2];
    await down(2, b0[0], b0[1]);
    await advance(1 / 60);
    await spreadTo(2, b0, b1);
    await advance(0.1);
    await page.waitForTimeout(500); // real time: a point hold would start after its timer
    await advance(0.1);
    const endDist = Math.hypot(a[0] - b1[0], a[1] - b1[1]);
    const spread = await item();
    const holdPhase = (await holds()).touch;
    const yawSpread = await yawOf();
    row('two-finger spread to ~2x distance -> size ~2 (+-10%)', Math.abs(spread.size / (endDist / startDist) - 1) <= 0.1 && Math.abs(spread.size / 2 - 1) <= 0.1, { size: round(spread.size), fingerRatio: round(endDist / startDist, 3), startPx: round(startDist, 1), endPx: round(endDist, 1) });
    row('camera did not look during the gesture (+-0.01 rad)', Math.abs(yawSpread - yaw0) <= 0.01, { yawDeltaRad: round(yawSpread - yaw0, 5) });
    row('no point hold during the gesture', holdPhase !== 'held' && holdPhase !== 'pending', { touchHold: holdPhase });
    row('still held during the gesture', spread.heldBy === 'right', { heldBy: spread.heldBy });

    // Lift B: size stays, still held. A third move of A must not resize.
    await up(2);
    await advance(0.3);
    const afterB = await item();
    row('lifting finger B keeps size and the hold', afterB.heldBy === 'right' && Math.abs(afterB.size - spread.size) < 1e-6, { size: round(afterB.size), heldBy: afterB.heldBy });
    await move(1, a[0] + 3, a[1] + 3);
    await advance(0.1);
    const afterMove = await item();
    row('finger A alone does not resize', Math.abs(afterMove.size - spread.size) < 1e-6, { size: round(afterMove.size) });

    // Lift A: released (existing behaviour); size kept.
    await up(1);
    await advance(0.2);
    const freed = await untilFree();
    row('lifting finger A releases the prop', !freed.heldBy, { heldBy: freed.heldBy });
    let at = await item();
    for (let i = 0; i < 240 && at.body !== 'asleep'; i += 1) {
      await advance(1 / 60);
      at = await item();
    }
    row('released prop keeps size ~2 and comes to rest', Math.abs(at.size - spread.size) < 1e-6 && at.body === 'asleep', { size: round(at.size), body: at.body, boundsMinY: round(at.boundsMin[1]) });

    // A hold with no finger down: touch, lift while the reach is under way; the prop stays held.
    await reload();
    const quickPoint = await touchProp(1, { quick: true });
    row('quick touch starts a reach', quickPoint !== null, { quickPoint });
    const hands = await untilHeld(4);
    const reachState = (await readState(page)).objects.reach;
    row('prop stays held with no finger down', hands.heldBy === 'right' && active.size === 0, { heldBy: hands.heldBy, pointer: reachState.pointer, phase: reachState.phase });
    if (hands.heldBy === 'right') {
      const yawP = await yawOf();
      const pa = [300, 330];
      const pb0 = [300, 170];
      const pb1 = [300, 250];
      await down(1, pa[0], pa[1]);
      await advance(1 / 60);
      row('lone finger down on a no-finger hold does not release at press', (await item()).heldBy === 'right', { heldBy: (await item()).heldBy });
      await down(2, pb0[0], pb0[1]);
      await advance(1 / 60);
      await spreadTo(2, pb0, pb1);
      await advance(0.1);
      const pinched = await item();
      const ratio = (pa[1] - pb1[1]) / (pa[1] - pb0[1]);
      row('two fingers pinch in -> size shrinks by the finger ratio (+-10%), not released', pinched.heldBy === 'right' && Math.abs(pinched.size / ratio - 1) <= 0.1, { size: round(pinched.size), fingerRatio: round(ratio, 3), heldBy: pinched.heldBy });
      row('pinch with no finger hold did not look', Math.abs((await yawOf()) - yawP) <= 0.01, { yawDeltaRad: round((await yawOf()) - yawP, 5) });
      await up(2);
      await up(1);
      await advance(0.3);
      const afterPinch = await item();
      row('lifting both fingers after the pinch does not release', afterPinch.heldBy === 'right' && Math.abs(afterPinch.size - pinched.size) < 1e-6, { heldBy: afterPinch.heldBy, size: round(afterPinch.size) });

      // A lone tap on the prop lets go.
      let tapped = null;
      const centre = (await where()) ?? { x: 200, y: 400 };
      for (const [ox, oy] of [[0, 0], [6, 0], [-6, 0], [0, 6], [0, -6], [12, 0], [-12, 0], [0, 12], [0, -12], [10, 10], [-10, -10], [10, -10], [-10, 10]]) {
        await down(3, centre.x + ox, centre.y + oy);
        await advance(1 / 60);
        const mid = await item();
        if (mid.heldBy !== 'right') {
          tapped = { ox, oy, phase: 'pressed at down' };
        }
        await up(3);
        await advance(1 / 60);
        const st = await readState(page);
        if (!st.objects.items[0].heldBy || st.objects.reach.settling) {
          tapped = { ox, oy, settling: st.objects.reach.settling };
          break;
        }
        if (tapped) break;
        await advance(0.1);
      }
      const gone = await untilFree(5);
      row('a lone tap on the held prop lets it go (and not at press)', tapped !== null && tapped.phase === undefined && !gone.heldBy, { tapped, heldBy: gone.heldBy, size: round(gone.size) });
    }

    return { label, status: failures.length ? 'fail' : 'pass', failures, rows };
  } finally {
    await context.close();
  }
}

// ---------------------------------------------------------------- headset

/** Local bounds corners of every mesh under `root`, in world space at key `i`. */
function glbModelBounds(take, root, i) {
  const box = new THREE.Box3();
  const visit = (index) => {
    const node = take.json.nodes[index];
    if (node.mesh !== undefined) {
      const world = worldAt(take, index, i);
      for (const primitive of take.json.meshes[node.mesh].primitives) {
        const accessor = take.json.accessors[primitive.attributes.POSITION];
        const [lo, hi] = [accessor.min, accessor.max];
        for (const x of [lo[0], hi[0]]) for (const y of [lo[1], hi[1]]) for (const z of [lo[2], hi[2]]) box.expandByPoint(new THREE.Vector3(x, y, z).applyMatrix4(world));
      }
    }
    for (const child of node.children ?? []) visit(child);
  };
  visit(root);
  return box;
}

/**
 * The two-hand stretch take. Returns the pass/fail rows, the exported GLB path
 * and capture's own per-step series (`capture.series`: size, bounds min/max,
 * heldBy, body; `capture.offset` aligns series index i + offset to GLB key i).
 */
export async function runIwerResizeTake({ browser, baseUrl, artifactDir, consoleErrors }) {
  const label = 'resize-iwer';
  const failures = [];
  const { rows, row } = makeRows(failures);
  await mkdir(artifactDir, { recursive: true });
  const { context, page } = await setupPage(browser, { iwer: true, consoleErrors, label });
  try {
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

    let series = null;
    const item = async () => (await readState(page)).objects.items[0];
    const step = async (count = 1) => {
      for (let i = 0; i < count; i += 1) {
        await page.clock.runFor(STEP_MS);
        if (series) {
          const it = await item();
          series.push({ size: it.size, min: it.boundsMin, max: it.boundsMax, heldBy: it.heldBy, body: it.body });
        }
      }
    };
    const controller = (side, position) => page.evaluate(({ s, p }) => window.IWER_DEVICE.controllers[s].position.set(...p), { s: side, p: position });
    const button = (side, id, value) => page.evaluate(({ s, i, v }) => window.IWER_DEVICE.controllers[s].updateButtonValue(i, v), { s: side, i: id, v: value });
    const rest = { left: [-0.3, 0.9, -0.1], right: [0.3, 0.9, -0.1] };
    await controller('left', rest.left);
    await controller('right', rest.right);
    await step(20);
    let state = await readState(page);
    if (!state.objects.items[0]?.placed) {
      row('the object loaded and placed', false, {});
      return { label, status: 'fail', failures, rows };
    }
    const rigYaw = state.thumbstick.rigYaw;
    const toTracking = (delta) => {
      const c = Math.cos(-rigYaw);
      const s = Math.sin(-rigYaw);
      return [delta[0] * c + delta[2] * s, delta[1], -delta[0] * s + delta[2] * c];
    };
    /** Closes the loop on a hand bone until it reaches `target(state)`. */
    const bring = async (side, grip, target) => {
      let error = Infinity;
      for (let i = 0; i < 20 && error > 0.02; i += 1) {
        const st = await readState(page);
        const delta = toTracking(target(st).map((v, k) => v - st.objects.hands[side].position[k]));
        error = Math.hypot(...delta);
        grip = grip.map((v, k) => v + delta[k] * 0.8);
        await controller(side, grip);
        await step(6);
      }
      return { grip, error };
    };
    // The right hand glides in until the palm is 7 cm from the prop: a palm driven into a hovering prop would knock it down (props
    // collide with the avatar).
    let rightGrip = [...rest.right];
    let palmToProp = Infinity;
    for (let i = 0; i < 150; i += 1) {
      const st = await readState(page);
      palmToProp = st.objects.reach.palmToPropM ?? Infinity;
      if (palmToProp <= 0.07) break;
      const toCenter = st.objects.items[0].position.map((v, k) => v - st.objects.hands.right.position[k]);
      const length = Math.hypot(...toCenter);
      const move = Math.min(0.012, Math.max(0.002, (palmToProp - 0.07) * 0.5));
      const delta = toTracking(toCenter.map((v) => (v / length) * move));
      rightGrip = rightGrip.map((v, k) => v + delta[k]);
      await controller('right', rightGrip);
      await step(1);
    }
    row('right hand reached the prop', palmToProp <= 0.1, { palmToPropM: round(palmToProp, 3) });

    // A left squeeze with nothing held (and a prop out of the left hand's reach) grabs nothing.
    await button('left', 'squeeze', 1);
    await step(4);
    row('left squeeze far from the prop grabs nothing', !(await item()).heldBy, { heldBy: (await item()).heldBy });
    await button('left', 'squeeze', 0);
    await step(4);

    await clickButton(page, 'Start Recording');
    await page.getByRole('button', { name: 'Stop Recording', exact: true }).waitFor({ timeout: 10_000 });
    series = [];
    await step(18);
    const frame0 = series.length;

    await button('right', 'squeeze', 1);
    await step(3);
    const held = await item();
    row('right squeeze grabs the prop', held.heldBy === 'right' && held.size === 1, { heldBy: held.heldBy, size: held.size });
    const mass1 = held.mass;

    // Left controller to the prop, squeeze.
    const left = await bring('left', [...rest.left], (st) => {
      const it = st.objects.items[0];
      const c = centreOf(it);
      // The face of the bounds away from the right hand, so the two palms start apart.
      return [it.boundsMax[0] - 0.03, c[1], c[2]];
    });
    state = await readState(page);
    const palmGap = Math.hypot(...state.objects.hands.left.position.map((v, k) => v - state.objects.hands.right.position[k]));
    row('left hand brought to the prop', left.error <= 0.08, { errorM: round(left.error, 3), leftToRightHandM: round(palmGap, 3) });
    await button('left', 'squeeze', 1);
    await step(4);
    const stretching = await item();
    row('left squeeze next to the held prop: right still holds, size 1', stretching.heldBy === 'right' && Math.abs(stretching.size - 1) <= 0.05, { heldBy: stretching.heldBy, size: stretching.size });
    const d0 = Math.max(palmGap, 0.01);

    // Move the left controller away from the right hand until the palm distance doubles (size ~2), evenly over each move's frames as a
    // real hand does, so the size never jumps between recorded keys.
    let gripL = left.grip;
    const away = (() => {
      const delta = toTracking(state.objects.hands.left.position.map((v, k) => v - state.objects.hands.right.position[k]));
      const len = Math.hypot(...delta);
      return len > 1e-3 ? delta.map((v) => v / len) : [-1, 0, 0];
    })();
    let size = 1;
    for (let i = 0; i < 30 && Math.abs(size - 2) > 0.05; i += 1) {
      const move = away.map((v) => (v * (2 - size) * d0 * 0.6) / 6);
      for (let f = 0; f < 6; f += 1) {
        gripL = gripL.map((v, k) => v + move[k]);
        await controller('left', gripL);
        await step(1);
      }
      size = (await item()).size;
    }
    await step(10);
    const stretched = await item();
    row('stretching the left hand away -> size ~2 (+-10%)', Math.abs(stretched.size / 2 - 1) <= 0.1, { size: round(stretched.size), startHandGapM: round(d0, 3) });
    row('still held by the right hand while stretching', stretched.heldBy === 'right', { heldBy: stretched.heldBy });
    row('mass follows size^3 while stretched', Math.abs(stretched.mass / mass1 / stretched.size ** 3 - 1) <= 0.03, { massKg: round(stretched.mass), mass1Kg: round(mass1), ratio: round(stretched.mass / mass1, 3) });

    // Release the left: the right keeps the prop; the size is kept even when the left hand moves on.
    await button('left', 'squeeze', 0);
    await step(4);
    const afterLeft = await item();
    await controller('left', gripL.map((v, k) => v + away[k] * 0.1));
    await step(10);
    const afterMove = await item();
    row('releasing the left hand keeps the right hold and the size', afterLeft.heldBy === 'right' && Math.abs(afterLeft.size - stretched.size) < 0.02, { heldBy: afterLeft.heldBy, size: round(afterLeft.size) });
    row('moving the released left hand no longer resizes', Math.abs(afterMove.size - afterLeft.size) < 1e-6 && afterMove.heldBy === 'right', { size: round(afterMove.size) });

    // Release the right: the prop falls and rests, size kept.
    await button('right', 'squeeze', 0);
    await step(3);
    let rested = await item();
    row('releasing the right hand releases the prop', !rested.heldBy, { heldBy: rested.heldBy });
    for (let i = 0; i < 240 && rested.body !== 'asleep'; i += 1) {
      await step(1);
      rested = await item();
    }
    row('released stretched prop rests at its size, bottom on a surface', rested.body === 'asleep' && Math.abs(rested.size - afterMove.size) < 1e-6 && SURFACES_Y.some((y) => Math.abs(rested.boundsMin[1] - y) <= FLOOR_TOLERANCE_M), { body: rested.body, size: round(rested.size), boundsMinY: round(rested.boundsMin[1]) });

    const glb = path.join(artifactDir, `${label}.glb`);
    await saveDownload(page, async () => {
      await clickButton(page, 'Stop Recording');
      for (let i = 0; i < 20; i += 1) await page.clock.runFor(STEP_MS);
    }, glb);
    const captured = series;
    series = null;

    const take = loadTake(await readFile(glb));
    const wrappers = objectNodes(take);
    row('one RecordedObject wrapper', wrappers.length === 1, { wrappers: wrappers.length });
    const sizeNode = findNode(take, 'RecordedObjectSize');
    row('RecordedObjectSize node exists under the wrapper', sizeNode >= 0 && take.parents.get(sizeNode) === wrappers[0], { sizeNode, parent: take.parents.get(sizeNode), wrapper: wrappers[0] });
    if (sizeNode < 0 || wrappers.length !== 1) return { label, status: 'fail', failures, rows, glb };
    const scaleTrack = take.channels.get(sizeNode)?.scale;
    row('size node has a linear .scale track with a key per avatar key', scaleTrack?.interpolation === 'LINEAR' && scaleTrack.keys === take.times.length, { interpolation: scaleTrack?.interpolation, keys: scaleTrack?.keys, avatarKeys: take.times.length });
    const wrapperScale = take.channels.get(wrappers[0])?.scale;
    row('the wrapper has no scale track (never absent)', !wrapperScale, { wrapperScale: Boolean(wrapperScale) });
    if (!scaleTrack) return { label, status: 'fail', failures, rows, glb };
    const uniform = Array.from({ length: scaleTrack.keys }).every((_, i) => scaleTrack.values[i * 3] === scaleTrack.values[i * 3 + 1] && scaleTrack.values[i * 3] === scaleTrack.values[i * 3 + 2]);
    row('scale track is uniform (x=y=z)', uniform, {});
    const glbSize = (i) => scaleTrack.values[i * 3];

    // Align capture's per-step series (starting at recording start) to the GLB keys.
    const capSizes = captured.map((c) => c.size);
    let best = { offset: 0, error: Infinity };
    for (let offset = -40; offset <= 40; offset += 1) {
      let sum = 0;
      let n = 0;
      for (let i = 0; i < take.times.length; i += 1) {
        const c = capSizes[i + offset];
        if (c === undefined) continue;
        sum += Math.abs(glbSize(i) - c);
        n += 1;
      }
      if (n > take.times.length * 0.8 && sum / n < best.error) best = { offset, error: sum / n };
    }
    let maxSizeErr = 0;
    let maxExtentErr = 0;
    let maxCentreErrM = 0;
    let rawCentreErrM = 0;
    let centreShift = null;
    let compared = 0;
    let fastSkipped = 0;
    for (let i = 0; i < take.times.length; i += 12) {
      const c = captured[i + best.offset];
      if (!c) continue;
      // The recorded key may sit two frames either side of the step it is aligned to.
      maxSizeErr = Math.max(maxSizeErr, Math.min(...[-2, -1, 0, 1, 2].map((d) => Math.abs(glbSize(i) / (captured[i + best.offset + d]?.size ?? Infinity) - 1))));
      compared += 1;
      // A tumbling prop's mesh AABB is not the AABB of the local box's corners (all the GLB's accessors give), so only held and settled frames are compared.
      const unsettled = [-2, -1, 0, 1, 2].some((d) => { const f = captured[i + best.offset + d]; return f && !f.heldBy && f.body !== 'asleep'; });
      if (unsettled) { fastSkipped += 1; continue; }
      const box = glbModelBounds(take, sizeNode, i);
      const gExt = [box.max.x - box.min.x, box.max.y - box.min.y, box.max.z - box.min.z];
      const gCentre = [(box.max.x + box.min.x) / 2, (box.max.y + box.min.y) / 2, (box.max.z + box.min.z) / 2];
      const centreAtFrame = (d) => {
        const f = captured[i + best.offset + d];
        return f ? [0, 1, 2].map((a) => (f.max[a] + f.min[a]) / 2) : null;
      };
      const cCentre = centreAtFrame(0);
      // Like the size, within two frames of the aligned step (a stretch changes the size every frame).
      maxExtentErr = Math.max(maxExtentErr, Math.min(...[-2, -1, 0, 1, 2].map((d) => {
        const f = captured[i + best.offset + d];
        return f ? Math.max(...gExt.map((v, a) => Math.abs(v / (f.max[a] - f.min[a]) - 1))) : Infinity;
      })));
      const diff = gCentre.map((v, a) => v - cCentre[a]);
      centreShift ??= diff;
      // Within two frames of the aligned step (a fall is metres per second).
      const nearest = Math.min(...[-2, -1, 0, 1, 2].map((d) => {
        const cc = centreAtFrame(d);
        return cc ? Math.hypot(...gCentre.map((v, a) => v - cc[a] - centreShift[a])) : Infinity;
      }));
      maxCentreErrM = Math.max(maxCentreErrM, nearest);
      rawCentreErrM = Math.max(rawCentreErrM, Math.hypot(...diff));
    }
    row('GLB scale track matches capture size at sampled frames (+-1%)', compared > 20 && maxSizeErr <= 0.01, { compared, alignedOffsetFrames: best.offset, meanAbsSizeErr: round(best.error, 5), maxRelErr: round(maxSizeErr, 5), keys: take.times.length, captureFrames: captured.length, frame0 });
    row('GLB model world bounds extents match capture within 2%', compared > 20 && maxExtentErr <= 0.02, { maxRelExtentErr: round(maxExtentErr, 5) });
    row('GLB model world bounds centre moves with capture within 2 cm (constant frame offset removed)', maxCentreErrM <= 0.02, { maxCentreErrM: round(maxCentreErrM, 4), rawMaxCentreErrM: round(rawCentreErrM, 4), fastFramesSkipped: fastSkipped, frameOffsetM: centreShift?.map((v) => round(v, 3)) });
    const sizes = Array.from({ length: scaleTrack.keys }, (_, i) => glbSize(i));
    row('track spans 1 to ~2', Math.min(...sizes) === 1 && Math.abs(Math.max(...sizes) / 2 - 1) <= 0.1, { min: Math.min(...sizes), max: round(Math.max(...sizes), 4) });

    return { label, status: failures.length ? 'fail' : 'pass', failures, rows, glb, floorY: FLOOR_Y, capture: { series: captured, offset: best.offset } };
  } finally {
    await context.close();
  }
}

export const runIwerResize = runIwerResizeTake;
