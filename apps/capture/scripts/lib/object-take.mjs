import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import * as THREE from 'three';

import {
  attachXrEnvironment,
  createXrContext,
  enterIwerSessionFromButton,
  freezePageClock,
  waitForIwerRuntime,
  waitForPageFunctions,
  waitForTextContentPrefix,
  waitForXrRenderLoop,
  wireXrConsoleErrors
} from '@holoim/tooling-testing/xr-env';

import { angleDeg, findNode, loadTake, objectNodes, relativePose, rigidPose, worldAt } from './object-glb.mjs';

// Explain with an object (PRD-043): scripted takes that load the bracket
// fixture, grab it, move and turn it, and put it down, through capture's real
// input paths, then read the exported GLB.
//   - IWER controllers: a squeeze out of reach and a trigger press grab
//     nothing; a squeeze with the avatar hand on the object grabs it; moving
//     and turning the controller moves and turns the object rigidly with the
//     avatar's hand; releasing hands it to physics, which drops it to the
//     floor and leaves it at rest.
//   - Desktop: a take with no object exports no object; the overlay picker
//     refuses an unsupported file and loads the bracket; G picks it up into
//     the right hand, Q turns it, walking carries it, G puts it down
//     (it drops to the floor, no throw), and G out of reach does nothing.
// Each export is checked: one RecordedObject node, as many keys as the
// avatar, a valid HOLOIM_objects extension with the hold span, and the
// object's pose relative to the avatar's RightHand matching capture's.

export const OBJECT_URL = '/fixtures/objects/bracket.glb';
const SCENE = '/fixtures/scenes/body-floor.gltf';
const STEP_MS = 1000 / 60;
const VIEWPORT = { width: 640, height: 400 };
// Rigid hold, read from capture's own state each step.
const RIGID_POSITION_M = 0.002;
const RIGID_ANGLE_DEG = 0.5;
// GLB against capture.
const EXPORT_POSITION_M = 0.01;
const EXPORT_ANGLE_DEG = 1;
const SPAN_TOLERANCE_SEC = 0.1;
// A released prop settles within this long and rests within this far of the surface.
const REST_TIMEOUT_SEC = 3;
const FLOOR_TOLERANCE_M = 0.01;
// The scene sits 0.01 m above its authored floor.
const FLOOR_Y = 0.01;

const v3 = (a) => new THREE.Vector3(...a);
const q4 = (a) => new THREE.Quaternion(...a);
const round = (value, digits = 4) => Number(value.toFixed(digits));
const smooth = (t) => t * t * (3 - 2 * t);

export function poseOf(entry) {
  return entry ? { position: v3(entry.position), quaternion: q4(entry.quaternion) } : null;
}

export async function setupPage(browser, { iwer, consoleErrors, label }) {
  const context = await createXrContext(browser, { viewport: VIEWPORT, acceptDownloads: true });
  const page = await context.newPage();
  wireXrConsoleErrors(page, consoleErrors, { label });
  await page.route('**/__holoim/input-recordings*', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '{"path":"object-take-input.json"}' }));
  if (iwer) await attachXrEnvironment(page, { mode: 'iwer', cacheClearState: true });
  return { context, page };
}

export async function openCapture(page, baseUrl, query) {
  const url = new URL(baseUrl);
  url.searchParams.set('scene', SCENE);
  url.searchParams.set('sceneScale', '1');
  url.searchParams.set('manualClock', '1');
  // XR_AVATAR_URL: run the same take on another avatar (the avatars check sets it per fixture).
  if (process.env.XR_AVATAR_URL) url.searchParams.set('avatar', process.env.XR_AVATAR_URL);
  for (const [key, value] of Object.entries(query)) {
    if (Array.isArray(value)) for (const item of value) url.searchParams.append(key, item);
    else url.searchParams.set(key, value);
  }
  await page.goto(url.href, { waitUntil: 'networkidle' });
  await waitForPageFunctions(page, ['advanceTime', 'render_game_to_text', '__setManualClock', '__setFrameStepping', '__setSpectatorView']);
  await waitForTextContentPrefix(page, '#status', 'loaded');
}

/**
 * What a squat looks like, over the sampled frames: the hips' lowest height above the floor, the torso's lean from vertical
 * (hips to head, and hips to neck), the head's height over the hips, and where each ankle is relative to the hips along the
 * facing (a leg trailing back, or flung forward). Every squat in every check keeps the limits asserted below.
 */
