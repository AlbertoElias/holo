import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import { createXrContext, waitForPageFunctions, waitForTextContentPrefix, wireXrConsoleErrors } from '@holoim/tooling-testing/xr-env';

import * as THREE from 'three';

import { DesktopReach } from '../../src/objects/DesktopReach.ts';
import { ObjectInteraction } from '../../src/objects/ObjectInteraction.ts';
import { findNode, loadTake, relativePose, rigidPose, worldAt } from './object-glb.mjs';
import { OBJECT_URL, openCapture, poseOf, readState, saveDownload } from './object-take.mjs';

// Crouch and reach on flat screens (slice 3): a prop on the floor is picked up
// and set down by capture's real input paths.
//   - Keyboard (`G`, recorded): the prop is put on the floor by a low set-down,
//     then G reaches for it: the body squats, the palm reaches it before it
//     moves, it is held rigidly, the avatar stands into the carry pose, and the
//     exported GLB shows the hips drop. G again sets it down on the floor.
//   - Feet: from the first bend of the reach to the end of the stand-up, both
//     ankles stay where they stood when it began (height within 1 cm, slide at
//     most 2 cm, never below the floor), sampled every frame.
//   - Cancels: walking or a second G during the reach leaves the prop where it
//     was; walking while it is lowered (a squat, or the arm alone) keeps it
//     held; G during the set-down lets go at once.
//   - Mouse (first person, pointer lock stood in as the pointing check does): the
//     view pitches to -1.45 rad, a press on the floor prop reaches for it, and a
//     pointer lifted during the reach doesn't cancel it, but a second press
//     does; the next press after the early lift lets the prop go like G. The
//     point aim stays clamped to +-1.2 rad.
//   - Phone (390 x 844, CDP touch, third person): a touch on the floor prop
//     near the feet reaches for it; a second touch cancels the reach, and the
//     next touch after an early lift lets the prop go.
// Every number goes into the take's entry of report.json.

// The scene sits 0.01 m above its authored floor.
const FLOOR_Y = 0.01;
const STEP_MS = 1000 / 60;
const REST_TIMEOUT_SEC = 4;
const VIEWPORT = { width: 960, height: 540 };
const PHONE = { width: 390, height: 844 };
const round = (value, digits = 3) => Number(value.toFixed(digits));
const centreOf = (item) => [0, 1, 2].map((a) => (item.boundsMin[a] + item.boundsMax[a]) / 2);
const dist = (a, b) => Math.hypot(...a.map((v, i) => v - b[i]));

async function openPage(browser, baseUrl, consoleErrors, label, { viewport, touch }) {
  const context = await createXrContext(browser, { viewport, acceptDownloads: true, ...(touch ? { hasTouch: true, isMobile: true, deviceScaleFactor: 2 } : {}) });
  const page = await context.newPage();
  wireXrConsoleErrors(page, consoleErrors, { label });
  await page.route('**/__holoim/input-recordings*', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '{"path":"object-reach-input.json"}' }));
  await openCapture(page, baseUrl, { object: OBJECT_URL });
  await waitForPageFunctions(page, ['__projectToScreen', '__loadObjectUrl', '__setMockInput', '__sampleHolds']);
  await waitForTextContentPrefix(page, '#status', 'loaded');
  const advance = (seconds) => page.evaluate((ms) => window.advanceTime(ms), Math.round(seconds * 60) * STEP_MS);
  const state = () => readState(page);
  const item = async () => (await state()).objects.items[0];
  /** Steps until `done(state)` holds, at most `maxSec`; returns the last state and the seconds stepped. */
  const until = async (done, maxSec) => {
    let current = await state();
    let t = 0;
    for (; t < maxSec * 60 && !done(current); t += 1) {
      await advance(1 / 60);
      current = await state();
    }
    return { state: current, sec: t / 60 };
  };
  const rest = async () => (await until((st) => st.objects.items[0].body === 'asleep', REST_TIMEOUT_SEC)).state.objects.items[0];
  /** G picks the hovering prop up, G again sets it down: the prop ends on the floor. */
  const putOnFloor = async () => {
    await page.locator('canvas').first().focus();
    await page.keyboard.press('KeyG');
    const carried = await until((st) => st.objects.items[0].heldBy && st.objects.reach.phase === 'carry', 3);
    if (!carried.state.objects.items[0].heldBy) throw new Error('the setup pickup did not hold the prop');
    await advance(0.3);
    await page.keyboard.press('KeyG');
    await until((st) => !st.objects.items[0].heldBy, 4);
    const resting = await rest();
    await until((st) => st.crouch.amount < 0.01, 2);
    return resting;
  };
  const rearm = async () => {
    if (!(await page.evaluate((url) => window.__loadObjectUrl(url), OBJECT_URL))) throw new Error('the object did not reload');
    await advance(0.3);
  };
  // The prop placed while the page loads sits further out than the avatar's reach; place it again in front of the settled avatar.
  await advance(1);
  await rearm();
  return { context, page, advance, state, item, until, rest, putOnFloor, rearm };
}

