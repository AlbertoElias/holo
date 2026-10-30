import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import * as THREE from 'three';

import { loadTake } from './object-glb.mjs';
import { clickButton, openCapture, readState, saveDownload, setupPage } from './object-take.mjs';
import { enterIwer, reach, shooter, stepper, summonedItems, TRAY_URLS } from './summon-take.mjs';

// Put an object back, and remove a tray item, in a headset (docs/features/archive/tray-remove.md):
// IWER controllers and tracked hands through capture's real input paths.
//   - Let go outside the open tray's zone: a plain drop. Let go with the dominant palm in the
//     zone: the object leaves the registry, the take log gets a put-back for its slot, and the
//     VR chrome's slot signifier reads `returning` while it is over the arc.
//   - With an empty hand and two items, each miniature has a Close ring: a controller's ray and
//     trigger, or a hand's fingertip poke, removes slot 2; a pinch ray at the ring does not.
//   - A put-back mid-take: the exported object is `prepared`, present once from frame 0, and its
//     presence ends at the put-back (within a frame).

const round = (value, digits = 4) => Number(value.toFixed(digits));
const smooth = (t) => t * t * (3 - 2 * t);
const FRAME_SEC = 1 / 60;
const AIM_FROM = [0.15, 1.35, -0.15];
const FAR = [0.6, 1.0, 0.0];
const REST = { left: [-0.3, 0.9, -0.1], right: [0.3, 0.9, -0.1] };
const TRAY_HAND = [-0.12, 1.1, -0.32];

const vrChrome = (page) => page.evaluate(() => window.__sampleChrome().vr);
const itemIds = (state) => state.objects.items.map((item) => item.id);

/** Puts a controller (or hand) at `from` (world) with its −Z toward a world point, as ci-capture-ui's `aim`. */
async function aim(page, kind, side, from, target) {
  await page.evaluate(({ kind, side, from, target }) => {
    const device = window.IWER_DEVICE;
    const head = window.__sampleChrome().vr.head;
    const offset = [head[0] - device.position.x, head[1] - device.position.y, head[2] - device.position.z];
    const input = kind === 'hand' ? device.hands[side] : device.controllers[side];
    input.position.set(from[0] - offset[0], from[1] - offset[1], from[2] - offset[2]);
    const d = [target[0] - from[0], target[1] - from[1], target[2] - from[2]];
    const length = Math.hypot(...d);
    const [x, y, z] = d.map((v) => v / length);
    const w = 1 - z;
    if (w < 1e-6) input.quaternion.set(0, 1, 0, 0);
    else {
      const half = Math.hypot(y, -x, w);
      input.quaternion.set(y / half, -x / half, 0, w / half);
    }
  }, { kind, side, from, target });
}

/** The take's one prepared object: present from frame 0, gone before the end, ending at the put-back. */
function checkPutBackExport(buffer, { putBackSec, takeSec, fail }) {
  const take = loadTake(buffer);
  const report = { valid: take.validation?.ok ?? false };
  if (!take.validation?.ok) {
    fail(`export: the GLB's objects extension is invalid (${JSON.stringify(take.validation)})`);
    return report;
  }
  const entries = take.validation.value.objects;
  const end = take.times[take.times.length - 1];
  report.duration = round(end);
  report.objects = entries.map((entry) => ({ name: entry.name, origin: entry.origin, presence: entry.presence }));
  // The tray-dropped object stays the whole take; only the carried one goes back, at the put-back.
  const early = entries.filter((entry) => entry.presence.length === 1 && entry.presence[0].end < end - 1e-3);
  if (entries.some((entry) => entry.origin !== 'prepared')) fail(`export: every object was in the scene when the take began, expected prepared (${JSON.stringify(report.objects)})`);
  if (entries.some((entry) => entry.presence.length !== 1 || entry.presence[0].start !== 0)) fail(`export: expected one presence span from 0 per object (${JSON.stringify(report.objects)})`);
  if (early.length !== 1) fail(`export: expected exactly one presence ending before the take's end (${JSON.stringify(report.objects)})`);
  else {
    const spanEnd = early[0].presence[0].end;
    report.presenceEndSec = round(spanEnd);
    report.expectedSec = round(putBackSec);
    report.takeSec = round(takeSec);
    if (Math.abs(spanEnd - putBackSec) > FRAME_SEC + 1e-3) fail(`export: presence ends at ${round(spanEnd)} s, the put-back was at ${round(putBackSec)} s`);
  }
  return report;
}

