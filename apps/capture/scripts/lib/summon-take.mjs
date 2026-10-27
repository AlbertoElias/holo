import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import * as THREE from 'three';

import {
  enterIwerSessionFromButton,
  freezePageClock,
  waitForIwerRuntime,
  waitForXrRenderLoop
} from '@holoim/tooling-testing/xr-env';

import { angleDeg, findNode, loadTake, objectNodes, relativePose, rigidPose, worldAt } from './object-glb.mjs';
import { clickButton, openCapture, OBJECT_URL, poseOf, readState, saveDownload, setupPage } from './object-take.mjs';

// Summon and place while speaking (PRD-045): scripted IWER takes through
// capture's real input paths, then the exported GLB read without a renderer.
//   - Controllers: holding left Y opens the tray at the left hand; a right
//     squeeze away from it, or before recording, summons nothing; a squeeze
//     on each miniature summons a new object into the right hand, which a
//     release places. Two items are summoned and placed in one take.
//   - The GLB: two summoned RecordedObject nodes hidden (scale 0) until their
//     summon key, at the hand then, and still where they were placed; no tray
//     geometry; authoring spans for the tray arm and each reach, with the
//     arm chain inside them an eased slerp of the boundary keys.
//   - A tray-only take (open, reach, close, no summon): summoned objects from
//     the last take are gone, and the GLB has `objects: []` with spans.
//   - Tracked hands: palm up opens the tray after the dwell, palm down
//     closes it, and a right pinch on a miniature summons.

export const TRAY_URLS = [OBJECT_URL, '/fixtures/objects/diagram.png'];
// Meshes in each tray item's model: the bracket's three parts, the image card.
const ITEM_MESHES = { 'bracket.glb': 3, 'diagram.png': 1 };
const STEP_MS = 1000 / 60;
const EXPORT_POSITION_M = 0.01;
const EXPORT_ANGLE_DEG = 1;
const INTERPOLATION_DEG = 0.5;
const ARM_BONES = (prefix) => [`${prefix}Shoulder`, `${prefix}Arm`, `${prefix}ForeArm`, `${prefix}Hand`];
// Top-level scene nodes a take may contain (the unnamed one is the key light's
// target, which has no mesh); anything else is unexpected geometry.
const ALLOWED_ROOTS = /^(|RecordedAvatar|RecordedObject(_\d+)?|RecordedBubbleSphere|RecordedSceneBubble.*|SceneBubble.*|RecordedHemisphereLight|RecordedDirectionalLight.*)$/;

const round = (value, digits = 4) => Number(value.toFixed(digits));
const smooth = (t) => t * t * (3 - 2 * t);
const v3 = (a) => new THREE.Vector3(...a);

/** The scene's top-level node names and mesh nodes under each. */
function sceneRoots(take) {
  const { json } = take;
  const roots = json.scenes[json.scene ?? 0].nodes;
  const meshesUnder = (index) => (json.nodes[index].mesh !== undefined ? 1 : 0) + (json.nodes[index].children ?? []).reduce((sum, child) => sum + meshesUnder(child), 0);
  return roots.map((index) => ({ index, name: json.nodes[index].name ?? '', meshes: meshesUnder(index) }));
}

function localQuaternion(take, node, i) {
  const rotation = take.channels.get(node)?.rotation;
  return rotation ? new THREE.Quaternion().fromArray(rotation.values, i * 4) : new THREE.Quaternion(...(take.json.nodes[node].rotation ?? [0, 0, 0, 1]));
}

const keyAt = (take, time) => {
  let best = 0;
  take.times.forEach((t, i) => {
    if (Math.abs(t - time) < Math.abs(take.times[best] - time)) best = i;
  });
  return best;
};

/**
 * The arm chain inside each span against the eased slerp of its boundary
 * keys (the keys just outside it). Returns the worst deviation in degrees,
 * and how far the arm moved across the span (so a frozen arm is visible).
 */
