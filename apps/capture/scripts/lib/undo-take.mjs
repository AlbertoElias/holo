import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import * as THREE from 'three';

import { HALO_PINCH_STAGES, haloDrag, installMiddlePinchPose } from './iwer-halo.ts';
import { loadTake, objectNodes, rigidPose, worldAt } from './object-glb.mjs';
import { clickButton, OBJECT_URL, openCapture, PROOF_VIDEO_DIR, proofPace, readState, saveDownload, setupPage } from './object-take.mjs';
import { enterIwer, reach, STEP_MS, stepper, summonedItems, TRAY_URLS } from './summon-take.mjs';
import { advance, setupFlatPage } from './tray-anytime-take.mjs';

// Undo and redo for every authoring action (docs/features/undo-redo.md),
// through the Halo's W ("Undo") and E ("Redo") buttons on flat screens, and
// the same Halo committed with a headset's controllers or hands:
//   - undo-desktop: before a take W/E reach summon, place, resize and tray
//     removal, say "Nothing to undo"/"Nothing to redo" at the ends, and a new
//     action clears redo. During a take W right after Record has nothing to
//     undo; a put-back undone returns the object; interleaved summon, size and
//     place undo in reverse. The exported GLB shows the put-back object's
//     presence in two spans and the undone place and resize as jumps at the
//     undo frame with earlier frames unchanged.
//   - undo-touch: the same W and E with a finger on a phone-size screen.
//   - undo-controllers, undo-hands: W and E committed through the headset's
//     Halo (thumbstick, thumb-middle pinch) on a summon and a put back.
// Reports carry the history log and counts.

const TRAY = [OBJECT_URL, '/fixtures/objects/diagram.png', '/fixtures/objects/credited-bracket.glb'];
const NAMES = ['bracket.glb', 'diagram.png', 'Test Bracket'];
const FRAME_SEC = STEP_MS / 1000;
const round = (value, digits = 3) => Number(value.toFixed(digits));

const events = (state) => state.objects.items.filter((item) => item.layer === 'event');
const heldNow = (state) => events(state).find((item) => item.heldBy) ?? null;
const byId = (state, id) => events(state).find((item) => item.id === id) ?? null;
const trayNames = (state) => state.objects.tray.items.map((item) => item.name);
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const history = (page) => page.evaluate(() => window.__sampleHolds().history);
const statusLine = (page) => page.evaluate(() => document.querySelector('[data-capture-status-line]')?.textContent ?? null);

/** A page-time clock: `t` is the simulation time (tray logs' timeSec), kept by counting the frames stepped since a sync. */
function kit(page) {
  const clock = { t: null };
  const adv = async (seconds) => {
    await advance(page, seconds);
    if (clock.t !== null) clock.t += Math.round(seconds * 60) / 60;
  };
  const read = () => readState(page);
  const settle = async (id, maxSec = 8) => {
    let state = await read();
    for (let i = 0; i < maxSec * 10; i += 1) {
      const item = byId(state, id);
      if (!item || (!item.heldBy && item.body === 'asleep')) break;
      await adv(0.1);
      state = await read();
    }
    return state;
  };
  /** T + `slot`: summons into the right hand; the clock syncs to the summon's own time. */
  const summon = async (slot) => {
    await page.keyboard.down('KeyT');
    await adv(0.3);
    await page.keyboard.press(`Digit${slot}`);
    await advance(page, 1 / 60);
    const state = await read();
    const log = state.objects.tray.summons.at(-1);
    clock.t = log.timeSec + FRAME_SEC;
    await adv(0.2);
    await page.keyboard.up('KeyT');
    await adv(0.1);
    return { state: await read(), log };
  };
  /** The Halo's W or E, as a flat-screen user clicks them; returns the status line and the history's last step. */
  const halo = async (name, { touch = false } = {}) => {
    // The open tray row covers the Halo's ring: close it first.
    if ((await read()).objects.tray.open) {
      if (touch) await page.locator('[data-testid="dock-tray"]').tap();
      else await page.locator('[data-testid="dock-tray"]').click();
      await adv(0.3);
    }
    const glyph = page.getByRole('img', { name: /^Halo/ });
    const pick = () => page.getByRole('button', { name, exact: true });
    if (touch) {
      await glyph.tap();
      await pick().tap();
    } else {
      await glyph.click();
      await pick().click();
    }
    const at = clock.t;
    await adv(0.1);
    const h = await history(page);
    dbg(name, '->', await statusLine(page), JSON.stringify(h.words), JSON.stringify(h.undoneWords));
    const step = h.log.filter((entry) => entry.op === 'undo' || entry.op === 'redo').at(-1) ?? null;
    return { text: await statusLine(page), step, at, history: h };
  };
  /** G, until the object is held (the nearest one in reach is picked up). */
  const grab = async (id) => {
    let state = await read();
    // The author reaches down for it: wait for the hold; press again only when nothing started.
    for (let attempt = 0; attempt < 3 && byId(state, id)?.heldBy == null; attempt += 1) {
      await page.keyboard.press('KeyG');
      for (let i = 0; i < 60 && byId(state, id)?.heldBy == null; i += 1) {
        await adv(0.05);
        state = await read();
        if (i === 10 && state.objects.reach.phase === 'idle') break;
      }
    }
    if (byId(state, id)?.heldBy == null) throw new Error(`G did not pick ${id} up (${JSON.stringify(events(state).map((i) => [i.id, i.heldBy, i.position]))} avatar ${JSON.stringify(state.avatar)} reach ${JSON.stringify(state.objects.reach)} hands ${JSON.stringify(state.objects.hands)})`);
    return state;
  };
  /** G lets go of a held object (a held-still release sets it down), then waits for it to rest. */
  const release = async (id) => {
    if ((await read()) && byId(await read(), id)?.heldBy != null) {
      await page.keyboard.press('KeyG');
      await adv(0.1);
    }
    const state = await settle(id);
    dbg('release', id, JSON.stringify(events(state).map((i) => [i.id, i.heldBy, i.body, i.position.map((v) => round(v, 2)), i.size])));
    return state;
  };
  const focusCanvas = () => page.locator('canvas').first().focus();
  return { clock, adv, read, settle, summon, halo, grab, release, focusCanvas };
}

