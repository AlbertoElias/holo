import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import { createXrContext, waitForPageFunctions, waitForTextContentPrefix, wireXrConsoleErrors } from '@holoim/tooling-testing/xr-env';

import * as THREE from 'three';

import { DesktopReach } from '../../src/objects/DesktopReach.ts';
import { ObjectInteraction } from '../../src/objects/ObjectInteraction.ts';
import { findNode, loadTake, relativePose, rigidPose, worldAt } from './object-glb.mjs';
import { OBJECT_URL, openCapture, poseOf, readState, saveDownload, squatTracker, recordEveryStep, stepJumps } from './object-take.mjs';

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

async function openPage(browser, baseUrl, consoleErrors, label, { viewport, touch, scene }) {
  const context = await createXrContext(browser, { viewport, acceptDownloads: true, ...(touch ? { hasTouch: true, isMobile: true, deviceScaleFactor: 2 } : {}) });
  const page = await context.newPage();
  wireXrConsoleErrors(page, consoleErrors, { label });
  await page.route('**/__holoim/input-recordings*', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '{"path":"object-reach-input.json"}' }));
  await openCapture(page, baseUrl, { object: OBJECT_URL, ...(scene ? { scene } : {}) });
  await waitForPageFunctions(page, ['__projectToScreen', '__loadObjectUrl', '__setMockInput', '__sampleHolds']);
  await waitForTextContentPrefix(page, '#status', 'loaded');
  await recordEveryStep(page);
  const advance = (seconds) => page.evaluate((ms) => window.advanceTime(ms), Math.round(seconds * 60) * STEP_MS);
  // Every state a check reads is also a sample of how the body looks: torso lean, head over hips, ankles under the body.
  const tracker = squatTracker(FLOOR_Y);
  const state = async () => {
    const st = await readState(page);
    tracker.sample(st);
    return st;
  };
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
    if (!carried.state.objects.items[0].heldBy) throw new Error(`the setup pickup did not hold the prop ${JSON.stringify({ reach: carried.state.objects.reach, avatar: carried.state.avatar, prop: carried.state.objects.items[0].position, shoulder: carried.state.pose.shoulder, sec: carried.sec })}`);
    await advance(0.3);
    await page.keyboard.press('KeyG');
    await until((st) => !st.objects.items[0].heldBy, 4);
    const resting = await rest();
    await until((st) => st.crouch.amount < 0.01, 2);
    return resting;
  };
  /** Walks backward (S) until the avatar's root is `distanceM` from the prop across the floor, then stands still. */
  const backOff = async (distanceM) => {
    await page.locator('canvas').first().focus();
    await page.keyboard.down('KeyS');
    for (let i = 0; i < 4 * 60; i += 1) {
      await advance(1 / 60);
      const st = await state();
      const prop = st.objects.items[0];
      if (Math.hypot(st.avatar.x - centreOf(prop)[0], st.avatar.z - centreOf(prop)[2]) >= distanceM) break;
    }
    await page.keyboard.up('KeyS');
    await advance(0.6);
  };
  const rearm = async () => {
    if (!(await page.evaluate((url) => window.__loadObjectUrl(url), OBJECT_URL))) throw new Error('the object did not reload');
    await advance(0.3);
  };
  // The prop placed while the page loads sits further out than the avatar's reach; place it again in front of the settled avatar.
  await advance(1);
  await rearm();
  return { context, page, advance, state, item, until, rest, putOnFloor, backOff, rearm, tracker };
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
  interaction.pendingStep = { x: 0, z: 0 };
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
    // Stand back so a squat can't reach the prop from here: the reach has to step in first.
    await s.backOff(0.5);
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
    // The squat plants the feet where the step left them: the slide reference is the stance at the first squat frame.
    let plantedFeet = null;
    const sampleFeet = (st) => {
      if (st.objects.reach.phase === 'step' || (st.objects.reach.phase === 'idle' && !plantedFeet)) return;
      plantedFeet ??= st.locomotion.legs.map((leg) => leg.foot);
      st.locomotion.legs.forEach((leg, i) => {
        const stand = plantedFeet[i];
        feet.maxRiseM = Math.max(feet.maxRiseM, leg.foot.y - stand.y);
        feet.maxDropM = Math.max(feet.maxDropM, stand.y - leg.foot.y);
        feet.minY = Math.min(feet.minY, leg.foot.y);
        feet.maxSlideM = Math.max(feet.maxSlideM, Math.hypot(leg.foot.x - plantedFeet[i].x, leg.foot.z - plantedFeet[i].z));
      });
      feet.frames += 1;
    };
    // Step in, spine pitch and the third-person camera, sampled every frame of the pickup.
    const stepIn = { sawStep: false, rootStart: [state0.avatar.x, state0.avatar.z], toeToPropBeforeM: null, toeToPropAfterM: null, aheadAfterM: null, movedM: null, stepSec: null, peakSpeedMps: 0, graspXZ: null };
    const pitch = { maxDeg: 0, atDemand: null, shoulderToGraspMinM: Infinity, shoulderToGraspAtFullM: null, hipsYAtFull: null };
    const cam = { minY: Infinity, maxY: -Infinity, squatMinPitch: Infinity, squatMaxPitch: -Infinity };
    const toeMid = (st) => {
      const [a, b] = st.pose.toes;
      return a && b ? [(a.x + b.x) / 2, (a.z + b.z) / 2] : null;
    };
    const grasp = [(start.boundsMin[0] + start.boundsMax[0]) / 2, (start.boundsMin[2] + start.boundsMax[2]) / 2];
    stepIn.graspXZ = grasp.map((v) => round(v));
    {
      const toes0 = toeMid(state0);
      stepIn.toeToPropBeforeM = toes0 ? round(Math.hypot(grasp[0] - toes0[0], grasp[1] - toes0[1]), 4) : null;
    }
    const toeAhead = { minM: Infinity };
    let minHipsY = Infinity;
    let stepStartStep = null;
    const samplePose = (st) => {
      const phase = st.objects.reach.phase;
      if (st.pose.hips) minHipsY = Math.min(minHipsY, st.pose.hips.y);
      // The feet must not twist as the legs fold: each toe stays ahead of its ankle along the facing.
      st.pose.toes.forEach((toe, i) => {
        if (!toe) return;
        const ankle = st.locomotion.legs[i].foot;
        const ahead = (toe.x - ankle.x) * -Math.sin(st.avatar.yaw) + (toe.z - ankle.z) * -Math.cos(st.avatar.yaw);
        toeAhead.minM = Math.min(toeAhead.minM, ahead);
      });
      if (st.pose.spinePitchDeg !== null) {
        if (st.pose.spinePitchDeg > pitch.maxDeg) pitch.atDemand = round(st.objects.reach.demand);
        pitch.maxDeg = Math.max(pitch.maxDeg, st.pose.spinePitchDeg);
      }
      if (st.pose.shoulder && phase === 'reach') {
        const d = Math.hypot(st.pose.shoulder.x - grasp[0], st.pose.shoulder.y - start.boundsMax[1], st.pose.shoulder.z - grasp[1]);
        pitch.shoulderToGraspMinM = Math.min(pitch.shoulderToGraspMinM, d);
        if (st.objects.reach.demand >= 0.999) {
          pitch.shoulderToGraspAtFullM = d;
          pitch.hipsYAtFull = st.pose.hips.y;
        }
      }
      cam.minY = Math.min(cam.minY, st.camera.y);
      cam.maxY = Math.max(cam.maxY, st.camera.y);
      if (st.objects.reach.demand > 0 && st.crouch.amount > 0.01) {
        cam.squatMinPitch = Math.min(cam.squatMinPitch, st.camera.pitchDeg);
        cam.squatMaxPitch = Math.max(cam.squatMaxPitch, st.camera.pitchDeg);
      }
      if (phase === 'step') {
        if (!stepIn.sawStep) stepStartStep = recSteps;
        stepIn.sawStep = true;
        stepIn.peakSpeedMps = Math.max(stepIn.peakSpeedMps, st.locomotion.horizontalSpeed);
        if (st.locomotion.state === 'walk') stepIn.walkFrames = (stepIn.walkFrames ?? 0) + 1;
      } else if (stepIn.sawStep && stepIn.stepSec === null) stepIn.stepSec = round((recSteps - stepStartStep) / 60);
      if (stepIn.toeToPropAfterM === null && (phase === 'reach' || phase === 'lift') && toeMid(st)) {
        const toes = toeMid(st);
        stepIn.toeToPropAfterM = round(Math.hypot(grasp[0] - toes[0], grasp[1] - toes[1]), 4);
        const yaw = st.avatar.yaw;
        stepIn.aheadAfterM = round((grasp[0] - toes[0]) * -Math.sin(yaw) + (grasp[1] - toes[1]) * -Math.cos(yaw), 4);
        stepIn.movedM = round(Math.hypot(st.avatar.x - stepIn.rootStart[0], st.avatar.z - stepIn.rootStart[1]), 4);
        reachStartStep = recSteps;
      }
    };
    let reachStartStep = null;
    for (let i = 0; i < 4 * 60; i += 1) {
      await step(1);
      const st = await s.state();
      if (carryStep === null || standStep === null) {
        sampleFeet(st);
        samplePose(st);
      }
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
    // The step in has its own time budget; the 1.5 s covers the squat, from the end of the step.
    const secToGrab = grabStep === null ? null : (grabStep - (reachStartStep ?? pressStep)) / 60;
    const secPressToGrab = grabStep === null ? null : (grabStep - pressStep) / 60;
    if (secToGrab !== null && secToGrab > 1.5) fail(`the palm reached the prop ${round(secToGrab)} s after the step in (limit 1.5 s)`);
    // Step in: the grasp point ends 0.2 to 0.3 m ahead of the toes, and the root moved the needed distance.
    const neededStepM = stepIn.toeToPropBeforeM === null ? 0 : Math.max(0, stepIn.toeToPropBeforeM - 0.25);
    stepIn.neededM = round(neededStepM, 4);
    if (stepIn.toeToPropAfterM === null) fail('the step in never ended in a reach');
    else {
      if (stepIn.toeToPropAfterM < 0.2 || stepIn.toeToPropAfterM > 0.3) fail(`after the step the prop's grasp point was ${stepIn.toeToPropAfterM} m from the toes (need 0.20 to 0.30 m)`);
      if (stepIn.aheadAfterM < 0.2 || stepIn.aheadAfterM > 0.3) fail(`after the step the grasp point was ${stepIn.aheadAfterM} m ahead of the toes along the facing (need 0.20 to 0.30 m)`);
      if (stepIn.sawStep && !(stepIn.walkFrames > 10)) fail(`the legs did not walk during the step (${stepIn.walkFrames ?? 0} walk frames)`);
      if (neededStepM >= 0.05 && (!stepIn.sawStep || Math.abs(stepIn.movedM - neededStepM) > 0.02)) fail(`the step moved the root ${stepIn.movedM} m, the stance needed ${stepIn.neededM} m (within 0.02 m)`);
    }
    stepIn.minToeAheadOfAnkleM = round(toeAhead.minM, 4);
    if (toeAhead.minM < 0.06) fail(`a foot twisted: a toe came within ${stepIn.minToeAheadOfAnkleM} m of its ankle along the facing (standing ${round(Math.hypot(0.123), 3)} m, limit 0.06 m)`);
    // Rendered hips bone height above the floor: a natural squat keeps them at 0.35 m or more.
    const hipsPickupAboveFloorM = round(minHipsY - FLOOR_Y, 3);
    if (hipsPickupAboveFloorM < 0.35) fail(`the hips went down to ${hipsPickupAboveFloorM} m above the floor during the pickup (limit 0.35 m)`);
    const spineReport = { maxDeg: round(pitch.maxDeg, 1), atDemand: pitch.atDemand, shoulderToGraspMinM: round(pitch.shoulderToGraspMinM, 3), shoulderToGraspAtFullM: pitch.shoulderToGraspAtFullM && round(pitch.shoulderToGraspAtFullM, 3), hipsYAtFull: pitch.hipsYAtFull && round(pitch.hipsYAtFull, 3) };
    if (pitch.maxDeg > 47) fail(`the spine pitched ${spineReport.maxDeg} degrees during the pickup (limit 45, tolerance 47)`);
    const cameraReport = { yRangeM: round(cam.maxY - cam.minY, 4), squatPitchRangeDeg: round(cam.squatMaxPitch - cam.squatMinPitch, 3) };
    if (cameraReport.yRangeM > 0.01) fail(`the follow camera's height moved ${cameraReport.yRangeM} m during the pickup (limit 0.01 m)`);
    if (cameraReport.squatPitchRangeDeg > 1) fail(`the follow camera pitched ${cameraReport.squatPitchRangeDeg} degrees during the squat (limit 1 degree)`);
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
    let lowerPitchDeg = 0;
    let lowerMinHipsY = Infinity;
    const lowerCam = { min: Infinity, max: -Infinity };
    for (let i = 0; i < 4 * 60 && !launch; i += 1) {
      await step(1);
      const st = await s.state();
      lowerPitchDeg = Math.max(lowerPitchDeg, st.pose.spinePitchDeg ?? 0);
      if (st.pose.hips) lowerMinHipsY = Math.min(lowerMinHipsY, st.pose.hips.y);
      lowerCam.min = Math.min(lowerCam.min, st.camera.y);
      lowerCam.max = Math.max(lowerCam.max, st.camera.y);
      lowestSquat = Math.max(lowestSquat, st.objects.reach.demand);
      const prop = st.objects.items[0];
      if (!prop.heldBy) launch = prop;
    }
    if (!launch) fail('the low set-down never let go of the prop');
    const hipsLowerAboveFloorM = round(lowerMinHipsY - FLOOR_Y, 3);
    if (hipsLowerAboveFloorM < 0.35) fail(`the hips went down to ${hipsLowerAboveFloorM} m above the floor during the low set-down (limit 0.35 m)`);
    if (lowerPitchDeg > 47) fail(`the spine pitched ${round(lowerPitchDeg, 1)} degrees during the low set-down (limit 45, tolerance 47)`);
    if (lowerCam.max - lowerCam.min > 0.01) fail(`the follow camera's height moved ${round(lowerCam.max - lowerCam.min, 4)} m during the low set-down (limit 0.01 m)`);
    // The set-down leaves the prop about 0.25 m ahead of the toes, so picking it up again needs no step.
    const afterSetDown = await s.state();
    const toesAfter = toeMid(afterSetDown);
    const propAfter = launch && centreOf(launch);
    const reachAgainStepM = toesAfter && propAfter ? round(Math.max(0, Math.hypot(propAfter[0] - toesAfter[0], propAfter[2] - toesAfter[1]) - 0.25), 4) : null;
    if (reachAgainStepM === null || reachAgainStepM >= 0.05) fail(`the set-down left the prop ${reachAgainStepM} m beyond the squat stance, so picking it up again would need a step (limit 0.05 m)`);
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

    // --- Reach radius: from further out than a squat reaches the avatar steps in, up to arm reach plus the step. ---
    const farReach = {};
    for (const distanceM of [0.55, 0.7]) {
      await s.rearm();
      await s.putOnFloor();
      await s.backOff(distanceM);
      const before = await s.state();
      const prop0 = before.objects.items[0];
      const graspFar = [(prop0.boundsMin[0] + prop0.boundsMax[0]) / 2, (prop0.boundsMin[2] + prop0.boundsMax[2]) / 2];
      const rootToPropM = round(Math.hypot(graspFar[0] - before.avatar.x, graspFar[1] - before.avatar.z), 3);
      await page.keyboard.press('KeyG');
      let aheadM = null;
      let minHips = Infinity;
      let held = null;
      for (let i = 0; i < 5 * 60 && !held; i += 1) {
        await advance(1 / 60);
        const st = await s.state();
        minHips = Math.min(minHips, st.pose.hips.y);
        if (aheadM === null && st.objects.reach.phase === 'reach') {
          const [a, b] = st.pose.toes;
          const mx = (a.x + b.x) / 2;
          const mz = (a.z + b.z) / 2;
          aheadM = round((graspFar[0] - mx) * -Math.sin(st.avatar.yaw) + (graspFar[1] - mz) * -Math.cos(st.avatar.yaw), 3);
        }
        if (st.objects.items[0].heldBy && st.objects.reach.phase === 'carry') held = st;
      }
      farReach[distanceM] = { rootToPropM, heldBy: held?.objects.items[0].heldBy ?? null, aheadAfterStepM: aheadM, minHipsAboveFloorM: round(minHips - FLOOR_Y, 3) };
      if (!held) fail(`G with the prop ${rootToPropM} m from the avatar's root never picked it up (phase ${(await s.state()).objects.reach.phase})`);
      else if (aheadM < 0.2 || aheadM > 0.3) fail(`from ${rootToPropM} m the step left the grasp point ${aheadM} m ahead of the toes (need 0.20 to 0.30 m)`);
      if (minHips - FLOOR_Y < 0.35) fail(`from ${rootToPropM} m the hips went down to ${round(minHips - FLOOR_Y, 3)} m above the floor (limit 0.35 m)`);
      await s.until((st) => st.crouch.amount < 0.01, 2);
    }

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
      if (after.sec > 0.5 + 2 / 60) fail(`${name}: the crouch took ${cancels[name].standSec} s to end (limit 0.5 s after the cancel, plus two frames of sampling)`);
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

    s.tracker.assert(fail, 'the body');
    const jumps = await stepJumps(s.page, 'the body', fail);
    return { label, squat: s.tracker.result(), continuity: jumps, status: failures.length ? 'fail' : 'pass', failures, glb, floor, pickup: { secToGrab, secPressToGrab, palmAtGrabM: palmAtGrabM && round(palmAtGrabM, 4), maxMovedBeforeHoldM: round(maxMovedBeforeHoldM, 6), rigidHoldChangeM: rigidM, crouchBackSec, heldSamples: samples.length }, feet: footReport, stepIn, spine: { ...spineReport, lowerMaxDeg: round(lowerPitchDeg, 1), hipsPickupAboveFloorM, hipsLowerAboveFloorM }, camera: { ...cameraReport, lowerYRangeM: round(lowerCam.max - lowerCam.min, 4) }, reachAgainStepM, farReach, setDown, export: exportReport, cancels };
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
      if (!['step', 'reach'].includes(again.objects.reach.phase)) fail(`the press after the cancel did not start a reach (phase ${again.objects.reach.phase})`);
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
    s.tracker.assert(fail, 'the body');
    const jumps = await stepJumps(s.page, 'the body', fail);
    return { label, squat: s.tracker.result(), continuity: jumps, status: failures.length ? 'fail' : 'pass', failures, pitchLimits, aimed, secondPress, reach };
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
      if (!['step', 'reach'].includes((await s.state()).objects.reach.phase)) fail('the touch after the cancel did not start a reach');
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
      if (['step', 'reach', 'lift'].includes(early9)) break;
      await touch('touchEnd', 9, 0, 0);
      await advance(0.1);
    }
    if (['step', 'reach', 'lift'].includes(early9)) await touch('touchEnd', 9, 0, 0);
    else fail(`a touch on the resting prop never started a reach (phase ${early9}, projected at ${JSON.stringify(restAt)}, ${JSON.stringify(centreOf(await s.item()))}, avatar ${JSON.stringify((await s.state()).avatar)}, shoulder ${JSON.stringify((await s.state()).pose.shoulder)}, crouch ${JSON.stringify((await s.state()).crouch)})`);
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
    s.tracker.assert(fail, 'the body');
    const jumps = await stepJumps(s.page, 'the body', fail);
    return { label, squat: s.tracker.result(), continuity: jumps, status: failures.length ? 'fail' : 'pass', failures, grab, secondTouch, earlyLift };
  } finally {
    await s.context.close();
  }
}