export function squatTracker(floorY = 0.01) {
  const t = { n: 0, nTorso: 0, nSpine: 0, nHead: 0, nAnkle: 0, minHipsAboveFloorM: Infinity, maxSpinePitchDeg: 0, maxTorsoDeg: 0, minHeadOverHipsM: Infinity, minAnkleAheadM: Infinity, maxAnkleAheadM: -Infinity, frames: [] };
  return {
    sample(st) {
      const p = st.pose;
      if (!p?.hips) return;
      t.n += 1;
      t.minHipsAboveFloorM = Math.min(t.minHipsAboveFloorM, p.hips.y - floorY);
      if (Number.isFinite(p.spinePitchDeg)) t.nSpine += 1;
      if (Number.isFinite(p.torsoPitchDeg)) t.nTorso += 1;
      if (p.head && Number.isFinite(p.head.y)) t.nHead += 1;
      if (typeof p.spinePitchDeg === 'number') t.maxSpinePitchDeg = Math.max(t.maxSpinePitchDeg, p.spinePitchDeg);
      if (typeof p.torsoPitchDeg === 'number') t.maxTorsoDeg = Math.max(t.maxTorsoDeg, p.torsoPitchDeg);
      if (p.head) t.minHeadOverHipsM = Math.min(t.minHeadOverHipsM, p.head.y - p.hips.y);
      for (const a of p.ankles ?? []) {
        if (!a) continue;
        const ahead = (a.x - p.hips.x) * -Math.sin(st.avatar.yaw) + (a.z - p.hips.z) * -Math.cos(st.avatar.yaw);
        if (Number.isFinite(ahead)) t.nAnkle += 1;
        t.minAnkleAheadM = Math.min(t.minAnkleAheadM, ahead);
        t.maxAnkleAheadM = Math.max(t.maxAnkleAheadM, ahead);
      }
      t.frames.push([st.objects?.reach?.phase, Number(st.objects?.reach?.demand?.toFixed(2)), Number((p.hips.y - floorY).toFixed(3)), Number(p.torsoPitchDeg?.toFixed(1)), Number((p.head ? p.head.y - p.hips.y : 0).toFixed(3))]);
    },
    result: () => ({
      minHipsAboveFloorM: Number(t.minHipsAboveFloorM.toFixed(3)),
      maxSpinePitchDeg: Number(t.maxSpinePitchDeg.toFixed(1)),
      maxTorsoDeg: Number(t.maxTorsoDeg.toFixed(1)),
      minHeadOverHipsM: Number(t.minHeadOverHipsM.toFixed(3)),
      ankleAheadOfHipsM: [Number(t.minAnkleAheadM.toFixed(3)), Number(t.maxAnkleAheadM.toFixed(3))]
    }),
    trace: () => t.frames.filter((_, i) => i % 4 === 0),
    assert(fail, label) {
      const r = this.result();
      if (t.n === 0 || t.nSpine === 0 || t.nTorso === 0 || t.nHead === 0 || t.nAnkle === 0) { fail(`${label}: the body was never sampled (samples ${t.n}, spine ${t.nSpine}, torso ${t.nTorso}, head ${t.nHead}, ankles ${t.nAnkle})`); return; }
      for (const [name, value] of Object.entries(r)) if (!(Array.isArray(value) ? value.every(Number.isFinite) : Number.isFinite(value))) fail(`${label}: ${name} is not a finite number (${value})`);
      if (r.minHipsAboveFloorM < 0.27) fail(`${label}: the hips went down to ${r.minHipsAboveFloorM} m above the floor (limit 0.27 m)`);
      if (r.maxTorsoDeg > 50) fail(`${label}: the torso (hips to head) leaned ${r.maxTorsoDeg} degrees from vertical (limit 50)`);
      if (r.maxSpinePitchDeg > 47) fail(`${label}: the spine pitched ${r.maxSpinePitchDeg} degrees (limit 45, tolerance 47)`);
      if (r.minHeadOverHipsM < 0.05) fail(`${label}: the head came down to ${r.minHeadOverHipsM} m over the hips (limit 0.05 m)`);
      if (r.ankleAheadOfHipsM[0] < -0.3 || r.ankleAheadOfHipsM[1] > 0.45) fail(`${label}: an ankle was ${r.ankleAheadOfHipsM} m ahead of the hips along the facing (limits -0.3 to 0.45 m): a leg trailing or flung`);
    }
  };
}


/**
 * Wraps `window.advanceTime` so every 1/60 s simulation step is sampled (the pose after
 * it), whatever step size a scenario advances by. `stepJumps` then finds one-step pops.
 */
export async function recordEveryStep(page) {
  await page.evaluate(() => {
    if (window.__stepLogInstalled) { window.__stepLog.length = 0; return; }
    window.__stepLogInstalled = true;
    window.__stepLog = [];
    const original = window.advanceTime.bind(window);
    window.advanceTime = (ms) => {
      const steps = Math.max(1, Math.round(ms / (1000 / 60)));
      for (let i = 0; i < steps; i += 1) {
        original(1000 / 60);
        const st = JSON.parse(window.render_game_to_text());
        const p = st.pose;
        if (p?.hips) window.__stepLog.push({ phase: st.objects?.reach?.phase, yaw: st.avatar.yaw, hips: p.hips, torso: p.torsoPitchDeg, ankles: p.ankles ?? [], knees: p.knees ?? [], thighs: p.thighs ?? [], held: st.objects?.items?.[0]?.heldBy ?? null, walking: Boolean(st.input?.forward || st.input?.back || st.input?.left || st.input?.right), root: [st.avatar.x, st.avatar.z], c: [st.crouch.amount, st.crouch.poseAmount, st.crouch.squat, st.objects?.reach?.demand].map((v) => Number(v?.toFixed?.(3))) });
      }
    };
  });
}

// While the user's own input walks the avatar, and for this many steps after (the walk cycle settling into the idle stance), the
// pose is judged against these looser bounds: nonzero, so a snap still fails. Everything else is judged tight.
const WALK_SETTLE_STEPS = 12;
const WALKING_BOUNDS = { hipsM: 0.15, ankleM: 0.15, torsoDeg: 15 };

