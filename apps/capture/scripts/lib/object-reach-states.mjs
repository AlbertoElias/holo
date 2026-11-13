import { enterIwerSessionFromButton } from '@holoim/tooling-testing/xr-env';
import { setHeadPose } from '@holoim/tooling-testing/iwer-phone';

import { openPage } from './object-reach.mjs';

// Desktop reach under interruption: the mouse's reach, carry and let-go, with the things that
// happen to a gesture half-way (focus lost, the tab hidden, a take started or stopped, the
// view toggled, the point action held, Esc). Each scenario opens a fresh page, puts the prop
// on the floor, aims the first-person view at it and presses the left mouse button under the
// pointer lock stood in at the DOM API (macOS Chromium refuses the real one).

const VIEWPORT = { width: 960, height: 540 };
const FOCAL_PX = VIEWPORT.height / 2 / Math.tan((35 * Math.PI) / 180);
const CENTRE = { x: VIEWPORT.width / 2, y: VIEWPORT.height / 2 };
const centreOf = (item) => [0, 1, 2].map((a) => (item.boundsMin[a] + item.boundsMax[a]) / 2);
const round = (value, digits = 3) => Number(value.toFixed(digits));

/** Aims the first-person view centre at the prop, closing the loop on its projection. */
async function aimAtProp(s) {
  const { page, advance } = s;
  let view = { yaw: 0, pitch: -1.2 };
  for (let i = 0; i < 10; i += 1) {
    await page.evaluate((arg) => window.__setMockInput(arg), { lookYaw: view.yaw, aimPitch: view.pitch });
    await advance(0.1);
    const at = await page.evaluate((p) => window.__projectToScreen(p), centreOf(await s.item()));
    if (!at) break;
    const ex = at.x - CENTRE.x;
    const ey = at.y - CENTRE.y;
    if (Math.hypot(ex, ey) < 3) break;
    view = { yaw: view.yaw - Math.atan(ex / FOCAL_PX), pitch: Math.max(-1.45, view.pitch - Math.atan(ey / FOCAL_PX)) };
  }
  await page.mouse.move(CENTRE.x, CENTRE.y);
}

async function prepare(browser, baseUrl, consoleErrors, label, { phone = false } = {}) {
  const s = await openPage(browser, baseUrl, consoleErrors, label, { viewport: VIEWPORT, touch: false, phone });
  if (phone) return s;
  const { page, advance } = s;
  await advance(1);
  await page.keyboard.press('KeyV');
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
    let hidden = false;
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
    window.__setHidden = (value) => {
      hidden = value;
      document.dispatchEvent(new Event('visibilitychange'));
    };
  });
  await page.mouse.click(CENTRE.x, CENTRE.y);
  await advance(0.3);
  await s.putOnFloor();
  await aimAtProp(s);
  await page.mouse.move(CENTRE.x, CENTRE.y);
  return s;
}

const snap = async (s) => {
  const st = await s.state();
  const item = st.objects.items[0];
  return { phase: st.objects.reach.phase, pointer: st.objects.reach.pointer, heldBy: item.heldBy, body: item.body, y: round(item.position[1]), crouch: round(st.crouch.amount, 2) };
};

/** Presses on the prop; true when a reach began. */
async function pressOnProp(s) {
  await s.page.mouse.down();
  await s.advance(0.05);
  const now = await snap(s);
  return { began: now.phase === 'step' || now.phase === 'reach', now };
}

