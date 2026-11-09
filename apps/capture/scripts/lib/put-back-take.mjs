import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import { heavyGlb } from './heavy-glb.mjs';
import { loadTake, objectNodes } from './object-glb.mjs';
import { OBJECT_URL, openCapture, readState, saveDownload } from './object-take.mjs';
import { STEP_MS } from './summon-take.mjs';
import { advance, advanceUntil, readRow, setupFlatPage } from './tray-anytime-take.mjs';

// Put an object back and remove a tray item (docs/features/tray-remove.md),
// through capture's real flat-screen UI:
//   - desktop-put-back: Backspace, Delete and the dock's Put back send the
//     held object back; Backspace typed in Find does not; a slot dragged up
//     off the row leaves the tray, the rest close up with their thumbnails,
//     and a copy summoned from it stays; a short or sideways drag does not
//     remove. A take carrying an object puts it back mid-take, and a
//     mid-take summon is put back too: both presences end where capture put
//     them back.
//   - tray-budget: an item taken off the tray still counts toward the 16 MB
//     budget while a copy of it is in the scene, since the take exports it;
//     once that copy is put back, it no longer does. Judged from refusals,
//     which are decided before a parse (a second heavy thumbnail read-back
//     stalls on SwiftShader under the manual clock; see the brief).
//   - touch-put-back: at phone size with touch, Put back is a 44 apx dock
//     glyph shown only while holding; a touch drag up off a slot removes it,
//     and a tap still summons.

const TRAY = [OBJECT_URL, '/fixtures/objects/diagram.png', '/fixtures/objects/credited-bracket.glb'];
// The credited fixture takes its credit's title as its name.
const NAMES = ['bracket.glb', 'diagram.png', 'Test Bracket'];
const FRAME_SEC = STEP_MS / 1000;

const events = (state) => state.objects.items.filter((item) => item.layer === 'event');
const heldNow = (state) => events(state).find((item) => item.heldBy) ?? null;
const trayNames = (state) => state.objects.tray.items.map((item) => item.name);
const round = (value, digits = 3) => Number(value.toFixed(digits));

function shooter(page, artifactDir, label, shots) {
  return async (name) => {
    const file = path.join(artifactDir, `${label}-${name}.png`);
    await page.screenshot({ path: file });
    shots[name] = file;
  };
}

/** T + `slot`: summons into the right hand. */
async function summonKey(page, slot) {
  await page.keyboard.down('KeyT');
  await advance(page, 0.3);
  await page.keyboard.press(`Digit${slot}`);
  await advance(page, 0.2);
  await page.keyboard.up('KeyT');
  await advance(page, 0.1);
  return readState(page);
}

/** A pointer drag on a slot by (dx, dy) CSS px, in steps, then lifted. */
async function dragSlot(page, slot, dx, dy) {
  const box = await page.locator(`[data-testid="tray-slot-${slot}"]`).boundingBox();
  const from = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  for (let i = 1; i <= 8; i += 1) {
    await page.mouse.move(from.x + (dx * i) / 8, from.y + (dy * i) / 8);
    await page.waitForTimeout(10);
  }
  await page.mouse.up();
  await advance(page, 0.2);
}

/** The same drag with a finger, through CDP so it is real touch input. */
async function touchDragSlot(page, slot, dx, dy) {
  const box = await page.locator(`[data-testid="tray-slot-${slot}"]`).boundingBox();
  const from = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  const cdp = await page.context().newCDPSession(page);
  const at = (x, y) => [{ x, y, id: 1 }];
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: at(from.x, from.y) });
  for (let i = 1; i <= 8; i += 1) {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: at(from.x + (dx * i) / 8, from.y + (dy * i) / 8) });
    await page.waitForTimeout(16);
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await cdp.detach();
  await advance(page, 0.2);
}