/**
 * Shared script: `driver` supplies the input (controllers or hands). Phases: drop outside the zone,
 * put back in the zone, a put-back inside a take, then the Close ring of slot 2.
 */
async function runPutBack({ browser, baseUrl, artifactDir, consoleErrors, label, mode, driver }) {
  const failures = [];
  const fail = (message) => failures.push(message);
  await mkdir(artifactDir, { recursive: true });
  const { context, page } = await setupPage(browser, { iwer: true, consoleErrors, label });
  try {
    if (mode === 'controller') await openCapture(page, baseUrl, { tray: TRAY_URLS });
    else {
      await openCapture(page, baseUrl, {});
      await page.evaluate((urls) => window.__loadTrayUrls(urls), TRAY_URLS);
    }
    await enterIwer(page, mode);
    const clock = stepper(page);
    const { step } = clock;
    const shot = shooter(page, step, artifactDir, label);
    const input = driver(page, step);
    await input.move('left', REST.left);
    await input.move('right', REST.right);
    await step(20);
    let state = await readState(page);
    if (state.objects.tray.items.length !== 2) {
      fail(`the tray did not load two items (${state.objects.tray.items.length})`);
      return { label, status: 'fail', failures };
    }
    const rigYaw = state.thumbstick.rigYaw;
    const report = {};
    const shots = {};
    const toMiniature = (slot) => reach(page, step, { move: (p) => input.move('right', p), start: input.at('right'), target: (s) => s.objects.tray.items[slot].position, rigYaw });
    const summonSlot1 = async () => {
      const before = summonedItems(await readState(page)).length;
      const reached = await toMiniature(0);
      if (reached.error > 0.06) fail(`the right hand never reached miniature 1 (${round(reached.error, 3)} m)`);
      await input.grip(true);
      await step(2);
      const after = summonedItems(await readState(page));
      const held = after.find((item) => item.heldBy === 'right');
      if (after.length !== before + 1 || !held) fail(`gripping miniature 1 did not summon into the right hand (${JSON.stringify(after.map((o) => [o.name, o.heldBy]))})`);
      return held ?? null;
    };

    // The tray opens (Y held, or palm up after the dwell).
    await input.openTray();
    state = await readState(page);
    if (!state.objects.tray.open) fail('the tray did not open');

    // (a) Let go outside the arc's zone: a plain drop.
    const first = await summonSlot1();
    if (first) {
      const from = input.at('right');
      for (let i = 1; i <= 40; i += 1) {
        const t = smooth(i / 40);
        await input.move('right', from.map((v, j) => v + (FAR[j] - v) * t));
        await step(1);
      }
      const away = await vrChrome(page);
      if (away.tray?.slots.some((slot) => slot.returning)) fail('a slot reads returning while the held object is far from the arc');
      await input.grip(false);
      await step(3);
      state = await readState(page);
      const dropped = state.objects.items.find((item) => item.id === first.id);
      report.drop = { stillInScene: Boolean(dropped), heldBy: dropped?.heldBy ?? null, putBacks: state.objects.tray.putBacks.length };
      if (!dropped || dropped.heldBy || state.objects.tray.putBacks.length) fail(`letting go outside the zone was not a plain drop (${JSON.stringify(report.drop)})`);
      await step(60);
    }

    // (b) Summon again, let go with the palm in the zone: put back.
    const second = await summonSlot1();
    if (second) {
      await step(4);
      const over = await vrChrome(page);
      report.returningProbe = over.tray?.slots.map((slot) => ({ slot: slot.slot, returning: slot.returning, glyph: slot.glyph }));
      if (!over.tray?.slots.find((slot) => slot.slot === 1)?.returning) fail(`slot 1's signifier is not returning while held over the arc (${JSON.stringify(over.tray)})`);
      shots.returning = await shot('1-returning');
      const before = itemIds(await readState(page));
      await input.grip(false);
      await step(2);
      state = await readState(page);
      const log = state.objects.tray.putBacks[0];
      report.putBack = { objectGone: !itemIds(state).includes(second.id), itemsBefore: before.length, itemsAfter: state.objects.items.length, log };
      if (itemIds(state).includes(second.id)) fail('letting go in the zone did not remove the object from the scene');
      if (state.objects.tray.putBacks.length !== 1 || log?.slot !== 1 || log?.objectId !== second.id) fail(`the put-back was not logged for slot 1 (${JSON.stringify(state.objects.tray.putBacks)})`);
      if (state.objects.items.length !== before.length - 1) fail('a put-back changed more than one object');
      await step(70);
    }
    await input.move('right', REST.right);
    await step(10);

    // (d) A put-back mid-take: the object is held when the take starts and goes back at about 1 s.
    const carried = await summonSlot1();
    await clickButton(page, 'Start Recording');
    await page.getByRole('button', { name: 'Stop Recording', exact: true }).waitFor({ timeout: 10_000 });
    const startedAt = clock.steps;
    await step(60);
    const beforeSteps = clock.steps;
    await input.grip(false);
    await step(1);
    state = await readState(page);
    const log = state.objects.tray.putBacks.at(-1);
    const midTake = { objectGone: carried ? !itemIds(state).includes(carried.id) : null, putBackStepsIntoTake: clock.steps - startedAt, log };
    report.midTake = midTake;
    if (!carried || itemIds(state).includes(carried.id)) fail(`the mid-take put-back did not remove the object (${JSON.stringify(midTake)})`);
    // The put-back lands on the step after the release key, so the take's presence ends at its time.
    await step(90);
    const glb = path.join(artifactDir, `${label}-mid-take.glb`);
    await saveDownload(page, async () => {
      await clickButton(page, 'Stop Recording');
      for (let i = 0; i < 20; i += 1) await step(1);
    }, glb);
    report.export = checkPutBackExport(await readFile(glb), { putBackSec: (beforeSteps - startedAt + 1) * FRAME_SEC, takeSec: (clock.steps - startedAt) * FRAME_SEC, fail });
    report.export.captureLogSec = log ? round(log.timeSec) : null;

    // (c) Empty hand, two items: slot 2 has a Close ring; a ray (controllers) or a poke (hands) removes it.
    await input.move('right', REST.right);
    await step(20);
    state = await readState(page);
    if (!state.objects.tray.open) await input.openTray();
    let probe = await vrChrome(page);
    const closeSlots = probe.tray?.slots.filter((slot) => slot.close).map((slot) => slot.slot) ?? [];
    report.closeRings = closeSlots;
    if (!closeSlots.includes(2)) fail(`slot 2 shows no Close ring with an empty hand (${JSON.stringify(probe.tray)})`);
    const ringAt = await page.evaluate(() => window.__trayClosePosition(2));
    if (!ringAt) fail('__trayClosePosition(2) is null');
    shots.close = await shot('2-close-rings');
    if (ringAt) {
      const negative = await input.negative(ringAt);
      report.negative = negative;
      state = await readState(page);
      if (state.objects.tray.items.length !== 2) fail(`${negative.how} removed an item (${state.objects.tray.items.length} left)`);
      const names = state.objects.tray.items.map((item) => item.name);
      report.removal = await input.remove(ringAt);
      await step(6);
      state = await readState(page);
      report.removal.itemsAfter = state.objects.tray.items.map((item) => `${item.slot}:${item.name}`);
      if (state.objects.tray.items.length !== 1) fail(`${report.removal.how} did not remove slot 2 (${JSON.stringify(report.removal.itemsAfter)} of ${JSON.stringify(names)})`);
      else if (state.objects.tray.items[0].slot !== 1) fail('the remaining item was not renumbered to slot 1');
      probe = await vrChrome(page);
      report.afterProbe = probe.tray?.slots.map((slot) => ({ slot: slot.slot, filled: slot.filled, close: slot.close }));
    }
    return { label, status: failures.length ? 'fail' : 'pass', failures, glb, shots, ...report };
  } finally {
    await context.close();
  }
}