/** Drags a tray slot up off the open row with the mouse. */
async function liftSlot(page, adv, slot) {
  const box = await page.locator(`[data-testid="tray-slot-${slot}"]`).boundingBox();
  const from = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  for (let i = 1; i <= 8; i += 1) {
    await page.mouse.move(from.x + (6 * i) / 8, from.y - (70 * i) / 8);
    await page.waitForTimeout(10);
  }
  await page.mouse.up();
  await adv(0.2);
}

/** F held with the view on the world ahead: a held mark (the same input held-mark-takes.ts uses), kept on release. */
async function holdMark(page, adv, pitch = -0.35) {
  await page.evaluate((arg) => window.__setMockInput(arg), { lookYaw: 0, aimPitch: pitch });
  await adv(0.4);
  await page.keyboard.down('KeyF');
  await adv(0.3);
  await proofPace(page, 600);
  await adv(1.0);
  await page.keyboard.up('KeyF');
  await adv(0.6);
  await page.evaluate((arg) => window.__setMockInput(arg), { lookYaw: 0, aimPitch: 0 });
  await adv(0.2);
}

const dbg = (...args) => (process.env.UNDO_DEBUG ? console.log('[undo]', ...args) : undefined);
const wordsOf = (h) => h.words.join(',');

export async function runDesktopUndoTake({ browser, baseUrl, artifactDir, consoleErrors }) {
  const label = 'undo-desktop';
  const failures = [];
  const fail = (message) => failures.push(message);
  await mkdir(artifactDir, { recursive: true });
  const { context, page } = await setupFlatPage(browser, { consoleErrors, label });
  const k = kit(page);
  const { adv, read, halo, release } = k;
  const report = { steps: {} };
  const expectText = (step, got, want) => {
    if (got.text !== want) fail(`${step}: the status line says ${JSON.stringify(got.text)}, expected ${JSON.stringify(want)}`);
    return got;
  };
  try {
    await openCapture(page, baseUrl, { tray: TRAY });
    // The dev tooling's Enter XR button (a shadow-DOM overlay) sits over the status line's centre; a proof video hides it so each status reads whole.
    if (PROOF_VIDEO_DIR) {
      await page.evaluate(() => {
        for (const host of document.querySelectorAll('*')) if (host.shadowRoot?.textContent?.includes('Enter XR')) host.style.display = 'none';
      });
    }
    await adv(1);
    let state = await read();
    for (let i = 0; i < 600 && state.objects.tray.items.length !== 3; i += 1) {
      await adv(1 / 60);
      state = await read();
    }
    if (trayNames(state).join() !== NAMES.join()) fail(`the tray did not load three items (${trayNames(state)})`);
    await k.focusCanvas();

    // --- Before a take ---
    const start = await history(page);
    report.steps.start = start.words;
    expectText('empty history', await halo('Undo'), 'Nothing to undo');
    if (start.done !== 0) fail(`the history is not empty after loading (${wordsOf(start)}), so "Nothing to undo" above is not from an empty stack`);
    expectText('empty redo', await halo('Redo'), 'Nothing to redo');

    // Summon, W (back on the tray), E (restored).
    const { state: afterSummon } = await k.summon(1);
    const obj = heldNow(afterSummon);
    if (!obj) fail('T + 1 did not summon into the hand');
    const id = obj?.id;
    expectText('undo summon', await halo('Undo'), 'Summon undone');
    state = await read();
    const gone = !byId(state, id);
    if (!gone) fail('W did not take the summoned object off the scene');
    const backLog = state.objects.tray.putBacks.at(-1);
    if (backLog?.objectId !== id) fail(`the undone summon is not in the put-back log (${JSON.stringify(backLog)})`);
    expectText('redo summon', await halo('Redo'), 'Summon restored');
    state = await read();
    if (!byId(state, id)) fail('E did not bring the summoned object back');
    if (!state.objects.tray.returns.some((entry) => entry.objectId === id)) fail('the redone summon is not in the returns log');
    await k.focusCanvas();
    report.steps.afterSummon = (await history(page)).words;

    // Size: hold it, grow it, let go; W returns the size, E applies it again.
    state = await k.settle(id);
    state = await read();
    const size0 = byId(state, id).size;
    state = await k.grab(id);
    await page.keyboard.down('Equal');
    await adv(0.8);
    await page.keyboard.up('Equal');
    await adv(0.1);
    state = await read();
    const size1 = byId(state, id)?.size;
    if (!(size1 > size0)) fail(`= did not grow the held object (${size0} -> ${size1})`);
    await k.release(id);
    const resized = await history(page);
    report.steps.afterResize = resized.words;
    // The grab-to-release that grew it is a Place too (it moved nothing).
    if (resized.words.slice(-2).join() !== 'Size,Place') fail(`the resize did not push Size then Place (${wordsOf(resized)})`);
    state = await k.settle(id);
    const p0 = byId(state, id).position;

    // Place: step back so it lies ahead, grab, walk with it, throw, settle. W returns the pre-grab pose.
    await page.keyboard.down('KeyS');
    await adv(0.2);
    await page.keyboard.up('KeyS');
    await adv(0.5);
    state = await k.grab(id);
    await page.keyboard.down('KeyW');
    await adv(0.8);
    await page.keyboard.up('KeyW');
    await page.keyboard.press('KeyG');
    await adv(0.1);
    state = await k.settle(id);
    const p1 = byId(state, id).position;
    const placed = await history(page);
    report.steps.afterPlace = placed.words;
    if (placed.words.at(-1) !== 'Place') fail(`the grab-to-release did not push a Place entry (${wordsOf(placed)})`);
    if (dist(p0, p1) < 0.1) fail(`the placed object barely moved (${dist(p0, p1).toFixed(3)} m)`);
    expectText('undo place', await halo('Undo'), 'Place undone');
    state = await read();
    const back0 = dist(byId(state, id)?.position ?? [9, 9, 9], p0);
    report.steps.place = { moved: round(dist(p0, p1)), backToStart: round(back0) };
    if (back0 > 0.05) fail(`W did not return the object to its pre-grab pose (${back0.toFixed(3)} m off)`);
    expectText('redo place', await halo('Redo'), 'Place restored');
    state = await k.settle(id);
    const back1 = dist(byId(state, id)?.position ?? [9, 9, 9], p1);
    if (back1 > 0.1) fail(`E did not put the object back where it came to rest (${back1.toFixed(3)} m off)`);
    // Undo the place, the resize's own hold, then the size.
    expectText('undo place again', await halo('Undo'), 'Place undone');
    expectText('undo the resize hold', await halo('Undo'), 'Place undone');
    expectText('undo size', await halo('Undo'), 'Size undone');
    state = await read();
    const sizeBack = byId(state, id)?.size;
    report.steps.size = { before: size0, grown: size1, afterUndo: sizeBack };
    if (Math.abs(sizeBack - size0) > 1e-3) fail(`W did not return the size (${size0} -> ${size1} -> ${sizeBack})`);
    expectText('redo size', await halo('Redo'), 'Size restored');
    state = await read();
    if (Math.abs(byId(state, id).size - size1) > 1e-3) fail(`E did not apply the size again (${byId(state, id).size}, expected ${size1})`);
    expectText('redo the resize hold', await halo('Redo'), 'Place restored');
    expectText('redo place again', await halo('Redo'), 'Place restored');

    // Remove a tray slot, W restores it, E removes it again, W restores it.
    await page.locator('[data-testid="dock-tray"]').click();
    await adv(0.3);
    await liftSlot(page, adv, 2);
    state = await read();
    if (trayNames(state).length !== 2) fail(`slot 2 did not leave the tray (${trayNames(state)})`);
    const removed = (await history(page)).words.at(-1);
    if (removed !== 'Tray removal') fail(`removing a slot pushed ${removed}, expected Tray removal`);
    expectText('undo tray removal', await halo('Undo'), 'Tray removal undone');
    state = await read();
    if (trayNames(state).join() !== NAMES.join()) fail(`W did not restore the slot (${trayNames(state)})`);
    expectText('redo tray removal', await halo('Redo'), 'Tray removal restored');
    expectText('undo tray removal again', await halo('Undo'), 'Tray removal undone');
    state = await read();
    if (trayNames(state).length !== 3) fail(`the second W did not restore the slot (${trayNames(state)})`);

    // A new action after an undo clears redo.
    await halo('Undo');
    const mid = await history(page);
    if (mid.undone < 1) fail('nothing undone to clear');
    await k.focusCanvas();
    await k.summon(1);
    report.steps.afterNewAction = await history(page);
    expectText('redo after a new action', await halo('Redo'), 'Nothing to redo');
    await k.focusCanvas();
    await page.keyboard.press('Backspace');
    await adv(0.3);

    // --- During a take ---
    // A summon still held when Record is pressed: its release is a Place, not a put-back.
    const edge = await k.summon(2);
    const edgeId = heldNow(edge.state)?.id;
    if (!edgeId) fail('T + 2 before Record did not summon into the hand');
    await page.getByRole('button', { name: 'Start Recording' }).click();
    await page.getByRole('button', { name: 'Stop Recording' }).waitFor();
    await adv(0.1);
    state = await read();
    const edgeAtRecord = byId(state, edgeId)?.position ?? [9, 9, 9];
    await adv(0.4);
    const cleared = await history(page);
    if (cleared.done !== 0 || cleared.undone !== 0) fail(`Record did not clear the history (${wordsOf(cleared)})`);
    expectText('undo right after Record', await halo('Undo'), 'Nothing to undo');
    await k.focusCanvas();
    // Move the still-held object, let go: one Place; W returns it to its pose at Record, E restores.
    state = await read();
    if (byId(state, edgeId)?.heldBy == null) fail('the summon was not still held across Record');
    await page.keyboard.down('KeyW');
    await adv(0.6);
    await page.keyboard.up('KeyW');
    await adv(0.1);
    state = await release(edgeId);
    const edgeRest = byId(state, edgeId)?.position ?? [9, 9, 9];
    const edgeHist = await history(page);
    report.steps.boundary = { words: edgeHist.words, moved: round(dist(edgeAtRecord, edgeRest)) };
    if (edgeHist.words.join() !== 'Place') fail(`the held-across-Record release pushed ${wordsOf(edgeHist)}, expected Place`);
    if (dist(edgeAtRecord, edgeRest) < 0.1) fail(`the boundary object barely moved (${dist(edgeAtRecord, edgeRest).toFixed(3)} m)`);
    expectText('undo the boundary place', await halo('Undo'), 'Place undone');
    state = await read();
    const edgeBack = dist(byId(state, edgeId)?.position ?? [9, 9, 9], edgeAtRecord);
    report.steps.boundary.backToRecordPose = round(edgeBack);
    if (edgeBack > 0.08) fail(`W did not return the boundary object to its pose at Record (${edgeBack.toFixed(3)} m off)`);
    expectText('redo the boundary place', await halo('Redo'), 'Place restored');
    state = await k.settle(edgeId);
    const edgeAgain = dist(byId(state, edgeId)?.position ?? [9, 9, 9], edgeRest);
    report.steps.boundary.redoError = round(edgeAgain);
    if (edgeAgain > 0.1) fail(`E did not put the boundary object back where it came to rest (${edgeAgain.toFixed(3)} m off)`);
    await adv(0.5);
    await k.focusCanvas();

    // A persistent object (Test Bracket): grown, then placed; W undoes the place, then the size.
    const keep = await k.summon(3);
    const keepId = heldNow(keep.state)?.id;
    const keepSummonSec = keep.log.timeSec;
    await page.keyboard.down('Equal');
    await adv(0.8);
    await page.keyboard.up('Equal');
    await adv(0.1);
    state = await read();
    const sizeAfter = byId(state, keepId).size;
    await k.release(keepId);
    await adv(0.8);
    state = await read();
    const sizeBefore = 1;
    const q0 = byId(state, keepId).position;
    await k.grab(keepId);
    await page.keyboard.down('KeyW');
    await adv(0.6);
    await page.keyboard.up('KeyW');
    await page.keyboard.press('KeyG');
    await adv(0.1);
    state = await k.settle(keepId);
    const q1 = byId(state, keepId).position;
    await adv(1.0);
    report.steps.beforeKeepUndo = (await history(page)).words;
    const keepPlace = await halo('Undo');
    const undoPlaceAt = keepPlace.at;
    expectText('undo place in the take', keepPlace, 'Place undone');
    state = await read();
    const q2 = byId(state, keepId)?.position ?? [9, 9, 9];
    if (dist(q2, q0) > 0.05) fail(`W in the take did not return the object to its pre-grab pose (${dist(q2, q0).toFixed(3)} m)`);
    await adv(1.0);
    const sizeUndo = await halo('Undo');
    const undoSizeAt = sizeUndo.at;
    expectText('undo size in the take', sizeUndo, 'Size undone');
    state = await read();
    const keepSizeBack = byId(state, keepId)?.size;
    if (Math.abs(keepSizeBack - sizeBefore) > 1e-3) fail(`W in the take did not return the size (${sizeBefore} -> ${sizeAfter} -> ${keepSizeBack})`);
    await adv(1.0);
    await k.focusCanvas();

    // Summon the bracket (slot 1) and put it back while held, then W: it returns.
    const bracket = await k.summon(1);
    const bracketId = heldNow(bracket.state)?.id;
    await adv(0.5);
    await page.keyboard.press('Backspace');
    await adv(0.1);
    state = await read();
    const putBack = state.objects.tray.putBacks.find((entry) => entry.objectId === bracketId);
    if (!putBack) fail('Backspace did not put the bracket back');
    await adv(1.0);
    await proofPace(page, 600);
    expectText('undo put back', await halo('Undo'), 'Put back undone');
    await proofPace(page, 1200);
    state = await read();
    const returned = state.objects.tray.returns.find((entry) => entry.objectId === bracketId);
    if (!byId(state, bracketId) || !returned) fail(`W did not bring the put-back object back (${JSON.stringify(returned)})`);
    await adv(1.0);
    await k.focusCanvas();
    // Interleaved: summon the diagram, grow it, set it down; then W W W in reverse order.
    const before = (await history(page)).log.length;
    const dia = await k.summon(2);
    const diaId = heldNow(dia.state)?.id;
    await page.keyboard.down('Equal');
    await adv(0.8);
    await page.keyboard.up('Equal');
    await adv(0.1);
    await k.release(diaId);
    await adv(0.3);
    const stack = await history(page);
    report.steps.interleaved = stack.words;
    const pushed = stack.log.slice(before).filter((entry) => entry.op === 'push').map((entry) => entry.word);
    const undoneWords = [];
    for (let i = 0; i < pushed.length; i += 1) {
      const step = await halo('Undo');
      undoneWords.push(step.step?.word ?? null);
    }
    report.steps.interleavedUndone = { pushed, undone: undoneWords };
    if (undoneWords.join() !== [...pushed].reverse().join()) fail(`interleaved actions did not undo in reverse (pushed ${pushed}, undone ${undoneWords})`);
    if (pushed[0] !== 'Summon' || !pushed.includes('Size')) fail(`the interleaved actions pushed ${pushed}`);
    state = await read();
    if (byId(state, diaId)) fail('undoing the interleaved summon left the diagram in the scene');
    await adv(0.5);
    await k.focusCanvas();

    // The brief's order: summon, a held mark, resize (all while the summon is still held), then W W W.
    const dia2 = await k.summon(2);
    const dia2Id = heldNow(dia2.state)?.id;
    await holdMark(page, adv);
    await page.keyboard.down('Equal');
    await adv(0.8);
    await page.keyboard.up('Equal');
    await adv(0.1);
    const orderStack = await history(page);
    // The held resize joins the history as the Halo is used, so the stack is judged by what W undoes.
    report.steps.order = { words: orderStack.words };
    const orderTexts = [];
    const orderSteps = [];
    for (let i = 0; i < 3; i += 1) {
      const step = await halo('Undo');
      orderTexts.push(step.text);
      orderSteps.push(step.step?.word ?? null);
      await proofPace(page, 800);
    }
    report.steps.order.texts = orderTexts;
    report.steps.order.undone = orderSteps;
    if (orderTexts.join() !== 'Size undone,Mark undone,Summon undone') fail(`W W W said ${JSON.stringify(orderTexts)}, expected Size, Mark, Summon undone in that order`);
    if (orderSteps.join() !== 'Size,Mark,Summon') fail(`the history log undid ${orderSteps}, expected Size,Mark,Summon`);
    state = await read();
    if (byId(state, dia2Id)) fail('the third W left the summoned object in the scene');
    if ((await history(page)).undone < 3) fail('three actions were not left to redo');
    // E restores in the same order; the resize is left to redo, then a new action clears it.
    const orderRedo = [];
    for (let i = 0; i < 2; i += 1) {
      orderRedo.push((await halo('Redo')).text);
      await proofPace(page, 800);
    }
    report.steps.order.redoTexts = orderRedo;
    if (orderRedo.join() !== 'Summon restored,Mark restored') fail(`E E said ${JSON.stringify(orderRedo)}, expected Summon restored, Mark restored`);
    if ((await history(page)).undone !== 1) fail('the resize is not left to redo');
    await k.focusCanvas();
    await k.summon(2);
    await proofPace(page, 600);
    expectText('redo after a new action in the take', await halo('Redo'), 'Nothing to redo');
    await k.focusCanvas();
    await page.keyboard.press('Backspace');
    await adv(0.3);

    const glb = await saveDownload(page, () => page.getByRole('button', { name: 'Stop Recording' }).click(), path.join(artifactDir, `${label}.glb`));
    await adv(0.5);
    const finalHistory = await history(page);
    if (finalHistory.done !== 0 || finalHistory.undone !== 0) fail(`stopping the take did not clear the history (${wordsOf(finalHistory)})`);
    expectText('undo after stop', await halo('Undo'), 'Nothing to undo');

    // --- The exported GLB ---
    const take = loadTake(await readFile(glb));
    const exported = { valid: take.validation?.ok ?? false, objectNodes: objectNodes(take).length };
    if (!exported.valid) fail(`HOLOIM_objects invalid: ${take.validation?.errors?.join('; ') ?? 'absent'}`);
    else {
      const entries = take.validation.value.objects;
      exported.entries = entries.map((entry) => ({ name: entry.name, origin: entry.origin, presence: entry.presence }));
      const index = (name, origin = null) => entries.findIndex((entry) => entry.name === name && (origin === null || entry.origin === origin));
      const brk = entries[index(NAMES[0], 'summoned')];
      const keepAt = entries[index(NAMES[2])];
      const offset = keepSummonSec - (keepAt?.presence?.[0]?.start ?? 0);
      exported.offsetSec = round(offset);
      // The put-back object: present until the put-back, absent, and back at the undo.
      if (!brk || brk.presence.length !== 2) fail(`the put-back then undone object's presence has ${brk?.presence?.length} spans, expected 2 (${JSON.stringify(brk?.presence)})`);
      else {
        const [first, second] = brk.presence;
        const putBackAt = putBack.timeSec - offset;
        const returnAt = returned.timeSec - offset;
        exported.putBack = { firstEnd: round(first.end), putBackAt: round(putBackAt), secondStart: round(second.start), returnAt: round(returnAt) };
        if (Math.abs(first.end - putBackAt) > 2 * FRAME_SEC) fail(`the first span ends at ${first.end}, the put-back was at ${putBackAt}`);
        if (Math.abs(second.start - returnAt) > 2 * FRAME_SEC) fail(`the second span starts at ${second.start}, the undo was at ${returnAt}`);
        if (!(second.start > first.end)) fail('the presence spans do not leave a gap');
        // The object resumes at the pose it was put back from.
        const node = brk.node ?? null;
        if (node !== null) {
          const times = Array.from(take.times);
          const at = (sec) => times.findIndex((time) => time >= sec - 1e-6);
          const iBefore = Math.max(0, at(first.end) - 1);
          const iAfter = Math.min(times.length - 1, at(second.start) + 1);
          const a = rigidPose(worldAt(take, node, iBefore)).position;
          const b = rigidPose(worldAt(take, node, iAfter)).position;
          const d = Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
          exported.putBack.resumeOffsetM = round(d);
          if (d > 0.05) fail(`the object did not resume at its put-back pose (${d.toFixed(3)} m)`);
        }
      }
      // The undone place and resize on the persistent object.
      const keepEntry = entries[index(NAMES[2])];
      const keepNode = keepEntry?.node;
      if (!keepEntry || keepNode === undefined) fail('the persistent object is not in the export');
      else {
        const times = Array.from(take.times);
        const frameOf = (sec) => times.findIndex((time) => time >= sec - 1e-6);
        const pos = (i) => {
          const p = rigidPose(worldAt(take, keepNode, i)).position;
          return [p.x, p.y, p.z];
        };
        // The size lives on the node's RecordedObjectSize child (a scale channel).
        const sizeChild = take.json.nodes[keepNode].children?.[0];
        const sizeTrack = take.channels.get(sizeChild)?.scale;
        const scaleAt = (i) => (sizeTrack ? sizeTrack.values[i * 3] : 1);
        const iPlace = frameOf(undoPlaceAt - offset);
        const before = pos(Math.max(0, iPlace - 3));
        const after = pos(iPlace + 3);
        exported.place = { frame: iPlace, undoAtSec: round(undoPlaceAt - offset), beforeError: round(dist(before, q1)), afterError: round(dist(after, q0)), jumpM: round(dist(before, after)) };
        // The settle in capture and the exported frame may sit a frame apart; judge against the rest pose.
        if (exported.place.beforeError > 0.05) fail(`before the undo the export has the object ${exported.place.beforeError} m from where it rested (${JSON.stringify(exported.place)})`);
        if (exported.place.afterError > 0.05) fail(`after the undo the export has the object ${exported.place.afterError} m from its pre-grab pose (${JSON.stringify(exported.place)})`);
        // Earlier frames unchanged: still at rest for the three frames before the undo.
        const still = [3, 2, 1].map((n) => dist(pos(iPlace - n), pos(iPlace - 4)));
        exported.place.stillBefore = still.map((v) => round(v, 4));
        if (Math.max(...still) > 0.01) fail(`frames before the undo are not at rest (${still})`);
        const jump = Math.max(...[-2, -1, 0, 1, 2].map((n) => dist(pos(iPlace + n), pos(iPlace + n - 1))));
        exported.place.maxStepM = round(jump);
        if (jump < 0.5 * dist(q1, q0)) fail(`no jump at the undo frame (largest step ${jump.toFixed(3)} m of ${dist(q1, q0).toFixed(3)} m)`);
        // The resize.
        const iSize = frameOf(undoSizeAt - offset);
        const sBefore = scaleAt(Math.max(0, iSize - 3));
        const sAfter = scaleAt(iSize + 3);
        exported.size = { frame: iSize, scaleBefore: round(sBefore, 4), scaleAfter: round(sAfter, 4), expectedBefore: round(sizeAfter / sizeBefore, 3) };
        if (!(Math.abs(sBefore / sAfter - sizeAfter / sizeBefore) < 0.05 * (sizeAfter / sizeBefore))) fail(`the exported size did not jump back at the undo frame (${JSON.stringify(exported.size)})`);
      }
    }
    return { label, status: failures.length ? 'fail' : 'pass', failures, glb, steps: report.steps, history: finalHistory, historyLog: (await history(page)).log, export: exported };
  } finally {
    await context.close();
  }
}

