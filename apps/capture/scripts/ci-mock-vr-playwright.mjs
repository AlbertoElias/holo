import { mkdir } from 'node:fs/promises';
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

import {
  boneOf,
  distance,
  dropoutPose,
  fingerQuatOf,
  pinchPose,
  pointingPose,
  quatAngleDelta,
  relaxedPose,
  retargetQualityOf,
  sensorOf,
  sourcePinchDistanceOf,
  tipOf,
  trackedJointCountOf
} from './lib/mock-vr-poses.mjs';

const DEFAULT_XR_TEST_MODE = 'iwer';
const CAPTURE_SUCCESS_SCREENSHOTS = process.env.XR_CAPTURE_SUCCESS_SCREENSHOTS === '1';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const baseUrl = process.env.BASE_URL ?? 'https://127.0.0.1:5174/';
const url = new URL(baseUrl);

const screenshotDir = process.env.XR_TEST_ARTIFACT_DIR ?? process.env.SCREENSHOT_DIR ?? 'output/ci-mock-vr';
await mkdir(screenshotDir, { recursive: true });

const browser = await launchXrBrowser(chromium);
const context = await createXrContext(browser, { viewport: resolveSimulationViewport() });
const page = await context.newPage();
const consoleErrors = [];
wireXrConsoleErrors(page, consoleErrors);

async function applyPoseAndSnapshot(pose, advanceMs) {
  return page.evaluate(
    ({ nextPose, ms }) => {
      window.__setMockVrPose(nextPose);
      window.advanceTime(ms);
      return JSON.parse(window.render_game_to_text());
    },
    { nextPose: pose, ms: advanceMs }
  );
}

async function waitForHooks() {
  try {
    await waitForPageFunctions(
      page,
      [
        '__setMockVrPose',
        '__setManualClock',
        'advanceTime',
        'render_game_to_text',
        '__captureHandCalibrationPose',
        '__resetHandCalibrationPose'
      ]
    );
  } catch (error) {
    throw new Error(`Mock VR hooks not ready. ${consoleErrors.join(' | ')}${error instanceof Error ? ` | ${error.message}` : ''}`);
  }
}