/** IWER controllers: Y opens the tray, squeeze summons, a ray and trigger pulls the Close ring. */
export async function runIwerPutBackTake({ browser, baseUrl, artifactDir, consoleErrors }) {
  const positions = { left: REST.left, right: REST.right };
  return runPutBack({
    browser, baseUrl, artifactDir, consoleErrors, label: 'iwer-put-back', mode: 'controller',
    driver: (page, step) => {
      const button = (side, id, value) => page.evaluate(({ s, i, v }) => window.IWER_DEVICE.controllers[s].updateButtonValue(i, v), { s: side, i: id, v: value });
      const move = async (side, position) => {
        positions[side] = position;
        await page.evaluate(({ s, p }) => {
          const c = window.IWER_DEVICE.controllers[s];
          c.position.set(...p);
          c.quaternion.set(0, 0, 0, 1);
        }, { s: side, p: position });
      };
      const trigger = async () => {
        await button('right', 'trigger', 1);
        await step(2);
        await button('right', 'trigger', 0);
        await step(2);
      };
      const rayAt = async (target) => {
        let hit = null;
        for (let attempt = 0; attempt < 3; attempt += 1) {
          await aim(page, 'controller', 'right', AIM_FROM, target);
          await step(3);
          hit = (await vrChrome(page)).rays.find((ray) => ray.side === 'right')?.hit ?? null;
        }
        return hit;
      };
      return {
        at: (side) => positions[side],
        move,
        grip: async (down) => {
          await button('right', 'squeeze', down ? 1 : 0);
          await step(down ? 1 : 2);
        },
        openTray: async () => {
          await move('left', TRAY_HAND);
          await step(20);
          await button('left', 'y-button', 1);
          await step(3);
        },
        negative: async () => ({ how: 'n/a (controllers have no pinch ray)' }),
        remove: async (target) => {
          const ray = await rayAt(target);
          await trigger();
          return { how: 'the right ray and trigger on the Close ring', rayHit: ray };
        }
      };
    }
  });
}