// --- Phone (flat, touch) ---

export async function runTouchUndoTake({ browser, baseUrl, artifactDir, consoleErrors }) {
  const label = 'undo-touch';
  const failures = [];
  const fail = (message) => failures.push(message);
  await mkdir(artifactDir, { recursive: true });
  const { context, page } = await setupFlatPage(browser, { consoleErrors, label, touch: true });
  const k = kit(page);
  const { adv, read } = k;
  const touch = { touch: true };
  const expectText = (step, got, want) => {
    if (got.text !== want) fail(`${step}: the status line says ${JSON.stringify(got.text)}, expected ${JSON.stringify(want)}`);
    return got;
  };
  const look = { x: 390 * 0.75, y: 844 * 0.4 };
  /** Tap Tray, tap slot 1: summoned into the hand. */
  const summonByTap = async (slot) => {
    await page.locator('[data-testid="dock-tray"]').tap();
    await adv(0.4);
    await page.locator(`[data-testid="tray-slot-${slot}"]`).tap();
    await adv(0.05);
    const state = await read();
    const log = state.objects.tray.summons.at(-1);
    k.clock.t = log.timeSec + FRAME_SEC;
    await adv(0.3);
    return { state: await read(), log };
  };
  try {
    await openCapture(page, baseUrl, { tray: TRAY });
    await adv(1);
    let state = await read();
    for (let i = 0; i < 600 && state.objects.tray.items.length !== 3; i += 1) {
      await adv(1 / 60);
      state = await read();
    }
    // Before a take: W on an empty history; summon, W, E.
    expectText('empty history', await k.halo('Undo', touch), 'Nothing to undo');
    const first = await summonByTap(1);
    const id = heldNow(first.state)?.id;
    if (!id) fail('tapping slot 1 did not summon');
    expectText('undo summon', await k.halo('Undo', touch), 'Summon undone');
    if (byId(await read(), id)) fail('W did not take the summoned object off the scene');
    expectText('redo summon', await k.halo('Redo', touch), 'Summon restored');
    if (!byId(await read(), id)) fail('E did not bring the summoned object back');
    await page.touchscreen.tap(look.x, look.y);
    await k.settle(id);

    // In a take: W right after Record has nothing; summon, put back with the dock's glyph, W returns it, E puts it back.
    await page.getByRole('button', { name: 'Start Recording' }).tap();
    await page.getByRole('button', { name: 'Stop Recording' }).waitFor();
    await adv(0.5);
    expectText('undo right after Record', await k.halo('Undo', touch), 'Nothing to undo');
    const mid = await summonByTap(2);
    const midId = heldNow(mid.state)?.id;
    await adv(0.5);
    await page.locator('[data-testid="dock-put-back"]').tap();
    await adv(0.2);
    state = await read();
    const putBack = state.objects.tray.putBacks.find((entry) => entry.objectId === midId);
    if (!putBack) fail('the dock Put back did not put the object back');
    await adv(0.8);
    expectText('undo put back', await k.halo('Undo', touch), 'Put back undone');
    const returned = (await read()).objects.tray.returns.find((entry) => entry.objectId === midId);
    if (!byId(await read(), midId) || !returned) fail(`W did not bring the put-back object back (${JSON.stringify(returned)})`);
    await adv(0.8);
    expectText('redo put back', await k.halo('Redo', touch), 'Put back restored');
    if (byId(await read(), midId)) fail('E did not put the object back again');
    await adv(0.5);
    const glb = await saveDownload(page, () => page.getByRole('button', { name: 'Stop Recording' }).tap(), path.join(artifactDir, `${label}.glb`));
    const finalHistory = await history(page);
    if (finalHistory.done !== 0) fail(`stopping the take did not clear the history (${wordsOf(finalHistory)})`);
    const take = loadTake(await readFile(glb));
    const exported = { valid: take.validation?.ok ?? false };
    if (!exported.valid) fail(`HOLOIM_objects invalid: ${take.validation?.errors?.join('; ') ?? 'absent'}`);
    else {
      const entry = take.validation.value.objects.find((object) => object.name === NAMES[1]);
      exported.presence = entry?.presence ?? null;
      // Put back, undone, put back again: two spans; the first ends at the put-back, the second at the redo.
      if (!entry || entry.presence.length !== 2) fail(`the diagram's presence has ${entry?.presence?.length} spans, expected 2 (${JSON.stringify(entry?.presence)})`);
    }
    return { label, status: failures.length ? 'fail' : 'pass', failures, glb, history: finalHistory, historyLog: (await history(page)).log, export: exported };
  } finally {
    await context.close();
  }
}