/**
 * A press of G toward a prop that the scene makes unsafe or unreachable: the avatar must not leave its ground, and must not take the prop.
 * `scene` is a hazard fixture (fixtures/scenes/reach-*.gltf, from scripts/generate-reach-hazard-scenes.mjs).
 */
async function runHazard({ browser, baseUrl, consoleErrors, label, scene, prepare, check }) {
  const failures = [];
  const fail = (message) => failures.push(`${label}: ${message}`);
  const s = await openPage(browser, baseUrl, consoleErrors, label, { viewport: VIEWPORT, touch: false, scene });
  const { page, advance } = s;
  try {
    await advance(1);
    await prepare(s);
    const settled = await s.rest();
    const start = await s.state();
    const startProp = settled.position;
    await page.locator('canvas').first().focus();
    await page.keyboard.press('KeyG');
    const seen = new Set();
    let held = false;
    let minY = Infinity;
    let maxMovedM = 0;
    let maxRootDropM = 0;
    let minZ = Infinity;
    for (let i = 0; i < 4 * 60; i += 1) {
      await advance(1 / 60);
      const st = await s.state();
      seen.add(st.objects.reach.phase);
      held ||= Boolean(st.objects.items[0].heldBy);
      minY = Math.min(minY, st.avatar.y);
      minZ = Math.min(minZ, st.avatar.z);
      maxMovedM = Math.max(maxMovedM, Math.hypot(st.avatar.x - start.avatar.x, st.avatar.z - start.avatar.z));
      maxRootDropM = Math.max(maxRootDropM, start.avatar.y - st.avatar.y);
    }
    const end = await s.state();
    const propMovedM = dist(end.objects.items[0].position, startProp);
    const report = { propStart: startProp.map((v) => round(v)), phases: [...seen], held, avatarStart: [start.avatar.x, start.avatar.y, start.avatar.z].map((v) => round(v)), maxRootDropM: round(maxRootDropM, 4), maxMovedM: round(maxMovedM, 4), minZ: round(minZ, 4), propMovedM: round(propMovedM, 4), propHeldBy: end.objects.items[0].heldBy };
    check({ fail, report, start, end });
    if (!(report.propStart[1] < start.avatar.y - 0.3) && label === 'reach-pit') fail(`the prop did not end up in the pit (y ${report.propStart[1]}, feet ${round(start.avatar.y)})`);
    s.tracker.sample(end);
    return { label, status: failures.length ? 'fail' : 'pass', failures, hazard: report };
  } finally {
    await s.context.close();
  }
}