/** IWER tracked hands: palm up opens the tray, a pinch summons, a fingertip poke pulls the Close ring. */
export async function runIwerHandsPutBackTake({ browser, baseUrl, artifactDir, consoleErrors }) {
  const positions = { left: REST.left, right: REST.right };
  const up = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI).toArray();
  const down = [0, 0, 0, 1];
  return runPutBack({
    browser, baseUrl, artifactDir, consoleErrors, label: 'iwer-hands-put-back', mode: 'hand',
    driver: (page, step) => {
      const move = async (side, position, quaternion = down) => {
        positions[side] = position;
        await page.evaluate(({ s, p, q }) => {
          const h = window.IWER_DEVICE.hands[s];
          h.position.set(...p);
          h.quaternion.set(...q);
        }, { s: side, p: position, q: quaternion });
      };
      const pinch = (value) => page.evaluate((v) => window.IWER_DEVICE.hands.right.updatePinchValue(v), value);
      let pinched = 0;
      const ramp = async (to) => {
        const steps = 6;
        const from = pinched;
        for (let i = 1; i <= steps; i += 1) {
          pinched = from + (to - from) * (i / steps);
          await pinch(pinched);
          await step(1);
        }
      };
      return {
        at: (side) => positions[side],
        move: (side, position) => move(side, position, side === 'left' && positions.left === TRAY_HAND ? up : down),
        grip: async (downNow) => {
          await ramp(downNow ? 1 : 0);
          await step(downNow ? 1 : 2);
        },
        openTray: async () => {
          await move('left', TRAY_HAND, up);
          await step(26);
        },
        negative: async (target) => {
          // A pinch while the ray rests on the ring (hands pinch to select) must not remove it.
          const from = [0.15, 1.35, -0.15];
          await aim(page, 'hand', 'right', from, target);
          await step(3);
          const ray = (await vrChrome(page)).rays.find((entry) => entry.side === 'right')?.hit ?? null;
          const before = summonedItems(await readState(page)).length;
          await ramp(1);
          await step(2);
          const summoned = summonedItems(await readState(page)).length - before;
          await ramp(0);
          await step(4);
          await move('right', REST.right);
          await step(6);
          return { how: 'a pinch ray at the Close ring', rayHit: ray, summonedByPinch: summoned };
        },
        remove: async (target) => {
          const poke = { how: 'a fingertip poke into the Close ring', passes: [] };
          for (const height of [0.1, 0.07, 0.05, 0.03, 0.02, 0.01, 0.005, 0, -0.005, -0.01, -0.02, -0.03]) {
            for (let pass = 0; pass < 2; pass += 1) {
              const chrome = await vrChrome(page);
              if (!chrome.poke.tip) break;
              const eye = new THREE.Vector3(...chrome.head);
              const centre = new THREE.Vector3(...target);
              const normal = eye.sub(centre).normalize();
              const goal = centre.addScaledVector(normal, height);
              const delta = goal.toArray().map((value, i) => value - chrome.poke.tip[i]);
              const h = positions.right;
              await page.evaluate(({ d }) => {
                const hand = window.IWER_DEVICE.hands.right;
                hand.position.set(hand.position.x + d[0], hand.position.y + d[1], hand.position.z + d[2]);
              }, { d: delta });
              positions.right = h.map((v, i) => v + delta[i]);
              await step(1);
            }
            const after = await vrChrome(page);
            const left = (await readState(page)).objects.tray.items.length;
            poke.passes.push({ height, tipToRingM: after.poke.tip ? round(Math.hypot(...after.poke.tip.map((v, i) => v - target[i])), 3) : null, items: left });
            if (left < 2) break;
          }
          return poke;
        }
      };
    }
  });
}