export async function stepJumps(page, label, fail, { hipsM = 0.04, ankleM = 0.01, torsoDeg = 5 } = {}) {
  const log = await page.evaluate(() => window.__stepLog.splice(0));
  // Loose only while the user's input walks, and for the settle steps after it, ending the moment the next reach, step or set-down begins
  // (a planted squat is always judged tight, however soon after a walk it starts).
  const loose = log.map((_, i) => {
    for (let j = i; j >= 0 && j > i - WALK_SETTLE_STEPS - 1; j -= 1) {
      if (log[j].walking) return true;
      if (j < i && ['step', 'reach', 'lower'].includes(log[j + 1].phase) && log[j].phase !== log[j + 1].phase) return false;
    }
    return false;
  });
  let evaluated = 0;
  let looseEvaluated = 0;
  const worst = { hips: 0, ankle: 0, torso: 0, at: {} };
  const worstLoose = { hips: 0, ankle: 0, torso: 0 };
  for (let i = 1; i < log.length; i += 1) {
    const a = log[i - 1];
    const b = log[i];
    if (!(a.c[0] > 0.01 || b.c[0] > 0.01)) continue;
    // The stand-up is fast but eased, so a pop is a jump in the hips' speed (a second difference), not a fast step.
    const c = log[i - 2];
    const target = loose[i] ? worstLoose : worst;
    if (loose[i]) looseEvaluated += 1;
    else evaluated += 1;
    const dh = c ? Math.abs(b.hips.y - 2 * a.hips.y + c.hips.y) : 0;
    if (dh > target.hips) { target.hips = dh; if (!loose[i]) worst.at.hips = [i, a.phase, b.phase]; }
    const dt = Math.abs((b.torso ?? 0) - (a.torso ?? 0));
    if (dt > target.torso) { target.torso = dt; if (!loose[i]) worst.at.torso = [i, a.phase, b.phase]; }
    // The automatic step in walks the legs (ankles swing); the transition out of it, into the squat, is checked.
    if (a.phase === 'step' && b.phase === 'step') continue;
    b.ankles.forEach((q, k) => {
      const r = a.ankles[k];
      if (!q || !r) return;
      const da = Math.hypot(q.x - r.x, q.y - r.y, q.z - r.z);
      if (da > target.ankle) { target.ankle = da; if (!loose[i]) worst.at.ankle = [i, a.phase, b.phase, k]; }
    });
  }
  // Legs: each knee bends forward of the hip-ankle line (along the facing) and stays above its ankle; the thigh turns smoothly.
  const knee = { missing: 0, measured: 0, minForwardM: Infinity, minAboveAnkleM: Infinity, maxThighDeg: 0, bad: [] };
  for (let i = 0; i < log.length; i += 1) {
    const e = log[i];
    if (!(e.c[0] > 0.3)) continue;
    if (loose[i]) continue;
    const fx = -Math.sin(e.yaw);
    const fz = -Math.cos(e.yaw);
    const fwd = (q) => q.x * fx + q.z * fz;
    if (e.knees.length < 2 || e.thighs.length < 2 || e.ankles.length < 2) { knee.missing += 1; continue; }
    e.knees.forEach((k, side) => {
      const t = e.thighs[side];
      const a = e.ankles[side];
      if (!k || !t || !a || ![k.x, k.y, k.z, t.x, t.y, t.z, a.x, a.y, a.z].every(Number.isFinite)) { knee.missing += 1; return; }
      knee.measured += 1;
      const bend = fwd(k) - (fwd(t) + fwd(a)) / 2;
      const above = k.y - a.y;
      knee.minForwardM = Math.min(knee.minForwardM, bend);
      knee.minAboveAnkleM = Math.min(knee.minAboveAnkleM, above);
      if (bend < 0.01 || above < 0.02) knee.bad.push([i, e.phase, side, Number(bend.toFixed(3)), Number(above.toFixed(3))]);
      const prev = log[i - 1]?.knees[side] && log[i - 1].thighs[side];
      if (prev) {
        const d0 = [log[i - 1].knees[side].x - prev.x, log[i - 1].knees[side].y - prev.y, log[i - 1].knees[side].z - prev.z];
        const d1 = [k.x - t.x, k.y - t.y, k.z - t.z];
        const dot = d0[0] * d1[0] + d0[1] * d1[1] + d0[2] * d1[2];
        const ang = (Math.acos(Math.max(-1, Math.min(1, dot / (Math.hypot(...d0) * Math.hypot(...d1))))) * 180) / Math.PI;
        if (ang > knee.maxThighDeg) { knee.maxThighDeg = ang; knee.at = [i, e.phase, side, e.c]; }
      }
    });
  }
  const out = { kneeForwardM: Number(knee.minForwardM.toFixed(3)), kneeAboveAnkleM: Number(knee.minAboveAnkleM.toFixed(3)), thighDegPerStep: Number(knee.maxThighDeg.toFixed(2)), steps: log.length, hipsM: Number(worst.hips.toFixed(4)), ankleM: Number(worst.ankle.toFixed(4)), torsoDeg: Number(worst.torso.toFixed(2)), at: worst.at };
  out.evaluated = evaluated;
  if (evaluated < 30) fail(`${label}: only ${evaluated} squat transitions were evaluated for continuity`);
  out.looseEvaluated = looseEvaluated;
  out.walkingMax = { hipsM: Number(worstLoose.hips.toFixed(4)), ankleM: Number(worstLoose.ankle.toFixed(4)), torsoDeg: Number(worstLoose.torso.toFixed(2)) };
  out.kneeSteps = knee.measured;
  if (knee.missing > 0 || knee.measured === 0 || !Number.isFinite(knee.minForwardM) || !Number.isFinite(knee.minAboveAnkleM)) fail(`${label}: the knee check had no usable data (${knee.measured} measured, ${knee.missing} missing)`);
  for (const [name, value] of Object.entries(WALKING_BOUNDS)) if (worstLoose[name === 'hipsM' ? 'hips' : name === 'ankleM' ? 'ankle' : 'torso'] > value) fail(`${label}: while walking, ${name} changed ${JSON.stringify(out.walkingMax)} in one step (limits ${JSON.stringify(WALKING_BOUNDS)})`);
  if (knee.minForwardM < 0.05) fail(`${label}: a knee bent only ${out.kneeForwardM} m forward of the hip-ankle line (limit 0.05 m): a leg folded backward`);
  if (knee.minAboveAnkleM < 0.02) fail(`${label}: a knee dropped to ${out.kneeAboveAnkleM} m above its ankle (limit 0.02 m)`);
  if (knee.maxThighDeg > 10) fail(`${label}: a thigh turned ${out.thighDegPerStep} degrees in one step (limit 10)`);
  if (worst.hips > hipsM) fail(`${label}: the hips' speed jumped ${out.hipsM} m per step in one step (limit ${hipsM}) at ${JSON.stringify(worst.at.hips)}`);
  if (worst.ankle > ankleM) fail(`${label}: an ankle jumped ${out.ankleM} m in one step (limit ${ankleM}) at ${JSON.stringify(worst.at.ankle)}`);
  if (worst.torso > torsoDeg) fail(`${label}: the torso angle jumped ${out.torsoDeg} degrees in one step (limit ${torsoDeg}) at ${JSON.stringify(worst.at.torso)}`);
  return out;
}

export const readState = (page) => page.evaluate(() => JSON.parse(window.render_game_to_text()));

export async function clickButton(page, name) {
  await page.getByRole('button', { name, exact: true }).evaluate((button) => button.click());
}

export async function saveDownload(page, stop, file) {
  const download = page.waitForEvent('download', { timeout: 30_000 });
  await stop();
  await (await download).saveAs(file);
  return file;
}

/**
 * Steps (via `step`) until the first object's body sleeps or is nearly still,
 * up to `timeoutSec`; returns its snapshot then.
 */
export async function settle(page, step, timeoutSec = REST_TIMEOUT_SEC) {
  let item;
  for (let i = 0; i < Math.round(timeoutSec * 60) + 1; i += 1) {
    await step(1);
    item = (await readState(page)).objects.items[0];
    if (item.body === 'asleep') break;
  }
  return { item, atRest: item.body === 'asleep' };
}