/** Holds a key until the avatar's state says it is there (at most 5 s). */
async function walkUntil(s, key, done) {
  await s.page.locator('canvas').first().focus();
  await s.page.keyboard.down(key);
  for (let i = 0; i < 5 * 60 && !done(await s.state()); i += 1) await s.advance(1 / 60);
  await s.page.keyboard.up(key);
  await s.advance(0.6);
}

/** A prop across a gap in the floor: the step in stops at the edge, the avatar neither falls nor walks onto nothing. */
export const runTrenchReach = (ctx) =>
  runHazard({
    ...ctx,
    label: 'reach-trench',
    scene: process.env.HAZARD_SCENE ?? '/fixtures/scenes/reach-trench.gltf',
    // The avatar sets the prop down at z -0.24, then backs off across the trench (z 0.10 to 0.30) to z 0.38.
    prepare: async (s) => {
      await s.putOnFloor();
      await walkUntil(s, 'KeyS', (st) => st.avatar.z >= 0.38);
    },
    check: ({ fail, report, start }) => {
      if (report.maxRootDropM > 0.05) fail(`the avatar dropped ${report.maxRootDropM} m: it stepped off the edge`);
      // The step began on the near strip (z 0.38 or more) and the trench's near edge is z 0.30: the root stays on the strip.
      if (start.avatar.z < 0.3) fail(`the avatar started at z ${start.avatar.z}, not on the near side of the trench`);
      if (report.minZ < 0.3 - 0.02) fail(`the avatar's root went to z ${report.minZ}, over the trench (near edge at 0.30)`);
      if (!report.phases.some((phase) => phase === 'step' || phase === 'reach')) fail(`G did not start a reach at all (phases ${report.phases}); the guard was never exercised`);
    }
  });

