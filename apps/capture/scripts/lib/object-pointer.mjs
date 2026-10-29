import { createXrContext, waitForPageFunctions, waitForTextContentPrefix, wireXrConsoleErrors } from '@holoim/tooling-testing/xr-env';

import { OBJECT_URL, openCapture, readState, squatTracker, recordEveryStep, stepJumps } from './object-take.mjs';

// Grab, place and throw with physics (slice 2): a mouse and a touch grab, by
// capture's real input events.
//   - Desktop mouse (first person, pointer lock stood in at the DOM API as the
//     pointing check does, because macOS Chromium refuses the real lock): the
//     click that acquires the lock grabs nothing; a left press on a prop out of
//     reach grabs nothing; a press at the view centre on a reachable prop
//     grabs it; a still release sets it down (held through the ease, then
//     resting within a few cm of where it was); a release while walking
//     throws it; a press during the set-down keeps it in hand.
//   - Phone (390 x 844, CDP touch): a touch elsewhere on the look side still
//     looks, a touch held elsewhere still points, the stick still walks, a
//     touch on the prop grabs it without pointing, a drag while holding still
//     looks, and lifting releases it.
// The rows go into the take's entry of report.json.

const STEP_MS = 1000 / 60;
const FLOOR_TOLERANCE_M = 0.01;
const REST_TIMEOUT_SEC = 3;
// The fixture's floor and its platform top in world space (the scene sits 0.01 m above its authored floor).
const SURFACES_Y = [0.01, 0.29];
const round = (value, digits = 3) => Number(value.toFixed(digits));
const centreOf = (item) => [0, 1, 2].map((a) => (item.boundsMin[a] + item.boundsMax[a]) / 2);

async function openPage(browser, baseUrl, consoleErrors, label, { viewport, touch }) {
  const context = await createXrContext(browser, { viewport, acceptDownloads: true, ...(touch ? { hasTouch: true, isMobile: true, deviceScaleFactor: 2 } : {}) });
  const page = await context.newPage();
  wireXrConsoleErrors(page, consoleErrors, { label });
  await page.route('**/__holoim/input-recordings*', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '{"path":"object-pointer-input.json"}' }));
  await openCapture(page, baseUrl, { object: OBJECT_URL });
  await waitForPageFunctions(page, ['__projectToScreen', '__loadObjectUrl', '__setMockInput', '__sampleHolds']);
  await waitForTextContentPrefix(page, '#status', 'loaded');
  await recordEveryStep(page);
  const advance = (seconds) => page.evaluate((ms) => window.advanceTime(ms), Math.round(seconds * 60) * STEP_MS);
  const item = async () => (await readState(page)).objects.items[0];
  const rearm = async () => {
    if (!(await page.evaluate((url) => window.__loadObjectUrl(url), OBJECT_URL))) throw new Error('the object did not reload');
    await advance(0.3);
    const fresh = await item();
    if (!fresh?.placed) throw new Error('the re-armed object was not placed');
    return fresh;
  };
  return { context, page, advance, item, rearm };
}

/** Steps until the first object sleeps (or the timeout) and returns it. */
async function rest(s) {
  let current = await s.item();
  for (let i = 0; i < Math.round(REST_TIMEOUT_SEC * 60) && current.body !== 'asleep'; i += 1) {
    await s.advance(1 / 60);
    current = await s.item();
  }
  return current;
}