/** Hold relation samples (object in the hand anchor's frame) while an object is held. */
function holdRelation(state) {
  const item = state.objects.items[0];
  if (!item?.heldBy) return null;
  const hand = poseOf(state.objects.hands[item.heldBy]);
  return hand ? relativePose(hand, poseOf(item)) : null;
}

function spread(relations) {
  const first = relations[0];
  let position = 0;
  let angle = 0;
  for (const relation of relations) {
    position = Math.max(position, relation.position.distanceTo(first.position));
    angle = Math.max(angle, angleDeg(relation.quaternion, first.quaternion));
  }
  return { position: round(position), angleDeg: round(angle, 3) };
}

/**
 * Checks an exported take against capture: the object node, its track
 * length, the extension, the hold spans, and the object's pose relative to
 * the avatar's RightHand at every held key against the relation capture read.
 * `compareTailSec` limits that to the hold's last seconds, for a hold whose
 * relation changes early (the desktop turn).
 */
export function checkObjectExport(buffer, { expectHolds, captureRelation, compareTailSec, compareEndGapSec = 0.02, fail }) {
  const take = loadTake(buffer);
  const nodes = objectNodes(take);
  const report = { objectNodes: nodes.length, keys: take.times.length, duration: round(take.times.at(-1) ?? 0, 3) };
  if (nodes.length !== 1) {
    fail(`export: expected one RecordedObject node, found ${nodes.length}`);
    return report;
  }
  const node = nodes[0];
  const channels = take.channels.get(node) ?? {};
  const rootKeys = take.channels.get(findNode(take, 'RecordedAvatar'))?.translation?.keys;
  report.objectKeys = { translation: channels.translation?.keys ?? 0, rotation: channels.rotation?.keys ?? 0, scale: channels.scale?.keys ?? 0 };
  if (!channels.translation || !channels.rotation) fail('export: the object node has no position or rotation track');
  if (channels.translation?.keys !== rootKeys || channels.rotation?.keys !== rootKeys) fail(`export: object keys ${channels.translation?.keys}/${channels.rotation?.keys} differ from the avatar's ${rootKeys}`);
  if (channels.scale) fail('export: an object present for the whole take has a scale track');
  if (!take.extension) fail('export: no HOLOIM_objects extension');
  else if (!take.validation?.ok) fail(`export: invalid HOLOIM_objects: ${take.validation?.errors.join('; ')}`);
  if (take.json.extensionsRequired?.includes('HOLOIM_objects')) fail('export: HOLOIM_objects must not be required');
  if (!take.json.extensionsUsed?.includes('HOLOIM_objects')) fail('export: HOLOIM_objects missing from extensionsUsed');
  const entry = take.validation?.ok ? take.validation.value.objects[0] : undefined;
  report.extension = entry ?? null;
  if (entry && entry.node !== node) fail(`export: the extension names node ${entry.node}, the object is node ${node}`);
  if (entry && (entry.presence.length !== 1 || entry.presence[0].start !== 0 || Math.abs(entry.presence[0].end - report.duration) > 1e-3)) {
    fail(`export: presence ${JSON.stringify(entry.presence)} does not cover the take`);
  }
  if (entry) {
    if (entry.holds.length !== expectHolds.length) fail(`export: ${entry.holds.length} hold span(s), expected ${expectHolds.length}`);
    for (const [i, expected] of expectHolds.entries()) {
      const hold = entry.holds[i];
      if (!hold) continue;
      if (hold.hand !== expected.hand) fail(`export: hold ${i} hand ${hold.hand}, expected ${expected.hand}`);
      const duration = hold.end - hold.start;
      if (Math.abs(duration - expected.duration) > SPAN_TOLERANCE_SEC) fail(`export: hold ${i} lasts ${round(duration, 3)} s, expected ${round(expected.duration, 3)} s`);
    }
  }

  // The object relative to the avatar's right hand, at every held key, against
  // capture's relation: the bone HOLOIM_humanoid declares, else the RPM name.
  const declaredHand = take.json.extensions?.HOLOIM_humanoid?.humanBones?.rightHand?.node;
  const hand = Number.isInteger(declaredHand) ? declaredHand : findNode(take, 'RightHand');
  const held = entry?.holds.find((hold) => hold.hand === 'right');
  if (hand < 0) fail('export: no right hand bone');
  if (hand >= 0 && held && captureRelation) {
    let position = 0;
    let angle = 0;
    let checked = 0;
    take.times.forEach((time, i) => {
      // Inside the span, away from the grab and release keys.
      const from = compareTailSec ? held.end - compareEndGapSec - compareTailSec : held.start + 0.05;
      if (time < from || time > held.end - compareEndGapSec) return;
      const relation = relativePose(rigidPose(worldAt(take, hand, i)), rigidPose(worldAt(take, node, i)));
      position = Math.max(position, relation.position.distanceTo(captureRelation.position));
      angle = Math.max(angle, angleDeg(relation.quaternion, captureRelation.quaternion));
      checked += 1;
    });
    report.handRelation = { keys: checked, maxPositionErrorM: round(position), maxAngleErrorDeg: round(angle, 3) };
    if (checked === 0) fail('export: no held keys to compare');
    if (position > EXPORT_POSITION_M || angle > EXPORT_ANGLE_DEG) fail(`export: object off the hand by ${round(position)} m / ${round(angle, 2)}° (limits ${EXPORT_POSITION_M} m / ${EXPORT_ANGLE_DEG}°)`);
  }
  return report;
}