/** A prop behind a thin wall, within the arm's radius: no grab, the prop untouched. */
export const runWallReach = (ctx) =>
  runHazard({
    ...ctx,
    label: 'reach-wall',
    scene: process.env.HAZARD_SCENE ?? '/fixtures/scenes/reach-wall.gltf',
    // The prop is set down at x 0; the avatar walks out through the doorway (z 0.6 to 1.4) to x -0.72 and back up to the prop's row.
    prepare: async (s) => {
      await s.putOnFloor();
      await walkUntil(s, 'KeyS', (st) => st.avatar.z >= 1.0);
      await walkUntil(s, 'KeyA', (st) => st.avatar.x <= -0.72);
      await walkUntil(s, 'KeyW', (st) => st.avatar.z <= -0.2);
    },
    check: ({ fail, report, start }) => {
      if (!(start.avatar.x < -0.6)) fail(`the avatar did not get round to the far side of the wall (x ${start.avatar.x})`);
      if (report.held || report.propHeldBy) fail(`the prop was taken across a wall (heldBy ${report.propHeldBy})`);
      if (report.propMovedM > 0.02) fail(`the prop behind the wall moved ${report.propMovedM} m`);
      if (report.phases.some((phase) => phase !== 'idle')) fail(`a reach began toward a prop behind a wall (phases ${report.phases})`);
      if (report.maxMovedM > 0.02) fail(`the avatar moved ${report.maxMovedM} m toward a prop behind a wall`);
    }
  });