function checkInterpolation(take, spans, fail) {
  const out = [];
  for (const span of spans) {
    const first = keyAt(take, span.start);
    const last = keyAt(take, span.end);
    const before = first - 1;
    const after = last + 1;
    if (before < 0 || after >= take.times.length) {
      out.push({ ...span, skipped: 'touches the take edge' });
      continue;
    }
    let worst = 0;
    let swing = 0;
    for (const bone of ARM_BONES(span.hand === 'left' ? 'Left' : 'Right')) {
      const node = findNode(take, bone);
      if (node < 0) continue;
      const a = localQuaternion(take, node, before);
      const b = localQuaternion(take, node, after);
      swing = Math.max(swing, angleDeg(a, b));
      for (let i = first; i <= last; i += 1) {
        const expected = a.clone().slerp(b, smooth((i - before) / (after - before)));
        worst = Math.max(worst, angleDeg(localQuaternion(take, node, i), expected));
      }
    }
    out.push({ ...span, keys: last - first + 1, maxErrorDeg: round(worst, 3), boundarySwingDeg: round(swing, 1) });
    if (worst > INTERPOLATION_DEG) fail(`export: ${span.hand} span at ${round(span.start, 3)} s is not the eased interpolation (${round(worst, 2)}°)`);
  }
  return out;
}

/** The summon take's GLB against what capture saw. */
export function checkSummonExport(buffer, { summons, fail }) {
  const take = loadTake(buffer);
  const report = { keys: take.times.length, duration: round(take.times.at(-1) ?? 0, 3) };
  if (!take.validation?.ok) {
    fail(`export: invalid or missing HOLOIM_objects: ${take.validation?.errors?.join('; ') ?? 'absent'}`);
    return report;
  }
  const value = take.validation.value;
  const nodes = objectNodes(take);
  report.objectNodes = nodes.length;
  if (nodes.length !== summons.length) fail(`export: ${nodes.length} RecordedObject nodes, expected ${summons.length}`);

  // No tray geometry: only the take's own top-level nodes, and each object
  // node carries one full-size model (never a miniature or the tray).
  const roots = sceneRoots(take);
  report.roots = roots.map((root) => `${root.name}:${root.meshes}`);
  for (const root of roots) if (!ALLOWED_ROOTS.test(root.name) || (root.name === '' && root.meshes > 0)) fail(`export: unexpected scene node "${root.name}" with ${root.meshes} mesh(es)`);
  if (take.json.nodes.some((node) => (node.name ?? '').startsWith('SceneObject_'))) fail('export: a capture SceneObject wrapper (tray item) was exported');

  const hand = findNode(take, 'RightHand');
  report.objects = value.objects.map((entry, k) => {
    const summon = summons[k];
    const node = entry.node;
    const meshes = sceneRoots(take).find((root) => root.index === node)?.meshes ?? 0;
    const channels = take.channels.get(node) ?? {};
    const out = { name: entry.name, origin: entry.origin, presence: entry.presence, meshes };
    if (entry.origin !== 'summoned') fail(`export: object ${k} origin ${entry.origin}, expected summoned`);
    if (entry.name !== summon?.name) fail(`export: object ${k} is ${entry.name}, expected ${summon?.name}`);
    if (meshes !== ITEM_MESHES[entry.name]) fail(`export: object ${k} (${entry.name}) has ${meshes} meshes, expected ${ITEM_MESHES[entry.name]}`);
    if (!channels.scale || channels.scale.interpolation !== 'STEP') fail(`export: object ${k} has no STEP scale track`);
    if (entry.presence.length !== 1) fail(`export: object ${k} presence ${JSON.stringify(entry.presence)}`);
    const start = entry.presence[0]?.start ?? 0;
    const startKey = keyAt(take, start);
    out.startKey = startKey;
    // Hidden before the summon key, shown from it.
    if (channels.scale) {
      const s = (i) => channels.scale.values[i * 3];
      const hiddenBefore = take.times.every((_, i) => i >= startKey || s(i) === 0);
      const shownAfter = take.times.every((_, i) => i < startKey || s(i) === 1);
      out.scale = { hiddenBefore, shownAfter };
      if (!hiddenBefore || !shownAfter) fail(`export: object ${k} scale is not 0 before its summon and 1 after`);
    }
    // In the hand at the summon key, as capture had it.
    if (hand >= 0 && summon?.handRelation) {
      const relation = relativePose(rigidPose(worldAt(take, hand, startKey + 1)), rigidPose(worldAt(take, node, startKey + 1)));
      const error = { positionM: round(relation.position.distanceTo(summon.handRelation.position)), angleDeg: round(angleDeg(relation.quaternion, summon.handRelation.quaternion), 3) };
      out.handAtSummon = error;
      if (error.positionM > EXPORT_POSITION_M || error.angleDeg > EXPORT_ANGLE_DEG) fail(`export: object ${k} not in the hand at its summon (${JSON.stringify(error)})`);
    }
    // Still where it was placed: constant from its release to the end.
    if (summon?.releaseKeyOffset !== undefined) {
      const placedKey = startKey + summon.releaseKeyOffset + 2;
      const placed = rigidPose(worldAt(take, node, Math.min(placedKey, take.times.length - 1)));
      const end = rigidPose(worldAt(take, node, take.times.length - 1));
      out.placedDrift = { positionM: round(placed.position.distanceTo(end.position)), angleDeg: round(angleDeg(placed.quaternion, end.quaternion), 3) };
      if (out.placedDrift.positionM > EXPORT_POSITION_M || out.placedDrift.angleDeg > EXPORT_ANGLE_DEG) fail(`export: object ${k} moved after it was placed (${JSON.stringify(out.placedDrift)})`);
      // The rest pose (what a still shows) is the placed pose.
      const rest = take.json.nodes[node];
      const restError = v3(rest.translation ?? [0, 0, 0]).distanceTo(rigidPose(worldAt(take, node, take.times.length - 1)).position);
      out.restAtPlacedM = round(restError);
      if (restError > EXPORT_POSITION_M) fail(`export: object ${k} rest pose is ${round(restError, 3)} m from where it was placed`);
    }
    return out;
  });

  // The two placed objects relative to each other, against capture.
  const placedCapture = summons.map((summon) => summon.placed).filter(Boolean);
  if (placedCapture.length === 2 && nodes.length === 2) {
    const end = take.times.length - 1;
    const glbRelation = relativePose(rigidPose(worldAt(take, value.objects[0].node, end)), rigidPose(worldAt(take, value.objects[1].node, end)));
    const captureRelation = relativePose(placedCapture[0], placedCapture[1]);
    report.placedRelation = { positionErrorM: round(glbRelation.position.distanceTo(captureRelation.position)), angleErrorDeg: round(angleDeg(glbRelation.quaternion, captureRelation.quaternion), 3) };
    if (report.placedRelation.positionErrorM > EXPORT_POSITION_M || report.placedRelation.angleErrorDeg > EXPORT_ANGLE_DEG) fail(`export: placed objects differ from capture (${JSON.stringify(report.placedRelation)})`);
  }
  // Summon spacing against capture.
  if (summons.length === 2 && value.objects.length === 2) {
    const glbGap = value.objects[1].presence[0].start - value.objects[0].presence[0].start;
    const captureGap = summons[1].timeSec - summons[0].timeSec;
    report.summonGap = { glbSec: round(glbGap, 4), captureSec: round(captureGap, 4) };
    if (Math.abs(glbGap - captureGap) > 1e-3) fail(`export: summons ${round(glbGap, 3)} s apart in the GLB, ${round(captureGap, 3)} s in capture`);
  }

  // Authoring spans: the tray arm, and one right reach ending on each summon.
  const spans = value.authoring ?? [];
  report.authoring = spans;
  const left = spans.filter((span) => span.hand === 'left');
  const right = spans.filter((span) => span.hand === 'right');
  if (left.length < 1) fail('export: no left (tray arm) authoring span');
  if (right.length !== summons.length) fail(`export: ${right.length} right authoring spans, expected ${summons.length}`);
  right.forEach((span, k) => {
    const start = value.objects[k]?.presence[0]?.start;
    if (start !== undefined && keyAt(take, span.end) !== keyAt(take, start) - 1) fail(`export: right span ${k} ends at ${round(span.end, 3)} s, not the key before its summon (${round(start, 3)} s)`);
  });
  report.interpolation = checkInterpolation(take, spans, fail);
  return report;
}

