import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { attachXrEnvironment, resolveXrTestMode } from '@holoim/tooling-testing/xr-env';

const TRACKED_HAND_JOINT_NAMES = [
  'wrist',
  'thumb-metacarpal',
  'thumb-phalanx-proximal',
  'thumb-phalanx-distal',
  'thumb-tip',
  'index-finger-metacarpal',
  'index-finger-phalanx-proximal',
  'index-finger-phalanx-intermediate',
  'index-finger-phalanx-distal',
  'index-finger-tip',
  'middle-finger-metacarpal',
  'middle-finger-phalanx-proximal',
  'middle-finger-phalanx-intermediate',
  'middle-finger-phalanx-distal',
  'middle-finger-tip',
  'ring-finger-metacarpal',
  'ring-finger-phalanx-proximal',
  'ring-finger-phalanx-intermediate',
  'ring-finger-phalanx-distal',
  'ring-finger-tip',
  'pinky-finger-metacarpal',
  'pinky-finger-phalanx-proximal',
  'pinky-finger-phalanx-intermediate',
  'pinky-finger-phalanx-distal',
  'pinky-finger-tip'
];

const FINGER_CHAINS = {
  thumb: ['thumb-metacarpal', 'thumb-phalanx-proximal', 'thumb-phalanx-distal', 'thumb-tip'],
  index: ['index-finger-metacarpal', 'index-finger-phalanx-proximal', 'index-finger-phalanx-intermediate', 'index-finger-phalanx-distal', 'index-finger-tip'],
  middle: ['middle-finger-metacarpal', 'middle-finger-phalanx-proximal', 'middle-finger-phalanx-intermediate', 'middle-finger-phalanx-distal', 'middle-finger-tip'],
  ring: ['ring-finger-metacarpal', 'ring-finger-phalanx-proximal', 'ring-finger-phalanx-intermediate', 'ring-finger-phalanx-distal', 'ring-finger-tip'],
  pinky: ['pinky-finger-metacarpal', 'pinky-finger-phalanx-proximal', 'pinky-finger-phalanx-intermediate', 'pinky-finger-phalanx-distal', 'pinky-finger-tip']
};

const FINGER_ROOT_OFFSETS = {
  thumb: { x: -0.034, y: 0.02, z: 0.02 },
  index: { x: -0.021, y: 0.085, z: 0.014 },
  middle: { x: -0.005, y: 0.084, z: 0.011 },
  ring: { x: 0.017, y: 0.086, z: 0.009 },
  pinky: { x: 0.033, y: 0.079, z: 0.006 }
};

const FINGER_SEGMENT_LENGTHS = {
  thumb: [0.03, 0.026, 0.022, 0.018],
  index: [0.03, 0.028, 0.024, 0.02],
  middle: [0.032, 0.03, 0.025, 0.02],
  ring: [0.029, 0.027, 0.023, 0.018],
  pinky: [0.024, 0.02, 0.016, 0.012]
};

const OPEN_HAND_CURL = {
  thumb: [0, 0, 0, 0],
  index: [0, 0, 0, 0],
  middle: [0, 0, 0, 0],
  ring: [0, 0, 0, 0],
  pinky: [0, 0, 0, 0]
};

const PINCH_CURL = {
  thumb: [0.75, 1.0, 0.9, 0.7],
  index: [1.1, 1.25, 1.1, 0.85],
  middle: [0, 0, 0, 0],
  ring: [0, 0, 0, 0],
  pinky: [0, 0, 0, 0]
};

const POINTING_CURL = {
  thumb: [0.2, 0.24, 0.2, 0.12],
  index: [0.04, 0.06, 0.05, 0.04],
  middle: [0.72, 0.9, 0.82, 0.66],
  ring: [0.78, 0.98, 0.88, 0.72],
  pinky: [0.84, 1.04, 0.92, 0.75]
};

const INDEX_DROPOUT_JOINTS = [
  'index-finger-phalanx-proximal',
  'index-finger-phalanx-intermediate',
  'index-finger-phalanx-distal',
  'index-finger-tip'
];

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function boneOf(snapshot) {
  return snapshot?.bonePosition ?? snapshot?.bone ?? null;
}

function sensorOf(snapshot) {
  return snapshot?.sensorPosition ?? snapshot?.sensor ?? null;
}

function trackedJointCountOf(snapshot) {
  return snapshot?.jointTrackedCount ?? 0;
}