/**
 * A railing (an 8 cm bar at 0.55 to 0.63 m) between the avatar and the prop: the line from the shoulder to the prop is clear while standing, and the lowering
 * shoulder puts the bar in the way mid-squat. The reach must be cancelled once the bar is in the way, never complete.
 */
export const runRailingReach = (ctx) =>
  runHazard({
    ...ctx,
    label: 'reach-railing',
    scene: process.env.HAZARD_SCENE ?? '/fixtures/scenes/reach-railing.gltf',
    prepare: async (s) => {
      await s.putOnFloor();
      await walkUntil(s, 'KeyS', (st) => st.avatar.z >= 1.0);
      await walkUntil(s, 'KeyA', (st) => st.avatar.x <= -0.72);
      await walkUntil(s, 'KeyW', (st) => st.avatar.z <= -0.2);
    },
    check: ({ fail, report, start }) => {
      if (!(start.avatar.x < -0.6)) fail(`the avatar did not get round to the far side of the railing (x ${start.avatar.x})`);
      if (report.held || report.propHeldBy) fail(`the prop was taken across a railing (heldBy ${report.propHeldBy})`);
      if (report.propMovedM > 0.02) fail(`the prop behind the railing moved ${report.propMovedM} m`);
      if (!report.phases.includes('reach')) fail(`no reach began (phases ${report.phases}); the railing was never in the way mid-squat`);
    }
  });

