import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';

import {
  attachXrEnvironment,
  captureXrScreenshot,
  createXrContext,
  enterIwerSessionFromButton,
  freezePageClock,
  launchXrBrowser,
  resolveSimulationViewport,
  resolveXrTestMode,
  waitForIwerRuntime,
  waitForPageFunctions,
  waitForTextContentPrefix,
  wireXrConsoleErrors
} from '@holoim/tooling-testing/xr-env';

const DEFAULT_XR_TEST_MODE = 'iwer';
const CAPTURE_SUCCESS_SCREENSHOTS = process.env.XR_CAPTURE_SUCCESS_SCREENSHOTS === '1';
const NO_MOVE = Object.freeze({ forward: false, back: false, left: false, right: false });
const STICK_ZERO = Object.freeze({ moveX: 0, moveY: 0, turnX: 0 });
const NO_INPUT = Object.freeze({ ...NO_MOVE, crouch: false, thumbstick: STICK_ZERO });
const VIDEO_MODE = process.env.VR_LOCO_VIDEO === '1';
const MIN_TRAVEL_METERS = 0.08;
// Require each input to land nearest its own cardinal direction: swapped axes
// or a wrong yaw sign produce errors of at least pi/2 and still fail.
const MAX_HEADING_ERROR_RAD = Math.PI / 4;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function horizontalDelta(start, end) {
  return {
    x: end.x - start.x,
    z: end.z - start.z
  };
}

function horizontalDistance(delta) {
  return Math.hypot(delta.x, delta.z);
}

function angleBetweenDeltas(a, b) {
  const aMag = horizontalDistance(a);
  const bMag = horizontalDistance(b);
  if (aMag < 1e-6 || bMag < 1e-6) return Math.PI;
  const dot = clamp((a.x * b.x + a.z * b.z) / (aMag * bMag), -1, 1);
  return Math.acos(dot);
}

// World-space travel direction for each input at a head yaw. Forward is the
// head's -Z projected on the ground plane; right is forward rotated -90°.
function expectedDirection(input, yawRad) {
  const forward = { x: -Math.sin(yawRad), z: -Math.cos(yawRad) };
  const right = { x: Math.cos(yawRad), z: -Math.sin(yawRad) };
  if (input === 'forward') return forward;
  if (input === 'back') return { x: -forward.x, z: -forward.z };
  if (input === 'right') return right;
  return { x: -right.x, z: -right.z };
}

function mockPose(yawRad, headY = 0) {
  return {
    enabled: true,
    head: {
      position: { x: 0, y: headY, z: 0 },
      quaternion: { x: 0, y: Math.sin(yawRad * 0.5), z: 0, w: Math.cos(yawRad * 0.5) }
    },
    hands: {
      left: {
        tracked: true,
        position: { x: -0.26, y: -0.2, z: -0.42 },
        quaternion: { x: 0, y: 0, z: 0, w: 1 }
      },
      right: {
        tracked: true,
        position: { x: 0.26, y: -0.2, z: -0.42 },
        quaternion: { x: 0, y: 0, z: 0, w: 1 }
      }
    }
  };
}

const baseUrl = process.env.BASE_URL ?? 'https://127.0.0.1:5174/';
// The flat test floor: the default scene spawns on a steep slope beside a
// drop, so a sideways trial could leave the ground and test the terrain, not
// the input. The default scene stays covered by the mock-VR and pipeline checks.
const url = new URL('?scene=/fixtures/scenes/body-floor.gltf&sceneScale=1', baseUrl);

const screenshotDir = process.env.XR_TEST_ARTIFACT_DIR ?? process.env.SCREENSHOT_DIR ?? 'output/ci-vr-locomotion';
await mkdir(screenshotDir, { recursive: true });

const browser = await launchXrBrowser(chromium);
const consoleErrors = [];
const resolvedMode = resolveXrTestMode(
  process.env.XR_TEST_MODE
    ?? (process.env.XR_SUPPORT_SHIM === '0' ? 'off' : DEFAULT_XR_TEST_MODE)
);