export async function runReachInterruptions({ browser, baseUrl, consoleErrors, only }) {
  const label = 'desktop-reach-interruptions';
  const failures = [];
  const fail = (message) => failures.push(message);
  const rows = {};
  const scenarios = {
    // The window loses focus while the button is down on a reach in progress: the pointer counts as lifted, the reach goes on, and the next press lets the prop go.
    async blurMidReach(s) {
      const { page, advance } = s;
      const started = await pressOnProp(s);
      if (!started.began) return fail('blurMidReach: the press did not start a reach ' + JSON.stringify(started.now));
      await page.evaluate(() => window.dispatchEvent(new Event('blur')));
      await advance(0.05);
      const afterBlur = await snap(s);
      await page.mouse.up();
      const carried = await s.until((st) => st.objects.items[0].heldBy && st.objects.reach.phase === 'carry', 3);
      const held = await snap(s);
      if (!carried.state.objects.items[0].heldBy) fail(`blurMidReach: the reach did not end in a hold ${JSON.stringify({ afterBlur, held })}`);
      await page.mouse.down();
      await advance(1 / 60);
      await page.mouse.up();
      await s.until((st) => !st.objects.items[0].heldBy, 4);
      const letGo = await snap(s);
      if (letGo.heldBy) fail(`blurMidReach: the next press did not let the prop go ${JSON.stringify(letGo)}`);
      return { afterBlur, held, letGo };
    },
    // The button is held through the reach and the lift (a drag carry); focus is lost: the prop is set down, and a new press grabs again.
    async blurWhileCarrying(s) {
      const { page, advance } = s;
      const started = await pressOnProp(s);
      if (!started.began) return fail('blurWhileCarrying: the press did not start a reach');
      const carried = await s.until((st) => st.objects.items[0].heldBy && st.objects.reach.phase === 'carry', 3);
      const before = await snap(s);
      if (!carried.state.objects.items[0].heldBy || !before.pointer) fail(`blurWhileCarrying: not carried by the pointer ${JSON.stringify(before)}`);
      await page.evaluate(() => window.dispatchEvent(new Event('blur')));
      const released = await s.until((st) => !st.objects.items[0].heldBy, 4);
      const afterBlur = await snap(s);
      if (afterBlur.heldBy) fail(`blurWhileCarrying: the prop is still held after blur ${JSON.stringify(afterBlur)}`);
      await page.mouse.up();
      await advance(0.3);
      await s.rest();
      await s.until((st) => st.crouch.amount < 0.01, 2);
      await aimAtProp(s);
      const again = await pressOnProp(s);
      if (!again.began) fail(`blurWhileCarrying: a press after the blur starts nothing ${JSON.stringify(again.now)}`);
      await page.mouse.up();
      return { before, afterBlur, releasedSec: round(released.sec), again: again.now };
    },
    async hiddenWhileCarrying(s) {
      const { page, advance } = s;
      const started = await pressOnProp(s);
      if (!started.began) return fail('hiddenWhileCarrying: the press did not start a reach');
      await s.until((st) => st.objects.items[0].heldBy && st.objects.reach.phase === 'carry', 3);
      await page.evaluate(() => window.__setHidden(true));
      await s.until((st) => !st.objects.items[0].heldBy, 4);
      const afterHidden = await snap(s);
      if (afterHidden.heldBy) fail(`hiddenWhileCarrying: still held ${JSON.stringify(afterHidden)}`);
      await page.evaluate(() => window.__setHidden(false));
      await page.mouse.up();
      await advance(0.3);
      await s.rest();
      await s.until((st) => st.crouch.amount < 0.01, 2);
      await aimAtProp(s);
      const again = await pressOnProp(s);
      if (!again.began) fail(`hiddenWhileCarrying: a press after the tab came back starts nothing ${JSON.stringify(again.now)}`);
      await page.mouse.up();
      return { afterHidden, again: again.now };
    },
    // Esc (the pointer lock lost) in the middle of the lift with the button down.
    async lockLostWhileCarrying(s) {
      const { page, advance } = s;
      const started = await pressOnProp(s);
      if (!started.began) return fail('lockLostWhileCarrying: the press did not start a reach');
      await s.until((st) => st.objects.items[0].heldBy && st.objects.reach.phase === 'carry', 3);
      await page.evaluate(() => document.exitPointerLock());
      await s.until((st) => !st.objects.items[0].heldBy, 4);
      const after = await snap(s);
      if (after.heldBy) fail(`lockLostWhileCarrying: still held ${JSON.stringify(after)}`);
      await page.mouse.up();
      await advance(0.3);
      await s.rest();
      await s.until((st) => st.crouch.amount < 0.01, 2);
      // The next click takes the lock back; it never grabs. The one after does.
      await page.mouse.down();
      await page.mouse.up();
      await advance(0.2);
      const first = await snap(s);
      await aimAtProp(s);
      const again = await pressOnProp(s);
      await page.mouse.up();
      if (first.phase !== 'idle') fail(`lockLostWhileCarrying: the click that takes the lock grabbed ${JSON.stringify(first)}`);
      if (!again.began) fail(`lockLostWhileCarrying: the press after the lock came back starts nothing ${JSON.stringify(again.now)}`);
      return { after, first, again: again.now };
    },
    // Record is pressed while the button is down on the reach, and again (Stop) while the prop is carried by the pointer.
    async takeBoundaryMidGesture(s) {
      const { page, advance } = s;
      const started = await pressOnProp(s);
      if (!started.began) return fail('takeBoundaryMidGesture: the press did not start a reach');
      await page.keyboard.press('KeyR');
      await advance(0.05);
      const recording = (await s.state()).recording;
      await advance(0.1);
      const afterStart = await snap(s);
      const carried = await s.until((st) => st.objects.items[0].heldBy && st.objects.reach.phase === 'carry', 3);
      const held = await snap(s);
      if (!carried.state.objects.items[0].heldBy) fail(`takeBoundaryMidGesture: the take start ended the reach ${JSON.stringify({ afterStart, held })}`);
      if (!held.pointer) fail(`takeBoundaryMidGesture: the pointer hold was lost over the take start ${JSON.stringify(held)}`);
      await page.keyboard.press('KeyR');
      await advance(0.1);
      const afterStop = await snap(s);
      if (!afterStop.heldBy || !afterStop.pointer) fail(`takeBoundaryMidGesture: the take stop changed the hold ${JSON.stringify(afterStop)}`);
      await page.mouse.up();
      await s.until((st) => !st.objects.items[0].heldBy, 4);
      const letGo = await snap(s);
      if (letGo.heldBy) fail(`takeBoundaryMidGesture: the lift of the button did not set the prop down ${JSON.stringify(letGo)}`);
      return { recording: recording?.state ?? recording, afterStart, held, afterStop, letGo };
    },
    // The view is toggled (V) and the point action (F) held while a reach and a carry are going on.
    async modeChangeMidReach(s) {
      const { page, advance } = s;
      const started = await pressOnProp(s);
      if (!started.began) return fail('modeChangeMidReach: the press did not start a reach');
      await page.keyboard.press('KeyV');
      await advance(0.05);
      const afterView = await snap(s);
      await page.mouse.up();
      const carried = await s.until((st) => st.objects.items[0].heldBy && st.objects.reach.phase === 'carry', 3);
      if (!carried.state.objects.items[0].heldBy) fail(`modeChangeMidReach: the view toggle ended the reach ${JSON.stringify({ afterView, now: await snap(s) })}`);
      // F during the carry: the arm points, the prop stays held; F up carries on.
      const beforePoint = await snap(s);
      await page.keyboard.down('KeyF');
      await advance(0.5);
      const pointing = await snap(s);
      await page.keyboard.up('KeyF');
      await advance(0.5);
      const afterPoint = await snap(s);
      if (!afterPoint.heldBy) fail(`modeChangeMidReach: the prop was let go by pointing ${JSON.stringify({ beforePoint, pointing, afterPoint })}`);
      return { afterView, beforePoint, pointing, afterPoint };
    },
    // A phone starts an AR session (the Enter AR button) while the prop is carried: the session takes the screen, so the hold has to end, as it does on VR entry, not freeze in the air.
    async arEntryWhileCarrying(s) {
      const { page, advance } = s;
      await page.locator('canvas').first().focus();
      await page.keyboard.press('KeyG');
      const carried = await s.until((st) => st.objects.items[0].heldBy && st.objects.reach.phase === 'carry', 3);
      if (!carried.state.objects.items[0].heldBy) return fail('arEntryWhileCarrying: the setup pickup did not hold the prop');
      await advance(0.3);
      const before = await snap(s);
      await page.evaluate(() => {
        window.IWER_DEVICE.controlMode = 'programmatic';
      });
      await setHeadPose(page, [0, 1.6, 0], [0, 0, 0, 1]);
      await enterIwerSessionFromButton(page, '#ARButton', { readyCheck: "JSON.parse(window.render_game_to_text()).ar.sessionMode === 'ar'" });
      const frames = [];
      for (let i = 0; i < 30; i += 1) {
        await page.evaluate(() => new Promise((resolve) => window.IWER_DEVICE.activeSession.requestAnimationFrame(() => resolve())));
        await advance(1 / 20);
        if (i % 10 === 9) frames.push(await snap(s));
      }
      // The prop falls to the floor and sleeps there; nothing leaves it in the air.
      await s.until((st) => st.objects.items[0].body === 'asleep', 6);
      const inAr = await s.state();
      const during = await snap(s);
      if (during.y > 0.3) fail(`arEntryWhileCarrying: the prop did not come down ${JSON.stringify(during)}`);
      const mode = inAr.ar?.sessionMode;
      if (mode !== 'ar') fail(`arEntryWhileCarrying: the session was ${mode}, not ar`);
      if (during.heldBy || during.phase !== 'idle') fail(`arEntryWhileCarrying: the hold or reach stayed over AR entry ${JSON.stringify({ before, during })}`);
      return { before, during, frames };
    },
    async pointDuringReach(s) {
      const { page, advance } = s;
      await page.keyboard.down('KeyF');
      const started = await pressOnProp(s);
      await advance(0.3);
      const during = await snap(s);
      await page.mouse.up();
      await page.keyboard.up('KeyF');
      await advance(0.3);
      const after = await snap(s);
      return { startedWhilePointing: started.now, during, after };
    }
  };
  for (const [name, run] of Object.entries(scenarios)) {
    if (only && !only.includes(name)) continue;
    const s = await prepare(browser, baseUrl, consoleErrors, `${label}-${name}`, { phone: name.startsWith('arEntry') });
    try {
      rows[name] = (await run(s)) ?? null;
    } catch (error) {
      fail(`${name}: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      await s.context.close();
    }
  }
  return { label, status: failures.length ? 'fail' : 'pass', failures, rows };
}