export async function runDesktopPutBackTake({ browser, baseUrl, artifactDir, consoleErrors }) {
  const label = 'desktop-put-back';
  const failures = [];
  const fail = (message) => failures.push(message);
  await mkdir(artifactDir, { recursive: true });
  const { context, page } = await setupFlatPage(browser, { consoleErrors, label });
  const shots = {};
  const shot = shooter(page, artifactDir, label, shots);
  const putBackGlyph = page.locator('[data-testid="dock-put-back"]');
  try {
    await openCapture(page, baseUrl, { tray: TRAY });
    await advance(page, 1);
    let state = await advanceUntil(page, (s) => s.objects.tray.items.length === 3, 10);
    if (trayNames(state).join() !== NAMES.join()) fail(`the tray did not load three items (${trayNames(state)})`);
    await page.locator('canvas').first().focus();
    const glyphHidden = !(await putBackGlyph.isVisible());
    if (!glyphHidden) fail('Put back shows with nothing held');

    // Backspace, the dock glyph and Delete each put the held object back.
    const keys = {};
    for (const how of ['Backspace', 'glyph', 'Delete']) {
      state = await summonKey(page, 1);
      const held = heldNow(state);
      if (!held || held.heldBy !== 'right') {
        fail(`${how}: T + 1 did not summon into the right hand`);
        continue;
      }
      if (!(await putBackGlyph.isVisible())) fail(`${how}: Put back is not on the dock while holding`);
      if (how === 'glyph') {
        await shot('1-put-back-glyph');
        await putBackGlyph.click();
        await page.locator('canvas').first().focus();
      } else await page.keyboard.press(how);
      await advance(page, 0.1);
      state = await readState(page);
      const gone = !events(state).some((item) => item.id === held.id);
      const log = state.objects.tray.putBacks.at(-1);
      keys[how] = { gone, slot: log?.slot ?? null, hand: heldNow(state)?.heldBy ?? null, glyphAfter: await putBackGlyph.isVisible() };
      if (!gone || log?.objectId !== held.id || log.slot !== 1) fail(`${how} did not put the held object back into slot 1 (${JSON.stringify(keys[how])})`);
      if (keys[how].hand) fail(`${how}: the hand still holds something`);
      if (keys[how].glyphAfter) fail(`${how}: Put back still shows with nothing held`);
    }

    // Backspace typed in Find does not put back.
    state = await summonKey(page, 1);
    const kept = heldNow(state);
    await page.locator('[data-testid="dock-find"]').click();
    await page.locator('[data-testid="find-sheet"]').waitFor();
    const field = page.locator('[data-testid="find-sheet"]').getByLabel('Find an object');
    await field.click();
    await page.keyboard.type('ab');
    await page.keyboard.press('Backspace');
    await page.keyboard.press('Delete');
    await advance(page, 0.2);
    state = await readState(page);
    const typed = { stillHeld: Boolean(kept && heldNow(state)?.id === kept.id), value: await field.inputValue() };
    if (!typed.stillHeld) fail(`Backspace in Find put the held object back (${JSON.stringify(typed)})`);
    await page.keyboard.press('Escape');
    await page.locator('canvas').first().focus();
    await page.keyboard.press('KeyG');
    await advanceUntil(page, (s) => !heldNow(s), 4);
    await advance(page, 1.2);

    // A copy of slot 2 placed in the scene, then slot 2 lifted off the shelf.
    state = await summonKey(page, 2);
    const copy = heldNow(state);
    await page.keyboard.press('KeyG');
    await advanceUntil(page, (s) => !heldNow(s), 4);
    await advance(page, 1.2);
    await page.locator('[data-testid="dock-tray"]').click();
    await advance(page, 0.3);
    const rowBefore = await readRow(page);
    // Short and sideways drags snap back: nothing leaves the tray.
    await dragSlot(page, 2, 40, 0);
    state = await readState(page);
    const sideways = { items: state.objects.tray.items.length, held: Boolean(heldNow(state)) };
    if (sideways.items !== 3 || sideways.held) fail(`a sideways drag removed or summoned (${JSON.stringify(sideways)})`);
    // Up past the line but more sideways than up: a slide along the row, not a lift.
    await dragSlot(page, 2, 60, -35);
    state = await readState(page);
    const diagonal = { items: state.objects.tray.items.length, held: Boolean(heldNow(state)) };
    if (diagonal.items !== 3 || diagonal.held) fail(`a sideways drag that rose past the line removed or summoned (${JSON.stringify(diagonal)})`);
    await dragSlot(page, 2, 0, -25);
    state = await readState(page);
    const short = { items: state.objects.tray.items.length, held: Boolean(heldNow(state)) };
    if (short.items !== 3 || short.held) fail(`a short drag up removed or summoned (${JSON.stringify(short)})`);
    if (!state.objects.tray.open) await page.locator('[data-testid="dock-tray"]').click();
    await advance(page, 0.2);
    await shot('2-row-before-lift');
    await dragSlot(page, 2, 6, -70);
    state = await readState(page);
    const rowAfter = await readRow(page);
    const lift = {
      names: trayNames(state),
      slots: state.objects.tray.items.map((item) => item.slot),
      copyStays: Boolean(copy && events(state).some((item) => item.id === copy.id)),
      thumbnails: rowAfter?.slots.filter((slot) => slot.filled).map((slot) => slot.thumbnail?.rendered && slot.thumbnail.loaded) ?? [],
      labels: rowAfter?.slots.filter((slot) => slot.filled).map((slot) => slot.label) ?? []
    };
    if (lift.names.join() !== [NAMES[0], NAMES[2]].join() || lift.slots.join() !== '1,2') fail(`slot 2 did not leave the tray, closing up (${JSON.stringify(lift)})`);
    if (!lift.copyStays) fail('the copy of the removed item left the scene');
    if (lift.thumbnails.length !== 2 || lift.thumbnails.some((ok) => !ok)) fail(`a remaining slot lost its thumbnail (${JSON.stringify(lift.thumbnails)})`);
    // The old slot 3 is now slot 2: its own thumbnail moved with it.
    const movedThumb = rowBefore?.slots[2]?.thumbnail && rowAfter?.slots[1]?.thumbnail;
    const thumbUrls = await page.evaluate(() => [...document.querySelectorAll('[data-tray-slot] img')].map((img) => img.src.slice(-40)));
    await shot('3-row-after-lift');
    // A click (no drag) on the open row still summons: the new slot 2.
    await page.locator('[data-testid="tray-slot-2"]').click();
    await advance(page, 0.3);
    state = await readState(page);
    const clicked = heldNow(state)?.name ?? null;
    if (clicked !== NAMES[2]) fail(`a click on the new slot 2 summoned ${clicked}, expected ${NAMES[2]}`);
    await page.keyboard.press('Backspace');
    await advance(page, 0.1);

    // A take: an object held as it starts is put back after about a second, and a mid-take summon is put back too.
    state = await summonKey(page, 1);
    const carried = heldNow(state);
    await page.getByRole('button', { name: 'Start Recording' }).click();
    await page.getByRole('button', { name: 'Stop Recording' }).waitFor();
    await advance(page, 1);
    if (!(await putBackGlyph.isVisible())) fail('Put back is not on the dock during a take');
    await shot('4-put-back-mid-take');
    await page.keyboard.press('Backspace');
    await advance(page, 0.4);
    state = await summonKey(page, 2);
    const midTake = heldNow(state);
    const midTakeState = { held: midTake?.name ?? null, open: state.objects.tray.open, items: trayNames(state), summons: state.objects.tray.summons.length, events: events(state).map((item) => `${item.name}:${item.heldBy}`) };
    await advance(page, 0.6);
    await page.keyboard.press('Backspace');
    await advance(page, 0.8);
    state = await readState(page);
    const logs = state.objects.tray.putBacks;
    const summons = state.objects.tray.summons;
    const glb = await saveDownload(page, () => page.getByRole('button', { name: 'Stop Recording' }).click(), path.join(artifactDir, `${label}.glb`));
    const take = loadTake(await readFile(glb));
    const takeEnd = take.times.at(-1) ?? 0;
    const exported = { valid: take.validation?.ok ?? false, objectNodes: objectNodes(take).length, duration: round(takeEnd) };
    if (!exported.valid) fail(`HOLOIM_objects invalid: ${take.validation?.errors?.join('; ') ?? 'absent'}`);
    else {
      const entries = take.validation.value.objects;
      exported.entries = entries.map((entry) => ({ name: entry.name, origin: entry.origin, presence: entry.presence }));
      // The diagram copy stays for the whole take; the carried bracket ends early; the mid-take summon starts and ends inside it.
      const prepared = entries.filter((entry) => entry.origin === 'prepared');
      const summoned = entries.filter((entry) => entry.origin === 'summoned');
      const early = prepared.filter((entry) => entry.name === NAMES[0]).sort((a, b) => a.presence[0].end - b.presence[0].end)[0];
      if (!early || early.presence.length !== 1 || early.presence[0].start !== 0 || !(early.presence[0].end < takeEnd - 1)) fail(`the carried object's presence does not end at its put-back (${JSON.stringify(early?.presence)})`);
      const whole = prepared.find((entry) => entry.name === NAMES[1]);
      if (!whole || whole.presence.length !== 1 || Math.abs(whole.presence[0].end - takeEnd) > 1e-6) fail(`the removed item's copy is not in the whole take (${JSON.stringify(whole?.presence)})`);
      const mid = summoned.find((entry) => entry.name === NAMES[2]);
      const summonLog = summons.find((entry) => entry.objectId === midTake?.id);
      const backLog = logs.find((entry) => entry.objectId === midTake?.id);
      if (!mid || mid.presence.length !== 1 || !summonLog || !backLog) fail(`the mid-take summon and put-back are not in the take (${JSON.stringify({ presence: mid?.presence, summonLog, backLog })})`);
      else {
        // Capture's put-back is one step before the frame it is gone from; the GLB's span ends on the last frame it was there.
        const glbSec = mid.presence[0].end - mid.presence[0].start;
        const captureSec = backLog.timeSec - summonLog.timeSec;
        exported.midTake = { glbSec: round(glbSec, 4), captureSec: round(captureSec, 4) };
        if (Math.abs(glbSec - captureSec) > 2 * FRAME_SEC) fail(`the mid-take object is present ${round(glbSec)} s in the GLB, ${round(captureSec)} s in capture`);
      }
      const carriedBack = logs.find((entry) => entry.objectId === carried?.id);
      if (!carriedBack) fail('the carried object\'s put-back is not logged');
    }
    // The bracket kept through the Find test and the diagram copy, the carried bracket, and the mid-take summon.
    if (exported.objectNodes !== 4) fail(`${exported.objectNodes} RecordedObject nodes, expected 4`);
    return { label, status: failures.length ? 'fail' : 'pass', failures, glb, shots, keys, typed, sideways, diagonal, short, lift, movedThumb: Boolean(movedThumb), thumbUrls, clicked, midTakeState, export: exported };
  } finally {
    await context.close();
  }
}