/** IWER controllers: negatives, grab, move and turn, release, export. */
export async function runIwerObjectTake({ browser, baseUrl, artifactDir, consoleErrors }) {
  const label = 'iwer-object-bracket';
  const failures = [];
  const fail = (message) => failures.push(message);
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

    let steps = 0;
    const step = async (count = 1) => {
      for (let i = 0; i < count; i += 1) await page.clock.runFor(STEP_MS);
      steps += count;
    };
    const controller = (side, position, quaternion) => page.evaluate(({ s, p, q }) => {
      const c = window.IWER_DEVICE.controllers[s];
      c.position.set(...p);
      if (q) c.quaternion.set(...q);
    }, { s: side, p: position, q: quaternion });
    const button = (side, id, value) => page.evaluate(({ s, i, v }) => window.IWER_DEVICE.controllers[s].updateButtonValue(i, v), { s: side, i: id, v: value });
    const shot = async (name) => {
      await page.evaluate(() => {
        window.__setSpectatorView('body');
        window.__setFrameStepping(true, true);
        for (const element of document.querySelectorAll('#ui-root, #VRButton, #ARButton, [data-webxr_runtime] > div')) element.style.visibility = 'hidden';
      });
      await step(2);
      const file = path.join(artifactDir, `${label}-${name}.png`);
      await page.screenshot({ path: file });
      await page.evaluate(() => {
        window.__setSpectatorView(false);
        window.__setFrameStepping(true, false);
        for (const element of document.querySelectorAll('#ui-root, #VRButton, #ARButton, [data-webxr_runtime] > div')) element.style.visibility = '';
      });
      return file;
    };

    // Rest: hands low at the sides, so the right hand is far from the object.
    const rest = { left: [-0.3, 0.9, -0.1], right: [0.3, 0.9, -0.1] };
    const identity = [0, 0, 0, 1];
    await controller('left', rest.left, identity);
    await controller('right', rest.right, identity);
    await step(20);
    let state = await readState(page);
    const loaded = state.objects.items[0];
    if (!loaded?.placed) {
      fail('the object did not load and place');
      return { label, failures };
    }

    // Out of reach: a squeeze grabs nothing.
    await button('right', 'squeeze', 1);
    await step(4);
    state = await readState(page);
    if (state.objects.items[0].heldBy) fail('a squeeze out of reach grabbed the object');
    if (state.objects.grab.right.source !== 'squeeze' || !state.objects.grab.right.pressed) fail(`squeeze not read: ${JSON.stringify(state.objects.grab.right)}`);
    await button('right', 'squeeze', 0);
    await step(4);

    // Bring the avatar's right hand onto the object: the hand follows the
    // controller through the rig and IK, so close the loop on the bone.
    const rigYaw = state.thumbstick.rigYaw;
    const toTracking = (delta) => {
      const c = Math.cos(-rigYaw);
      const s = Math.sin(-rigYaw);
      return [delta[0] * c + delta[2] * s, delta[1], -delta[0] * s + delta[2] * c];
    };
    // It glides in and stops with the palm 7 cm short of the object, within grab range, as a hand closes before a squeeze: a palm
    // driven into a hovering prop would knock it down (props collide with the avatar).
    let grip = [...rest.right];
    for (let i = 0; i < 150; i += 1) {
      state = await readState(page);
      const gap = state.objects.reach.palmToPropM ?? Infinity;
      if (gap <= 0.07) break;
      const toCenter = state.objects.items[0].position.map((v, k) => v - state.objects.hands.right.position[k]);
      const length = Math.hypot(...toCenter);
      const move = Math.min(0.012, Math.max(0.002, (gap - 0.07) * 0.5));
      const delta = toTracking(toCenter.map((v) => (v / length) * move));
      grip = grip.map((v, k) => v + delta[k]);
      await controller('right', grip);
      await step(1);
    }
    state = await readState(page);
    const reachGap = state.objects.reach.palmToPropM ?? Infinity;
    if (reachGap > 0.1) fail(`the avatar hand never reached the object (palm ${round(reachGap, 3)} m from it)`);

    // The trigger is the HUD's select, never a grab.
    await button('right', 'trigger', 1);
    await step(4);
    state = await readState(page);
    if (state.objects.items[0].heldBy) fail('the trigger grabbed the object');
    await button('right', 'trigger', 0);
    await step(4);
    state = await readState(page);
    if (state.objects.items[0].heldBy) fail('the trigger grabbed the object on release');

    await clickButton(page, 'Start Recording');
    await page.getByRole('button', { name: 'Stop Recording', exact: true }).waitFor({ timeout: 10_000 });
    await step(18);

    // Grab.
    await button('right', 'squeeze', 1);
    const grabStep = steps;
    await step(2);
    state = await readState(page);
    if (state.objects.items[0].heldBy !== 'right') fail(`a squeeze on the object did not grab it (heldBy ${state.objects.items[0].heldBy})`);
    const grabbedAt = poseOf(state.objects.items[0]);
    const shots = { grabbed: await shot('1-grabbed') };

    // Move and turn: 30 cm right and 15 cm up, 90° yaw and 30° pitch over 1.5 s.
    const relations = [];
    const moveSteps = 90;
    const yaw = new THREE.Quaternion();
    const pitch = new THREE.Quaternion();
    for (let i = 1; i <= moveSteps; i += 1) {
      const t = smooth(i / moveSteps);
      yaw.setFromAxisAngle(new THREE.Vector3(0, 1, 0), (Math.PI / 2) * t);
      pitch.setFromAxisAngle(new THREE.Vector3(1, 0, 0), (Math.PI / 6) * t);
      const q = yaw.clone().multiply(pitch);
      await controller('right', [grip[0] + 0.3 * t, grip[1] + 0.15 * t, grip[2]], [q.x, q.y, q.z, q.w]);
      await step(1);
      const relation = holdRelation(await readState(page));
      if (relation) relations.push(relation);
    }
    await step(12);
    state = await readState(page);
    const movedTo = poseOf(state.objects.items[0]);
    const holdRelationEnd = holdRelation(state);
    if (holdRelationEnd) relations.push(holdRelationEnd);
    shots.moved = await shot('2-moved-turned');

    const moved = movedTo.position.distanceTo(grabbedAt.position);
    const turned = angleDeg(movedTo.quaternion, grabbedAt.quaternion);
    // The avatar hand follows the controller through height fit and arm IK, so it travels less.
    if (moved < 0.1) fail(`the held object moved only ${round(moved, 3)} m`);
    if (turned < 60) fail(`the held object turned only ${round(turned, 1)}°`);
    if (relations.length < moveSteps) fail(`the object was dropped while moving (${relations.length}/${moveSteps} held steps)`);
    const rigid = relations.length ? spread(relations) : null;
    if (rigid && (rigid.position > RIGID_POSITION_M || rigid.angleDeg > RIGID_ANGLE_DEG)) fail(`the held object slid in the hand: ${JSON.stringify(rigid)}`);

    // Release and move the hand away: the object falls and comes to rest.
    await button('right', 'squeeze', 0);
    const releaseStep = steps;
    await step(2);
    state = await readState(page);
    if (state.objects.items[0].heldBy) fail('releasing the squeeze did not release the object');
    const releasedAt = poseOf(state.objects.items[0]);
    for (let i = 1; i <= 30; i += 1) {
      await controller('right', [grip[0] + 0.3 - 0.3 * smooth(i / 30), grip[1] + 0.15 - 0.4 * smooth(i / 30), grip[2] + 0.1 * smooth(i / 30)]);
      await step(1);
    }
    const resting = await settle(page, step);
    const settled = poseOf(resting.item);
    const fell = releasedAt.position.y - settled.position.y;
    const floorGapM = resting.item.boundsMin[1];
    if (!resting.atRest) fail(`the released object had not come to rest after ${REST_TIMEOUT_SEC} s (${resting.item.body}, ${round(Math.hypot(...resting.item.linvel), 3)} m/s)`);
    if (fell < 0.3) fail(`the released object fell only ${round(fell, 3)} m`);
    if (floorGapM < -FLOOR_TOLERANCE_M || floorGapM > FLOOR_TOLERANCE_M) fail(`the released object rests ${round(floorGapM, 4)} m from the floor (limit ${FLOOR_TOLERANCE_M} m)`);
    const drift = Math.hypot(settled.position.x - releasedAt.position.x, settled.position.z - releasedAt.position.z);
    shots.released = await shot('3-released');

    const glb = path.join(artifactDir, `${label}.glb`);
    await saveDownload(page, async () => {
      await clickButton(page, 'Stop Recording');
      // Export runs in a worker; keep frames coming for it.
      for (let i = 0; i < 20; i += 1) await step(1);
    }, glb);
    // Capture's own relation while held is the reference for the export.
    const captureRelation = relations[Math.floor(relations.length / 2)] ?? null;
    const exportReport = checkObjectExport(await readFile(glb), {
      expectHolds: [{ hand: 'right', duration: (releaseStep - grabStep) * STEP_MS / 1000 }],
      captureRelation,
      fail
    });

    return {
      label,
      status: failures.length ? 'fail' : 'pass',
      failures,
      glb,
      shots,
      capture: {
        palmToObjectM: round(reachGap, 3),
        movedM: round(moved, 3),
        turnedDeg: round(turned, 1),
        heldSteps: relations.length,
        rigidHold: rigid,
        fellM: round(fell, 3),
        restHorizontalDriftM: round(drift, 3),
        restFloorGapM: round(floorGapM, 4),
        handRelation: captureRelation && { position: captureRelation.position.toArray().map((v) => round(v)), quaternion: captureRelation.quaternion.toArray().map((v) => round(v)) }
      },
      export: exportReport
    };
  } finally {
    await context.close();
  }
}