/** A prop 1.2 m below the avatar's feet (a drop): not reachable, no step, no fall. */
export const runPitReach = (ctx) =>
  runHazard({
    ...ctx,
    label: 'reach-pit',
    scene: process.env.HAZARD_SCENE ?? '/fixtures/scenes/reach-pit.gltf',
    // The avatar sets the prop down at the rim; it falls into the pit.
    prepare: async (s) => {
      await s.putOnFloor();
    },
    check: ({ fail, report }) => {
      if (report.held || report.propHeldBy) fail(`the prop 1.2 m below the feet was taken (heldBy ${report.propHeldBy})`);
      if (report.phases.some((phase) => phase !== 'idle')) fail(`a reach began toward a prop in a pit (phases ${report.phases})`);
      if (report.maxRootDropM > 0.02 || report.maxMovedM > 0.02) fail(`the avatar moved (${report.maxMovedM} m) or dropped (${report.maxRootDropM} m) for a prop in a pit`);
    }
  });

/**
 * Entering VR mid-step leaves no queued step: the interaction's update in VR clears it, and the next frame out of VR carries no displacement.
 * Driven on the class itself (as standingSetDownWalk is): a real headset session can not be entered at an exact step of the reach.
 */
export function runVrEntryMidStep() {
  const failures = [];
  const interaction = Object.create(ObjectInteraction.prototype);
  interaction.reach = new DesktopReach();
  interaction.reach.phase = 'step';
  interaction.hold = null;
  interaction.pendingStep = { x: 0.012, z: -0.008 };
  interaction.clock = 0;
  interaction.deps = { avatar: { avatar: {} }, registry: { eventObjects: () => [], all: () => [] }, carry: { idle: () => {} }, grabInput: { reset: () => {} } };
  interaction.updateVr = () => {};
  interaction.place = () => {};
  const vrFrame = { deltaSec: 1 / 60, vrActive: true, bodyYaw: 0 };
  interaction.update(vrFrame);
  const afterEntry = interaction.takeReachStep();
  if (afterEntry !== null) fail(`a step of ${JSON.stringify(afterEntry)} stayed queued after VR entry`);
  if (interaction.reach.phase !== 'idle') failures.push(`the reach was ${interaction.reach.phase} after VR entry (need idle)`);
  // A queued step stays cleared however many VR frames pass, and the movement system takes it every frame (VR or not), so nothing carries out of VR.
  interaction.pendingStep = { x: 0.02, z: 0 };
  interaction.update(vrFrame);
  const second = interaction.takeReachStep();
  if (second !== null) failures.push(`a step stayed queued on a later VR frame (${JSON.stringify(second)})`);
  function fail(message) {
    failures.push(message);
  }
  return { label: 'reach-vr-entry-mid-step', status: failures.length ? 'fail' : 'pass', failures };
}