/** Hand-relative pose of the held prop at a state: the object in the hand anchor's frame. */
function relationOf(st) {
  const prop = st.objects.items[0];
  const hand = poseOf(st.objects.hands[prop.heldBy]);
  return hand ? relativePose(hand, poseOf(prop)) : null;
}

function spreadOf(relations) {
  let position = 0;
  for (const relation of relations) position = Math.max(position, relation.position.distanceTo(relations[0].position));
  return position;
}

/** A held prop being lowered by the arm alone, then the avatar walks: the set-down is cancelled and the prop stays held. */
function standingSetDownWalk() {
  const object = { heldBy: 'right', wrapper: new THREE.Group() };
  const interaction = Object.create(ObjectInteraction.prototype);
  interaction.reach = new DesktopReach();
  interaction.reach.phase = 'carry';
  interaction.hold = { object, side: 'right', desktop: true, offset: new THREE.Matrix4(), pointer: false, settle: { startSec: 0, lowerM: 0.1, squat: false, fullSec: null } };
  interaction.clock = 0;
  interaction.anchor = new THREE.Matrix4();
  interaction.world = new THREE.Matrix4();
  interaction.deps = { carry: { update: () => {} }, registry: { all: () => [object] }, tray: {} };
  interaction.readAnchor = () => true;
  interaction.writeWorld = () => {};
  interaction.physics = { gapBelow: () => 1, sample: () => {}, release: () => { object.heldBy = null; }, hold: () => {} };
  const walking = { deltaSec: 1 / 60, desktop: { summonSlot: null, toggle: false, grab: { press: null, release: false }, walking: true, pointHeld: false, turnYaw: 0, turnPitch: 0 } };
  const settlingBefore = Boolean(interaction.hold.settle);
  interaction.updateDesktop(walking);
  const heldAfter = object.heldBy;
  const settlingAfter = Boolean(interaction.hold?.settle);
  // Past the set-down's duration the prop must still be in the hand.
  interaction.clock = 0.4;
  interaction.updateDesktop(walking);
  return { settlingBefore, heldAfter, settlingAfter, releasedLater: object.heldBy === null };
}