function fingerQuatOf(snapshot, fingerName) {
  return snapshot?.fingerLocalQuaternions?.[fingerName] ?? null;
}

function tipOf(snapshot, fingerName) {
  return snapshot?.fingerTips?.[fingerName] ?? null;
}

function retargetQualityOf(snapshot) {
  return snapshot?.retargetDataQuality ?? null;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function distance(a, b) {
  if (!a || !b) return Number.NaN;
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

function quatFromAxisAngle(axis, radians) {
  const half = radians * 0.5;
  const sinHalf = Math.sin(half);
  return {
    x: axis.x * sinHalf,
    y: axis.y * sinHalf,
    z: axis.z * sinHalf,
    w: Math.cos(half)
  };
}

function quatMultiply(a, b) {
  return {
    x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z
  };
}

function normalizeQuat(q) {
  const length = Math.hypot(q.x, q.y, q.z, q.w);
  if (length < 1e-8) {
    return { x: 0, y: 0, z: 0, w: 1 };
  }
  return { x: q.x / length, y: q.y / length, z: q.z / length, w: q.w / length };
}

function quatAngleDelta(a, b) {
  if (!a || !b) return Number.NaN;
  const dot = Math.abs(clamp(a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w, -1, 1));
  return 2 * Math.acos(dot);
}

function mirroredX(side, value) {
  return side === 'left' ? value : -value;
}

function addVec(a, b) {
  return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z };
}

function scaleVec(a, scalar) {
  return { x: a.x * scalar, y: a.y * scalar, z: a.z * scalar };
}

function buildHandJoints(side, wristPosition, curlsByFinger) {
  const joints = {};
  const curlAxis = { x: 1, y: 0, z: 0 };
  const forward = { x: 0, y: 1, z: 0 };

  joints.wrist = {
    tracked: true,
    position: wristPosition,
    quaternion: { x: 0, y: 0, z: 0, w: 1 }
  };

  for (const fingerName of Object.keys(FINGER_CHAINS)) {
    const chain = FINGER_CHAINS[fingerName];
    const rootOffset = FINGER_ROOT_OFFSETS[fingerName];
    const lengths = FINGER_SEGMENT_LENGTHS[fingerName];
    const curls = curlsByFinger[fingerName] ?? [];

    let jointPosition = addVec(wristPosition, { x: mirroredX(side, rootOffset.x), y: rootOffset.y, z: rootOffset.z });
    let jointWorldQuat = { x: 0, y: 0, z: 0, w: 1 };

    for (let i = 0; i < chain.length; i += 1) {
      const jointName = chain[i];
      const localCurl = curls[i] ?? 0;
      if (i > 0 && localCurl !== 0) {
        const localQuat = quatFromAxisAngle(curlAxis, localCurl);
        jointWorldQuat = normalizeQuat(quatMultiply(jointWorldQuat, localQuat));
      }

      joints[jointName] = {
        tracked: true,
        position: jointPosition,
        quaternion: jointWorldQuat
      };

      const nextLength = lengths[i];
      if (nextLength) {
        jointPosition = addVec(jointPosition, scaleVec(forward, nextLength));
      }
    }
  }

  for (const jointName of TRACKED_HAND_JOINT_NAMES) {
    if (joints[jointName]) continue;
    joints[jointName] = {
      tracked: true,
      position: wristPosition,
      quaternion: { x: 0, y: 0, z: 0, w: 1 }
    };
  }

  return joints;
}

function buildMockPoseInput({ headQuaternion, leftHand, rightHand, leftCurls, rightCurls }) {
  return {
    enabled: true,
    head: {
      position: { x: 0, y: 0, z: 0 },
      quaternion: headQuaternion
    },
    hands: {
      left: {
        tracked: true,
        position: leftHand.position,
        quaternion: leftHand.quaternion,
        joints: buildHandJoints('left', leftHand.position, leftCurls)
      },
      right: {
        tracked: true,
        position: rightHand.position,
        quaternion: rightHand.quaternion,
        joints: buildHandJoints('right', rightHand.position, rightCurls)
      }
    }
  };
}

function clonePose(pose) {
  return JSON.parse(JSON.stringify(pose));
}

function withJointDropout(pose, side, jointNames) {
  const nextPose = clonePose(pose);
  const sideJoints = nextPose?.hands?.[side]?.joints;
  if (!sideJoints) return nextPose;
  for (const jointName of jointNames) {
    if (!sideJoints[jointName]) continue;
    sideJoints[jointName].tracked = false;
    delete sideJoints[jointName].position;
    delete sideJoints[jointName].quaternion;
  }
  return nextPose;
}

function sourcePinchDistanceOf(pose, side) {
  const joints = pose?.hands?.[side]?.joints;
  const thumbTip = joints?.['thumb-tip']?.position;
  const indexTip = joints?.['index-finger-tip']?.position;
  return distance(thumbTip, indexTip);
}

const baseUrl = process.env.BASE_URL ?? 'http://127.0.0.1:5174/';
const url = new URL(baseUrl);
url.searchParams.set('mockVr', '1');

const screenshotDir = process.env.XR_TEST_ARTIFACT_DIR ?? process.env.SCREENSHOT_DIR ?? 'output/ci-mock-vr';
await mkdir(screenshotDir, { recursive: true });

const browser = await chromium.launch({
  headless: true,
  args: ['--use-gl=angle', '--use-angle=swiftshader']
});
const page = await browser.newPage();
const consoleErrors = [];
page.on('pageerror', (err) => {
  consoleErrors.push(`pageerror: ${err.message}`);
});
page.on('console', (msg) => {
  if (msg.type() === 'error') {
    consoleErrors.push(`console.error: ${msg.text()}`);
  }
});

const relaxedPose = buildMockPoseInput({
  headQuaternion: { x: 0, y: 0, z: 0, w: 1 },
  leftHand: {
    position: { x: -0.26, y: -0.2, z: -0.42 },
    quaternion: { x: 0, y: 0, z: 0, w: 1 }
  },
  rightHand: {
    position: { x: 0.26, y: -0.2, z: -0.42 },
    quaternion: { x: 0, y: 0, z: 0, w: 1 }
  },
  leftCurls: OPEN_HAND_CURL,
  rightCurls: OPEN_HAND_CURL
});

const pinchPose = buildMockPoseInput({
  headQuaternion: { x: 0, y: 0.25, z: 0, w: 0.9682458365518543 },
  leftHand: {
    position: { x: -0.36, y: -0.1, z: -0.25 },
    quaternion: { x: 0, y: 0.3826834323650898, z: 0, w: 0.9238795325112867 }
  },
  rightHand: {
    position: { x: 0.34, y: 0.03, z: -0.2 },
    quaternion: { x: 0, y: -0.25881904510252074, z: 0, w: 0.9659258262890683 }
  },
  leftCurls: PINCH_CURL,
  rightCurls: PINCH_CURL
});

const pointingPose = buildMockPoseInput({
  headQuaternion: { x: 0, y: 0.25, z: 0, w: 0.9682458365518543 },
  leftHand: {
    position: { x: -0.34, y: -0.12, z: -0.24 },
    quaternion: { x: 0, y: 0.36, z: 0, w: 0.9329523032 }
  },
  rightHand: {
    position: { x: 0.33, y: 0.02, z: -0.18 },
    quaternion: { x: 0, y: -0.22, z: 0, w: 0.9754998711 }
  },
  leftCurls: POINTING_CURL,
  rightCurls: POINTING_CURL
});

const dropoutPose = withJointDropout(relaxedPose, 'right', INDEX_DROPOUT_JOINTS);

async function applyPoseAndSnapshot(pose, advanceMs) {
  return await page.evaluate(
    ({ nextPose, ms }) => {
      window.__setMockVrPose(nextPose);
      window.advanceTime(ms);
      return JSON.parse(window.render_game_to_text());
    },
    { nextPose: pose, ms: advanceMs }
  );
}

try {
  const mode = process.env.XR_TEST_MODE
    ?? (process.env.XR_SUPPORT_SHIM === '0' ? 'off' : 'polyfill');
  await attachXrEnvironment(page, { mode: resolveXrTestMode(mode) });

  await page.goto(url.href, { waitUntil: 'networkidle' });
  let hooksReady = false;
  for (let i = 0; i < 80; i += 1) {
    hooksReady = await page.evaluate(
      () =>
        typeof window.__setMockVrPose === 'function' &&
        typeof window.advanceTime === 'function' &&
        typeof window.render_game_to_text === 'function' &&
        typeof window.__captureHandCalibrationPose === 'function' &&
        typeof window.__resetHandCalibrationPose === 'function'
    );
    if (hooksReady) break;
    await page.waitForTimeout(250);
  }
  assert(hooksReady, `Mock VR hooks not ready. ${consoleErrors.join(' | ')}`);
  await page.waitForFunction(
    () => {
      const statusEl = document.getElementById('status');
      return Boolean(statusEl && statusEl.textContent && statusEl.textContent.toLowerCase().startsWith('loaded'));
    },
    null,
    { timeout: 20000 }
  );

  const relaxedPhase = await page.evaluate((pose) => {
    window.__resetHandCalibrationPose();
    window.__setMockVrPose(pose);
    window.advanceTime(350);
    const capture = window.__captureHandCalibrationPose();
    window.advanceTime(120);
    return { capture, snapshot: JSON.parse(window.render_game_to_text()) };
  }, relaxedPose);

  const pinchSnapshot = await applyPoseAndSnapshot(pinchPose, 450);
  const pointingSnapshot = await applyPoseAndSnapshot(pointingPose, 450);
  const dropoutHoldSnapshot = await applyPoseAndSnapshot(dropoutPose, 160);
  const dropoutRecoveredSnapshot = await applyPoseAndSnapshot(relaxedPose, 420);

  const relaxedSnapshot = relaxedPhase.snapshot;

  assert(relaxedSnapshot.mode === 'mock-vr', `Expected relaxed mock-vr mode, got ${relaxedSnapshot.mode}`);
  assert(pinchSnapshot.mode === 'mock-vr', `Expected pinch mock-vr mode, got ${pinchSnapshot.mode}`);
  assert(pointingSnapshot.mode === 'mock-vr', `Expected pointing mock-vr mode, got ${pointingSnapshot.mode}`);

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
  assert(Number.isFinite(relaxedAvatarPinchDistance), 'Missing relaxed avatar pinch distance metric.');
  assert(Number.isFinite(pinchAvatarDistance), 'Missing pinch avatar pinch distance metric.');

  const relaxedSourcePinchDistance = sourcePinchDistanceOf(relaxedPose, 'right');
  const pinchSourcePinchDistance = sourcePinchDistanceOf(pinchPose, 'right');

  assert(relaxedAvatarPinchDistance > pinchAvatarDistance + 0.004, `Avatar pinch did not close enough (relaxed=${relaxedAvatarPinchDistance.toFixed(4)} pinch=${pinchAvatarDistance.toFixed(4)}).`);
  assert(pinchAvatarDistance < 0.09, `Avatar pinch distance is too large (${pinchAvatarDistance.toFixed(4)}).`);

  const sourcePinchDelta = relaxedSourcePinchDistance - pinchSourcePinchDistance;
  const avatarPinchDelta = relaxedAvatarPinchDistance - pinchAvatarDistance;
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
  assert(pointingMiddleDelta > pointingIndexDelta * 1.15, `Pointing control fingers did not curl more than index (middle=${pointingMiddleDelta.toFixed(3)} index=${pointingIndexDelta.toFixed(3)}).`);

  const preDropoutRightIndexQuat = fingerQuatOf(pointingSnapshot.tracking.right, 'index');
  const dropoutRightIndexQuat = fingerQuatOf(dropoutHoldSnapshot.tracking.right, 'index');
  const recoveredRightIndexQuat = fingerQuatOf(dropoutRecoveredSnapshot.tracking.right, 'index');

  const holdDrift = quatAngleDelta(preDropoutRightIndexQuat, dropoutRightIndexQuat);
  const recoveryDelta = quatAngleDelta(dropoutRightIndexQuat, recoveredRightIndexQuat);
  assert(Number.isFinite(holdDrift), 'Dropout hold quaternion debug output missing.');
  assert(Number.isFinite(recoveryDelta), 'Dropout recovery quaternion debug output missing.');
  assert(holdDrift < 0.15, `Dropout hold drifted too much (${holdDrift.toFixed(3)} rad).`);
  assert(recoveryDelta > 0.04, `Dropout recovery did not converge (${recoveryDelta.toFixed(3)} rad).`);

  const dropoutQuality = retargetQualityOf(dropoutHoldSnapshot.tracking.right);
  assert(dropoutQuality, 'Dropout retarget quality metrics missing.');
  assert(dropoutQuality.heldSegments > 0, `Expected held segments during dropout (got ${JSON.stringify(dropoutQuality)}).`);

  assert(consoleErrors.length === 0, `Console errors found: ${consoleErrors.join(' | ')}`);

  await page.screenshot({ path: path.join(screenshotDir, 'mock-vr-final.png') });
  console.log('Mock VR CI check passed.');
} finally {
  await browser.close();
}