async function enterIwer(page, mode) {
  await page.evaluate((m) => {
    window.__setManualClock(true, false);
    window.IWER_DEVICE.primaryInputMode = m;
  }, mode);
  await waitForIwerRuntime(page);
  await enterIwerSessionFromButton(page, '#VRButton', { readyCheck: () => JSON.parse(window.render_game_to_text()).mode === 'vr' });
  await page.evaluate(() => {
    window.IWER_DEVICE.controlMode = 'programmatic';
  });
  await freezePageClock(page);
  await waitForXrRenderLoop(page);
  await page.evaluate(() => window.__setFrameStepping(true, false));
}

function stepper(page) {
  const state = { steps: 0 };
  state.step = async (count = 1) => {
    for (let i = 0; i < count; i += 1) await page.clock.runFor(STEP_MS);
    state.steps += count;
  };
  return state;
}

function shooter(page, step, artifactDir, label) {
  return async (name) => {
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
}

/** Closes the loop on the avatar's right hand bone, moving `input` until the bone reaches `target()`. */
async function reach(page, step, { move, start, target, rigYaw, tolerance = 0.02 }) {
  const toTracking = (delta) => {
    const c = Math.cos(-rigYaw);
    const s = Math.sin(-rigYaw);
    return [delta[0] * c + delta[2] * s, delta[1], -delta[0] * s + delta[2] * c];
  };
  let at = [...start];
  let error = Infinity;
  for (let iteration = 0; iteration < 20 && error > tolerance; iteration += 1) {
    const state = await readState(page);
    const goal = target(state);
    const hand = state.objects.hands.right.position;
    const delta = toTracking(goal.map((v, i) => v - hand[i]));
    error = Math.hypot(...delta);
    at = at.map((v, i) => v + delta[i] * 0.8);
    await move(at);
    await step(6);
  }
  const state = await readState(page);
  error = Math.hypot(...target(state).map((v, i) => v - state.objects.hands.right.position[i]));
  return { at, error };
}

const summonedItems = (state) => state.objects.items.filter((item) => item.origin === 'summoned');

function handRelationOf(state, id) {
  const item = state.objects.items.find((candidate) => candidate.id === id);
  const hand = poseOf(state.objects.hands.right);
  return item && hand ? relativePose(hand, poseOf(item)) : null;
}

/** IWER controllers: tray open and close, negatives, two summons and placements, export; then a tray-only take. */
export async function runIwerSummonTake({ browser, baseUrl, artifactDir, consoleErrors }) {
  const label = 'iwer-summon';
  const failures = [];
  const fail = (message) => failures.push(message);
  await mkdir(artifactDir, { recursive: true });
  const { context, page } = await setupPage(browser, { iwer: true, consoleErrors, label });
  try {
    // Repeated ?tray= parameters.
    await openCapture(page, baseUrl, { tray: TRAY_URLS });
    await enterIwer(page, 'controller');
    const clock = stepper(page);
    const { step } = clock;
    const shot = shooter(page, step, artifactDir, label);
    const controller = (side, position, quaternion) => page.evaluate(({ s, p, q }) => {
      const c = window.IWER_DEVICE.controllers[s];
      c.position.set(...p);
      if (q) c.quaternion.set(...q);
    }, { s: side, p: position, q: quaternion });
    const button = (side, id, value) => page.evaluate(({ s, i, v }) => window.IWER_DEVICE.controllers[s].updateButtonValue(i, v), { s: side, i: id, v: value });

    const rest = { left: [-0.3, 0.9, -0.1], right: [0.3, 0.9, -0.1] };
    const trayHand = [-0.12, 1.1, -0.32];
    const identity = [0, 0, 0, 1];
    await controller('left', rest.left, identity);
    await controller('right', rest.right, identity);
    await step(20);
    let state = await readState(page);
    const tray = state.objects.tray;
    const loaded = { items: tray.items.map((item) => `${item.slot}:${item.name}:${item.kind}`), open: tray.open, objects: state.objects.items.length };
    if (tray.items.length !== 2) {
      fail(`the tray did not load two items (${JSON.stringify(loaded)})`);
      return { label, failures, loaded };
    }
    if (tray.open || tray.items.some((item) => item.visible)) fail('the tray is open with nothing held');
    const rigYaw = state.thumbstick.rigYaw;

    // Hold Y: the tray opens at the left hand; releasing closes it.
    await controller('left', trayHand);
    await step(20);
    await button('left', 'y-button', 1);
    await step(3);
    state = await readState(page);
    const opened = { open: state.objects.tray.open, gesture: state.objects.tray.gesture, visible: state.objects.tray.items.map((item) => item.visible) };
    const palm = state.objects.hands.left.position;
    const trayAbovePalm = state.objects.tray.items.map((item) => round(item.position[1] - palm[1], 3));
    if (!opened.open || opened.gesture.source !== 'button') fail(`holding Y did not open the tray (${JSON.stringify(opened)})`);
    if (trayAbovePalm.some((dy) => dy < 0.05 || dy > 0.25)) fail(`the tray is not above the left hand (${trayAbovePalm} m)`);
    // Before recording, a squeeze on a miniature summons nothing.
    const early = await reach(page, step, { move: (p) => controller('right', p), start: rest.right, target: (s) => s.objects.tray.items[0].position, rigYaw });
    await button('right', 'squeeze', 1);
    await step(4);
    state = await readState(page);
    if (summonedItems(state).length) fail('a squeeze on the tray before recording summoned an object');
    await button('right', 'squeeze', 0);
    await controller('right', rest.right);
    await button('left', 'y-button', 0);
    await step(6);
    state = await readState(page);
    if (state.objects.tray.open) fail('releasing Y did not close the tray');

    await clickButton(page, 'Start Recording');
    await page.getByRole('button', { name: 'Stop Recording', exact: true }).waitFor({ timeout: 10_000 });
    // Talking with the right hand before reaching for the tray.
    for (let i = 1; i <= 30; i += 1) {
      await controller('right', [rest.right[0], rest.right[1] + 0.15 * Math.sin((i / 30) * Math.PI), rest.right[2] - 0.1]);
      await step(1);
    }
    await button('left', 'y-button', 1);
    await step(4);

    // A squeeze away from the tray summons nothing.
    await button('right', 'squeeze', 1);
    await step(4);
    state = await readState(page);
    if (summonedItems(state).length) fail('a squeeze away from the tray summoned an object');
    await button('right', 'squeeze', 0);
    await step(2);

    const shots = {};
    const summons = [];
    // The first item goes out to the right; the second is set down beside
    // the open tray, inside its zone but out of a miniature's reach, so it
    // can be grabbed again there (that reach is content, not menu).
    const places = [[0.25, 1.05, -0.45], null];
    let regrab = null;
    let from = rest.right;
    for (const [k, place] of places.entries()) {
      const slot = k;
      const reached = await reach(page, step, { move: (p) => controller('right', p), start: from, target: (s) => s.objects.tray.items[slot].position, rigYaw });
      if (reached.error > 0.06) fail(`the right hand never reached tray item ${slot + 1} (${round(reached.error, 3)} m)`);
      if (k === 0) shots.trayOpen = await shot('1-tray-open');
      await button('right', 'squeeze', 1);
      await step(1);
      const summonStep = clock.steps;
      await step(1);
      state = await readState(page);
      const summoned = summonedItems(state);
      const object = summoned[k];
      const log = state.objects.tray.summons[k];
      if (summoned.length !== k + 1 || object?.heldBy !== 'right') {
        fail(`squeezing tray item ${slot + 1} did not summon it into the right hand (${JSON.stringify(summoned.map((o) => [o.name, o.heldBy]))})`);
        break;
      }
      const summon = { name: object.name, id: object.id, timeSec: log.timeSec, summonStep, handRelation: handRelationOf(state, object.id) };
      if (k === 0) shots.summoned = await shot('2-summoned');
      // Carry it out and set it down.
      let carryTo = place;
      if (place) {
        const carryFrom = reached.at;
        for (let i = 1; i <= 50; i += 1) {
          const t = smooth(i / 50);
          await controller('right', carryFrom.map((v, j) => v + (place[j] - v) * t));
          await step(1);
        }
      } else {
        const beside = (st) => {
          const [a, b] = st.objects.tray.items.map((item) => v3(item.position));
          return b.clone().add(b.clone().sub(a).setY(0).normalize().multiplyScalar(0.22)).toArray();
        };
        carryTo = (await reach(page, step, { move: (p) => controller('right', p), start: reached.at, target: beside, rigYaw })).at;
      }
      await button('right', 'squeeze', 0);
      await step(2);
      state = await readState(page);
      const placedItem = state.objects.items.find((item) => item.id === object.id);
      if (placedItem?.heldBy) fail(`releasing did not place ${object.name}`);
      // Let go, the object falls and comes to rest; that rest pose is where it was placed.
      const settle = async () => {
        let item;
        for (let i = 0; i < 240; i += 1) {
          await step(1);
          state = await readState(page);
          item = state.objects.items.find((candidate) => candidate.id === object.id);
          if (item?.body === 'asleep') break;
        }
        if (item?.body !== 'asleep') fail(`${object.name} did not come to rest after release (${item?.body})`);
        summon.releaseKeyOffset = clock.steps - summonStep;
        summon.placed = poseOf(item);
      };
      if (!place) {
        // Catch it just after letting go beside the open tray: an event object, not a summon.
        const zoneDistanceM = Math.min(...state.objects.tray.items.map((item) => v3(item.position).distanceTo(v3(state.objects.hands.right.position))));
        await button('right', 'squeeze', 1);
        await step(2);
        state = await readState(page);
        regrab = { heldBy: state.objects.items.find((item) => item.id === object.id)?.heldBy ?? null, summons: summonedItems(state).length, trayOpen: state.objects.tray.open, handToNearestMiniatureM: round(zoneDistanceM, 3) };
        if (regrab.heldBy !== 'right' || regrab.summons !== 2) fail(`catching the object beside the tray failed or summoned (${JSON.stringify(regrab)})`);
        for (let i = 1; i <= 20; i += 1) {
          await controller('right', carryTo.map((v, j) => v + (j === 1 ? 0.06 : 0) * smooth(i / 20)));
          await step(1);
        }
        await button('right', 'squeeze', 0);
        await step(2);
      }
      await settle();
      summons.push(summon);
      from = carryTo;
    }
    await controller('right', rest.right);
    await step(20);
    shots.placed = await shot('3-placed');
    await button('left', 'y-button', 0);
    await step(20);
    state = await readState(page);
    if (state.objects.tray.open) fail('the tray stayed open after Y was released');
    const placedDrift = summons.map((summon) => {
      const item = state.objects.items.find((candidate) => candidate.id === summon.id);
      return item ? round(v3(item.position).distanceTo(summon.placed.position), 5) : null;
    });
    if (placedDrift.some((drift) => drift === null || drift > 0.002)) fail(`placed objects moved after rest (${placedDrift})`);

    const glb = path.join(artifactDir, `${label}.glb`);
    await saveDownload(page, async () => {
      await clickButton(page, 'Stop Recording');
      for (let i = 0; i < 20; i += 1) await step(1);
    }, glb);
    const exportReport = checkSummonExport(await readFile(glb), { summons, fail });

    // Tray-only take: open, reach in, close without summoning.
    await page.getByRole('button', { name: 'Start Recording', exact: true }).waitFor({ timeout: 30_000 });
    await clickButton(page, 'Start Recording');
    await page.getByRole('button', { name: 'Stop Recording', exact: true }).waitFor({ timeout: 10_000 });
    await step(4);
    state = await readState(page);
    const clearedAtNextTake = summonedItems(state).length === 0;
    if (!clearedAtNextTake) fail('summoned objects from the last take are still in the scene');
    await step(16);
    await button('left', 'y-button', 1);
    await step(4);
    await reach(page, step, { move: (p) => controller('right', p), start: rest.right, target: (s) => s.objects.tray.items[1].position, rigYaw });
    await button('left', 'y-button', 0);
    await step(4);
    await controller('right', rest.right);
    await step(20);
    const trayOnlyGlb = path.join(artifactDir, `${label}-tray-only.glb`);
    await saveDownload(page, async () => {
      await clickButton(page, 'Stop Recording');
      for (let i = 0; i < 20; i += 1) await step(1);
    }, trayOnlyGlb);
    const trayOnly = loadTake(await readFile(trayOnlyGlb));
    const trayOnlyReport = {
      objectNodes: objectNodes(trayOnly).length,
      valid: trayOnly.validation?.ok ?? false,
      objects: trayOnly.validation?.ok ? trayOnly.validation.value.objects.length : null,
      authoring: trayOnly.validation?.ok ? trayOnly.validation.value.authoring ?? [] : null
    };
    if (trayOnlyReport.objectNodes !== 0 || trayOnlyReport.objects !== 0) fail(`tray-only take exported objects (${JSON.stringify(trayOnlyReport)})`);
    if (!trayOnlyReport.valid || !trayOnlyReport.authoring?.some((span) => span.hand === 'left') || !trayOnlyReport.authoring?.some((span) => span.hand === 'right')) fail(`tray-only take lacks its authoring spans (${JSON.stringify(trayOnlyReport)})`);

    return {
      label,
      status: failures.length ? 'fail' : 'pass',
      failures,
      glb,
      shots,
      capture: {
        loaded,
        opened,
        trayAbovePalmM: trayAbovePalm,
        earlyReachErrorM: round(early.error, 3),
        summons: summons.map((summon) => ({ name: summon.name, timeSec: round(summon.timeSec, 4), releaseKeyOffset: summon.releaseKeyOffset })),
        placedDriftM: placedDrift,
        regrabBesideTray: regrab,
        clearedAtNextTake
      },
      export: exportReport,
      trayOnly: trayOnlyReport
    };
  } finally {
    await context.close();
  }
}

/** IWER tracked hands: palm up opens after the dwell, palm down closes, a right pinch on a miniature summons. */
export async function runIwerHandsSummonTake({ browser, baseUrl, artifactDir, consoleErrors }) {
  const label = 'iwer-hands-summon';
  const failures = [];
  const fail = (message) => failures.push(message);
  await mkdir(artifactDir, { recursive: true });
  const { context, page } = await setupPage(browser, { iwer: true, consoleErrors, label });
  try {
    await openCapture(page, baseUrl, {});
    await page.evaluate((urls) => window.__loadTrayUrls(urls), TRAY_URLS);
    await enterIwer(page, 'hand');
    const { step } = stepper(page);
    const hand = (side, position, quaternion) => page.evaluate(({ s, p, q }) => {
      const h = window.IWER_DEVICE.hands[s];
      h.position.set(...p);
      if (q) h.quaternion.set(...q);
    }, { s: side, p: position, q: quaternion });
    const pinch = (side, value) => page.evaluate(({ s, v }) => window.IWER_DEVICE.hands[s].updatePinchValue(v), { s: side, v: value });

    const rest = { left: [-0.3, 0.9, -0.1], right: [0.3, 0.9, -0.1] };
    const down = [0, 0, 0, 1];
    await hand('left', rest.left, down);
    await hand('right', rest.right, down);
    await step(20);
    let state = await readState(page);
    const rigYaw = state.thumbstick.rigYaw;
    // Palm up: the left hand turned 180° about its forward axis.
    const up = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI).toArray();
    const restPalm = state.objects.tray.gesture.palmUp;
    await hand('left', [-0.12, 1.1, -0.32], up);
    await step(6);
    state = await readState(page);
    const beforeDwell = { open: state.objects.tray.open, palmUp: state.objects.tray.gesture.palmUp };
    await step(20);
    state = await readState(page);
    const afterDwell = { open: state.objects.tray.open, palmUp: state.objects.tray.gesture.palmUp, source: state.objects.tray.gesture.source };
    if (beforeDwell.open) fail(`the tray opened before the palm-up dwell (${JSON.stringify(beforeDwell)})`);
    if (!afterDwell.open || afterDwell.source !== 'palm') fail(`palm up did not open the tray (${JSON.stringify(afterDwell)})`);

    await clickButton(page, 'Start Recording');
    await page.getByRole('button', { name: 'Stop Recording', exact: true }).waitFor({ timeout: 10_000 });
    await step(10);
    const reached = await reach(page, step, { move: (p) => hand('right', p), start: rest.right, target: (s) => s.objects.tray.items[0].position, rigYaw });
    if (reached.error > 0.06) fail(`the right hand never reached the tray (${round(reached.error, 3)} m)`);
    for (let i = 1; i <= 6; i += 1) {
      await pinch('right', i / 6);
      await step(1);
    }
    await step(2);
    state = await readState(page);
    const summoned = summonedItems(state);
    const pinchSummon = { count: summoned.length, heldBy: summoned[0]?.heldBy ?? null, grab: state.objects.grab.right };
    if (summoned.length !== 1 || summoned[0].heldBy !== 'right') fail(`a right pinch on the tray did not summon (${JSON.stringify(pinchSummon)})`);
    for (let i = 1; i <= 30; i += 1) {
      await hand('right', reached.at.map((v, j) => v + ([0.25, 1.05, -0.45][j] - v) * smooth(i / 30)));
      await step(1);
    }
    for (let i = 5; i >= 0; i -= 1) {
      await pinch('right', i / 6);
      await step(1);
    }
    await step(2);
    state = await readState(page);
    const placed = { heldBy: summonedItems(state)[0]?.heldBy ?? null };
    if (placed.heldBy) fail('releasing the pinch did not place the object');
    // Palm down closes the tray.
    await hand('left', [-0.12, 1.1, -0.32], down);
    await step(4);
    state = await readState(page);
    const closed = { open: state.objects.tray.open, palmUp: state.objects.tray.gesture.palmUp };
    if (closed.open) fail(`palm down did not close the tray (${JSON.stringify(closed)})`);
    await saveDownload(page, async () => {
      await clickButton(page, 'Stop Recording');
      for (let i = 0; i < 20; i += 1) await step(1);
    }, path.join(artifactDir, `${label}.glb`));
    return { label, status: failures.length ? 'fail' : 'pass', failures, restPalmUp: restPalm, beforeDwell, afterDwell, pinchSummon, placed, closed };
  } finally {
    await context.close();
  }
}