export async function runFloorReach({ browser, baseUrl, artifactDir, consoleErrors }) {
  const label = 'desktop-floor-reach';
  const failures = [];
  const fail = (message) => failures.push(message);
  await mkdir(artifactDir, { recursive: true });
  const s = await openPage(browser, baseUrl, consoleErrors, label, { viewport: VIEWPORT, touch: false });
  const { page, advance } = s;
  try {
    await advance(1);
    const onFloor = await s.putOnFloor();
    const floor = { centre: centreOf(onFloor).map((v) => round(v)), floorGapM: round(onFloor.boundsMin[1] - FLOOR_Y, 4), body: onFloor.body };
    const state0 = await s.state();
    const standingFeet = state0.locomotion.legs.map((leg) => leg.foot);
    floor.aheadOfAvatarM = round(Math.hypot(floor.centre[0] - state0.avatar.x, floor.centre[2] - state0.avatar.z));
    if (onFloor.body !== 'asleep') fail(`the prop did not come to rest on the floor (${onFloor.body})`);

    // --- Recorded pickup from the floor with G, then a low set-down. ---
    await page.getByRole('button', { name: 'Start Recording' }).click();
    await page.getByRole('button', { name: 'Stop Recording' }).waitFor();
    let recSteps = 0;
    const step = async (count = 1) => {
      for (let i = 0; i < count; i += 1) {
        await advance(1 / 60);
        recSteps += 1;
      }
    };
    await step(12);
    const start = await s.item();
    const startPos = start.position;
    await page.keyboard.press('KeyG');
    const pressStep = recSteps;
    const samples = [];
    let grabStep = null;
    let carryStep = null;
    let standStep = null;
    let maxMovedBeforeHoldM = 0;
    let palmAtGrabM = null;
    const feet = { maxRiseM: 0, minY: Infinity, maxSlideM: 0, maxDropM: 0, frames: 0 };
    const sampleFeet = (st) => {
      st.locomotion.legs.forEach((leg, i) => {
        const stand = standingFeet[i];
        feet.maxRiseM = Math.max(feet.maxRiseM, leg.foot.y - stand.y);
        feet.maxDropM = Math.max(feet.maxDropM, stand.y - leg.foot.y);
        feet.minY = Math.min(feet.minY, leg.foot.y);
        feet.maxSlideM = Math.max(feet.maxSlideM, Math.hypot(leg.foot.x - stand.x, leg.foot.z - stand.z));
      });
      feet.frames += 1;
    };
    for (let i = 0; i < 4 * 60; i += 1) {
      await step(1);
      const st = await s.state();
      if (carryStep === null || standStep === null) sampleFeet(st);
      const prop = st.objects.items[0];
      if (!prop.heldBy) maxMovedBeforeHoldM = Math.max(maxMovedBeforeHoldM, dist(prop.position, startPos));
      else if (grabStep === null) {
        grabStep = recSteps;
        palmAtGrabM = st.objects.reach.palmToPropM;
      }
      if (prop.heldBy) {
        const relation = relationOf(st);
        if (relation) samples.push(relation);
      }
      if (carryStep === null && st.objects.reach.phase === 'carry') carryStep = recSteps;
      if (carryStep !== null && standStep === null && st.crouch.amount < 0.01 && st.crouch.squat === 0) standStep = recSteps;
      if (standStep !== null && recSteps - standStep > 30) break;
    }
    await step(30);
    const held = await s.item();
    // From the reach's first bend to the end of the stand-up the feet stay where they stood.
    const footReport = { maxRiseM: round(feet.maxRiseM, 4), maxDropM: round(feet.maxDropM, 4), minAnkleY: round(feet.minY, 4), maxSlideM: round(feet.maxSlideM, 4), standingAnkleY: standingFeet.map((f) => round(f.y, 4)), frames: feet.frames };
    if (feet.frames < 30) fail(`the feet were sampled for only ${feet.frames} frames of the reach`);
    if (feet.maxRiseM > 0.01 || feet.maxDropM > 0.01) fail(`the ankles moved ${footReport.maxRiseM} m up and ${footReport.maxDropM} m down during the reach (limit 0.01 m)`);
    if (feet.maxSlideM > 0.02) fail(`the feet slid ${footReport.maxSlideM} m during the reach (limit 0.02 m)`);
    if (feet.minY < FLOOR_Y) fail(`an ankle went to ${footReport.minAnkleY} m, below the floor (${FLOOR_Y} m)`);
    if (grabStep === null) fail('G did not pick up the prop from the floor');
    if (maxMovedBeforeHoldM > 0.001) fail(`the prop moved ${round(maxMovedBeforeHoldM, 5)} m before the hand reached it (limit 0.001 m)`);
    const secToGrab = grabStep === null ? null : (grabStep - pressStep) / 60;
    if (secToGrab !== null && secToGrab > 1.5) fail(`the palm reached the prop after ${round(secToGrab)} s (limit 1.5 s)`);
    if (palmAtGrabM !== null && palmAtGrabM > 0.1) fail(`the palm was ${round(palmAtGrabM, 4)} m from the prop at the grab (limit 0.10 m)`);
    const rigidM = samples.length ? spreadOf(samples) : null;
    if (rigidM === null || rigidM > 1e-4) fail(`the prop slid ${rigidM === null ? 'unmeasured' : round(rigidM, 6)} m in the hand over the held span (limit 0.0001 m)`);
    const crouchBackSec = carryStep !== null && standStep !== null ? (standStep - carryStep) / 60 : null;
    if (crouchBackSec === null || crouchBackSec > 0.8) fail(`the crouch was not back to 0 within 0.8 s of the carry pose (${crouchBackSec})`);
    if (held.heldBy !== 'right') fail('the prop was not held after the pickup');

    // Low set-down: G lowers the prop with a squat; it is let go within 3 cm of the floor, with no velocity.
    await page.keyboard.press('KeyG');
    let launch = null;
    let lowestSquat = 0;
    for (let i = 0; i < 4 * 60 && !launch; i += 1) {
      await step(1);
      const st = await s.state();
      lowestSquat = Math.max(lowestSquat, st.objects.reach.demand);
      const prop = st.objects.items[0];
      if (!prop.heldBy) launch = prop;
    }
    if (!launch) fail('the low set-down never let go of the prop');
    const settled = await s.rest();
    const setDown = launch && {
      letGoAboveFloorM: round(launch.boundsMin[1] - FLOOR_Y, 4),
      // One step of gravity falls 0.16 m/s; the let-go itself adds no sideways or upward velocity.
      launchSpeedMps: round(Math.hypot(launch.linvel[0], launch.linvel[2]), 4),
      launchSpinRadps: round(Math.hypot(...launch.angvel), 4),
      restDriftM: round(Math.hypot(centreOf(settled)[0] - centreOf(launch)[0], centreOf(settled)[2] - centreOf(launch)[2]), 4),
      restFloorGapM: round(settled.boundsMin[1] - FLOOR_Y, 4),
      peakDemand: round(lowestSquat),
      body: settled.body
    };
    if (setDown) {
      if (setDown.letGoAboveFloorM > 0.03) fail(`the prop was let go ${setDown.letGoAboveFloorM} m above the floor (limit 0.03 m)`);
      if (setDown.launchSpeedMps > 0.01 || setDown.launchSpinRadps > 0.05) fail(`the low set-down let go with velocity ${setDown.launchSpeedMps} m/s, ${setDown.launchSpinRadps} rad/s`);
      if (setDown.restDriftM > 0.02) fail(`the prop moved ${setDown.restDriftM} m after the let-go (limit 0.02 m)`);
      if (Math.abs(setDown.restFloorGapM) > 0.003) fail(`the prop rests ${setDown.restFloorGapM} m from the floor (limit 0.003 m)`);
      if (setDown.body !== 'asleep') fail(`the prop did not come to rest (${setDown.body})`);
    }
    await step(60);

    const glb = path.join(artifactDir, `${label}.glb`);
    await saveDownload(page, async () => {
      await page.getByRole('button', { name: 'Stop Recording' }).click();
      for (let i = 0; i < 20; i += 1) await advance(1 / 60);
    }, glb);
    const take = loadTake(await readFile(glb));
    const entry = take.validation?.ok ? take.validation.value.objects[0] : undefined;
    const hold = entry?.holds[0];
    const declaredHips = take.json.extensions?.HOLOIM_humanoid?.humanBones?.hips?.node;
    const hips = Number.isInteger(declaredHips) ? declaredHips : findNode(take, 'Hips');
    const hipsY = take.times.map((_, i) => rigidPose(worldAt(take, hips, i)).position.y);
    const at = (sec) => take.times.reduce((best, t, i) => (Math.abs(t - sec) < Math.abs(take.times[best] - sec) ? i : best), 0);
    const pressKey = at(pressStep / 60);
    const standing = hipsY[Math.max(0, pressKey - 3)];
    const lowestHips = Math.min(...hipsY.slice(pressKey, hold ? at(hold.start) + 1 : undefined));
    const afterStand = carryStep === null ? null : hipsY[at((carryStep + 48) / 60)];
    const exportReport = {
      holds: entry?.holds ?? [],
      holdStartSec: hold?.start ?? null,
      measuredGrabSec: grabStep === null ? null : round(grabStep / 60),
      hipsStandingY: round(standing, 4),
      hipsLowestY: round(lowestHips, 4),
      hipsDropM: round(standing - lowestHips, 4),
      hipsYAtCarry: afterStand === null ? null : round(afterStand, 4)
    };
    if (!hold) fail('export: no hold span');
    else if (Math.abs(hold.start - grabStep / 60) > 0.1) fail(`export: the hold starts at ${round(hold.start)} s, the hand reached the prop at ${round(grabStep / 60)} s (limit 0.1 s)`);
    if (exportReport.hipsDropM < 0.15) fail(`export: the hips dropped only ${exportReport.hipsDropM} m during the reach (need 0.15 m)`);

    // --- Cancels, each on a fresh floor prop. ---
    const cancels = {};
    const checkCancel = async (name, press) => {
      await s.rearm();
      const floorProp = await s.putOnFloor();
      const before = floorProp.position;
      await press();
      const after = await s.until((st) => st.crouch.amount < 0.01 && st.crouch.squat === 0 && st.objects.reach.phase === 'idle', 1.5);
      const prop = after.state.objects.items[0];
      cancels[name] = { movedM: round(dist(prop.position, before), 6), heldBy: prop.heldBy, standSec: round(after.sec), phase: after.state.objects.reach.phase };
      if (cancels[name].movedM > 1e-5 || prop.heldBy) fail(`${name}: the prop moved ${cancels[name].movedM} m or was held (${prop.heldBy})`);
      if (after.sec > 0.5 + 0.2) fail(`${name}: the crouch took ${cancels[name].standSec} s to end (limit 0.5 s after the cancel)`);
    };
    await checkCancel('walk-cancels-reach', async () => {
      await page.keyboard.press('KeyG');
      await advance(0.2);
      const st = await s.state();
      cancels['walk-cancels-reach-demandBefore'] = round(st.objects.reach.demand);
      await page.keyboard.down('KeyD');
      await advance(0.1);
      await page.keyboard.up('KeyD');
    });
    await checkCancel('second-G-cancels-reach', async () => {
      await page.keyboard.press('KeyG');
      await advance(0.2);
      await page.keyboard.press('KeyG');
    });
    // Walking while it is lowered keeps it held; G during the set-down lets go at once.
    await s.rearm();
    await page.keyboard.press('KeyG');
    await s.until((st) => st.objects.items[0].heldBy && st.objects.reach.phase === 'carry', 3);
    await advance(0.3);
    await page.keyboard.press('KeyG');
    await advance(0.25);
    const lowering = await s.state();
    await page.keyboard.down('KeyA');
    await advance(0.1);
    await page.keyboard.up('KeyA');
    const afterWalk = await s.until((st) => st.crouch.amount < 0.01 && st.objects.reach.phase === 'carry', 1.5);
    cancels['walk-during-lowering'] = { phaseWhileLowering: lowering.objects.reach.phase, heldAfter: afterWalk.state.objects.items[0].heldBy, standSec: round(afterWalk.sec), phase: afterWalk.state.objects.reach.phase };
    if (lowering.objects.reach.phase !== 'lower') fail(`walk-during-lowering: the set-down was not a squat (phase ${lowering.objects.reach.phase})`);
    if (afterWalk.state.objects.items[0].heldBy !== 'right') fail('walking while lowering did not keep the prop held');
    if (afterWalk.sec > 0.8) fail(`walk-during-lowering: the avatar took ${cancels['walk-during-lowering'].standSec} s to stand (limit 0.8 s)`);
    // Walking during a standing (arm-only) set-down also keeps it held. No surface in the fixture is within the standing arm's reach
    // below a carried prop, so this one runs the production ObjectInteraction with the geometry mocked.
    cancels['walk-during-standing-lowering'] = standingSetDownWalk();
    const standingCase = cancels['walk-during-standing-lowering'];
    if (!standingCase.settlingBefore) fail(`walk-during-standing-lowering: no arm-only set-down began (${JSON.stringify(standingCase)})`);
    else if (standingCase.heldAfter !== 'right' || standingCase.settlingAfter || standingCase.releasedLater) fail(`walk-during-standing-lowering: walking did not cancel the set-down and keep the prop held (${JSON.stringify(standingCase)})`);
    await s.rearm();
    await page.keyboard.press('KeyG');
    await s.until((st) => st.objects.items[0].heldBy && st.objects.reach.phase === 'carry', 3);
    await advance(0.3);
    await page.keyboard.press('KeyG');
    await advance(0.25);
    const midLower = await s.state();
    await page.keyboard.press('KeyG');
    await advance(1 / 60);
    const letGo = (await s.item()).heldBy;
    cancels['G-during-lowering'] = { phaseBefore: midLower.objects.reach.phase, heldBefore: midLower.objects.items[0].heldBy, heldAfterG: letGo };
    if (midLower.objects.reach.phase !== 'lower' || midLower.objects.items[0].heldBy !== 'right') fail(`G-during-lowering: not lowering a held prop (${JSON.stringify(cancels['G-during-lowering'])})`);
    if (letGo) fail('G during the set-down did not let go at once');
    await s.rest();

    return { label, status: failures.length ? 'fail' : 'pass', failures, glb, floor, pickup: { secToGrab, palmAtGrabM: palmAtGrabM && round(palmAtGrabM, 4), maxMovedBeforeHoldM: round(maxMovedBeforeHoldM, 6), rigidHoldChangeM: rigidM, crouchBackSec, heldSamples: samples.length }, feet: footReport, setDown, export: exportReport, cancels };
  } finally {
    await s.context.close();
  }
}