async function captureScreenshot(filename, { force = false } = {}) {
  if (!force && !CAPTURE_SUCCESS_SCREENSHOTS) return;
  try {
    await captureXrScreenshot(page, path.join(screenshotDir, filename));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[mock-vr] ${filename} screenshot skipped: ${message}`);
  }
}

try {
  const mode = resolveXrTestMode(
    process.env.XR_TEST_MODE
      ?? (process.env.XR_SUPPORT_SHIM === '0' ? 'off' : DEFAULT_XR_TEST_MODE)
  );

  await attachXrEnvironment(page, { mode });
  await page.goto(url.href, { waitUntil: 'networkidle' });
  await waitForHooks();
  await waitForTextContentPrefix(page, '#status', 'loaded');
  // Simulation advances only through advanceTime from here on.
  await page.evaluate(() => window.__setManualClock(true));

  if (mode === 'iwer') {
    await waitForIwerRuntime(page);
    await enterIwerSessionFromButton(page, '#VRButton', {
      readyCheck: () => JSON.parse(window.render_game_to_text()).mode === 'vr'
    });
  }
  await freezePageClock(page);

  const automaticPinchPhase = await page.evaluate(({ relaxed, pinch }) => {
    window.__resetHandCalibrationPose();
    window.__setMockVrPose(relaxed);
    window.advanceTime(350);
    const relaxedSnapshot = JSON.parse(window.render_game_to_text());
    window.__setMockVrPose(pinch);
    window.advanceTime(450);
    const pinchSnapshot = JSON.parse(window.render_game_to_text());
    return { relaxedSnapshot, pinchSnapshot };
  }, { relaxed: relaxedPose, pinch: pinchPose });

  const automaticRightPinchDistance = automaticPinchPhase.pinchSnapshot.tracking.right.pinchDistanceMeters;
  const automaticLeftPinchDistance = automaticPinchPhase.pinchSnapshot.tracking.left.pinchDistanceMeters;
  assert(automaticPinchPhase.relaxedSnapshot.tracking.right.calibrated === false, 'Automatic pinch reference unexpectedly calibrated finger segments.');
  assert(Number.isFinite(automaticRightPinchDistance), 'Automatic right pinch distance metric is missing.');
  assert(Number.isFinite(automaticLeftPinchDistance), 'Automatic left pinch distance metric is missing.');
  assert(automaticRightPinchDistance < 0.018, `Automatic right pinch does not reach fingertip contact (${automaticRightPinchDistance.toFixed(4)}).`);
  assert(automaticLeftPinchDistance < 0.018, `Automatic left pinch does not reach fingertip contact (${automaticLeftPinchDistance.toFixed(4)}).`);

  const relaxedPhase = await page.evaluate((pose) => {
    window.__resetHandCalibrationPose();
    window.__setMockVrPose(pose);
    window.advanceTime(350);
    const capture = window.__captureHandCalibrationPose();
    window.advanceTime(120);
    return { capture, snapshot: JSON.parse(window.render_game_to_text()) };
  }, relaxedPose);

  const pinchSnapshot = await applyPoseAndSnapshot(pinchPose, 450);
  await captureScreenshot('mock-vr-pinch.png');
  const pointingSnapshot = await applyPoseAndSnapshot(pointingPose, 450);
  const dropoutHoldSnapshot = await applyPoseAndSnapshot(dropoutPose, 160);
  const dropoutRecoveredSnapshot = await applyPoseAndSnapshot(relaxedPose, 420);

  const relaxedSnapshot = relaxedPhase.snapshot;

  assert(relaxedSnapshot.mode === 'vr', `Expected relaxed vr mode, got ${relaxedSnapshot.mode}`);
  assert(pinchSnapshot.mode === 'vr', `Expected pinch vr mode, got ${pinchSnapshot.mode}`);
  assert(pointingSnapshot.mode === 'vr', `Expected pointing vr mode, got ${pointingSnapshot.mode}`);

  assert(relaxedPhase.capture?.left === true, 'Left hand calibration capture failed.');
  assert(relaxedPhase.capture?.right === true, 'Right hand calibration capture failed.');

  assert(relaxedSnapshot.tracking.left.poseValid, 'Left hand tracking pose is invalid in relaxed phase.');
  assert(relaxedSnapshot.tracking.right.poseValid, 'Right hand tracking pose is invalid in relaxed phase.');
  assert(pinchSnapshot.tracking.left.poseValid, 'Left hand tracking pose is invalid in pinch phase.');
  assert(pinchSnapshot.tracking.right.poseValid, 'Right hand tracking pose is invalid in pinch phase.');

  assert(relaxedSnapshot.tracking.left.calibrated === true, 'Left hand should be calibrated after capture.');
  assert(relaxedSnapshot.tracking.right.calibrated === true, 'Right hand should be calibrated after capture.');

  const relaxedLeftBone = boneOf(relaxedSnapshot.tracking.left);
  const relaxedRightBone = boneOf(relaxedSnapshot.tracking.right);
  const pinchLeftBone = boneOf(pinchSnapshot.tracking.left);
  const pinchRightBone = boneOf(pinchSnapshot.tracking.right);
  const pinchLeftSensor = sensorOf(pinchSnapshot.tracking.left);
  const pinchRightSensor = sensorOf(pinchSnapshot.tracking.right);

  assert(relaxedLeftBone && relaxedRightBone, 'Relaxed solved hand bones were not produced.');
  assert(pinchLeftBone && pinchRightBone, 'Pinch solved hand bones were not produced.');
  assert(pinchLeftSensor && pinchRightSensor, 'Pinch hand sensor positions were not produced.');

  const leftDelta = distance(relaxedLeftBone, pinchLeftBone);
  const rightDelta = distance(relaxedRightBone, pinchRightBone);
  assert(leftDelta > 0.05, `Left hand bone did not move enough (${leftDelta.toFixed(3)}).`);
  assert(rightDelta > 0.05, `Right hand bone did not move enough (${rightDelta.toFixed(3)}).`);

  const leftSensorGap = distance(pinchLeftSensor, pinchLeftBone);
  const rightSensorGap = distance(pinchRightSensor, pinchRightBone);
  assert(leftSensorGap < 0.02, `Left hand sensor drift too large (${leftSensorGap.toFixed(3)}).`);
  assert(rightSensorGap < 0.02, `Right hand sensor drift too large (${rightSensorGap.toFixed(3)}).`);

  const leftTrackedJointCount = trackedJointCountOf(pinchSnapshot.tracking.left);
  const rightTrackedJointCount = trackedJointCountOf(pinchSnapshot.tracking.right);
  assert(leftTrackedJointCount >= 20, `Left finger joint tracked count too low (${leftTrackedJointCount}).`);
  assert(rightTrackedJointCount >= 20, `Right finger joint tracked count too low (${rightTrackedJointCount}).`);

  const relaxedAvatarPinchDistance = relaxedSnapshot.tracking.right.pinchDistanceMeters;
  const pinchAvatarDistance = pinchSnapshot.tracking.right.pinchDistanceMeters;
  const pinchLeftAvatarDistance = pinchSnapshot.tracking.left.pinchDistanceMeters;
  assert(Number.isFinite(relaxedAvatarPinchDistance), 'Missing relaxed avatar pinch distance metric.');
  assert(Number.isFinite(pinchAvatarDistance), 'Missing pinch avatar pinch distance metric.');
  assert(Number.isFinite(pinchLeftAvatarDistance), 'Missing left avatar pinch distance metric.');

  const relaxedSourcePinchDistance = sourcePinchDistanceOf(relaxedPose, 'right');
  const pinchSourcePinchDistance = sourcePinchDistanceOf(pinchPose, 'right');

  const sourcePinchDelta = relaxedSourcePinchDistance - pinchSourcePinchDistance;
  const avatarPinchDelta = relaxedAvatarPinchDistance - pinchAvatarDistance;
  console.log(
    `[mock-vr] pinch source=${pinchSourcePinchDistance.toFixed(4)}m avatar-right=${pinchAvatarDistance.toFixed(4)}m avatar-left=${pinchLeftAvatarDistance.toFixed(4)}m`
  );

  assert(
    relaxedAvatarPinchDistance > pinchAvatarDistance + 0.004,
    `Avatar pinch did not close enough (relaxed=${relaxedAvatarPinchDistance.toFixed(4)} pinch=${pinchAvatarDistance.toFixed(4)}).`
  );
  assert(pinchSourcePinchDistance < 0.018, `Source pinch does not reach fingertip contact (${pinchSourcePinchDistance.toFixed(4)}).`);
  assert(pinchAvatarDistance < 0.018, `Right avatar pinch does not reach fingertip contact (${pinchAvatarDistance.toFixed(4)}).`);
  assert(pinchLeftAvatarDistance < 0.018, `Left avatar pinch does not reach fingertip contact (${pinchLeftAvatarDistance.toFixed(4)}).`);

  assert(sourcePinchDelta > 0, `Source pinch distance did not decrease (${sourcePinchDelta.toFixed(4)}).`);
  assert(avatarPinchDelta > 0, `Avatar pinch distance did not decrease (${avatarPinchDelta.toFixed(4)}).`);

  const pointingHand = pointingSnapshot.tracking.right;
  const pointingHandBone = boneOf(pointingHand);
  const pointingIndexTip = tipOf(pointingHand, 'index');
  const pointingMiddleTip = tipOf(pointingHand, 'middle');
  const pointingRingTip = tipOf(pointingHand, 'ring');
  const pointingPinkyTip = tipOf(pointingHand, 'pinky');

  assert(pointingHandBone, 'Pointing hand bone data missing.');
  assert(pointingIndexTip && pointingMiddleTip && pointingRingTip && pointingPinkyTip, 'Pointing finger tip metrics missing.');

  const indexReach = distance(pointingIndexTip, pointingHandBone);
  const middleReach = distance(pointingMiddleTip, pointingHandBone);
  const ringReach = distance(pointingRingTip, pointingHandBone);
  const pinkyReach = distance(pointingPinkyTip, pointingHandBone);

  assert(indexReach > middleReach + 0.001, `Pointing index is not more extended than middle (index=${indexReach.toFixed(4)} middle=${middleReach.toFixed(4)}).`);
  assert(indexReach > ringReach + 0.001, `Pointing index is not more extended than ring (index=${indexReach.toFixed(4)} ring=${ringReach.toFixed(4)}).`);
  assert(indexReach > pinkyReach + 0.001, `Pointing index is not more extended than pinky (index=${indexReach.toFixed(4)} pinky=${pinkyReach.toFixed(4)}).`);

  const relaxedRightIndexQuat = fingerQuatOf(relaxedSnapshot.tracking.right, 'index');
  const relaxedRightMiddleQuat = fingerQuatOf(relaxedSnapshot.tracking.right, 'middle');
  const pointingRightIndexQuat = fingerQuatOf(pointingSnapshot.tracking.right, 'index');
  const pointingRightMiddleQuat = fingerQuatOf(pointingSnapshot.tracking.right, 'middle');
  const pointingIndexDelta = quatAngleDelta(relaxedRightIndexQuat, pointingRightIndexQuat);
  const pointingMiddleDelta = quatAngleDelta(relaxedRightMiddleQuat, pointingRightMiddleQuat);

  assert(Number.isFinite(pointingIndexDelta), 'Pointing index quaternion debug output missing.');
  assert(Number.isFinite(pointingMiddleDelta), 'Pointing middle quaternion debug output missing.');
  assert(
    pointingMiddleDelta > pointingIndexDelta * 1.15,
    `Pointing control fingers did not curl more than index (middle=${pointingMiddleDelta.toFixed(3)} index=${pointingIndexDelta.toFixed(3)}).`
  );

  const preDropoutRightIndexQuat = fingerQuatOf(pointingSnapshot.tracking.right, 'index');
  const dropoutRightIndexQuat = fingerQuatOf(dropoutHoldSnapshot.tracking.right, 'index');
  const recoveredRightIndexQuat = fingerQuatOf(dropoutRecoveredSnapshot.tracking.right, 'index');

  // Converged means the bone returns to what the same live relaxed pose
  // produces without a dropout, not merely that it moved.
  const holdDrift = quatAngleDelta(preDropoutRightIndexQuat, dropoutRightIndexQuat);
  const recoveryError = quatAngleDelta(relaxedRightIndexQuat, recoveredRightIndexQuat);
  assert(Number.isFinite(holdDrift), 'Dropout hold quaternion debug output missing.');
  assert(Number.isFinite(recoveryError), 'Dropout recovery quaternion debug output missing.');
  assert(holdDrift < 0.15, `Dropout hold drifted too much (${holdDrift.toFixed(3)} rad).`);
  assert(recoveryError < 0.02, `Dropout recovery did not converge to the live pose (${recoveryError.toFixed(3)} rad off).`);
  // The whole index chain must recover, not only the sampled bone.
  const relaxedIndexTip = tipOf(relaxedSnapshot.tracking.right, 'index');
  const recoveredIndexTip = tipOf(dropoutRecoveredSnapshot.tracking.right, 'index');
  assert(relaxedIndexTip && recoveredIndexTip, 'Dropout recovery fingertip metrics missing.');
  const recoveredWrist = boneOf(dropoutRecoveredSnapshot.tracking.right);
  assert(relaxedRightBone && recoveredWrist, 'Dropout recovery wrist metrics missing.');
  // The motor can settle on sloped terrain between samples. Finger recovery is
  // measured relative to its wrist, preserving the same 2 mm chain tolerance.
  const relativeTip = (tip, wrist) => ({ x: tip.x - wrist.x, y: tip.y - wrist.y, z: tip.z - wrist.z });
  const tipRecoveryError = distance(relativeTip(relaxedIndexTip, relaxedRightBone), relativeTip(recoveredIndexTip, recoveredWrist));
  const wristTargetError = distance(
    relativeTip(relaxedRightBone, relaxedSnapshot.tracking.right.targetPosition),
    relativeTip(recoveredWrist, dropoutRecoveredSnapshot.tracking.right.targetPosition)
  );
  console.log(`[mock-vr] dropout tip wrist-relative=${(tipRecoveryError * 1000).toFixed(2)}mm world=${(distance(relaxedIndexTip, recoveredIndexTip) * 1000).toFixed(2)}mm wrist-target-residual-change=${(wristTargetError * 1000).toFixed(2)}mm`);
  assert(wristTargetError < 0.002, `Dropout recovery changed wrist-to-target residual by ${(wristTargetError * 1000).toFixed(1)} mm.`);
  assert(tipRecoveryError < 0.002, `Dropout recovery left the wrist-relative index fingertip ${(tipRecoveryError * 1000).toFixed(1)} mm from the live pose.`);

  const dropoutQuality = retargetQualityOf(dropoutHoldSnapshot.tracking.right);
  assert(dropoutQuality, 'Dropout retarget quality metrics missing.');
  assert(dropoutQuality.heldSegments > 0, `Expected held segments during dropout (got ${JSON.stringify(dropoutQuality)}).`);

  assert(consoleErrors.length === 0, `Console errors found: ${consoleErrors.join(' | ')}`);

  await captureScreenshot('mock-vr-final.png');
  console.log('Mock VR CI check passed.');
} catch (error) {
  await captureScreenshot('mock-vr-failure.png', { force: true });
  throw error;
} finally {
  await context.close();
  await browser.close();
}