export async function runTouchPutBackTake({ browser, baseUrl, artifactDir, consoleErrors }) {
  const label = 'touch-put-back';
  const failures = [];
  const fail = (message) => failures.push(message);
  await mkdir(artifactDir, { recursive: true });
  const { context, page } = await setupFlatPage(browser, { consoleErrors, label, touch: true });
  const shots = {};
  const shot = shooter(page, artifactDir, label, shots);
  const putBackGlyph = page.locator('[data-testid="dock-put-back"]');
  const trayGlyph = page.locator('[data-testid="dock-tray"]');
  try {
    await openCapture(page, baseUrl, { tray: TRAY });
    await advance(page, 1);
    let state = await advanceUntil(page, (s) => s.objects.tray.items.length === 3, 10);
    if (await putBackGlyph.isVisible()) fail('Put back shows with nothing held');

    // Tap Tray, tap slot 1: held. Put back is on the dock at a finger's size; a tap puts it back.
    await trayGlyph.tap();
    await advance(page, 0.4);
    await page.locator('[data-testid="tray-slot-1"]').tap();
    await advance(page, 0.3);
    state = await readState(page);
    const held = heldNow(state);
    if (!held) fail('tapping slot 1 did not summon');
    const box = await putBackGlyph.boundingBox();
    const glyph = { visible: await putBackGlyph.isVisible(), width: box?.width ?? 0, height: box?.height ?? 0, title: await putBackGlyph.getAttribute('title') };
    if (!glyph.visible || glyph.width < 44 || glyph.height < 44) fail(`Put back is not a 44 apx dock glyph while holding (${JSON.stringify(glyph)})`);
    if (/backspace/i.test(glyph.title ?? '')) fail(`the touch Put back shows keyboard help (${glyph.title})`);
    await shot('1-put-back-glyph');
    await putBackGlyph.tap();
    await advance(page, 0.2);
    state = await readState(page);
    const tapped = { gone: Boolean(held) && !events(state).some((item) => item.id === held.id), slot: state.objects.tray.putBacks.at(-1)?.slot ?? null, glyphAfter: await putBackGlyph.isVisible() };
    if (!tapped.gone || tapped.slot !== 1 || tapped.glyphAfter) fail(`a tap on Put back did not put the object back (${JSON.stringify(tapped)})`);

    // A finger drags slot 2 up off the row: it leaves; a tap on the new slot 2 still summons.
    await trayGlyph.tap();
    await advance(page, 0.4);
    await touchDragSlot(page, 2, 0, -80);
    state = await readState(page);
    const lifted = { names: trayNames(state), held: Boolean(heldNow(state)), look: state.camera?.lookYaw ?? null };
    if (lifted.names.join() !== [NAMES[0], NAMES[2]].join() || lifted.held) fail(`a touch drag up did not remove slot 2 alone (${JSON.stringify(lifted)})`);
    await shot('2-row-after-lift');
    if (!state.objects.tray.open) {
      await trayGlyph.tap();
      await advance(page, 0.4);
    }
    await page.locator('[data-testid="tray-slot-2"]').tap();
    await advance(page, 0.3);
    state = await readState(page);
    const tappedAfter = heldNow(state)?.name ?? null;
    if (tappedAfter !== NAMES[2]) fail(`a tap on the new slot 2 summoned ${tappedAfter}, expected ${NAMES[2]}`);
    return { label, status: failures.length ? 'fail' : 'pass', failures, shots, glyph, tapped, lifted, tappedAfter };
  } finally {
    await context.close();
  }
}