export async function runMouseFloorReach({ browser, baseUrl, consoleErrors }) {
  const label = 'desktop-mouse-floor-reach';
  const failures = [];
  const fail = (message) => failures.push(message);
  const s = await openPage(browser, baseUrl, consoleErrors, label, { viewport: VIEWPORT, touch: false });
  const { page, advance } = s;
  try {
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
    });
    const centre = { x: VIEWPORT.width / 2, y: VIEWPORT.height / 2 };
    await page.mouse.click(centre.x, centre.y);
    await advance(0.3);
    await s.putOnFloor();
    const FOCAL_PX = VIEWPORT.height / 2 / Math.tan((35 * Math.PI) / 180);

    // The view pitches down to -1.45 rad and no further; the point aim stays within +-1.2.
    await page.evaluate(() => window.__setMockInput({ lookYaw: 0, aimPitch: -1.6 }));
    await advance(0.1);
    const limits = await s.state();
    const pitchLimits = { viewPitch: round(limits.point.viewPitch), pointAimPitch: round(limits.point.aimPitch) };
    if (Math.abs(pitchLimits.viewPitch + 1.45) > 0.001) fail(`the first-person view pitched to ${pitchLimits.viewPitch} rad, not the -1.45 limit`);
    if (pitchLimits.pointAimPitch < -1.2 - 1e-6) fail(`the point aim reached ${pitchLimits.pointAimPitch} rad (clamp is -1.2)`);

    // Aim the view centre at the prop on the floor, as the mouse would, closing the loop on its projection.
    let view = { yaw: 0, pitch: -1.2 };
    let aimPx = Infinity;
    for (let i = 0; i < 10; i += 1) {
      await page.evaluate((arg) => window.__setMockInput(arg), { lookYaw: view.yaw, aimPitch: view.pitch });
      await advance(0.1);
      const at = await page.evaluate((p) => window.__projectToScreen(p), centreOf(await s.item()));
      if (!at) break;
      const ex = at.x - centre.x;
      const ey = at.y - centre.y;
      aimPx = Math.hypot(ex, ey);
      if (aimPx < 3) break;
      view = { yaw: view.yaw - Math.atan(ex / FOCAL_PX), pitch: Math.max(-1.45, view.pitch - Math.atan(ey / FOCAL_PX)) };
    }
    const aimed = { pitchRad: round((await s.state()).point.viewPitch), aimErrorPx: round(aimPx, 1) };
    if (aimPx > 40) fail(`the floor prop is ${aimed.aimErrorPx} px from the view centre`);
    const before = (await s.item()).position;
    const OFFSETS = [[0, 0], [10, 0], [-10, 0], [0, 10], [0, -10], [18, 0], [-18, 0], [0, 18], [0, -18]];
    let grabbed = false;
    let lastPress = null;
    let pressedAt = null;
    let heldDuringReach = null;
    for (const [ox, oy] of OFFSETS) {
      const pitch = view.pitch - Math.atan(oy / FOCAL_PX);
      const yaw = view.yaw - Math.atan(ox / FOCAL_PX);
      await page.evaluate((arg) => window.__setMockInput(arg), { lookYaw: yaw, aimPitch: pitch });
      await advance(0.1);
      await page.mouse.move(centre.x, centre.y);
      await page.mouse.down();
      pressedAt = ox === 0 && oy === 0 ? 'centre' : `${ox},${oy}`;
      // The pointer is lifted during the reach: the grab completes and stays held.
      await advance(0.1);
      const reaching = await s.state();
      if (reaching.objects.reach.phase === 'reach') {
        lastPress = reaching;
        await page.mouse.up();
        heldDuringReach = (await s.item()).heldBy;
        grabbed = true;
        break;
      }
      await page.mouse.up();
      await advance(0.1);
    }
    if (!grabbed) fail('a press at the view centre never started a reach');
    // A second press during the reach cancels it: the body stands, nothing is grabbed. Then the same press starts it again.
    let secondPress = null;
    if (grabbed) {
      await page.mouse.down();
      await advance(0.05);
      const cancelledState = await s.state();
      await page.mouse.up();
      secondPress = { phase: cancelledState.objects.reach.phase, heldBy: cancelledState.objects.items[0].heldBy, movedM: round(dist(cancelledState.objects.items[0].position, before), 6) };
      if (secondPress.phase !== 'idle' || secondPress.heldBy || secondPress.movedM > 1e-5) fail(`a second mouse press did not cancel the reach: ${JSON.stringify(secondPress)}`);
      await s.until((st) => st.crouch.amount < 0.01 && st.crouch.squat === 0, 1.5);
      await page.mouse.down();
      await advance(0.1);
      const again = await s.state();
      if (again.objects.reach.phase !== 'reach') fail(`the press after the cancel did not start a reach (phase ${again.objects.reach.phase})`);
      await page.mouse.up();
    }
    const moved = Math.max(0, dist((await s.item()).position, before));
    const after = await s.until((st) => st.objects.items[0].heldBy && st.objects.reach.phase === 'carry', 2.5);
    await advance(1);
    const stillHeld = await s.state();
    const reach = {
      pressedAt,
      phaseAtPress: lastPress?.objects.reach.phase,
      heldDuringReach,
      secToCarry: round(after.sec),
      propMovedBeforeHoldM: round(heldDuringReach ? 0 : moved, 5),
      heldAfterPointerLifted: stillHeld.objects.items[0].heldBy,
      crouchAmountAfter: round(stillHeld.crouch.amount, 4),
      palmToPropM: round(stillHeld.objects.reach.palmToPropM ?? -1, 4)
    };
    if (reach.heldDuringReach) fail('the prop was held before the palm reached it');
    if (reach.heldAfterPointerLifted !== 'right') fail(`a pointer lifted during the reach cancelled it (heldBy ${reach.heldAfterPointerLifted})`);
    if (reach.crouchAmountAfter > 0.01) fail(`the avatar did not stand back up (crouch ${reach.crouchAmountAfter})`);
    // The next mouse press lets the early-lifted prop go, like G (a press anywhere under the lock): it is set down on the floor.
    await page.mouse.down();
    await advance(1 / 60);
    reach.releasePhase = (await s.state()).objects.reach.phase;
    await page.mouse.up();
    await s.until((st) => !st.objects.items[0].heldBy, 4);
    reach.letGoByNextPress = !(await s.item()).heldBy;
    if (!reach.letGoByNextPress) fail('the next mouse press did not let the early-lifted prop go');
    const resting = await s.rest();
    reach.setDownFloorGapM = round(resting.boundsMin[1] - FLOOR_Y, 4);
    if (Math.abs(resting.boundsMin[1] - FLOOR_Y) > 0.003) fail(`the set-down prop rests ${reach.setDownFloorGapM} m from the floor`);
    return { label, status: failures.length ? 'fail' : 'pass', failures, pitchLimits, aimed, secondPress, reach };
  } finally {
    await s.context.close();
  }
}