/** Desktop: the overlay tray picker and its refusal, 1–5 without T, then T + 1 summons into the right hand and G places. */
export async function runDesktopSummonTake({ browser, baseUrl, captureRoot, artifactDir, consoleErrors }) {
  const label = 'desktop-summon';
  const failures = [];
  const fail = (message) => failures.push(message);
  await mkdir(artifactDir, { recursive: true });
  const { context, page } = await setupPage(browser, { iwer: false, consoleErrors, label });
  try {
    await openCapture(page, baseUrl, {});
    const advance = (seconds) => page.evaluate((ms) => window.advanceTime(ms), Math.round(seconds * 60) * STEP_MS);
    await advance(1);
    const fixtures = ['bracket.glb', 'diagram.png'].map((name) => path.join(captureRoot, 'fixtures/objects', name));
    // The pickers live in the settings side sheet.
    await page.getByRole('button', { name: 'Settings' }).click();
    const picker = page.getByLabel('Add tray items (.glb, .png, .jpg)');
    await picker.setInputFiles(fixtures);
    await page.getByText('Tray: 2').waitFor({ timeout: 10_000 });
    // Four more would make six: refused together, the tray keeps its two.
    await picker.setInputFiles([...fixtures, ...fixtures]);
    await page.getByText('The tray holds at most 5 items.').waitFor({ timeout: 10_000 });
    let state = await readState(page);
    const refusal = { items: state.objects.tray.items.length, message: 'The tray holds at most 5 items.' };
    if (refusal.items !== 2) fail(`a refused pick changed the tray (${refusal.items} items)`);
    await page.keyboard.press('Escape');
    await page.getByRole('dialog', { name: 'Settings' }).waitFor({ state: 'detached' });

    await page.locator('canvas').first().focus();
    let withoutT;
    let summoned;
    let placed;
    let trayShown;
    await page.getByRole('button', { name: 'Start Recording' }).click();
    await page.getByRole('button', { name: 'Stop Recording' }).waitFor();
    await advance(0.2);
    // 1 without T does nothing.
    await page.keyboard.press('Digit1');
    await advance(0.1);
    state = await readState(page);
    withoutT = { summoned: summonedItems(state).length };
    if (withoutT.summoned) fail('1 without T summoned an object');
    await page.keyboard.down('KeyT');
    await advance(0.1);
    state = await readState(page);
    trayShown = { open: state.objects.tray.open, source: state.objects.tray.gesture.source };
    if (!trayShown.open || trayShown.source !== 'key') fail(`holding T did not show the tray (${JSON.stringify(trayShown)})`);
    await page.keyboard.press('Digit2');
    await advance(0.05);
    state = await readState(page);
    const item = summonedItems(state)[0];
    const firstToHandM = item ? round(v3(item.position).distanceTo(v3(state.objects.hands.right.position)), 3) : null;
    await advance(0.5);
    await page.keyboard.up('KeyT');
    state = await readState(page);
    const held = summonedItems(state)[0];
    summoned = { name: held?.name ?? null, heldBy: held?.heldBy ?? null, firstToHandM, toHandM: held ? round(v3(held.position).distanceTo(v3(state.objects.hands.right.position)), 3) : null, carryWeight: state.objects.carryWeight };
    if (summoned.name !== 'diagram.png' || summoned.heldBy !== 'right') fail(`T + 2 did not summon the image into the right hand (${JSON.stringify(summoned)})`);
    if (summoned.firstToHandM === null || summoned.firstToHandM > 0.25 || summoned.toHandM > 0.25) fail(`the summoned object is not in the hand (${JSON.stringify(summoned)})`);
    await page.keyboard.press('KeyG');
    await advance(0.2);
    state = await readState(page);
    placed = { heldBy: summonedItems(state)[0]?.heldBy ?? null };
    if (placed.heldBy) fail('G did not put the summoned object down');
    const glb = await saveDownload(page, () => page.getByRole('button', { name: 'Stop Recording' }).click(), path.join(artifactDir, `${label}.glb`));
    const take = loadTake(await readFile(glb));
    const exported = {
      objectNodes: objectNodes(take).length,
      origins: take.validation?.ok ? take.validation.value.objects.map((entry) => entry.origin) : null,
      authoring: take.validation?.ok ? take.validation.value.authoring ?? [] : null
    };
    if (exported.objectNodes !== 1 || exported.origins?.[0] !== 'summoned') fail(`desktop export: ${JSON.stringify(exported)}`);
    if (exported.authoring?.length) fail('a desktop take has authoring spans (no arm moves for the desktop tray)');
    return { label, status: failures.length ? 'fail' : 'pass', failures, glb, refusal, withoutT, trayShown, summoned, placed, export: exported };
  } finally {
    await context.close();
  }
}
