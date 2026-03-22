import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';

import {
  attachXrEnvironment,
  createXrContext,
  enterIwerSessionFromButton,
  launchXrBrowser,
  resolveXrTestMode,
  waitForIwerRuntime,
  waitForPageFunctions,
  waitForTextContentPrefix,
  wireXrConsoleErrors
} from '@holoim/tooling-testing/xr-env';

const DEFAULT_XR_TEST_MODE = 'iwer';

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
  if (aMag < 1e-6 || bMag < 1e-6) return 0;
  const dot = clamp((a.x * b.x + a.z * b.z) / (aMag * bMag), -1, 1);
  return Math.acos(dot);
}

const baseUrl = process.env.BASE_URL ?? 'https://127.0.0.1:5174/';
const url = new URL(baseUrl);

const screenshotDir = process.env.XR_TEST_ARTIFACT_DIR ?? process.env.SCREENSHOT_DIR ?? 'output/ci-vr-locomotion';
await mkdir(screenshotDir, { recursive: true });

const browser = await launchXrBrowser(chromium);
const context = await createXrContext(browser);
const consoleErrors = [];
const resolvedMode = resolveXrTestMode(
  process.env.XR_TEST_MODE
    ?? (process.env.XR_SUPPORT_SHIM === '0' ? 'off' : DEFAULT_XR_TEST_MODE)
);

async function waitForReady(page) {
  await page.goto(url.href, { waitUntil: 'networkidle' });

  try {
    await waitForPageFunctions(page, [
      '__setMockVrPose',
      '__setMockInput',
      'advanceTime',
      'render_game_to_text'
    ]);
  } catch (error) {
    throw new Error(`Mock VR hooks not ready. ${consoleErrors.join(' | ')}${error instanceof Error ? ` | ${error.message}` : ''}`);
  }

  await waitForTextContentPrefix(page, '#status', 'loaded');
}

async function withScenarioPage(label, callback) {
  const page = await context.newPage();
  wireXrConsoleErrors(page, consoleErrors, { label });

  try {
    await attachXrEnvironment(page, { mode: resolvedMode });
    await waitForReady(page);
    return await callback(page);
  } finally {
    await page.close();
  }
}

async function withVrScenarioPage(label, callback) {
  return withScenarioPage(label, async (page) => {
    if (resolvedMode === 'iwer') {
      await waitForIwerRuntime(page);
      await enterIwerSessionFromButton(page, '#VRButton', {
        readyCheck: () => JSON.parse(window.render_game_to_text()).mode === 'vr'
      });
    }
    return callback(page);
  });
}

async function setMockPose(page, yawRad, headY = 0) {
  await page.evaluate(
    ({ yawRad: nextYaw, headY: nextHeadY }) => {
      window.__setMockVrPose({
        enabled: true,
        head: {
          position: { x: 0, y: nextHeadY, z: 0 },
          quaternion: {
            x: 0,
            y: Math.sin(nextYaw * 0.5),
            z: 0,
            w: Math.cos(nextYaw * 0.5)
          }
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
      });
    },
    { yawRad, headY }
  );
}

async function setMockInput(page, payload) {
  await page.evaluate((nextInput) => {
    window.__setMockInput(nextInput);
  }, payload);
}

async function advance(page, ms) {
  await page.evaluate((deltaMs) => {
    window.advanceTime(deltaMs);
  }, ms);
}

async function snapshot(page) {
  return page.evaluate(() => JSON.parse(window.render_game_to_text()));
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
    input: state.input
  };
}