/** A copy of the bracket that declares Draco compression, which capture must refuse. */
async function unsupportedCopy(captureRoot, file) {
  const source = await readFile(path.join(captureRoot, 'fixtures/objects/bracket.glb'));
  const jsonLength = source.readUInt32LE(12);
  const json = JSON.parse(source.subarray(20, 20 + jsonLength).toString('utf8'));
  json.extensionsUsed = ['KHR_draco_mesh_compression'];
  const text = Buffer.from(JSON.stringify(json));
  const padded = Buffer.alloc(Math.ceil(text.length / 4) * 4, 0x20);
  text.copy(padded);
  const rest = source.subarray(20 + jsonLength);
  const header = Buffer.alloc(20);
  header.writeUInt32LE(0x46546c67, 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(20 + padded.length + rest.length, 8);
  header.writeUInt32LE(padded.length, 12);
  header.writeUInt32LE(0x4e4f534a, 16);
  await writeFile(file, Buffer.concat([header, padded, rest]));
  return file;
}

/** Desktop: no-object take, picker refusal and load, G/Q carry, walking, put down, out of reach. */
export async function runDesktopObjectTake({ browser, baseUrl, captureRoot, artifactDir, consoleErrors }) {
  const label = 'desktop-object-bracket';
  const failures = [];
  const fail = (message) => failures.push(message);
  await mkdir(artifactDir, { recursive: true });
  const { context, page } = await setupPage(browser, { iwer: false, consoleErrors, label });
  try {
    await openCapture(page, baseUrl, {});
    await recordEveryStep(page);
    const advance = (seconds) => page.evaluate((ms) => window.advanceTime(ms), Math.round(seconds * 60) * STEP_MS);
    const record = async (seconds, file, between) => {
      await page.getByRole('button', { name: 'Start Recording' }).click();
      await page.getByRole('button', { name: 'Stop Recording' }).waitFor();
      await advance(0.1);
      if (between) await between();
      else await advance(seconds);
      return saveDownload(page, () => page.getByRole('button', { name: 'Stop Recording' }).click(), file);
    };
    await advance(1);

    // A take with no object exports no object node and no extension.
    const plain = await readFile(await record(0.5, path.join(artifactDir, `${label}-no-object.glb`)));
    await page.getByRole('button', { name: 'Start Recording' }).waitFor();
    const plainTake = loadTake(plain);
    const noObject = { objectNodes: objectNodes(plainTake).length, extension: plainTake.extension !== undefined, extensionsUsed: plainTake.json.extensionsUsed ?? [] };
    if (noObject.objectNodes !== 0 || noObject.extension || noObject.extensionsUsed.includes('HOLOIM_objects')) fail(`a take without an object exported one: ${JSON.stringify(noObject)}`);

    // The picker refuses an unsupported model and keeps capture working.
    // The pickers live in the settings side sheet.
    await page.getByRole('button', { name: 'Settings' }).click();
    const picker = page.getByLabel('Choose an object (.glb)');
    await picker.setInputFiles(await unsupportedCopy(captureRoot, path.join(artifactDir, `${label}-draco.glb`)));
    await page.getByText('Unsupported in objects: Draco-compressed meshes.').waitFor({ timeout: 10_000 });
    let state = await readState(page);
    if (state.objects.items.length !== 0) fail('a refused model was added to the scene');
    const refusal = 'Unsupported in objects: Draco-compressed meshes.';

    // ...and loads the bracket.
    await picker.setInputFiles(path.join(captureRoot, 'fixtures/objects/bracket.glb'));
    await page.getByText('Object: bracket.glb').waitFor({ timeout: 10_000 });
    await page.keyboard.press('Escape');
    await page.getByRole('dialog', { name: 'Settings' }).waitFor({ state: 'detached' });
    await advance(0.1);
    state = await readState(page);
    if (state.objects.items[0]?.placed !== true) fail('the picked object was not placed');

    const keyFor = async (code, seconds) => {
      await page.keyboard.down(code);
      await advance(seconds);
      await page.keyboard.up(code);
    };
    const focusCanvas = () => page.locator('canvas').first().focus();
    await focusCanvas();

    let pickedUp;
    let carried;
    let putDown;
    let setDown;
    const relations = [];
    let holdSeconds = 0;
    const glb = await record(0, path.join(artifactDir, `${label}.glb`), async () => {
      await advance(0.3);
      await page.keyboard.press('KeyG');
      // The hand goes to the object, takes it where it hangs, and the arm settles into the carry pose.
      // The hold begins when the palm is on it, so count the held time from there.
      let reached = 0;
      for (; reached < 90; reached += 1) {
        await advance(1 / 60);
        if ((await readState(page)).objects.items[0].heldBy) break;
      }
      await advance(0.8 - reached / 60);
      holdSeconds += 0.8 - (reached + 1) / 60;
      state = await readState(page);
      pickedUp = { heldBy: state.objects.items[0].heldBy, carryWeight: state.objects.carryWeight, toHandM: round(v3(state.objects.items[0].position).distanceTo(v3(state.objects.hands.right.position)), 3) };
      const before = poseOf(state.objects.items[0]);
      await keyFor('KeyQ', 0.5);
      await keyFor('KeyW', 1);
      holdSeconds += 1.5;
      for (let i = 0; i < 10; i += 1) {
        await advance(1 / 60);
        holdSeconds += 1 / 60;
        const relation = holdRelation(await readState(page));
        if (relation) relations.push(relation);
      }
      state = await readState(page);
      const after = poseOf(state.objects.items[0]);
      carried = { movedM: round(after.position.distanceTo(before.position), 3), turnedDeg: round(angleDeg(after.quaternion, before.quaternion), 1) };
      // Stop walking and turning, then put it down: it drops, with no throw.
      await advance(0.6);
      holdSeconds += 0.6;
      await page.keyboard.press('KeyG');
      // Set down: the hand lowers the prop rigidly toward the surface; it is let go at 2 cm above it, or when the hand can go no lower.
      await advance(0.1);
      holdSeconds += 0.1;
      const easing = (await readState(page)).objects.items[0];
      setDown = { heldDuringEase: easing.heldBy };
      let launch = easing;
      const squat = squatTracker();
      for (let i = 0; i < 150 && launch.heldBy; i += 1) {
        await advance(1 / 60);
        const frame = await readState(page);
        squat.sample(frame);
        launch = frame.objects.items[0];
        if (launch.heldBy) holdSeconds += 1 / 60;
      }
      const released = poseOf(launch);
      await keyFor('KeyS', 0.5);
      const trace = [];
      for (let i = 0; i < Math.round(REST_TIMEOUT_SEC * 60); i += 1) {
        await advance(1 / 60);
        const sample = (await readState(page)).objects.items[0];
        if (i % 6 === 0) trace.push({ t: round(i / 60, 2), centre: [0, 1, 2].map((a) => round((sample.boundsMin[a] + sample.boundsMax[a]) / 2, 3)), linvel: sample.linvel.map((v) => round(v, 2)), body: sample.body });
        if (sample.body === 'asleep') break;
      }
      state = await readState(page);
      const item = state.objects.items[0];
      squat.assert(fail, 'put-down');
      await stepJumps(page, 'put-down', fail);
      putDown = {
        squat: squat.result(),
        trace,
        heldBy: item.heldBy,
        // How far it fell from the hand's lowest point to the floor, after the let-go.
        dropHeightM: round(launch.boundsMin[1] - item.boundsMin[1], 4),
        launchSpeedMps: round(Math.hypot(launch.linvel[0], launch.linvel[2]), 3),
        launchSpinRadps: round(Math.hypot(...launch.angvel), 3),
        // The bounds centre, not the model origin: a tipping prop swings its origin.
        driftM: round(Math.hypot((item.boundsMin[0] + item.boundsMax[0] - launch.boundsMin[0] - launch.boundsMax[0]) / 2, (item.boundsMin[2] + item.boundsMax[2] - launch.boundsMin[2] - launch.boundsMax[2]) / 2), 3),
        originDriftM: round(Math.hypot(item.position[0] - released.position.x, item.position[2] - released.position.z), 3),
        body: item.body,
        floorGapM: round(item.boundsMin[1], 4)
      };
      await advance(0.2);
    });
    await page.getByRole('button', { name: 'Start Recording' }).waitFor();

    if (pickedUp.heldBy !== 'right') fail(`G did not pick up the object (heldBy ${pickedUp.heldBy})`);
    if (pickedUp.carryWeight < 1) fail(`the carry pose did not blend in (${pickedUp.carryWeight})`);
    if (pickedUp.toHandM > 0.15) fail(`the carried object is ${pickedUp.toHandM} m from the hand`);
    if (carried.turnedDeg < 30) fail(`Q turned the object only ${carried.turnedDeg}°`);
    if (carried.movedM < 0.5) fail(`walking carried the object only ${carried.movedM} m`);
    if (setDown.heldDuringEase !== 'right') fail('G released the object at once instead of setting it down');
    if (putDown.heldBy) fail('G did not put the object down');
    if (putDown.launchSpeedMps > 0.05 || putDown.launchSpinRadps > 0.05) fail(`the put-down object was flung: ${putDown.launchSpeedMps} m/s, ${putDown.launchSpinRadps} rad/s`);
    // Slice 3: nothing is within the arm's standing reach below it, so the body squats until it is just above the floor.
    if (putDown.dropHeightM > 0.03) fail(`the put-down object was let go ${putDown.dropHeightM} m above the floor (limit 0.03 m)`);
    if (putDown.driftM > 0.02) fail(`the put-down object drifted ${putDown.driftM} m sideways after a ${putDown.dropHeightM} m drop (limit 0.02 m)`);
    if (putDown.body !== 'asleep') fail(`the put-down object did not come to rest (${putDown.body})`);
    if (Math.abs(putDown.floorGapM - FLOOR_Y) > 0.003) fail(`the put-down object rests ${round(putDown.floorGapM - FLOOR_Y, 4)} m from the floor (limit 0.003 m)`);

    // Out of reach, G does nothing.
    await page.keyboard.press('KeyG');
    await advance(0.2);
    state = await readState(page);
    const outOfReach = { heldBy: state.objects.items[0].heldBy };
    if (outOfReach.heldBy) fail('G picked up an object out of reach');

    // Walking into the resting object shoves it along (props collide with the avatar), and the avatar walks on at the same speed: props never push it.
    state = await readState(page);
    const restAt = state.objects.items[0].position;
    // Line the right foot up with it first (the avatar faces -z, so its right is +x): a prop dead centre passes between the feet.
    const lineUpX = restAt[0] - 0.09;
    for (let i = 0; i < 120 && Math.abs(state.avatar.x - lineUpX) > 0.02; i += 1) {
      const side = lineUpX > state.avatar.x ? 'KeyD' : 'KeyA';
      await page.keyboard.down(side);
      await advance(1 / 60);
      await page.keyboard.up(side);
      await advance(1 / 60);
      state = await readState(page);
    }
    const key = restAt[2] < state.avatar.z ? 'KeyW' : 'KeyS';
    const heading = Math.sign(restAt[2] - state.avatar.z);
    const walk = [];
    await page.keyboard.down(key);
    for (let i = 0; i < 300; i += 1) {
      await advance(1 / 30);
      state = await readState(page);
      walk.push({ z: state.avatar.z, gapM: Math.hypot(state.avatar.x - restAt[0], state.avatar.z - restAt[2]), prop: state.objects.items[0].position, body: state.objects.items[0].body });
      // On until the avatar is 0.5 m past where the prop was.
      if ((state.avatar.z - restAt[2]) * heading > 0.5) break;
    }
    await page.keyboard.up(key);
    await advance(1.5);
    state = await readState(page);
    const speedOver = (samples) => (samples.length < 2 ? null : Math.abs(samples.at(-1).z - samples[0].z) / ((samples.length - 1) / 30));
    // Up to speed after 0.2 s; the approach ends 0.4 m short of the prop.
    const approach = speedOver(walk.filter((w, i) => i > 6 && w.gapM > 0.4 && (w.z - restAt[2]) * heading < 0));
    const firstMoved = walk.findIndex((w) => v3(w.prop).distanceTo(v3(restAt)) > 0.005);
    const contact = firstMoved < 0 ? [] : walk.slice(firstMoved, firstMoved + 10);
    const pushed = speedOver(contact);
    const final = state.objects.items[0];
    const walkThrough = {
      walkedPastM: round((walk.at(-1).z - restAt[2]) * heading, 3),
      objectMovedM: round(v3(final.position).distanceTo(v3(restAt)), 4),
      objectMovedAlongM: round((final.position[2] - restAt[2]) * heading, 4),
      approachSpeedMps: approach === null ? null : round(approach, 3),
      contactSpeedMps: pushed === null ? null : round(pushed, 3),
      wokeBody: walk.find((w) => w.body === 'dynamic') ? 'dynamic' : walk[0]?.body,
      body: final.body
    };
    if (walkThrough.walkedPastM < 0.5) fail(`the avatar did not walk past the resting object (${walkThrough.walkedPastM} m past)`);
    if (walkThrough.objectMovedAlongM < 0.1) fail(`walking into the resting object moved it only ${walkThrough.objectMovedAlongM} m along the walk (expected at least 0.1 m)`);
    if (approach === null || pushed === null) fail('walking into the resting object: no approach or contact speed to compare');
    else if (Math.abs(pushed - approach) > approach * 0.02 + 0.01) fail(`the shoved object changed the avatar's walking speed (${walkThrough.approachSpeedMps} m/s before, ${walkThrough.contactSpeedMps} m/s while pushing)`);

    // A freshly placed object hovers in front of the avatar until something knocks it; walking into it does, and it falls to the floor.
    const knockdownsBefore = state.objects.physics?.knockdowns ?? 0;
    if (!(await page.evaluate((url) => window.__loadObjectUrl(url), OBJECT_URL))) fail('re-placing the object for the knock-down failed');
    await advance(0.2);
    state = await readState(page);
    const hoverBody = state.objects.items[0].body;
    const hoverAt = state.objects.items[0].position;
    await page.keyboard.down('KeyW');
    await advance(0.8);
    await page.keyboard.up('KeyW');
    await advance(2.5);
    state = await readState(page);
    const knocked = state.objects.items[0];
    const knockdown = { hoverBody, hoverAtM: hoverAt.map((v) => round(v, 3)), knockdowns: (state.objects.physics?.knockdowns ?? 0) - knockdownsBefore, body: knocked.body, floorGapM: round(knocked.boundsMin[1] - FLOOR_Y, 4) };
    if (hoverBody !== 'kinematic') fail(`the re-placed object was not hovering (${hoverBody})`);
    if (knockdown.knockdowns !== 1) fail(`walking into the hovering object knocked down ${knockdown.knockdowns} objects, expected 1`);
    if (knocked.body !== 'asleep' || Math.abs(knockdown.floorGapM) > 0.01) fail(`the knocked-down object did not come to rest on the floor (${knocked.body}, ${knockdown.floorGapM} m above it)`);

    const exportReport = checkObjectExport(await readFile(glb), {
      expectHolds: [{ hand: 'right', duration: holdSeconds }],
      captureRelation: relations.at(-1) ?? null,
      // The span after the Q turn, including the set-down squat: the prop stays rigid with the hand.
      compareTailSec: 0.6,
      fail
    });
    const shotFile = path.join(artifactDir, `${label}-put-down.png`);
    await page.evaluate(() => document.getElementById('ui-root')?.style.setProperty('visibility', 'hidden'));
    await page.evaluate(() => window.__setManualClock(true, true));
    await advance(2 / 60);
    await page.screenshot({ path: shotFile });
    return { label, status: failures.length ? 'fail' : 'pass', failures, glb, noObject, refusal, pickedUp, carried, putDown, setDown, outOfReach, walkThrough, knockdown, shots: { final: shotFile }, export: exportReport };
  } finally {
    await context.close();
  }
}