/**
 * The way to the prop is checked on every frame of a reach, not at its start: the shoulder moves through the squat. A railing that closes the line mid-squat
 * can not be set up where the avatar can also stand close enough to grab (its body is in the way of the bar), so this drives `stillReaching` on the class
 * with the obstruction opening and closing between frames.
 */
export function runRevalidatesEveryFrame() {
  const failures = [];
  const object = { wrapper: new THREE.Group() };
  const interaction = Object.create(ObjectInteraction.prototype);
  interaction.reach = new DesktopReach();
  interaction.reach.begin(object, false, 0);
  interaction.reach.grasp.set(0, 0.13, -0.3);
  interaction.pos = new THREE.Vector3();
  interaction.pos2 = new THREE.Vector3();
  interaction.quat = new THREE.Quaternion();
  interaction.scale = new THREE.Vector3();
  interaction.deps = {
    registry: { all: () => [object] },
    carry: { getReach: () => 0.5 },
    avatar: { getBoneWorldPosition: (_ref, out) => out.set(0.1, 1.0, 0) }
  };
  interaction.desktopReachable = () => true;
  let blocked = false;
  interaction.reachBlocked = () => blocked;
  const frame = { deltaSec: 1 / 60, desktop: { walking: false, pointHeld: false } };
  const log = [];
  for (let i = 0; i < 40; i += 1) {
    // Open at first, shut from frame 10 to 20 (the bar between the lowering shoulder and the prop), open again.
    blocked = i >= 10 && i < 20;
    const going = interaction.stillReaching(frame);
    log.push(going);
    if (!going) break;
  }
  if (log.length !== 11 || log[10] !== false) failures.push(`the reach did not end on the first blocked frame (ended after ${log.length} frames: ${log.map(Number).join('')})`);
  if (log.slice(0, 10).some((going) => !going)) failures.push('the reach ended before the way was blocked');
  return { label: 'reach-revalidates-every-frame', status: failures.length ? 'fail' : 'pass', failures };
}