export async function runPhoneFloorReach({ browser, baseUrl, consoleErrors }) {
  const label = 'phone-touch-floor-reach';
  const failures = [];
  const fail = (message) => failures.push(message);
  const s = await openPage(browser, baseUrl, consoleErrors, label, { viewport: PHONE, touch: true });
  const { page, advance } = s;
  try {
    const cdp = await page.context().newCDPSession(page);
    const touch = (type, id, x, y) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y, id, radiusX: 4, radiusY: 4, force: 1 }] });
    await advance(1);
    // Third person: the avatar's own G puts the prop on the floor near its feet.
    const floorProp = await s.putOnFloor();
    await advance(0.3);
    const centre = centreOf(floorProp);
    const at = await page.evaluate((p) => window.__projectToScreen(p), centre);
    if (!at) {
      fail('the floor prop does not project onto the screen');
      return { label, status: 'fail', failures };
    }
    const before = (await s.item()).position;
    let grabbed = false;
    let touchAt = at;
    let phaseAtTouch = null;
    for (const [ox, oy] of [[0, 0], [8, 0], [-8, 0], [0, 8], [0, -8], [14, 0], [-14, 0], [0, 14], [0, -14]]) {
      touchAt = { x: at.x + ox, y: at.y + oy };
      await touch('touchStart', 7, touchAt.x, touchAt.y);
      await advance(0.1);
      phaseAtTouch = (await s.state()).objects.reach.phase;
      if (phaseAtTouch === 'reach' || phaseAtTouch === 'lift') {
        grabbed = true;
        break;
      }
      await touch('touchEnd', 7, 0, 0);
      await advance(0.1);
    }
    if (!grabbed) {
      fail(`a touch on the floor prop near the feet never started a reach (projected at ${JSON.stringify(at)})`);
      return { label, status: 'fail', failures };
    }
    // A second touch anywhere on the look side, after the first lifted, cancels the reach: the body stands, nothing is grabbed.
    const secondTouch = { phaseBefore: phaseAtTouch };
    if (phaseAtTouch === 'reach') {
      await touch('touchEnd', 7, 0, 0);
      await advance(0.03);
      const lookSide = { x: PHONE.width * 0.7, y: PHONE.height * 0.3 };
      await touch('touchStart', 8, lookSide.x, lookSide.y);
      await advance(0.05);
      const cancelled = await s.state();
      await touch('touchEnd', 8, 0, 0);
      Object.assign(secondTouch, { phase: cancelled.objects.reach.phase, heldBy: cancelled.objects.items[0].heldBy, movedM: round(dist(cancelled.objects.items[0].position, before), 6) });
      if (secondTouch.phase !== 'idle' || secondTouch.heldBy || secondTouch.movedM > 1e-5) fail(`a second touch did not cancel the reach: ${JSON.stringify(secondTouch)}`);
      await s.until((st) => st.crouch.amount < 0.01 && st.crouch.squat === 0, 1.5);
      await touch('touchStart', 7, touchAt.x, touchAt.y);
      await advance(0.1);
      if ((await s.state()).objects.reach.phase !== 'reach') fail('the touch after the cancel did not start a reach');
    } else {
      fail(`the reach was already ${phaseAtTouch} 0.1 s after the touch, so the second-touch cancel tested nothing`);
    }
    const maxMovedBeforeHoldM = { v: 0 };
    let current = await s.state();
    for (let i = 0; i < 150 && !current.objects.items[0].heldBy; i += 1) {
      maxMovedBeforeHoldM.v = Math.max(maxMovedBeforeHoldM.v, dist(current.objects.items[0].position, before));
      await advance(1 / 60);
      current = await s.state();
    }
    const holding = await s.until((st) => st.objects.items[0].heldBy && st.objects.reach.phase === 'carry', 2.5);
    const grab = { heldBy: holding.state.objects.items[0].heldBy, phaseAtTouch, secToCarry: round(holding.sec), propMovedBeforeHoldM: round(maxMovedBeforeHoldM.v, 5), palmToPropM: round(holding.state.objects.reach.palmToPropM ?? -1, 4) };
    if (grab.heldBy !== 'right') fail(`a touch on the floor prop did not pick it up (heldBy ${grab.heldBy})`);
    if (grab.propMovedBeforeHoldM > 0.001) fail(`the prop moved ${grab.propMovedBeforeHoldM} m before the hand reached it`);
    // Lifting the finger sets it down, on the floor.
    await advance(0.3);
    await touch('touchEnd', 7, 0, 0);
    await s.until((st) => !st.objects.items[0].heldBy, 4);
    const resting = await s.rest();
    grab.setDownFloorGapM = round(resting.boundsMin[1] - FLOOR_Y, 4);
    if (Math.abs(resting.boundsMin[1] - FLOOR_Y) > 0.003) fail(`the touch set-down prop rests ${grab.setDownFloorGapM} m from the floor`);
    // A touch that lifted before the hand arrived still takes the prop; the next touch anywhere on the look side lets it go.
    await s.rearm();
    await s.putOnFloor();
    await advance(0.3);
    const restAt = await page.evaluate((p) => window.__projectToScreen(p), centreOf(await s.item()));
    let early9 = null;
    for (const [ox, oy] of [[0, 0], [8, 0], [-8, 0], [0, 8], [0, -8], [14, 0], [-14, 0], [0, 14], [0, -14]]) {
      if (!restAt) break;
      await touch('touchStart', 9, restAt.x + ox, restAt.y + oy);
      await advance(0.1);
      early9 = (await s.state()).objects.reach.phase;
      if (early9 === 'reach' || early9 === 'lift') break;
      await touch('touchEnd', 9, 0, 0);
      await advance(0.1);
    }
    if (early9 === 'reach' || early9 === 'lift') await touch('touchEnd', 9, 0, 0);
    else fail(`a touch on the resting prop never started a reach (phase ${early9}, projected at ${JSON.stringify(restAt)}, ${JSON.stringify(centreOf(await s.item()))})`);
    const early = await s.until((st) => st.objects.items[0].heldBy && st.objects.reach.phase === 'carry', 2.5);
    await advance(0.5);
    const earlyHeld = (await s.item()).heldBy;
    await touch('touchStart', 10, PHONE.width * 0.7, PHONE.height * 0.3);
    await advance(1 / 60);
    await touch('touchEnd', 10, 0, 0);
    const letGo = await s.until((st) => !st.objects.items[0].heldBy, 4);
    const earlyLift = { heldAfterLift: earlyHeld, secToCarry: round(early.sec), heldAfterNextTouch: letGo.state.objects.items[0].heldBy };
    if (earlyLift.heldAfterLift !== 'right') fail(`a touch lifted during the reach did not leave the prop held (${earlyLift.heldAfterLift})`);
    if (earlyLift.heldAfterNextTouch) fail('the next touch did not let the early-lifted prop go');
    await s.rest();
    return { label, status: failures.length ? 'fail' : 'pass', failures, grab, secondTouch, earlyLift };
  } finally {
    await s.context.close();
  }
}