// Applies pose and input, then advances the manual clock, in one page turn so
// no browser event or realtime frame can land between them.
async function step(page, { pose, input, ms = 0, respawn = false } = {}) {
  return page.evaluate(({ nextPose, nextInput, deltaMs, shouldRespawn }) => {
    if (shouldRespawn && !window.__respawnCharacter()) throw new Error('Character respawn failed.');
    if (nextPose) window.__setMockVrPose(nextPose);
    if (nextInput) window.__setMockInput(nextInput);
    if (deltaMs > 0) window.advanceTime(deltaMs);
    return JSON.parse(window.render_game_to_text());
  }, { nextPose: pose ?? null, nextInput: input ?? null, deltaMs: ms, shouldRespawn: respawn });
}

function toSlug(label) {
  return label.replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase();
}

function summarizeState(state) {
  return {
    mode: state.mode,
    position: state.character?.position,
    grounded: state.character?.grounded,
    velocityY: state.character?.velocityY,
    locomotionState: state.locomotion?.state,
    horizontalSpeed: state.locomotion?.horizontalSpeed,
    targetHorizontalSpeed: state.locomotion?.targetHorizontalSpeed,
    crouchAmount: state.crouch?.amount,
    crouchSource: state.crouch?.source,
    input: state.input,
    thumbstick: state.thumbstick
  };
}