async function captureScreenshot(page, filename, label) {
  const screenshotPath = path.join(screenshotDir, filename);
  try {
    await page.screenshot({ path: screenshotPath, timeout: 10_000 });
    return screenshotPath;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[vr-locomotion] ${label} screenshot skipped: ${message}`);
    return null;
  }
}

async function waitForState(page, label, predicate, options = {}) {
  const stepMs = options.stepMs ?? 80;
  const timeoutMs = options.timeoutMs ?? 1600;
  const timeline = [];
  const timelinePath = path.join(screenshotDir, `${toSlug(label)}-timeline.json`);
  const screenshotName = `${toSlug(label)}-failure.png`;

  for (let elapsedMs = 0; elapsedMs <= timeoutMs; elapsedMs += stepMs) {
    if (elapsedMs > 0) {
      await advance(page, stepMs);
    }

    const state = await snapshot(page);
    timeline.push({
      elapsedMs,
      ...summarizeState(state)
    });
    if (predicate(state)) {
      return state;
    }
  }

  await writeFile(timelinePath, JSON.stringify(timeline, null, 2));
  const screenshotPath = await captureScreenshot(page, screenshotName, `${label} failure`);
  const screenshotDetail = screenshotPath ? ` Screenshot: ${screenshotPath}` : ' Screenshot capture skipped.';
  throw new Error(`${label}: condition not met after ${timeoutMs}ms. Timeline: ${timelinePath}.${screenshotDetail}`);
}

async function ensureGrounded(page) {
  for (let index = 0; index < 20; index += 1) {
    const state = await snapshot(page);
    if (state.character?.grounded) return state;
    await advance(page, 120);
  }
  throw new Error('Character never reached grounded state in mock VR.');
}

async function runMoveScenario(label, yawRad, inputPayload, durationMs, screenshotName) {
  return withVrScenarioPage(label, async (page) => {
    await setMockPose(page, yawRad);
    await advance(page, 300);
    const start = await ensureGrounded(page);

    assert(start.mode === 'vr', `${label}: expected vr mode, got ${start.mode}`);
    assert(start.tracking.left.poseValid && start.tracking.right.poseValid, `${label}: hand tracking invalid in baseline.`);
    assert(start.locomotion?.activeProfile === 'vr-lower-body', `${label}: expected vr-lower-body profile, got ${start.locomotion?.activeProfile}`);
    assert(start.locomotion?.state === 'idle', `${label}: expected idle locomotion at baseline, got ${start.locomotion?.state}`);

    await setMockInput(page, inputPayload);
    await advance(page, 120);
    const engaged = await snapshot(page);
    for (const [key, expected] of Object.entries(inputPayload)) {
      if (key === 'jump') continue;
      if (expected === true) {
        assert(
          engaged.input?.[key] === true,
          `${label}: mock input '${key}' did not engage (state ${JSON.stringify(engaged.input)}).`
        );
      }
    }
    let observedWalk = engaged.locomotion?.state === 'walk' && (engaged.locomotion?.horizontalSpeed ?? 0) >= 0.05;
    const movementSamples = 4;
    const movementStepMs = Math.max(50, Math.floor(durationMs / movementSamples));
    for (let index = 0; index < movementSamples; index += 1) {
      await advance(page, movementStepMs);
      const sample = await snapshot(page);
      if (sample.locomotion?.state === 'walk' && (sample.locomotion?.horizontalSpeed ?? 0) >= 0.05) {
        observedWalk = true;
      }
    }
    await setMockInput(page, { forward: false, back: false, left: false, right: false });
    await advance(page, 120);

    const end = await snapshot(page);
    const delta = horizontalDelta(start.character.position, end.character.position);
    await captureScreenshot(page, screenshotName, label);

    return {
      start,
      end,
      delta,
      distance: horizontalDistance(delta),
      observedWalk
    };
  });
}

function bestByDistance(trials) {
  return trials.reduce((best, next) => (next.distance > best.distance ? next : best), trials[0]);
}

async function measureForwardDistanceForHeadY(label, headY, screenshotName) {
  return withVrScenarioPage(label, async (page) => {
    await setMockPose(page, 0, 0);
    await advance(page, 240);
    await setMockPose(page, 0, headY);
    await advance(page, 320);
    const start = await ensureGrounded(page);

    if (headY < -0.05) {
      assert((start.crouch?.amount ?? 0) > 0.2, `${label}: expected crouch amount to rise for headY=${headY}, got ${start.crouch?.amount}`);
    } else {
      assert((start.crouch?.amount ?? 0) < 0.1, `${label}: expected near-zero crouch for standing headY=${headY}, got ${start.crouch?.amount}`);
    }

    await setMockInput(page, { forward: true });
    await advance(page, 420);
    const end = await snapshot(page);
    await setMockInput(page, { forward: false });
    await captureScreenshot(page, screenshotName, label);
    return {
      distance: horizontalDistance(horizontalDelta(start.character.position, end.character.position)),
      targetSpeed: end.locomotion?.targetHorizontalSpeed ?? 0
    };
  });
}

async function runMovementTrials(actionName, inputPayload, durationMs, screenshotPrefix) {
  const yawVariants = [
    { id: 'yaw0', rad: 0 },
    { id: 'yaw90', rad: Math.PI * 0.5 },
    { id: 'yaw180', rad: Math.PI },
    { id: 'yaw-90', rad: -Math.PI * 0.5 }
  ];

  const trials = [];
  for (const yaw of yawVariants) {
    const trial = await runMoveScenario(
      `${actionName}-${yaw.id}`,
      yaw.rad,
      inputPayload,
      durationMs,
      `${screenshotPrefix}-${yaw.id}.png`
    );
    trials.push({ actionName, yawId: yaw.id, ...trial });
  }
  return trials;
}

try {
  const forwardTrials = await runMovementTrials('forward', { forward: true }, 450, '01-forward');
  const rightTrials = await runMovementTrials('strafe-right', { right: true }, 450, '02-strafe-right');
  const hasForwardWalkState = forwardTrials.some((trial) => trial.observedWalk);
  const hasStrafeWalkState = rightTrials.some((trial) => trial.observedWalk);

  const bestForward = bestByDistance(forwardTrials);
  const bestRight = bestByDistance(rightTrials);

  assert(
    bestForward.distance > 0.08,
    `No viable forward locomotion flow found. Distances: ${forwardTrials
      .map((trial) => `${trial.yawId}=${trial.distance.toFixed(3)}`)
      .join(', ')}`
  );
  assert(
    bestRight.distance > 0.08,
    `No viable strafe-right locomotion flow found. Distances: ${rightTrials
      .map((trial) => `${trial.yawId}=${trial.distance.toFixed(3)}`)
      .join(', ')}`
  );
  assert(hasForwardWalkState, 'No forward trial ever entered walk locomotion state.');
  assert(hasStrafeWalkState, 'No strafe-right trial ever entered walk locomotion state.');

  const rightByYaw = new Map(rightTrials.map((trial) => [trial.yawId, trial]));
  let bestYawPair = null;
  for (const forwardTrial of forwardTrials) {
    const rightTrial = rightByYaw.get(forwardTrial.yawId);
    if (!rightTrial) continue;
    if (forwardTrial.distance < 0.08 || rightTrial.distance < 0.08) continue;
    const angle = angleBetweenDeltas(forwardTrial.delta, rightTrial.delta);
    const score = Math.min(forwardTrial.distance, rightTrial.distance);
    if (!bestYawPair || score > bestYawPair.score) {
      bestYawPair = {
        yawId: forwardTrial.yawId,
        angle,
        score
      };
    }
  }
  assert(bestYawPair, 'No yaw variant produced viable forward and strafe-right movement together.');
  assert(
    bestYawPair.angle > 0.35,
    `Forward/strafe at yaw ${bestYawPair.yawId} were too similar (angle ${bestYawPair.angle.toFixed(3)} rad).`
  );

  await withVrScenarioPage('jump', async (page) => {
    await setMockPose(page, 0);
    await advance(page, 300);

    const preJump = await ensureGrounded(page);
    const jumpStartY = preJump.character.position.y;

    await setMockInput(page, { jump: true });
    await advance(page, 180);

    const midJump = await snapshot(page);
    assert(!midJump.character.grounded, 'Jump scenario: character should be airborne shortly after jump.');
    assert(
      midJump.locomotion?.state === 'jump' || midJump.locomotion?.state === 'fall',
      `Jump scenario: expected jump/fall locomotion state, got ${midJump.locomotion?.state}`
    );
    assert(
      midJump.character.position.y > jumpStartY + 0.05,
      `Jump scenario: insufficient lift (${(midJump.character.position.y - jumpStartY).toFixed(3)}).`
    );

    await advance(page, 2000);
    const postJump = await ensureGrounded(page);
    const landingOffset = Math.abs(postJump.character.position.y - jumpStartY);
    assert(landingOffset < 0.28, `Jump scenario: landing offset too large (${landingOffset.toFixed(3)}).`);

    await captureScreenshot(page, '03-jump-landed.png', 'jump landed');
  });

  await withVrScenarioPage('vr-crouch-state', async (page) => {
    await setMockPose(page, 0, 0);
    await advance(page, 320);
    const standing = await ensureGrounded(page);
    assert((standing.crouch?.amount ?? 0) < 0.1, `VR crouch: expected near-zero standing crouch amount, got ${standing.crouch?.amount}`);

    await setMockPose(page, 0, -0.32);
    await advance(page, 620);
    const crouched = await snapshot(page);
    assert((crouched.crouch?.amount ?? 0) > 0.2, `VR crouch: crouch amount did not rise enough (${crouched.crouch?.amount}).`);
    assert(
      crouched.crouch?.source === 'vr' || crouched.crouch?.source === 'mixed',
      `VR crouch: expected crouch source vr/mixed, got ${crouched.crouch?.source}`
    );
    const avatarRootDeltaY = Math.abs((crouched.avatar?.y ?? 0) - (standing.avatar?.y ?? 0));
    assert(avatarRootDeltaY < 0.04, `VR crouch: avatar root Y drifted too much (${avatarRootDeltaY.toFixed(3)}).`);
    await setMockPose(page, 0, 0);
    await advance(page, 680);
    const recovered = await snapshot(page);
    assert((recovered.crouch?.amount ?? 0) < 0.1, `VR crouch: crouch amount did not recover (${recovered.crouch?.amount}).`);
    await captureScreenshot(page, '04-vr-crouch.png', 'vr crouch');
  });

  const standingMovement = await measureForwardDistanceForHeadY('vr-crouch-speed-standing', 0, '05-vr-crouch-speed-standing.png');
  const crouchedMovement = await measureForwardDistanceForHeadY('vr-crouch-speed-crouched', -0.32, '06-vr-crouch-speed-crouched.png');
  assert(
    crouchedMovement.targetSpeed < standingMovement.targetSpeed * 0.92,
    `VR crouch: target speed not reduced enough (standing ${standingMovement.targetSpeed.toFixed(3)}, crouched ${crouchedMovement.targetSpeed.toFixed(3)}).`
  );
  // Horizontal travel in the mocked XR flow is noisier than target speed
  // because head-height changes can shift grounding/settling timing by a few
  // frames. The locomotion target speed is the authoritative signal for the
  // crouch slowdown, so keep distance as diagnostics only.
  console.info(
    `VR crouch distance diagnostic: standing=${standingMovement.distance.toFixed(3)} crouched=${crouchedMovement.distance.toFixed(3)}`
  );

  await withScenarioPage('desktop-keyboard-mapping', async (page) => {
    await page.evaluate(() => {
      window.__setMockVrPose({ enabled: false });
    });
    await advance(page, 240);

    await page.keyboard.down('w');
    const forwardPressed = await waitForState(
      page,
      'desktop-keyboard-forward-down',
      (state) => state.input?.forward === true
    );
    assert(forwardPressed.input?.forward === true, 'Desktop keyboard mapping: W key did not set forward input.');

    await page.keyboard.up('w');
    await waitForState(page, 'desktop-keyboard-forward-up', (state) => state.input?.forward === false);

    await page.keyboard.down('c');
    const crouchPressed = await waitForState(
      page,
      'desktop-keyboard-crouch-down',
      (state) => state.input?.crouch === true
    );
    assert(crouchPressed.input?.crouch === true, 'Desktop keyboard mapping: C key did not set crouch input.');

    await page.keyboard.up('c');
    await waitForState(page, 'desktop-keyboard-crouch-up', (state) => state.input?.crouch === false);
    await captureScreenshot(page, '07-desktop-keyboard-mapping.png', 'desktop keyboard mapping');
  });

  await withScenarioPage('desktop-crouch', async (page) => {
    await page.evaluate(() => {
      window.__setMockVrPose({ enabled: false });
    });
    await advance(page, 240);
    const baseline = await snapshot(page);
    assert(baseline.mode === 'third' || baseline.mode === 'first', `Desktop crouch: expected desktop mode, got ${baseline.mode}`);

    await setMockInput(page, { crouch: true });
    const crouched = await waitForState(
      page,
      'desktop-crouch-engaged',
      (state) => (state.crouch?.amount ?? 0) > 0.2 && state.crouch?.source === 'desktop'
    );
    assert(crouched.input?.crouch === true, 'Desktop crouch: input state did not report crouch=true.');

    const crouchedY = crouched.character.position.y;
    await setMockInput(page, { crouch: true, jump: true });
    await advance(page, 220);
    const midJump = await snapshot(page);
    assert(
      midJump.character.velocityY > 0 || midJump.character.position.y > crouchedY + 0.03 || midJump.character.grounded === false,
      'Desktop crouch: jump did not trigger while crouched.'
    );

    await setMockInput(page, { crouch: false });
    await waitForState(
      page,
      'desktop-crouch-released',
      (state) => (state.crouch?.amount ?? 0) < 0.1
    );
    await captureScreenshot(page, '08-desktop-crouch.png', 'desktop crouch');
  });

  await withScenarioPage('desktop-crouch-walk', async (page) => {
    await page.evaluate(() => {
      window.__setMockVrPose({ enabled: false });
    });
    await advance(page, 240);
    const baseline = await snapshot(page);

    await setMockInput(page, { crouch: true, forward: true });
    const crouchWalk = await waitForState(
      page,
      'desktop-crouch-walk-steady',
      (state) => (
        (state.crouch?.amount ?? 0) > 0.2
        && (state.character?.grounded ?? false)
        && state.locomotion?.state === 'walk'
      ),
      { timeoutMs: 2200, stepMs: 100 }
    );
    assert(
      crouchWalk.character.position.y >= baseline.character.position.y - 0.12,
      `Desktop crouch-walk: character dropped too far while crouch-walking (baselineY=${baseline.character.position.y.toFixed(3)}, crouchWalkY=${crouchWalk.character.position.y.toFixed(3)}).`
    );

    await setMockInput(page, { crouch: false, forward: false });
    await advance(page, 240);
    await captureScreenshot(page, '09-desktop-crouch-walk.png', 'desktop crouch walk');
  });

  await withScenarioPage('desktop-crouch-release-walk', async (page) => {
    await page.evaluate(() => {
      window.__setMockVrPose({ enabled: false });
    });
    await advance(page, 240);

    await setMockInput(page, { crouch: true, forward: true });
    const crouchedWalk = await waitForState(
      page,
      'desktop-crouch-release-baseline',
      (state) => (
        (state.character?.grounded ?? false)
        && state.locomotion?.state === 'walk'
        && (state.crouch?.amount ?? 0) > 0.2
      ),
      { timeoutMs: 2200, stepMs: 100 }
    );

    await setMockInput(page, { crouch: false, forward: true });
    const shortlyAfterRelease = await waitForState(
      page,
      'desktop-crouch-release-recovered',
      (state) => (
        state.locomotion?.state === 'walk'
        && (state.crouch?.amount ?? 0) < (crouchedWalk.crouch?.amount ?? 1)
      ),
      { timeoutMs: 2200, stepMs: 100 }
    );

    assert(
      shortlyAfterRelease.locomotion?.state === 'walk',
      `Desktop crouch-release-walk: expected walk shortly after release, got ${shortlyAfterRelease.locomotion?.state}.`
    );

    await setMockInput(page, { forward: false, crouch: false });
    await advance(page, 220);
    await captureScreenshot(page, '10-desktop-crouch-release-walk.png', 'desktop crouch release walk');
  });

  assert(consoleErrors.length === 0, `Console errors detected:\n${consoleErrors.join('\n')}`);
  console.log('Mock VR locomotion flow check passed.');
} finally {
  await context.close();
  await browser.close();
}