const HEAVY_URL = '/fixtures/objects/heavy-generated.glb';

export async function runTrayBudgetTake({ browser, baseUrl, artifactDir, consoleErrors }) {
  const label = 'tray-budget';
  const failures = [];
  const fail = (message) => failures.push(message);
  await mkdir(artifactDir, { recursive: true });
  const { context, page } = await setupFlatPage(browser, { consoleErrors, label });
  const heavy = heavyGlb();
  const refusals = [];
  page.on('console', (message) => {
    const size = /The tray would be ([\d.]+) MB/.exec(message.text());
    if (size) refusals.push(Number(size[1]));
  });
  // Started in the page and stepped on the manual clock until it settles: a load's thumbnail waits on frames.
  const load = async (count) => {
    await page.evaluate(({ u, n }) => {
      window.__budgetLoad = 'pending';
      window.__loadTrayUrls(Array(n).fill(u)).then((ok) => (window.__budgetLoad = ok));
    }, { u: HEAVY_URL, n: count });
    for (let i = 0; i < 600; i += 1) {
      const result = await page.evaluate(() => window.__budgetLoad);
      if (result !== 'pending') return result;
      await advance(page, 1 / 30);
    }
    return 'timeout';
  };
  try {
    await page.route(`**${HEAVY_URL}`, (route) => route.fulfill({ status: 200, contentType: 'model/gltf-binary', body: heavy }));
    await openCapture(page, baseUrl, {});
    await advance(page, 1);
    await page.locator('canvas').first().focus();
    const mb = heavy.byteLength / 1048576;
    // Refusals are decided from the bytes, before any parse: the sizes say what the budget counted.
    const first = await load(1);
    if (first !== true) fail(`a ${round(mb, 2)} MB item did not load (${first})`);
    // Summon it and keep it in the hand, then take slot 1 off the tray: its copy still exports.
    let state = await summonKey(page, 1);
    const copy = heldNow(state);
    await page.locator('[data-testid="dock-tray"]').click();
    await advance(page, 0.3);
    await dragSlot(page, 1, 0, -70);
    state = await readState(page);
    const removed = state.objects.tray.items.length === 0;
    if (!removed) fail(`slot 1 did not leave the tray (${state.objects.tray.items.length} items)`);
    // Two more would be three copies' bytes, past 16 MB: refused, counting the copy in the hand.
    const whileCopy = await load(2);
    const countedWithCopy = refusals.at(-1) ?? null;
    if (whileCopy !== false || countedWithCopy === null || Math.abs(countedWithCopy - 3 * mb) > 0.1) fail(`two more loads with the copy in the scene: ${whileCopy}, counted ${countedWithCopy} MB, expected ${round(3 * mb, 1)}`);
    // The copy put back: its bytes no longer count.
    await page.locator('canvas').first().focus();
    await page.keyboard.press('Backspace');
    await advance(page, 0.2);
    const left = Boolean(copy) && !events(await readState(page)).some((item) => item.id === copy.id);
    if (!left) fail('Backspace did not put the copy back');
    const afterPutBack = await load(3);
    const countedAfter = refusals.at(-1) ?? null;
    if (afterPutBack !== false || countedAfter === null || Math.abs(countedAfter - 3 * mb) > 0.1) fail(`three loads after the put-back: ${afterPutBack}, counted ${countedAfter} MB, expected ${round(3 * mb, 1)} (the copy's bytes freed)`);
    return { label, status: failures.length ? 'fail' : 'pass', failures, mb: round(mb, 2), first, removed, whileCopy, countedWithCopy, left, afterPutBack, countedAfter };
  } finally {
    await context.close();
  }
}