// --- Headset (IWER controllers and hands) ---

const REST = { left: [-0.3, 0.9, -0.1], right: [0.3, 0.9, -0.1] };
const TRAY_HAND = [-0.12, 1.1, -0.32];

/**
 * W and E committed through the headset's Halo (the left thumbstick on controllers, the right hand's thumb-middle pinch on
 * hands): a summon before a take, then a summon in a take, undone and redone, then the export.
 */
async function runHeadsetUndo({ browser, baseUrl, artifactDir, consoleErrors, label, mode }) {
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
    const { step } = stepper(page);
    const up = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI).toArray();
    if (mode === 'hand') await page.evaluate(installMiddlePinchPose);
    const pos = { left: REST.left, right: REST.right };
    const move = (side, position, quaternion = [0, 0, 0, 1]) => {
      pos[side] = position;
      return page.evaluate(({ s, p, q, hand }) => {
        const input = hand ? window.IWER_DEVICE.hands[s] : window.IWER_DEVICE.controllers[s];
        input.position.set(...p);
        input.quaternion.set(...q);
      }, { s: side, p: position, q: quaternion, hand: mode === 'hand' });
    };
    const button = (side, id, value) => page.evaluate(({ s, i, v }) => window.IWER_DEVICE.controllers[s].updateButtonValue(i, v), { s: side, i: id, v: value });
    const axes = (x, y) => page.evaluate(({ x, y }) => window.IWER_DEVICE.controllers.left.updateAxes('thumbstick', x, y), { x, y });
    const pinch = (value) => page.evaluate((v) => window.IWER_DEVICE.hands.right.updatePinchValue(v), value);
    let pinched = 0;
    const ramp = async (to) => {
      const from = pinched;
      for (let i = 1; i <= 6; i += 1) {
        pinched = from + (to - from) * (i / 6);
        await pinch(pinched);
        await step(1);
      }
    };
    await move('left', REST.left);
    await move('right', REST.right);
    await step(20);
    let state = await readState(page);
    if (state.objects.tray.items.length !== 2) {
      fail(`the tray did not load two items (${state.objects.tray.items.length})`);
      return { label, status: 'fail', failures };
    }
    const rigYaw = state.thumbstick.rigYaw;
    const openTray = async () => {
      if (mode === 'controller') {
        await move('left', TRAY_HAND);
        await step(20);
        await button('left', 'y-button', 1);
        await step(3);
      } else {
        await move('left', TRAY_HAND, up);
        await step(26);
      }
    };
    const closeTray = async () => {
      if (mode === 'controller') await button('left', 'y-button', 0);
      await move('left', REST.left);
      await step(10);
    };
    /** Opens the tray, reaches slot 1, grips: the object is in the right hand; then lets go and rests. */
    const summon = async (slot) => {
      await openTray();
      const reached = await reach(page, step, { move: (p) => move('right', p), start: pos.right, target: (s) => s.objects.tray.items[slot].position, rigYaw });
      if (reached.error > 0.06) fail(`the right hand never reached miniature ${slot + 1} (${round(reached.error, 3)} m)`);
      if (mode === 'controller') {
        await button('right', 'squeeze', 1);
        await step(4);
      } else {
        await ramp(1);
        await step(2);
      }
      const held = summonedItems(await readState(page)).find((item) => item.heldBy === 'right');
      if (!held) fail('gripping a miniature did not summon into the right hand');
      if (mode === 'controller') await button('right', 'squeeze', 0);
      else {
        // Letting go near the tray puts the object back; carry it away first so the release is a plain drop.
        const from = pos.right;
        for (let i = 1; i <= 40; i += 1) {
          const t = i / 40;
          await move('right', from.map((v, j) => v + ([0.6, 1.0, 0.0][j] - v) * t));
          await step(1);
        }
        await ramp(0);
      }
      await move('right', REST.right);
      await closeTray();
      await step(60);
      return held ?? null;
    };
    /** The Halo, committed with this input: `direction` w is Undo, e is Redo. */
    const halo = async (direction) => {
      if (mode === 'controller') {
        await button('left', 'thumbstick', 1);
        await step(6);
        await axes(direction === 'w' ? -1 : 1, 0);
        await step(30);
        await button('left', 'thumbstick', 0);
        await step(6);
        await axes(0, 0);
        await step(24);
      } else {
        const origin = [0.18, 1.3, -0.4];
        const { dx, dy } = haloDrag(direction);
        for (const stage of HALO_PINCH_STAGES) {
          const frames = Math.max(1, Math.round(stage.sec * 60));
          for (let i = 1; i <= frames; i += 1) {
            const at = [origin[0] + dx * stage.drag(i / frames), origin[1] + dy * stage.drag(i / frames), origin[2]];
            await page.evaluate((p) => {
              window.__setHandPoseId('right', 'middlePinch');
              window.IWER_DEVICE.hands.right.position.set(...p);
            }, at);
            await step(1);
          }
        }
        await page.evaluate(() => window.__setHandPoseId('right', 'default'));
        await move('right', REST.right);
        await step(30);
      }
      const h = await history(page);
      return { step: h.log.filter((entry) => entry.op === 'undo' || entry.op === 'redo').at(-1) ?? null, history: h };
    };
    const expectStep = (name, got, op, word) => {
      if (got.step?.op !== op || got.step.word !== word || got.step.done !== true) fail(`${name}: the history's last step is ${JSON.stringify(got.step)}, expected ${op} ${word} done`);
    };

    // Before a take.
    const first = await summon(0);
    let h = await history(page);
    if (!h.words.includes('Summon')) fail(`the summon did not push a Summon entry (${wordsOf(h)})`);
    /** Undo until the Summon entry itself is undone (a drop after it is a Place entry); returns the count. */
    const undoToSummon = async (name) => {
      let n = 0;
      let last = null;
      do {
        last = await halo('w');
        n += 1;
      } while (last.step?.word !== 'Summon' && n < 4);
      expectStep(name, last, 'undo', 'Summon');
      return n;
    };
    const redoBack = async (name, n) => {
      let last = null;
      for (let i = 0; i < n; i += 1) last = await halo('e');
      expectStep(name, last, 'redo', 'Summon');
    };
    let n = await undoToSummon('undo summon');
    if (first && summonedItems(await readState(page)).some((item) => item.id === first.id)) fail('the Halo W did not take the summoned object off the scene');
    await redoBack('redo summon', n);
    if (first && !summonedItems(await readState(page)).some((item) => item.id === first.id)) fail('the Halo E did not bring the summoned object back');

    // In a take: summon, W, E; the export shows the gap.
    await clickButton(page, 'Start Recording');
    await page.getByRole('button', { name: 'Stop Recording', exact: true }).waitFor({ timeout: 10_000 });
    await step(30);
    h = await history(page);
    if (h.done !== 0) fail(`Record did not clear the history (${wordsOf(h)})`);
    const mid = await summon(1);
    state = await readState(page);
    const summonLog = state.objects.tray.summons.find((entry) => entry.objectId === mid?.id);
    n = await undoToSummon('undo summon in the take');
    state = await readState(page);
    const gone = !state.objects.items.some((item) => item.id === mid?.id);
    if (!gone) fail('the Halo W in the take did not remove the summoned object');
    await step(40);
    await redoBack('redo summon in the take', n);
    state = await readState(page);
    if (!state.objects.items.some((item) => item.id === mid?.id)) fail('the Halo E in the take did not bring the summoned object back');
    await step(60);
    const glb = path.join(artifactDir, `${label}.glb`);
    await saveDownload(page, async () => {
      await clickButton(page, 'Stop Recording');
      for (let i = 0; i < 20; i += 1) await step(1);
    }, glb);
    const finalHistory = await history(page);
    if (finalHistory.done !== 0) fail(`stopping the take did not clear the history (${wordsOf(finalHistory)})`);
    const take = loadTake(await readFile(glb));
    const exported = { valid: take.validation?.ok ?? false, summonSec: summonLog ? round(summonLog.timeSec) : null };
    if (!exported.valid) fail(`HOLOIM_objects invalid: ${take.validation?.errors?.join('; ') ?? 'absent'}`);
    else {
      exported.entries = take.validation.value.objects.map((entry) => ({ name: entry.name, origin: entry.origin, presence: entry.presence }));
      const entry = take.validation.value.objects.find((object) => object.origin === 'summoned' && object.name === NAMES[1]);
      if (!entry || entry.presence.length < 1) fail(`the summoned diagram is not in the export (${JSON.stringify(exported.entries)})`);
      // Summoned, undone (gone), redone (back): the redo returns the same object, so two spans.
      else if (entry.presence.length !== 2) fail(`the undone and redone summon has ${entry.presence.length} presence spans, expected 2 (${JSON.stringify(entry.presence)})`);
    }
    return { label, status: failures.length ? 'fail' : 'pass', failures, glb, history: finalHistory, historyLog: (await history(page)).log, export: exported };
  } finally {
    await context.close();
  }
}

export const runControllersUndoTake = (run) => runHeadsetUndo({ ...run, label: 'undo-controllers', mode: 'controller' });
export const runHandsUndoTake = (run) => runHeadsetUndo({ ...run, label: 'undo-hands', mode: 'hand' });