export async function runDesktopMouseObject({ browser, baseUrl, consoleErrors }) {
  const label = 'desktop-mouse-object';
  const failures = [];
  const fail = (message) => failures.push(message);
  const viewport = { width: 960, height: 540 };
  const s = await openPage(browser, baseUrl, consoleErrors, label, { viewport, touch: false });
  const { page, advance } = s;
  try {
    await advance(1);
    await page.keyboard.press('KeyV');
    // Pointer lock stood in at the DOM API: capture's click handler still calls requestPointerLock and its handlers still read pointerLockElement.
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
    const centre = { x: viewport.width / 2, y: viewport.height / 2 };
    const locked = () => page.evaluate(() => document.pointerLockElement === document.querySelector('canvas'));
    const eyeY = async () => (await readState(page)).heightAdaptation.eyeWorld;

    // Point the first-person view so the prop's bounds centre sits at (offset from) the view centre,
    // closing the loop on its projection. The bracket is an L, so some offsets land on the model and some beside it.
    const FOCAL_PX = viewport.height / 2 / Math.tan((35 * Math.PI) / 180);
    let view = { yaw: 0, pitch: 0 };
    const aim = async (offset = { x: 0, y: 0 }) => {
      if (view.yaw === 0 && view.pitch === 0) {
        const current = await s.item();
        const eye = await eyeY();
        const c = centreOf(current);
        const d = [c[0] - eye.x, c[1] - eye.y, c[2] - eye.z];
        view = { yaw: Math.atan2(-d[0], -d[2]), pitch: Math.asin(d[1] / Math.hypot(...d)) };
      }
      let error = Infinity;
      for (let i = 0; i < 8; i += 1) {
        await page.evaluate((arg) => window.__setMockInput(arg), { lookYaw: view.yaw, aimPitch: view.pitch });
        await advance(0.1);
        const at = await page.evaluate((p) => window.__projectToScreen(p), centreOf(await s.item()));
        if (!at) return Infinity;
        const ex = at.x - (centre.x + offset.x);
        const ey = at.y - (centre.y + offset.y);
        error = Math.hypot(ex, ey);
        if (error < 2) break;
        view = { yaw: view.yaw - Math.atan(ex / FOCAL_PX), pitch: view.pitch - Math.atan(ey / FOCAL_PX) };
      }
      return error;
    };
    // Presses at offsets from the prop's centre until one lands on the model; returns the offset, or null.
    const OFFSETS = [[0, 0], [12, 0], [-12, 0], [0, 12], [0, -12], [24, 0], [-24, 0], [0, 24], [0, -24], [20, 20], [-20, -20], [20, -20], [-20, 20]];
    const grabByMouse = async (holdSec, offsets = OFFSETS) => {
      for (const [x, y] of offsets) {
        await aim({ x: -x, y: -y });
        await press(holdSec);
        if ((await s.item()).heldBy) return { x, y };
        await lift();
      }
      return null;
    };
    const press = async (ms = 0) => {
      await page.mouse.move(centre.x, centre.y);
      await page.mouse.down();
      await advance(Math.max(1 / 60, ms));
    };
    const lift = async () => {
      await page.mouse.up();
      await advance(1 / 60);
    };

    const aimedPx = await aim();
    if (aimedPx > 4) fail(`the prop is ${round(aimedPx, 1)} px from the view centre; the aim did not settle`);

    // The click that acquires the pointer lock never grabs.
    await page.mouse.click(centre.x, centre.y);
    await advance(0.3);
    const acquiring = { lockedAfter: await locked(), heldBy: (await s.item()).heldBy };
    if (!acquiring.lockedAfter) fail('the click did not take the pointer lock');
    if (acquiring.heldBy) fail('the lock-acquiring click grabbed the prop');

    // Out of reach: walk back, look at the prop from there, and press. Slice 2: a prop within 8 m and in sight is fetched into the hand
    // (it was a press that grabbed nothing before). Beyond 8 m and behind a wall nothing happens: see lib/object-push.mjs.
    await page.keyboard.down('KeyS');
    await advance(1.5);
    await page.keyboard.up('KeyS');
    await advance(0.3);
    const farAimPx = await aim();
    // The bracket is an L, seen thin from afar: press at offsets until one lands on the model.
    const fine = [];
    for (let x = -16; x <= 16; x += 4) for (let y = -16; y <= 16; y += 4) fine.push([x, y]);
    const farHit = await grabByMouse(0.3, fine.sort((p, q) => Math.hypot(...p) - Math.hypot(...q)));
    await advance(0.5);
    const far = await s.item();
    const farHand = (await readState(page)).objects.hands.right.position;
    const farToHandM = Math.hypot(...far.position.map((v, k) => v - farHand[k]));
    await lift();
    await advance(0.5);
    const stillHeld = (await s.item()).heldBy;
    const outOfReach = { heldBy: far.heldBy, aimedPx: round(farAimPx, 1), hitOffsetPx: farHit, toHandM: round(farToHandM, 3), heldAfterLift: stillHeld };
    if (farAimPx > 40) fail(`the far prop was not in the view centre (${outOfReach.aimedPx} px), so the out-of-reach press tested nothing`);
    if (!farHit || outOfReach.heldBy !== 'right') fail('a press on a prop out of reach but within 8 m and in sight did not fetch it');
    if (outOfReach.toHandM > 0.15) fail(`the fetched prop is ${outOfReach.toHandM} m from the hand after 0.5 s`);
    if (stillHeld !== 'right') fail('the fetched prop was let go when the button lifted');

    // Still: grab, hold, let go. Held through the set-down ease, then dropped from a few cm.
    await s.rearm();
    const hitAt = await grabByMouse(0.5);
    const grabbed = await s.item();
    const state = await readState(page);
    const grab = { heldBy: grabbed.heldBy, carryWeight: state.objects.carryWeight, hitOffsetPx: hitAt };
    if (grab.heldBy !== 'right') fail(`a left press at the view centre did not grab the prop (heldBy ${grab.heldBy})`);
    if (grab.carryWeight < 1) fail(`the carry pose did not blend in on a mouse grab (${grab.carryWeight})`);
    await advance(0.3);
    const beforeLift = await s.item();
    await page.mouse.up();
    await advance(0.1);
    const easing = await s.item();
    if (easing.heldBy !== 'right') fail('the prop was released at once on a still lift instead of being set down');
    if (!(easing.boundsMin[1] < beforeLift.boundsMin[1] - 0.005)) fail(`the prop was not lowered during the set-down (${round(beforeLift.boundsMin[1] - easing.boundsMin[1], 4)} m)`);
    // The let-go is the first free state: the prop was lowered with the hand, so it drops from there.
    let released = easing;
    const squat = squatTracker();
    for (let i = 0; i < 150 && released.heldBy; i += 1) {
      await advance(1 / 60);
      const frame = await readState(page);
      squat.sample(frame);
      released = frame.objects.items[0];
    }
    squat.assert(fail, 'a still release');
    await stepJumps(page, 'a still release', fail);
    if (released.heldBy) fail('the set-down never released the prop');
    const launch = released;
    const resting = await rest(s);
    const stillRelease = {
      squat: squat.result(),
      // Sideways speed: one step of gravity alone falls 0.16 m/s.
      launchSpeedMps: round(Math.hypot(launch.linvel[0], launch.linvel[2])),
      fellFromHandM: round(beforeLift.boundsMin[1] - resting.boundsMin[1]),
      dropAfterLetGoM: round(launch.boundsMin[1] - resting.boundsMin[1], 4),
      driftM: round(Math.hypot(centreOf(resting)[0] - centreOf(launch)[0], centreOf(resting)[2] - centreOf(launch)[2])),
      // The squat carries the prop out with the hand as the avatar leans over.
      handTravelM: round(Math.hypot(centreOf(launch)[0] - centreOf(beforeLift)[0], centreOf(launch)[2] - centreOf(beforeLift)[2])),
      floorGapM: round(resting.boundsMin[1], 4),
      body: resting.body
    };
    // Slice 3: nothing is within the arm's standing reach below, so the body squats and the prop is let go just above the surface.
    if (stillRelease.dropAfterLetGoM > 0.03) fail(`a still release let go ${stillRelease.dropAfterLetGoM} m above the surface (limit 0.03 m)`);
    if (stillRelease.launchSpeedMps > 0.6) fail(`a still release launched the prop at ${stillRelease.launchSpeedMps} m/s`);
    if (stillRelease.driftM > 0.02) fail(`a still release drifted ${stillRelease.driftM} m sideways after the let-go (limit 0.02 m)`);
    if (stillRelease.body !== 'asleep') fail(`the set-down prop did not come to rest (${stillRelease.body})`);
    if (!SURFACES_Y.some((y) => Math.abs(stillRelease.floorGapM - y) <= FLOOR_TOLERANCE_M)) fail(`the set-down prop rests at ${stillRelease.floorGapM} m, not on a surface of the scene (${SURFACES_Y.join(' or ')} m)`);

    // Pressing during the set-down keeps the prop in hand.
    await s.rearm();
    await grabByMouse(0.5);
    await page.mouse.up();
    await advance(0.1);
    const settling = await s.item();
    await page.mouse.down();
    await advance(0.6);
    const regrabbed = await s.item();
    await page.mouse.up();
    await advance(1);
    const afterCancel = await s.item();
    const cancelled = { settlingHeldBy: settling.heldBy, heldAfterPress: regrabbed.heldBy, releasedAfterLift: afterCancel.heldBy === null };
    if (settling.heldBy !== 'right' || regrabbed.heldBy !== 'right') fail(`a press during the set-down did not keep the prop in hand: ${JSON.stringify(cancelled)}`);
    if (!cancelled.releasedAfterLift) fail('the prop stayed held after the second lift');
    await rest(s);

    // Moving: let go while walking and the prop is thrown with the fitted velocity.
    await s.rearm();
    await grabByMouse(0.5);
    await page.keyboard.down('KeyW');
    await advance(0.6);
    const walking = await s.item();
    await page.mouse.up();
    await page.keyboard.up('KeyW');
    await advance(1 / 60);
    const thrown = await s.item();
    const afterThrow = await rest(s);
    const flick = {
      heldBy: thrown.heldBy,
      walkingHeldBy: walking.heldBy,
      launchSpeedMps: round(Math.hypot(thrown.linvel[0], thrown.linvel[2])),
      travelledM: round(Math.hypot(centreOf(afterThrow)[0] - centreOf(walking)[0], centreOf(afterThrow)[2] - centreOf(walking)[2])),
      body: afterThrow.body,
      floorGapM: round(afterThrow.boundsMin[1], 4)
    };
    if (flick.walkingHeldBy !== 'right') fail('the prop was not held while walking');
    if (flick.heldBy) fail('releasing while walking kept the prop held');
    if (flick.launchSpeedMps < 0.5) fail(`releasing while walking launched the prop at only ${flick.launchSpeedMps} m/s`);
    if (flick.body !== 'asleep') fail(`the thrown prop did not come to rest (${flick.body})`);
    if (flick.travelledM < 0.3) fail(`the thrown prop travelled only ${flick.travelledM} m`);

    // The lock is lost while holding: the prop lets go.
    await s.rearm();
    await grabByMouse(0.5);
    await page.evaluate(() => document.exitPointerLock());
    await advance(1);
    const lostLock = { heldBy: (await s.item()).heldBy };
    if (lostLock.heldBy) fail('losing the pointer lock left the prop held');

    return { label, status: failures.length ? 'fail' : 'pass', failures, acquiring, outOfReach, grab, stillRelease, cancelled, flick, lostLock };
  } finally {
    await s.context.close();
  }
}