async function captureScreenshot(page, filename, label, { force = false } = {}) {
  if (!force && !CAPTURE_SUCCESS_SCREENSHOTS) {
    return null;
  }

  const screenshotPath = path.join(screenshotDir, filename);
  try {
    await captureXrScreenshot(page, screenshotPath);
    return screenshotPath;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[vr-locomotion] ${label} screenshot skipped: ${message}`);
    return null;
  }
}

async function failWithArtifacts(page, label, message, timeline) {
  const timelinePath = path.join(screenshotDir, `${toSlug(label)}-timeline.json`);
  await writeFile(timelinePath, JSON.stringify(timeline, null, 2));
  const screenshotPath = await captureScreenshot(page, `${toSlug(label)}-failure.png`, `${label} failure`, { force: true });
  const screenshotDetail = screenshotPath ? ` Screenshot: ${screenshotPath}` : ' Screenshot capture skipped.';
  throw new Error(`${label}: ${message}. Timeline: ${timelinePath}.${screenshotDetail}`);
}

// Simulated-time wait: every iteration advances the manual clock, so the
// budget is in simulation milliseconds and is identical on every host.
async function waitForState(page, label, predicate, { stepMs = 80, timeoutMs = 1600 } = {}) {
  const timeline = [];
  for (let elapsedMs = 0; elapsedMs <= timeoutMs; elapsedMs += stepMs) {
    const state = await step(page, { ms: elapsedMs > 0 ? stepMs : 0 });
    timeline.push({ elapsedMs, ...summarizeState(state) });
    if (predicate(state)) {
      return state;
    }
  }
  return failWithArtifacts(page, label, `condition not met after ${timeoutMs} simulated ms`, timeline);
}

async function waitForReady(page, mark) {
  await page.goto(url.href, { waitUntil: 'networkidle' });
  mark('goto');

  try {
    await waitForPageFunctions(page, [
      '__setMockVrPose',
      '__setMockInput',
      '__setManualClock',
      '__respawnCharacter',
      'advanceTime',
      'render_game_to_text'
    ]);
  } catch (error) {
    throw new Error(`Mock VR hooks not ready. ${consoleErrors.join(' | ')}${error instanceof Error ? ` | ${error.message}` : ''}`);
  }
  mark('hooks');

  await waitForTextContentPrefix(page, '#status', 'loaded');
  mark('loaded');
}

function createPhaseTimer(label) {
  let last = Date.now();
  const phases = [];
  return {
    mark: (name) => {
      const now = Date.now();
      phases.push(`${name} ${((now - last) / 1000).toFixed(1)}s`);
      last = now;
    },
    report: (suffix = 'page ready') => console.info(`[vr-locomotion] ${label} ${suffix}: ${phases.join(', ')}`)
  };
}

// Each scenario page gets its own context because Playwright's clock is
// context-wide and is frozen once a page is ready. Contexts stay open until
// the browser closes: closing one mid-run makes the next wait on GPU teardown.
async function openScenarioPage(label, { vr }) {
  const context = await createXrContext(browser, { viewport: resolveSimulationViewport() });
  const timer = createPhaseTimer(label);
  const page = await context.newPage();
  wireXrConsoleErrors(page, consoleErrors, { label });
  await attachXrEnvironment(page, { mode: resolvedMode, cacheClearState: true });
  timer.mark('context');
  await waitForReady(page, timer.mark);
  // Take the clock before session entry so the XR transition, standing-head
  // baseline, and every later step happen inside deterministic steps.
  await page.evaluate(() => window.__setManualClock(true));

  if (vr) {
    await step(page, { pose: mockPose(0), input: NO_INPUT, ms: 120 });
    if (resolvedMode === 'iwer') {
      await waitForIwerRuntime(page);
      await enterIwerSessionFromButton(page, '#VRButton', {
        readyCheck: () => JSON.parse(window.render_game_to_text()).mode === 'vr'
      });
      timer.mark('session');
    }
    await freezePageClock(page);
    await waitForState(
      page,
      `${label}-vr-ready`,
      (state) => (
        (state.mode === 'vr' || state.mode === 'mock-vr')
        && state.mockVr?.enabled === true
        && (state.crouch?.amount ?? 0) < 0.1
      ),
      { stepMs: 40, timeoutMs: 1600 }
    );
  } else {
    await freezePageClock(page);
    await step(page, { pose: { enabled: false }, input: NO_INPUT, ms: 240 });
  }
  timer.mark('baseline');
  timer.report();
  return page;
}

// Every scenario starts from a grounded, idle, standing baseline so shared
// pages cannot carry state from one check into the next. Respawning returns
// the character to the same terrain point so slopes cannot bias later trials.
async function settle(page, label, { pose, respawn = true } = {}) {
  await step(page, { pose, input: NO_INPUT, ms: 300, respawn });
  return waitForState(
    page,
    `${label}-baseline`,
    (state) => (
      state.character?.grounded === true
      && state.locomotion?.state === 'idle'
      && (state.crouch?.amount ?? 0) < 0.1
    ),
    { stepMs: 120, timeoutMs: 2400 }
  );
}

async function measureMove(page, yawRad, yawId, inputName) {
  const label = `${inputName}-${yawId}`;
  const start = await settle(page, label, { pose: mockPose(yawRad) });
  assert(start.mode === 'vr', `${label}: expected vr mode, got ${start.mode}`);
  assert(start.tracking.left.poseValid && start.tracking.right.poseValid, `${label}: hand tracking invalid in baseline.`);
  assert(start.locomotion?.activeProfile === 'vr-lower-body', `${label}: expected vr-lower-body profile, got ${start.locomotion?.activeProfile}`);

  const timeline = [];
  const engaged = await step(page, { input: { ...NO_MOVE, [inputName]: true }, ms: 120 });
  timeline.push(summarizeState(engaged));
  assert(engaged.input?.[inputName] === true, `${label}: mock input did not engage (state ${JSON.stringify(engaged.input)}).`);

  // The first input step is a real sample too: a direction may walk off a
  // ledge before the later samples, which must then correctly report falling.
  let observedWalk = engaged.locomotion?.state === 'walk' && (engaged.locomotion?.horizontalSpeed ?? 0) >= 0.05;
  for (let sample = 0; sample < 4; sample += 1) {
    const state = await step(page, { ms: 110 });
    timeline.push(summarizeState(state));
    if (state.locomotion?.state === 'walk' && (state.locomotion?.horizontalSpeed ?? 0) >= 0.05) {
      observedWalk = true;
    }
  }
  const end = await step(page, { input: NO_MOVE, ms: 120 });
  timeline.push(summarizeState(end));

  const delta = horizontalDelta(start.character.position, end.character.position);
  const distance = horizontalDistance(delta);
  const headingError = angleBetweenDeltas(delta, expectedDirection(inputName, yawRad));
  const detail = `distance ${distance.toFixed(3)} m, heading error ${headingError.toFixed(3)} rad`;
  if (!observedWalk) await failWithArtifacts(page, label, `never entered walk (${detail})`, timeline);
  if (distance <= MIN_TRAVEL_METERS) await failWithArtifacts(page, label, `travel too short (${detail})`, timeline);
  if (headingError >= MAX_HEADING_ERROR_RAD) await failWithArtifacts(page, label, `travelled the wrong way (${detail})`, timeline);
  return { label, distance, headingError };
}

async function runVrScenarios() {
  const page = await openScenarioPage('vr', { vr: true });
  const timer = createPhaseTimer('vr');
  const headings = [
    { id: 'yaw0', rad: 0 },
    { id: 'yaw90', rad: Math.PI * 0.5 },
    { id: 'yaw180', rad: Math.PI },
    { id: 'yaw-90', rad: -Math.PI * 0.5 }
  ];
  const moves = [];
  for (const heading of headings) {
    for (const inputName of ['forward', 'back', 'right', 'left']) {
      moves.push(await measureMove(page, heading.rad, heading.id, inputName));
    }
  }
  console.info(`[vr-locomotion] moves: ${moves.map((move) => `${move.label}=${move.distance.toFixed(3)}m/${move.headingError.toFixed(3)}rad`).join(', ')}`);
  await captureScreenshot(page, '01-vr-moves.png', 'vr moves');
  timer.mark('moves');

  const preJump = await settle(page, 'jump', { pose: mockPose(0) });
  const jumpStartY = preJump.character.position.y;
  await step(page, { input: { jump: true }, ms: 40 });
  const midJump = await waitForState(
    page,
    'jump-airborne',
    (state) => (
      state.character.grounded === false
      && (state.locomotion?.state === 'jump' || state.locomotion?.state === 'fall')
      && state.character.position.y > jumpStartY + 0.05
    ),
    { stepMs: 40, timeoutMs: 700 }
  );
  assert(midJump.character.position.y > jumpStartY + 0.05, 'Jump scenario: insufficient lift.');
  await step(page, { ms: 2000 });
  const postJump = await waitForState(page, 'jump-landed', (state) => state.character?.grounded === true, { stepMs: 120, timeoutMs: 2400 });
  const landingOffset = Math.abs(postJump.character.position.y - jumpStartY);
  assert(landingOffset < 0.28, `Jump scenario: landing offset too large (${landingOffset.toFixed(3)}).`);
  await captureScreenshot(page, '02-jump-landed.png', 'jump landed');
  timer.mark('jump');

  const standing = await settle(page, 'vr-crouch', { pose: mockPose(0, 0) });
  const crouched = await step(page, { pose: mockPose(0, -0.32), ms: 620 });
  assert((crouched.crouch?.amount ?? 0) > 0.2, `VR crouch: crouch amount did not rise enough (${crouched.crouch?.amount}).`);
  assert(
    crouched.crouch?.source === 'vr' || crouched.crouch?.source === 'mixed',
    `VR crouch: expected crouch source vr/mixed, got ${crouched.crouch?.source}`
  );
  const avatarRootDeltaY = Math.abs((crouched.avatar?.y ?? 0) - (standing.avatar?.y ?? 0));
  assert(avatarRootDeltaY < 0.04, `VR crouch: avatar root Y drifted too much (${avatarRootDeltaY.toFixed(3)}).`);
  const recovered = await step(page, { pose: mockPose(0, 0), ms: 680 });
  assert((recovered.crouch?.amount ?? 0) < 0.1, `VR crouch: crouch amount did not recover (${recovered.crouch?.amount}).`);
  await captureScreenshot(page, '03-vr-crouch.png', 'vr crouch');
  timer.mark('crouch');

  await settle(page, 'vr-crouch-speed-standing', { pose: mockPose(0, 0) });
  const standingMove = await step(page, { input: { forward: true }, ms: 420 });
  await step(page, { input: NO_MOVE, ms: 0 });
  await settle(page, 'vr-crouch-speed-reset', { pose: mockPose(0, 0) });
  const crouchedStart = await step(page, { pose: mockPose(0, -0.32), ms: 320 });
  assert((crouchedStart.crouch?.amount ?? 0) > 0.2, `VR crouch speed: crouch did not engage (${crouchedStart.crouch?.amount}).`);
  const crouchedMove = await step(page, { input: { forward: true }, ms: 420 });
  await step(page, { pose: mockPose(0, 0), input: NO_MOVE, ms: 680 });
  const standingSpeed = standingMove.locomotion?.targetHorizontalSpeed ?? 0;
  const crouchedSpeed = crouchedMove.locomotion?.targetHorizontalSpeed ?? 0;
  assert(
    crouchedSpeed < standingSpeed * 0.92,
    `VR crouch: target speed not reduced enough (standing ${standingSpeed.toFixed(3)}, crouched ${crouchedSpeed.toFixed(3)}).`
  );
  timer.mark('crouch-speed');

  // ── Thumbstick locomotion ──────────────────────────────────────────
  // Heading the avatar faces, from the same look yaw the motor steers by.
  const headingOf = (state) => state.avatar?.yaw ?? 0;
  const stickMove = async (label, stick, ms) => {
    const start = await settle(page, label, { pose: mockPose(0) });
    const yaw = headingOf(start);
    for (let elapsed = 0; elapsed < ms; elapsed += 110) {
      await step(page, { input: { thumbstick: stick }, ms: 110 });
    }
    const end = await step(page, { input: NO_INPUT, ms: 60 });
    const delta = horizontalDelta(start.character.position, end.character.position);
    return { yaw, delta, distance: horizontalDistance(delta), end };
  };

  for (const [name, stick, inputName] of [
    ['stick-forward', { moveX: 0, moveY: 1, turnX: 0 }, 'forward'],
    ['stick-back', { moveX: 0, moveY: -1, turnX: 0 }, 'back'],
    ['stick-right', { moveX: 1, moveY: 0, turnX: 0 }, 'right'],
    ['stick-left', { moveX: -1, moveY: 0, turnX: 0 }, 'left']
  ]) {
    const { yaw, delta, distance } = await stickMove(name, stick, 440);
    const err = angleBetweenDeltas(delta, expectedDirection(inputName, yaw));
    assert(distance > MIN_TRAVEL_METERS, `${name}: travel too short (${distance.toFixed(3)} m).`);
    assert(err < MAX_HEADING_ERROR_RAD, `${name}: heading error ${err.toFixed(3)} rad at yaw ${yaw.toFixed(3)}.`);
    console.info(`[vr-locomotion] ${name}: ${distance.toFixed(3)}m heading-err ${err.toFixed(3)}rad`);
  }

  // Deadzone: sub-threshold deflection must not creep.
  const dz = await stickMove('stick-deadzone', { moveX: 0.08, moveY: 0.08, turnX: 0 }, 550);
  assert(dz.distance < 0.02, `stick-deadzone: avatar crept ${dz.distance.toFixed(3)} m.`);

  // Analog scaling: half stick travels materially less than full stick.
  const half = await stickMove('stick-half', { moveX: 0, moveY: 0.5, turnX: 0 }, 550);
  const full = await stickMove('stick-full', { moveX: 0, moveY: 1, turnX: 0 }, 550);
  assert(half.distance > 0.03 && half.distance < full.distance * 0.8,
    `stick analog scaling: half ${half.distance.toFixed(3)} m vs full ${full.distance.toFixed(3)} m.`);

  // Snap turn: one flick = one 30° snap, no re-trigger while held, and the
  // avatar root does not translate while turning in place.
  const turnStart = await settle(page, 'snap-turn', { pose: mockPose(0) });
  const preTurnPos = turnStart.character.position;
  const preTurnYaw = turnStart.thumbstick?.turnYaw ?? 0;
  const preSnaps = turnStart.thumbstick?.snapCount ?? 0;
  let held = await step(page, { input: { thumbstick: { moveX: 0, moveY: 0, turnX: 1 } }, ms: 110 });
  for (let i = 0; i < 3; i += 1) held = await step(page, { ms: 110 });
  assert((held.thumbstick?.snapCount ?? 0) === preSnaps + 1,
    `snap-turn: held stick snapped ${held.thumbstick?.snapCount - preSnaps} times, expected 1.`);
  const snapDelta = (held.thumbstick?.turnYaw ?? 0) - preTurnYaw;
  assert(Math.abs(snapDelta + Math.PI / 6) < 0.06, `snap-turn: turn delta ${snapDelta.toFixed(3)} rad, expected ≈ -0.524.`);
  const turnTravel = horizontalDistance(horizontalDelta(preTurnPos, held.character.position));
  assert(turnTravel < 0.02, `snap-turn: avatar translated ${turnTravel.toFixed(3)} m while turning.`);
  assert(Math.abs((held.thumbstick?.rigYaw ?? 0) - (held.thumbstick?.turnYaw ?? 0)) < 0.06,
    `snap-turn: rig yaw ${held.thumbstick?.rigYaw} does not match turn yaw ${held.thumbstick?.turnYaw}.`);
  await step(page, { input: NO_INPUT, ms: 80 });
  const second = await step(page, { input: { thumbstick: { moveX: 0, moveY: 0, turnX: 1 } }, ms: 110 });
  assert((second.thumbstick?.snapCount ?? 0) === preSnaps + 2, 'snap-turn: second flick after release did not snap.');
  await step(page, { input: NO_INPUT, ms: 80 });

  // Forward stick after turning follows the new heading.
  const postTurn = await stickMove('stick-after-turn', { moveX: 0, moveY: 1, turnX: 0 }, 440);
  const postErr = angleBetweenDeltas(postTurn.delta, expectedDirection('forward', postTurn.yaw));
  assert(postTurn.distance > MIN_TRAVEL_METERS && postErr < MAX_HEADING_ERROR_RAD,
    `stick-after-turn: distance ${postTurn.distance.toFixed(3)} m, heading error ${postErr.toFixed(3)} rad at yaw ${postTurn.yaw.toFixed(3)}.`);

  // Smooth turn: heading rotates continuously while the stick is held.
  const smoothStart = await settle(page, 'smooth-turn', { pose: mockPose(0) });
  await step(page, { input: { turnMode: 'smooth', thumbstick: { moveX: 0, moveY: 0, turnX: 1 } }, ms: 0 });
  let smooth = smoothStart;
  for (let i = 0; i < 5; i += 1) smooth = await step(page, { ms: 100 });
  const smoothDelta = (smooth.thumbstick?.turnYaw ?? 0) - (smoothStart.thumbstick?.turnYaw ?? 0);
  assert(smoothDelta < -0.5 && smoothDelta > -1.4, `smooth-turn: turned ${smoothDelta.toFixed(3)} rad in 0.5 s.`);
  assert((smooth.thumbstick?.snapCount ?? 0) === (smoothStart.thumbstick?.snapCount ?? 0), 'smooth-turn: snap fired in smooth mode.');
  await step(page, { input: { turnMode: 'snap', thumbstick: STICK_ZERO }, ms: 80 });
  await captureScreenshot(page, '06-thumbstick.png', 'thumbstick');
  timer.mark('thumbstick');
  timer.report('scenarios');
}

// Choreographed third-person video of thumbstick locomotion: forward,
// snap-turn right, forward, strafe, snap-turn, forward. Frames use the
// fixed-tripod spectator view with the page UI hidden, so the avatar's
// travel across the room (not a follow camera) is what the viewer sees.
async function runThumbstickVideo() {
  const page = await openScenarioPage('video', { vr: true });
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.evaluate(() => {
    window.__setSpectatorView('body-fixed');
    const devui = window.IWER_DEVICE.devui;
    for (const element of [devui?.devUIContainer, devui?.devUICanvas, document.getElementById('ui-root'), document.getElementById('VRButton'), document.getElementById('ARButton')]) {
      if (element instanceof HTMLElement) element.style.display = 'none';
    }
  });
  await settle(page, 'video', { pose: mockPose(0) });
  const framesDir = path.join(screenshotDir, 'frames');
  await mkdir(framesDir, { recursive: true });
  let frame = 0;
  const shot = async () => {
    const name = `frame-${String(frame).padStart(4, '0')}.png`;
    frame += 1;
    // captureXrScreenshot, not page.screenshot: it runs a few frozen frames
    // first so IWER composites the current state. A raw screenshot captures
    // the stale XR composite and every frame looks identical.
    await captureXrScreenshot(page, path.join(framesDir, name), { timeout: 10_000 }).catch(() => undefined);
  };
  const drive = async (input, ms) => {
    const start = await step(page, { input, ms: 0 });
    let end = start;
    for (let elapsed = 0; elapsed < ms; elapsed += 100) {
      end = await step(page, { ms: 100 });
      await shot();
    }
    const travelled = horizontalDistance(horizontalDelta(start.character.position, end.character.position));
    console.info(`[vr-locomotion] video drive ${JSON.stringify(input.thumbstick)}: ${travelled.toFixed(2)} m, turnYaw ${(end.thumbstick?.turnYaw ?? 0).toFixed(2)} rad`);
    return end;
  };
  await shot();
  await drive({ thumbstick: { moveX: 0, moveY: 1, turnX: 0 } }, 1600);
  await drive({ thumbstick: { moveX: 0, moveY: 0, turnX: 1 } }, 300);
  await drive({ thumbstick: { moveX: 0, moveY: 1, turnX: 0 } }, 1600);
  await drive({ thumbstick: { moveX: 1, moveY: 0, turnX: 0 } }, 900);
  await drive({ thumbstick: { moveX: 0, moveY: 0, turnX: -1 } }, 300);
  await drive({ thumbstick: { moveX: 0, moveY: 1, turnX: 0 } }, 1400);
  await drive({ thumbstick: STICK_ZERO }, 400);
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const videoPath = path.join(screenshotDir, 'vr-thumbstick-locomotion.mp4');
  // The XR composite is a 320x180 canvas centered in the 1280x720 page;
  // crop to it and upscale so the avatar fills the video frame.
  await promisify(execFile)('ffmpeg', ['-y', '-framerate', '10', '-i', path.join(framesDir, 'frame-%04d.png'),
    '-vf', 'crop=320:180:480:270,scale=1280:720:flags=lanczos',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', videoPath], { timeout: 120_000 });
  console.info(`[vr-locomotion] video: ${videoPath} (${frame} frames)`);
  return videoPath;
}

async function runDesktopScenarios() {
  const page = await openScenarioPage('desktop', { vr: false });
  const timer = createPhaseTimer('desktop');
  const baseline = await settle(page, 'desktop');
  assert(baseline.mode === 'third' || baseline.mode === 'first', `Desktop: expected desktop mode, got ${baseline.mode}`);

  await page.keyboard.down('w');
  await waitForState(page, 'desktop-keyboard-forward-down', (state) => state.input?.forward === true);
  await page.keyboard.up('w');
  await waitForState(page, 'desktop-keyboard-forward-up', (state) => state.input?.forward === false);
  await page.keyboard.down('c');
  await waitForState(page, 'desktop-keyboard-crouch-down', (state) => state.input?.crouch === true);
  await page.keyboard.up('c');
  await waitForState(page, 'desktop-keyboard-crouch-up', (state) => state.input?.crouch === false);
  timer.mark('keyboard');

  await settle(page, 'desktop-crouch');
  await step(page, { input: { crouch: true } });
  const crouched = await waitForState(
    page,
    'desktop-crouch-engaged',
    (state) => (state.crouch?.amount ?? 0) > 0.2 && state.crouch?.source === 'desktop'
  );
  const crouchedY = crouched.character.position.y;
  const midJump = await step(page, { input: { crouch: true, jump: true }, ms: 220 });
  assert(
    midJump.character.velocityY > 0 || midJump.character.position.y > crouchedY + 0.03 || midJump.character.grounded === false,
    'Desktop crouch: jump did not trigger while crouched.'
  );
  await step(page, { input: { crouch: false } });
  await waitForState(page, 'desktop-crouch-released', (state) => (state.crouch?.amount ?? 0) < 0.1);
  await captureScreenshot(page, '04-desktop-crouch.png', 'desktop crouch');
  timer.mark('crouch');

  await settle(page, 'desktop-crouch-walk');
  await step(page, { input: { crouch: true, forward: true } });
  const crouchWalk = (state) => (
    (state.crouch?.amount ?? 0) > 0.2
    && (state.character?.grounded ?? false)
    && state.locomotion?.state === 'walk'
  );
  const crouchedWalk = await waitForState(page, 'desktop-crouch-walk-steady', crouchWalk, { timeoutMs: 2200, stepMs: 100 });
  await step(page, { ms: 600 });
  await waitForState(page, 'desktop-crouch-walk-sustained', crouchWalk, { timeoutMs: 1200, stepMs: 100 });

  await step(page, { input: { crouch: false, forward: true } });
  await waitForState(
    page,
    'desktop-crouch-release-walk',
    (state) => (
      state.locomotion?.state === 'walk'
      && (state.crouch?.amount ?? 0) < (crouchedWalk.crouch?.amount ?? 1)
    ),
    { timeoutMs: 2200, stepMs: 100 }
  );
  await step(page, { input: NO_INPUT, ms: 220 });
  await captureScreenshot(page, '05-desktop-crouch-walk.png', 'desktop crouch walk');
  timer.mark('crouch-walk');
  timer.report('scenarios');
}

async function timedStage(name, run) {
  const startedAt = Date.now();
  await run();
  console.info(`[vr-locomotion] ${name} passed in ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
}

try {
  await timedStage('vr scenarios', runVrScenarios);
  await timedStage('desktop scenarios', runDesktopScenarios);
  if (VIDEO_MODE) await timedStage('thumbstick video', runThumbstickVideo);
  assert(consoleErrors.length === 0, `Console errors detected:\n${consoleErrors.join('\n')}`);
  console.log('Mock VR locomotion flow check passed.');
} finally {
  await browser.close();
}