export async function runPhoneTouchObject({ browser, baseUrl, consoleErrors }) {
  const label = 'phone-touch-object';
  const failures = [];
  const fail = (message) => failures.push(message);
  const viewport = { width: 390, height: 844 };
  const s = await openPage(browser, baseUrl, consoleErrors, label, { viewport, touch: true });
  const { page, advance } = s;
  try {
    const cdp = await page.context().newCDPSession(page);
    const touch = (type, id, x, y) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y, id, radiusX: 4, radiusY: 4, force: 1 }] });
    const holds = () => page.evaluate(() => window.__sampleHolds());
    const yawOf = async () => (await readState(page)).avatar.yaw;
    await advance(1);
    const where = async () => {
      const current = await s.item();
      return { current, at: await page.evaluate((p) => window.__projectToScreen(p), centreOf(current)) };
    };
    let { at } = await where();
    if (!at || at.x < viewport.width * 0.4 || at.y > viewport.height - 160) fail(`the prop projects to ${JSON.stringify(at)}, not on the look side above the dock`);
    at ??= { x: 200, y: 400 };
    // A spot on the look side, well away from the prop.
    const empty = { x: 330, y: 150 };
    if (Math.hypot(empty.x - at.x, empty.y - at.y) < 100) fail('the empty touch spot is on the prop');

    // Touch elsewhere still looks.
    const yaw0 = await yawOf();
    await touch('touchStart', 1, empty.x, empty.y);
    for (const dx of [-20, -40, -60]) await touch('touchMove', 1, empty.x + dx, empty.y);
    await touch('touchEnd', 1, 0, 0);
    await advance(0.1);
    const looked = { yawDeltaRad: round((await yawOf()) - yaw0), heldBy: (await s.item()).heldBy };
    if (Math.abs(looked.yawDeltaRad) < 0.1) fail(`a touch dragged on empty space did not look (${looked.yawDeltaRad} rad)`);
    if (looked.heldBy) fail('a touch on empty space grabbed the prop');

    // Touch and hold elsewhere still points.
    ({ at } = await where());
    await touch('touchStart', 2, empty.x, empty.y);
    await page.waitForTimeout(450);
    await advance(0.1);
    const pointPhase = (await holds()).touch;
    await touch('touchEnd', 2, 0, 0);
    await advance(0.3);
    if (pointPhase !== 'held') fail(`a touch resting 450 ms on empty space is ${pointPhase}, not a point hold`);

    // The stick still walks.
    const before = (await readState(page)).avatar;
    await touch('touchStart', 3, 60, 600);
    await touch('touchMove', 3, 60, 540);
    await touch('touchMove', 3, 60, 480);
    await advance(0.6);
    const during = (await readState(page)).avatar;
    await touch('touchEnd', 3, 0, 0);
    await advance(0.3);
    const walked = { movedM: round(Math.hypot(during.x - before.x, during.z - before.z)) };
    if (walked.movedM < 0.2) fail(`the stick walked only ${walked.movedM} m`);

    // Touch on the reachable prop grabs it (re-armed in front of the avatar, which has turned).
    await s.rearm();
    await advance(0.5);
    ({ at } = await where());
    if (!at || at.x < viewport.width * 0.4) fail(`the re-armed prop projects to ${JSON.stringify(at)}`);
    // The bracket is an L: try points around its projected centre until a touch lands on the model.
    const centreAt = at ?? { x: 200, y: 400 };
    let grabAt = centreAt;
    for (const [ox, oy] of [[0, 0], [10, 0], [-10, 0], [0, 10], [0, -10], [20, 0], [-20, 0], [0, 20], [0, -20], [16, 16], [-16, -16], [16, -16], [-16, 16]]) {
      grabAt = { x: centreAt.x + ox, y: centreAt.y + oy };
      await touch('touchStart', 4, grabAt.x, grabAt.y);
      await advance(0.1);
      // A touch on the model starts a reach; the prop is held once the palm is on it.
      const started = await readState(page);
      if (started.objects.items[0].heldBy || ['step', 'reach'].includes(started.objects.reach.phase)) break;
      await touch('touchEnd', 4, 0, 0);
      await advance(0.1);
    }
    await advance(0.4);
    const grabbed = await s.item();
    const grabState = await readState(page);
    const grab = { heldBy: grabbed.heldBy, carryWeight: grabState.objects.carryWeight, holdPhase: (await holds()).touch };
    if (grab.heldBy !== 'right') fail(`a touch on the prop did not grab it (heldBy ${grab.heldBy})`);
    if (grab.holdPhase === 'held') fail('the grabbing touch also became a point hold');
    // Dragging still looks, with the prop in hand.
    const yawG = await yawOf();
    for (const dx of [10, 20, 30, 40]) {
      await touch('touchMove', 4, grabAt.x - dx, grabAt.y);
      await advance(1 / 60);
    }
    const draggedHeld = { yawDeltaRad: round((await yawOf()) - yawG), heldBy: (await s.item()).heldBy };
    if (Math.abs(draggedHeld.yawDeltaRad) < 0.05) fail(`dragging the grabbing touch did not look (${draggedHeld.yawDeltaRad} rad)`);
    if (draggedHeld.heldBy !== 'right') fail('dragging dropped the prop');
    // Still, then lift: it is set down.
    await advance(0.5);
    const beforeLift = await s.item();
    const preLift = (await readState(page)).objects.reach;
    await touch('touchEnd', 4, 0, 0);
    await advance(1 / 60);
    const postLift = (await readState(page)).objects.reach;
    await advance(0.1);
    const easing = await s.item();
    let lifted = easing;
    const squat = squatTracker();
    for (let i = 0; i < 150 && lifted.heldBy; i += 1) {
      await advance(1 / 60);
      const frame = await readState(page);
      squat.sample(frame);
      lifted = frame.objects.items[0];
    }
    squat.assert(fail, 'a still touch lift');
    await stepJumps(page, 'a still touch lift', fail);
    const resting = await rest(s);
    const lift = {
      squat: squat.result(),
      dropAfterLetGoM: round(lifted.boundsMin[1] - resting.boundsMin[1], 4),
      heldDuringEase: easing.heldBy,
      heldAfter: lifted.heldBy,
      preLift,
      postLift,
      driftM: round(Math.hypot(centreOf(resting)[0] - centreOf(lifted)[0], centreOf(resting)[2] - centreOf(lifted)[2])),
      handTravelM: round(Math.hypot(centreOf(lifted)[0] - centreOf(beforeLift)[0], centreOf(lifted)[2] - centreOf(beforeLift)[2])),
      floorGapM: round(resting.boundsMin[1], 4),
      body: resting.body
    };
    if (lift.heldAfter) fail('lifting the finger did not release the prop');
    if (lift.dropAfterLetGoM > 0.03) fail(`a still touch lift let go ${lift.dropAfterLetGoM} m above the surface (limit 0.03 m)`);
    if (lift.driftM > 0.02) fail(`a still touch lift drifted ${lift.driftM} m after the let-go (limit 0.02 m)`);
    if (lift.body !== 'asleep') fail(`the released prop did not come to rest (${lift.body})`);

    return { label, status: failures.length ? 'fail' : 'pass', failures, looked, pointPhase, walked, grab, draggedHeld, lift };
  } finally {
    await s.context.close();
  }
}
