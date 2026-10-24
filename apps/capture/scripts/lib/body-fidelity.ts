// Full-body fidelity metrics for room-scale VR, from per-frame samples taken
// during a recorded-input replay (window.__sampleBody()) and the recording's
// own head poses.
//
// Every oracle is independent of the body solver: the tracked head comes from
// the recording at the player's time, mapped to world by the camera rig (as
// the renderer does); the avatar is measured from its bones; feet contact and
// steps come from sole heights over raycast ground. Avatar proportions only
// enter as bind-pose measurements (leg length, ankle height) used to
// normalize.

export const THRESHOLDS = Object.freeze({
  minActiveShare: 0.95,
  // Share of foot-frames with raycast ground under heel and ball.
  minGroundCoverage: 0.98,
  // The app's head pose must be the recorded pose (frame order, spaces).
  maxHeadInputErrorM: 0.002,
  // World lock: the rig moves only for terrain height (no input movement in
  // these replays).
  maxRigDriftM: 0.01,
  maxRigTurnDeg: 0.1,
  maxRigHeightVsGroundM: 0.03,
  // Avatar eye midpoint on the tracked eyes. While walking, the pelvis dips
  // so planted feet stay reachable at double support; the tracked head's
  // bob is not in phase with the avatar's steps, so the eyes may sit a few
  // centimetres low then.
  maxEyeErrorStillP95M: 0.02,
  maxEyeErrorWalkingP95M: 0.045,
  maxEyeErrorM: 0.06,
  maxEyeLagFrames: 0,
  // Head orientation from eye and head-top bones (pitch offset calibrated on
  // the first standing frames; yaw is not calibrated).
  maxHeadYawErrorP95Deg: 8,
  maxHeadPitchErrorP95Deg: 8,
  // Pelvis and root follow the head.
  maxPelvisLagFrames: 2,
  maxOvershootM: 0.03,
  // Body yaw.
  maxNeckTwistDeg: 75,
  maxTurnSettleSec: 1.0,
  turnSettleDeg: 15,
  minTurnLagSec: 0.05,
  maxTurnLagSec: 0.6,
  maxWalkYawErrorP95Deg: 20,
  // Feet.
  maxFootDriftM: 0.02,
  maxSkatingShare: 0.02,
  minSoleHeightM: -0.015,
  maxPlantedSoleHeightM: 0.02,
  minFootSeparationM: 0.08,
  maxPlantedJitterM: 0.002,
  // Stepping.
  minCadenceHz: 1.2,
  maxCadenceHz: 2.6,
  minStepLengthLeg: 0.4,
  maxStepLengthLeg: 1.1,
  maxStepsWhileStill: 1,
  maxStepsInPlace: 1,
  // Crouch and lean.
  minCrouchRatio: 0.6,
  maxCrouchRatio: 1.2,
  minLeanCorrelation: 0.9,
  // Smoothness.
  maxPelvisJerkRatio: 2,
  // Pops: a joint's move in one 30 Hz frame against its neighbours' (a
  // swing is fast but continuous), and an absolute cap — swinging feet reach
  // 5–6 m/s in a 1.2 m/s stride, so 8 m/s, and 3 m/s for pelvis and head.
  maxJointPopRatio: 3,
  minPopStepM: 0.04,
  maxJointStepM: { hips: 0.1, head: 0.1, leftKnee: 0.27, rightKnee: 0.27, leftAnkle: 0.27, rightAnkle: 0.27, leftToe: 0.27, rightToe: 0.27 },
  maxPelvisYawStepDeg: 15,
  // Hands still land on the tracked hands while the body moves.
  maxWristErrorP95M: 0.02
});

const ON_GROUND_M = 0.01;
const CONTACT_M = 0.015;
const LIFT_M = 0.025;
const SKATE_SPEED = 0.25;

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const length = (a) => Math.hypot(a[0], a[1], a[2]);
const flatDistance = (a, b) => Math.hypot(a[0] - b[0], a[2] - b[2]);
const mid = (a, b) => scale(add(a, b), 0.5);
const DEG = 180 / Math.PI;
const wrap = (angle) => Math.atan2(Math.sin(angle), Math.cos(angle));

function rotate(q, v) {
  const [x, y, z, w] = q;
  const uv = cross([x, y, z], v);
  const uuv = cross([x, y, z], uv);
  return add(v, add(scale(uv, 2 * w), scale(uuv, 2)));
}
const qmul = ([ax, ay, az, aw], [bx, by, bz, bw]) => [
  aw * bx + ax * bw + ay * bz - az * by,
  aw * by - ax * bz + ay * bw + az * bx,
  aw * bz + ax * by - ay * bx + az * bw,
  aw * bw - ax * bx - ay * by - az * bz
];
function slerp(a, b, t) {
  let cos = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
  const sign = cos < 0 ? -1 : 1;
  cos *= sign;
  if (cos > 0.9995) {
    const out = a.map((value, i) => value + (sign * b[i] - value) * t);
    const n = Math.hypot(...out);
    return out.map((value) => value / n);
  }
  const theta = Math.acos(cos);
  const wa = Math.sin((1 - t) * theta) / Math.sin(theta);
  const wb = (sign * Math.sin(t * theta)) / Math.sin(theta);
  return a.map((value, i) => wa * value + wb * b[i]);
}

function percentile(values, p) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(p * (sorted.length - 1)))];
}
const mean = (values) => (values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null);
const median = (values) => percentile(values, 0.5);
const max = (values) => (values.length ? Math.max(...values) : null);
const min = (values) => (values.length ? Math.min(...values) : null);

function correlation(a, b) {
  const ma = mean(a);
  const mb = mean(b);
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < a.length; i += 1) {
    num += (a[i] - ma) * (b[i] - mb);
    da += (a[i] - ma) ** 2;
    db += (b[i] - mb) ** 2;
  }
  return da > 0 && db > 0 ? num / Math.sqrt(da * db) : null;
}

// Lag (frames) maximizing correlation of two multi-channel series; positive
// means `follower` trails `leader`.
function bestLag(leader, follower, maxLag) {
  let best = { lag: 0, r: -Infinity };
  for (let lag = -maxLag; lag <= maxLag; lag += 1) {
    const a = [];
    const b = [];
    for (let i = 0; i < leader.length; i += 1) {
      const j = i + lag;
      if (j < 0 || j >= follower.length) continue;
      for (let k = 0; k < leader[i].length; k += 1) {
        a.push(leader[i][k]);
        b.push(follower[j][k]);
      }
    }
    const r = a.length > 20 ? correlation(a, b) : null;
    if (r !== null && r > best.r) best = { lag, r };
  }
  return best;
}

function unwrapSeries(angles) {
  const out = [];
  let offset = 0;
  for (let i = 0; i < angles.length; i += 1) {
    if (i > 0) {
      const delta = angles[i] - angles[i - 1];
      if (delta > Math.PI) offset -= 2 * Math.PI;
      else if (delta < -Math.PI) offset += 2 * Math.PI;
    }
    out.push(angles[i] + offset);
  }
  return out;
}

// Centered moving average over `radius` frames on each side.
function smooth(values, radius) {
  return values.map((_, i) => {
    let total = 0;
    let count = 0;
    for (let j = Math.max(0, i - radius); j <= Math.min(values.length - 1, i + radius); j += 1) {
      total += values[j];
      count += 1;
    }
    return total / count;
  });
}

// Runs of consecutive indices where predicate holds.
function runs(count, predicate) {
  const out = [];
  let start = -1;
  for (let i = 0; i <= count; i += 1) {
    const on = i < count && predicate(i);
    if (on && start < 0) start = i;
    if (!on && start >= 0) {
      out.push([start, i - 1]);
      start = -1;
    }
  }
  return out;
}

// Heading on the floor of a frame given its right axis (forward = up × right).
const yawFromRight = (right) => Math.atan2(-right[2], right[0]);

// Interpolated viewer pose of an ActionRecorder recording at playback time
// `timeMs` (relative to its first frame), as the ActionPlayer replays it.
export function recordedHeadAt(recording, timeMs) {
  const frames = recording.frames;
  const t = frames[0][0] + timeMs;
  let i = 0;
  while (i < frames.length - 2 && frames[i + 1][0] < t) i += 1;
  const a = frames[i];
  const b = frames[Math.min(i + 1, frames.length - 1)];
  const span = b[0] - a[0];
  const alpha = span > 0 ? Math.min(1, Math.max(0, (t - a[0]) / span)) : 0;
  const position = [0, 1, 2].map((k) => a[1 + k] + (b[1 + k] - a[1 + k]) * alpha);
  const quaternion = slerp(a.slice(4, 8), b.slice(4, 8), alpha);
  return { position, quaternion };
}

// Samples arrive on XR frames (a 16 ms grid), so their spacing alternates
// (32 and 48 ms); interpolate every numeric field onto a uniform grid of
// `stepMs` by playback time so velocities, jerk, and lags are not distorted.
function resampleUniform(frames, stepMs) {
  if (frames.length < 2) return frames;
  const lerp = (a, b, t) => {
    if (typeof a === 'number' && typeof b === 'number') return a + (b - a) * t;
    if (Array.isArray(a) && Array.isArray(b) && a.length === b.length) return a.map((v, i) => lerp(v, b[i], t));
    if (a && b && typeof a === 'object' && typeof b === 'object') {
      const out = {};
      for (const key of Object.keys(a)) out[key] = key in b ? lerp(a[key], b[key], t) : a[key];
      return out;
    }
    return t < 0.5 ? a : b;
  };
  const out = [];
  let j = 0;
  for (let time = frames[0].timeMs; time <= frames.at(-1).timeMs + 1e-6; time += stepMs) {
    while (j < frames.length - 2 && frames[j + 1].timeMs < time) j += 1;
    const a = frames[j];
    const b = frames[j + 1];
    const span = b.timeMs - a.timeMs;
    const t = span > 0 ? Math.min(1, Math.max(0, (time - a.timeMs) / span)) : 0;
    const frame = lerp(a, b, t);
    frame.timeMs = time;
    out.push(frame);
  }
  return out;
}

export function analyzeBodyReplay(rawFrames, { stepMs, recording }) {
  const frames = resampleUniform(rawFrames, stepMs);
  const failures = [];
  const metrics = {};
  const fail = (id, message) => failures.push(`${id}: ${message}`);
  const check = (id, value, ok, describe) => {
    metrics[id] = value;
    if (value === null || value === undefined) return;
    if (!ok(value)) fail(id, describe(value));
  };
  const dt = stepMs / 1000;
  const samples = frames.filter((frame) => frame.body.active && frame.body.solver.aligned);
  metrics.activeShare = samples.length / Math.max(1, frames.length);
  if (metrics.activeShare < THRESHOLDS.minActiveShare) fail('activeShare', `${(metrics.activeShare * 100).toFixed(0)}% of frames ran the body solver`);
  if (samples.length < 30) return { failures, metrics };
  const dims = samples[0].body.dims;
  const leg = dims.legLength;
  const n = samples.length;

  // Ground truth: the recording's head in tracking space, and in world space
  // through the rig the renderer uses.
  const truthLocal = samples.map((frame) => recordedHeadAt(recording, frame.timeMs));
  const truth = samples.map((frame, i) => {
    const rig = frame.body.rig;
    return {
      position: add(rig.position, rotate(rig.quaternion, truthLocal[i].position)),
      quaternion: qmul(rig.quaternion, truthLocal[i].quaternion)
    };
  });
  const bones = samples.map((frame) => frame.body.bones);
  const eyes = samples.map((frame) => mid(frame.body.eyes.left, frame.body.eyes.right));

  // Input path.
  // On the raw samples: exact playback times, no interpolation between them.
  const inputErrors = rawFrames
    .filter((frame) => frame.body.active && frame.body.solver.aligned)
    .map((frame) => (frame.body.trackedHead ? length(sub(frame.body.trackedHead.local, recordedHeadAt(recording, frame.timeMs).position)) : Infinity));
  check('headInputErrorM', max(inputErrors), (v) => v <= THRESHOLDS.maxHeadInputErrorM, (v) => `app head pose is ${(v * 1000).toFixed(1)} mm from the recorded pose`);

  // World lock.
  const rig0 = samples[0].body.rig.position;
  const ground0 = samples[0].body.ground.root?.y ?? 0;
  check('rigDriftM', max(samples.map((frame) => flatDistance(frame.body.rig.position, rig0))), (v) => v <= THRESHOLDS.maxRigDriftM, (v) => `rig moved ${(v * 100).toFixed(1)} cm horizontally (world swims)`);
  check('rigTurnDeg', max(samples.map((frame) => 2 * Math.acos(Math.min(1, Math.abs(frame.body.rig.quaternion[3]))) * DEG)), (v) => v <= THRESHOLDS.maxRigTurnDeg, (v) => `rig turned ${v.toFixed(2)}°`);
  check('rigHeightVsGroundP95M', percentile(samples.map((frame) => Math.abs(frame.body.rig.position[1] - rig0[1] - ((frame.body.ground.root?.y ?? ground0) - ground0))), 0.95), (v) => v <= THRESHOLDS.maxRigHeightVsGroundM, (v) => `rig height strays ${(v * 100).toFixed(1)} cm from the ground under the body`);

  // Eyes on eyes.
  const eyeErrors = eyes.map((eye, i) => length(sub(eye, truth[i].position)));
  check('eyeErrorMaxM', max(eyeErrors), (v) => v <= THRESHOLDS.maxEyeErrorM, (v) => `avatar eyes up to ${(v * 100).toFixed(1)} cm from the tracked eyes`);
  const velocity = (series) => series.slice(1).map((p, i) => [(p[0] - series[i][0]) / dt, (p[2] - series[i][2]) / dt]);
  const truthVelocity = velocity(truth.map((t) => t.position));
  const moving = truthVelocity.some(([x, z]) => Math.hypot(x, z) > 0.3);
  if (moving) {
    const eyeLag = bestLag(truthVelocity, velocity(eyes), 6);
    check('eyeLagFrames', Math.abs(eyeLag.lag), (v) => v <= THRESHOLDS.maxEyeLagFrames, (v) => `avatar eyes trail the head by ${v} frames`);
  }

  // Head orientation from bones.
  const trackedRight = truth.map((t) => rotate(t.quaternion, [1, 0, 0]));
  const trackedUp = truth.map((t) => rotate(t.quaternion, [0, 1, 0]));
  const avatarRight = samples.map((frame) => sub(frame.body.eyes.right, frame.body.eyes.left));
  const avatarUp = bones.map((b) => sub(b.headTop, b.head));
  const pitchOf = (up, right) => {
    const forward = cross(up, right);
    return Math.asin(Math.max(-1, Math.min(1, forward[1] / (length(forward) || 1))));
  };
  const headYaw = trackedRight.map(yawFromRight);
  const avatarHeadYaw = avatarRight.map(yawFromRight);
  const trackedPitch = trackedUp.map((up, i) => pitchOf(up, trackedRight[i]));
  const avatarPitch = avatarUp.map((up, i) => pitchOf(up, avatarRight[i]));
  const calibrationFrames = Math.min(n, Math.round(0.5 / dt));
  const pitchOffset = median(avatarPitch.slice(0, calibrationFrames).map((p, i) => p - trackedPitch[i]));
  check('headYawErrorP95Deg', percentile(headYaw.map((yaw, i) => Math.abs(wrap(avatarHeadYaw[i] - yaw)) * DEG), 0.95), (v) => v <= THRESHOLDS.maxHeadYawErrorP95Deg, (v) => `avatar head yaw p95 ${v.toFixed(1)}° off the tracked head`);
  check('headPitchErrorP95Deg', percentile(trackedPitch.map((pitch, i) => Math.abs(avatarPitch[i] - pitchOffset - pitch) * DEG), 0.95), (v) => v <= THRESHOLDS.maxHeadPitchErrorP95Deg, (v) => `avatar head pitch p95 ${v.toFixed(1)}° off the tracked head`);

  // Room-scale motion of the user, for phase detection.
  const headLocal = truthLocal.map((t) => t.position);
  const rawSpeed = headLocal.map((p, i) => (i === 0 ? 0 : flatDistance(p, headLocal[i - 1]) / dt));
  const speed = smooth(rawSpeed, Math.round(0.15 / dt));
  const yawSeries = unwrapSeries(headYaw);
  const yawRate = smooth(yawSeries.map((y, i) => (i === 0 ? 0 : (y - yawSeries[i - 1]) / dt)), Math.round(0.1 / dt));
  // Pelvis lag while walking (in a lean the pelvis rightly moves against
  // the head).
  const walkingIndices = speed.map((v, i) => i).filter((i) => i > 0 && speed[i] > 0.4);
  if (walkingIndices.length > 20) {
    const pick = (series) => walkingIndices.map((i) => [(series[i][0] - series[i - 1][0]) / dt, (series[i][2] - series[i - 1][2]) / dt]);
    const hipsLag = bestLag(pick(truth.map((t) => t.position)), pick(bones.map((b) => b.hips)), 10);
    check('pelvisLagFrames', Math.abs(hipsLag.lag), (v) => v <= THRESHOLDS.maxPelvisLagFrames, (v) => `pelvis trails the head by ${v} frames`);
  }
  const standingY = median(headLocal.slice(0, calibrationFrames).map((p) => p[1]));
  const headDrop = headLocal.map((p) => standingY - p[1]);

  // Body yaw from the hip joints.
  const pelvisYaw = bones.map((b) => yawFromRight(sub(b.rightHip, b.leftHip)));
  const twist = pelvisYaw.map((yaw, i) => Math.abs(wrap(headYaw[i] - yaw)) * DEG);
  check('neckTwistMaxDeg', max(twist), (v) => v <= THRESHOLDS.maxNeckTwistDeg, (v) => `head turned ${v.toFixed(0)}° from the pelvis`);
  const turns = runs(n, (i) => Math.abs(yawRate[i]) > 30 / DEG)
    .filter(([a, b]) => Math.abs(yawSeries[b] - yawSeries[a]) > 45 / DEG);
  const settleTimes = [];
  const turnLags = [];
  for (const [start, end] of turns) {
    let stop = end;
    while (stop < n - 1 && Math.abs(yawRate[stop]) > 5 / DEG) stop += 1;
    // A turn holds its new heading for 0.5 s; a glance there and back does not.
    const hold = Math.round(0.5 / dt);
    if (stop + hold >= n || yawSeries.slice(stop, stop + hold).some((y) => Math.abs(y - yawSeries[stop]) > 10 / DEG)) continue;
    let settled = stop;
    while (settled < n - 1 && Math.abs(wrap(headYaw[settled] - pelvisYaw[settled])) * DEG > THRESHOLDS.turnSettleDeg) settled += 1;
    settleTimes.push((settled - stop) * dt);
    const inPlace = speed.slice(start, stop + 1).every((s) => s < 0.2);
    if (inPlace) {
      // Lag between the head and the pelvis each covering half of the turn.
      const from = Math.max(0, start - Math.round(0.3 / dt));
      const to = Math.min(n - 1, stop + Math.round(1.2 / dt));
      const headTurn = yawSeries.slice(from, to + 1);
      const pelvisTurn = unwrapSeries(pelvisYaw.slice(from, to + 1));
      const offset = Math.round((pelvisTurn[0] - headTurn[0]) / (2 * Math.PI)) * 2 * Math.PI;
      const half = (headTurn[0] + headTurn.at(-1)) / 2;
      const sign = Math.sign(headTurn.at(-1) - headTurn[0]);
      const crossing = (series, shift) => series.findIndex((y) => sign * (y - shift - half) >= 0);
      const headHalf = crossing(headTurn, 0);
      const pelvisHalf = crossing(pelvisTurn, offset);
      // Only turns the pelvis makes too: one already past halfway (a glance
      // inside the neck's range) has no lag to measure.
      const pelvisTravel = Math.abs(pelvisTurn.at(-1) - pelvisTurn[0]);
      if (headHalf >= 0 && pelvisHalf > 0 && pelvisTravel > Math.abs(headTurn.at(-1) - headTurn[0]) / 2) turnLags.push((pelvisHalf - headHalf) * dt);
    }
  }
  metrics.turnLags = turnLags;
  metrics.turnSettleTimes = settleTimes;
  check('turnSettleMaxSec', max(settleTimes), (v) => v <= THRESHOLDS.maxTurnSettleSec, (v) => `pelvis took ${v.toFixed(2)} s to follow the head after a turn`);
  check('turnLagMinSec', min(turnLags), (v) => v >= THRESHOLDS.minTurnLagSec, (v) => `pelvis turns with the head (${v.toFixed(2)} s lag): no neck`);
  check('turnLagMaxSec', max(turnLags), (v) => v <= THRESHOLDS.maxTurnLagSec, (v) => `pelvis lags head turns by ${v.toFixed(2)} s`);
  const walkingStraight = samples.map((_, i) => i).filter((i) => speed[i] > 0.6 && Math.abs(yawRate[i]) < 10 / DEG);
  check('walkYawErrorP95Deg', walkingStraight.length > 10 ? percentile(walkingStraight.map((i) => twist[i]), 0.95) : null, (v) => v <= THRESHOLDS.maxWalkYawErrorP95Deg, (v) => `pelvis faces ${v.toFixed(0)}° off the head while walking`);

  // Overshoot after stops: how far root and pelvis run ahead of where they
  // rest relative to the head, along the walk direction.
  const stops = [];
  for (let i = 1; i < n; i += 1) {
    if (speed[i - 1] >= 0.05 || speed[i] >= 0.05) continue;
    let peak = i - 1;
    while (peak > 0 && speed[peak] < 0.5) peak -= 1;
    if (speed[peak] < 0.5 || stops.some((s) => s.peak === peak)) continue;
    const hold = Math.round(0.8 / dt);
    if (i + hold >= n || speed.slice(i, i + hold).some((s) => s >= 0.05)) continue;
    const back = Math.max(0, i - Math.round(1.0 / dt));
    const travel = sub(headLocal[i], headLocal[back]);
    const travelLength = Math.hypot(travel[0], travel[2]);
    if (travelLength < 0.2) continue;
    stops.push({ peak, at: i, hold, direction: [travel[0] / travelLength, 0, travel[2] / travelLength] });
  }
  const overshoot = (series) => max(stops.map(({ at, hold, direction }) => {
    const ahead = [];
    for (let i = at - Math.round(0.3 / dt); i < at + hold; i += 1) ahead.push(dot(sub(series[i], truth[i].position), direction));
    const rest = mean(ahead.slice(-Math.round(0.2 / dt)));
    return Math.max(0, max(ahead) - rest);
  }));
  check('rootOvershootM', stops.length ? overshoot(samples.map((frame) => frame.body.root)) : null, (v) => v <= THRESHOLDS.maxOvershootM, (v) => `root overshoots by ${(v * 100).toFixed(1)} cm after stopping`);
  check('pelvisOvershootM', stops.length ? overshoot(bones.map((b) => b.hips)) : null, (v) => v <= THRESHOLDS.maxOvershootM, (v) => `pelvis overshoots by ${(v * 100).toFixed(1)} cm after stopping`);

  // Feet: heel (sole under the ankle, rolled with the foot) and ball of the
  // foot, against the ground raycast under each.
  const footPoints = { left: [], right: [] };
  let missingGround = 0;
  for (const frame of samples) {
    for (const side of ['left', 'right']) {
      const ankle = frame.body.bones[`${side}Ankle`];
      const toe = frame.body.bones[`${side}Toe`];
      const d = sub(toe, ankle);
      const horizontal = Math.hypot(d[0], d[2]) || 1e-6;
      const u = [d[0] / horizontal, 0, d[2] / horizontal];
      const roll = Math.atan2(d[1], horizontal) - Math.atan2(dims.toeHeight - dims.ankleHeight, dims.toeForward);
      const heel = add(add(ankle, scale(u, dims.ankleHeight * Math.sin(roll))), [0, -dims.ankleHeight * Math.cos(roll), 0]);
      const ball = add(add(toe, scale(u, dims.toeHeight * Math.sin(roll))), [0, -dims.toeHeight * Math.cos(roll), 0]);
      // A missing ground sample is not contact: it counts against coverage
      // and leaves the point out of every contact measure.
      const groundHeel = frame.body.ground[`${side}Ankle`]?.y;
      const groundBall = frame.body.ground[`${side}Toe`]?.y;
      if (groundHeel === undefined || groundBall === undefined) missingGround += 1;
      footPoints[side].push({ heel, ball, heelHeight: groundHeel === undefined ? Infinity : heel[1] - groundHeel, ballHeight: groundBall === undefined ? Infinity : ball[1] - groundBall, ankle });
    }
  }
  check('groundCoverage', 1 - missingGround / Math.max(1, 2 * n), (v) => v >= THRESHOLDS.minGroundCoverage, (v) => `ground under the feet sampled on only ${(v * 100).toFixed(0)}% of foot-frames`);
  const drifts = [];
  const jitters = [];
  let skating = 0;
  let pointFrames = 0;
  const liftoffs = { left: [], right: [] };
  for (const side of ['left', 'right']) {
    const points = footPoints[side];
    for (const key of ['heel', 'ball']) {
      const heightKey = `${key}Height`;
      for (const [a, b] of runs(n, (i) => points[i][heightKey] < ON_GROUND_M)) {
        let drift = 0;
        for (let i = a; i <= b; i += 1) {
          drift = Math.max(drift, flatDistance(points[i][key], points[a][key]));
          if (i > a) jitters.push(flatDistance(points[i][key], points[i - 1][key]));
        }
        drifts.push(drift);
      }
      for (let i = 1; i < n; i += 1) {
        pointFrames += 1;
        if (points[i][heightKey] < CONTACT_M && flatDistance(points[i][key], points[i - 1][key]) / dt > SKATE_SPEED) skating += 1;
      }
    }
    let grounded = true;
    for (let i = 0; i < n; i += 1) {
      const low = Math.min(points[i].heelHeight, points[i].ballHeight);
      if (grounded && low > LIFT_M) {
        grounded = false;
        liftoffs[side].push(i);
      } else if (!grounded && low < CONTACT_M) {
        grounded = true;
      }
    }
  }
  check('footDriftMaxM', max(drifts), (v) => v <= THRESHOLDS.maxFootDriftM, (v) => `a planted foot slid ${(v * 100).toFixed(1)} cm`);
  check('skatingShare', skating / Math.max(1, pointFrames), (v) => v <= THRESHOLDS.maxSkatingShare, (v) => `${(v * 100).toFixed(1)}% of foot-frames skate on the ground`);
  const lowest = ['left', 'right'].flatMap((side) => footPoints[side].map((p) => Math.min(p.heelHeight, p.ballHeight)));
  check('soleHeightMinM', min(lowest), (v) => v >= THRESHOLDS.minSoleHeightM, (v) => `a foot sinks ${(-v * 100).toFixed(1)} cm into the ground`);
  const plantedLow = [];
  for (const side of ['left', 'right']) {
    const points = footPoints[side];
    const still = (i) => i > 0 && flatDistance(points[i].heel, points[i - 1].heel) / dt < 0.05 && flatDistance(points[i].ball, points[i - 1].ball) / dt < 0.05
      && Math.abs(points[i].ankle[1] - points[i - 1].ankle[1]) / dt < 0.05;
    for (const [a, b] of runs(n, still)) {
      if (b - a < 3) continue;
      for (let i = a; i <= b; i += 1) plantedLow.push(Math.min(points[i].heelHeight, points[i].ballHeight));
    }
  }
  check('plantedSoleHeightMaxM', max(plantedLow), (v) => v <= THRESHOLDS.maxPlantedSoleHeightM, (v) => `a planted foot floats ${(v * 100).toFixed(1)} cm above the ground`);
  check('footSeparationMinM', min(samples.map((_, i) => flatDistance(footPoints.left[i].ankle, footPoints.right[i].ankle))), (v) => v >= THRESHOLDS.minFootSeparationM, (v) => `feet come within ${(v * 100).toFixed(1)} cm of each other`);
  check('plantedJitterRmsM', jitters.length ? Math.sqrt(mean(jitters.map((j) => j * j))) : null, (v) => v <= THRESHOLDS.maxPlantedJitterM, (v) => `planted feet jitter ${(v * 1000).toFixed(1)} mm per frame`);

  // Stepping.
  const steps = [...liftoffs.left, ...liftoffs.right].sort((a, b) => a - b);
  metrics.steps = steps.length;
  // Relocations: a foot ending more than 3 cm from where it last stood still,
  // however low it lifted (shuffles hide below lift-off heights).
  const relocations = [];
  for (const side of ['left', 'right']) {
    const points = footPoints[side];
    const still = (i) => i > 0 && flatDistance(points[i].ankle, points[i - 1].ankle) / dt < 0.05;
    const rests = runs(n, still).filter(([a, b]) => b - a >= 2);
    for (let r = 1; r < rests.length; r += 1) {
      if (flatDistance(points[rests[r][0]].ankle, points[rests[r - 1][1]].ankle) > 0.03) relocations.push(rests[r - 1][1] + 1);
    }
  }
  relocations.sort((a, b) => a - b);
  metrics.relocations = relocations.length;
  const relocationsIn = (a, b) => relocations.filter((i) => i >= a && i <= b).length;
  // Eyes while standing (slow, no foot lifting within 0.5 s) and otherwise.
  const settleFrames = Math.round(0.5 / dt);
  const standingNow = samples.map((_, i) => speed[i] < 0.15 && !steps.some((step) => Math.abs(step - i) <= settleFrames));
  check('eyeErrorStillP95M', percentile(eyeErrors.filter((_, i) => standingNow[i]), 0.95), (v) => v <= THRESHOLDS.maxEyeErrorStillP95M, (v) => `avatar eyes p95 ${(v * 100).toFixed(1)} cm from the tracked eyes while standing`);
  check('eyeErrorWalkingP95M', standingNow.filter((v) => !v).length > 10 ? percentile(eyeErrors.filter((_, i) => !standingNow[i]), 0.95) : null, (v) => v <= THRESHOLDS.maxEyeErrorWalkingP95M, (v) => `avatar eyes p95 ${(v * 100).toFixed(1)} cm from the tracked eyes while moving`);
  const walkWindows = runs(n, (i) => speed[i] >= 0.8 && speed[i] <= 1.6).filter(([a, b]) => (b - a) * dt >= 1.2);
  const cadences = [];
  const stepLengths = [];
  for (const [a, b] of walkWindows) {
    // Between the window's first and last lift-off, so the window's edges do
    // not quantize the rate.
    const inside = steps.filter((i) => i >= a && i <= b);
    if (inside.length < 2) {
      cadences.push(0);
      stepLengths.push(Infinity);
      continue;
    }
    const first = inside[0];
    const last = inside.at(-1);
    cadences.push((inside.length - 1) / ((last - first) * dt));
    let distance = 0;
    for (let i = first + 1; i <= last; i += 1) distance += flatDistance(headLocal[i], headLocal[i - 1]);
    stepLengths.push(distance / (inside.length - 1) / leg);
  }
  check('cadenceMinHz', min(cadences), (v) => v >= THRESHOLDS.minCadenceHz, (v) => `walking at ${v.toFixed(2)} steps/s`);
  check('cadenceMaxHz', max(cadences), (v) => v <= THRESHOLDS.maxCadenceHz, (v) => `walking at ${v.toFixed(2)} steps/s`);
  check('stepLengthMinLeg', min(stepLengths), (v) => v >= THRESHOLDS.minStepLengthLeg, (v) => `steps of ${v.toFixed(2)} leg lengths`);
  check('stepLengthMaxLeg', max(stepLengths), (v) => v <= THRESHOLDS.maxStepLengthLeg, (v) => (Number.isFinite(v) ? `steps of ${v.toFixed(2)} leg lengths` : 'walking without stepping'));
  const stillWindows = runs(n, (i) => speed[i] < 0.15 && Math.abs(yawRate[i]) < 20 / DEG && headDrop[i] < 0.05).filter(([a, b]) => (b - a) * dt >= 2);
  check('stepsWhileStillMax', stillWindows.length ? max(stillWindows.map(([a, b]) => relocationsIn(a + Math.round(0.6 / dt), b))) : null, (v) => v <= THRESHOLDS.maxStepsWhileStill, (v) => `${v} steps while standing still`);

  // Crouch and lean in place.
  const feetMid = samples.map((_, i) => mid(footPoints.left[i].ankle, footPoints.right[i].ankle));
  const pelvisForward = pelvisYaw.map((yaw) => [-Math.sin(yaw), 0, -Math.cos(yaw)]);
  const leanOffset = truth.map((t, i) => dot(sub(t.position, feetMid[i]), pelvisForward[i]));
  const standingLean = median(leanOffset.slice(0, calibrationFrames));
  // A lean lowers the head as the torso pivots; a slow small step does not.
  const leaning = (i) => leanOffset[i] - standingLean > 0.12 && headDrop[i] > 0.02;
  const inPlace = runs(n, (i) => speed[i] < 0.35 && (headDrop[i] > 0.15 || leaning(i))).filter(([a, b]) => b - a > 10);
  check('stepsInPlaceMax', inPlace.length ? max(inPlace.map(([a, b]) => relocationsIn(a, b))) : null, (v) => v <= THRESHOLDS.maxStepsInPlace, (v) => `${v} steps while crouching or leaning in place`);
  const hips0 = median(bones.slice(0, calibrationFrames).map((b) => b.hips[1]));
  const crouchFrames = samples.map((_, i) => i).filter((i) => headDrop[i] > 0.2);
  check('crouchRatio', crouchFrames.length > 10 ? median(crouchFrames.map((i) => (hips0 - bones[i].hips[1]) / headDrop[i])) : null, (v) => v >= THRESHOLDS.minCrouchRatio && v <= THRESHOLDS.maxCrouchRatio, (v) => `pelvis drops ${v.toFixed(2)}× the head drop`);
  // Signed forward pitch of the pelvis→neck line, about the pelvis' axis.
  const spinePitch = bones.map((b, i) => {
    const spine = sub(b.neck, b.hips);
    return Math.atan2(dot(spine, pelvisForward[i]), spine[1]) * DEG;
  });
  // Leaning in place: upright enough not to be a crouch, slow, and no foot
  // lifting within 0.3 s.
  // Correlated over each forward lean in place, from 1 s before to 1 s after.
  const quiet = Math.round(0.3 / dt);
  const leanWindows = runs(n, leaning).filter(([a, b]) => b - a > 10);
  const leanFrames = samples.map((_, i) => i).filter((i) => leanWindows.some(([a, b]) => i >= a - 1 / dt && i <= b + 1 / dt)
    && headDrop[i] < 0.15 && speed[i] < 0.35 && !steps.some((step) => Math.abs(step - i) <= quiet));
  // A lean in the input with no spine response at all (constant pitch) is a
  // failure, not a missing phase.
  check('leanCorrelation', leanFrames.length > 15 ? correlation(leanFrames.map((i) => leanOffset[i]), leanFrames.map((i) => spinePitch[i])) ?? -1 : null, (v) => v >= THRESHOLDS.minLeanCorrelation, (v) => `spine pitch follows the head's lean with r = ${v.toFixed(2)}`);

  // Smoothness.
  const jerkRms = (series) => {
    let total = 0;
    for (let i = 3; i < series.length; i += 1) {
      const j = series[i].map((v, k) => (v - 3 * series[i - 1][k] + 3 * series[i - 2][k] - series[i - 3][k]) / dt ** 3);
      total += dot(j, j);
    }
    return Math.sqrt(total / Math.max(1, series.length - 3));
  };
  const headJerk = jerkRms(truth.map((t) => t.position));
  check('pelvisJerkRatio', headJerk > 0 ? jerkRms(bones.map((b) => b.hips)) / headJerk : null, (v) => v <= THRESHOLDS.maxPelvisJerkRatio, (v) => `pelvis jerk ${v.toFixed(2)}× the head's`);
  let worstJoint = { ratio: 0, key: null, step: 0 };
  let worstPop = { ratio: 0, key: null, step: 0, frame: null };
  for (const [key, limit] of Object.entries(THRESHOLDS.maxJointStepM)) {
    const stepsOf = bones.slice(1).map((b, i) => length(sub(b[key], bones[i][key])));
    stepsOf.forEach((step, i) => {
      if (step / limit > worstJoint.ratio) worstJoint = { ratio: step / limit, key, step };
      if (step < THRESHOLDS.minPopStepM) return;
      // A pop stands out against the frames both before and after it.
      const around = [stepsOf[i - 2], stepsOf[i - 1], stepsOf[i + 1], stepsOf[i + 2]].filter((v) => v !== undefined);
      const ratio = step / Math.max(0.005, max(around));
      if (ratio > worstPop.ratio) worstPop = { ratio, key, step, frame: i + 1 };
    });
  }
  metrics.jointStepWorst = worstJoint;
  metrics.jointPopWorst = worstPop;
  check('jointStepRatio', worstJoint.ratio, (v) => v <= 1, () => `${worstJoint.key} moved ${(worstJoint.step * 100).toFixed(1)} cm in one frame`);
  check('jointPopRatio', worstPop.ratio, (v) => v <= THRESHOLDS.maxJointPopRatio, () => `${worstPop.key} popped ${(worstPop.step * 100).toFixed(1)} cm in one frame (${worstPop.ratio.toFixed(1)}× its neighbours)`);
  check('pelvisYawStepMaxDeg', max(pelvisYaw.slice(1).map((yaw, i) => Math.abs(wrap(yaw - pelvisYaw[i])) * DEG)), (v) => v <= THRESHOLDS.maxPelvisYawStepDeg, (v) => `pelvis turned ${v.toFixed(1)}° in one frame`);

  // Hands, where the recording has hand joints.
  const wristErrors = [];
  for (const frame of frames) {
    for (const side of ['left', 'right']) {
      const hand = frame.hands?.[side];
      if (hand?.source !== 'xr-hand' || !hand.tracked.wrist || !hand.avatar.wrist) continue;
      wristErrors.push(length(sub(hand.tracked.wrist, hand.avatar.wrist)));
    }
  }
  check('wristErrorP95M', wristErrors.length > 20 ? percentile(wristErrors, 0.95) : null, (v) => v <= THRESHOLDS.maxWristErrorP95M, (v) => `avatar wrists p95 ${(v * 100).toFixed(1)} cm from the tracked wrists`);

  metrics.phases = { walkWindows: walkWindows.length, turns: turns.length, inPlaceTurns: turnLags.length, stops: stops.length, stillWindows: stillWindows.length, inPlaceWindows: inPlace.length, crouchFrames: crouchFrames.length, leanFrames: leanFrames.length };
  return { failures, metrics };
}

const fmt = (value, digits = 3) => (value === null || value === undefined ? '-' : Number.isFinite(value) ? Number(value.toFixed(digits)) : String(value));

export function formatBodyReport(report) {
  const m = report.metrics;
  const cm = (v) => (v === null || v === undefined ? '-' : `${(v * 100).toFixed(1)}cm`);
  return [
    `[body-replay] ${report.label}: ${report.frames} frames (${(report.durationMs / 1000).toFixed(1)} s), ${m.steps ?? 0} steps, phases ${JSON.stringify(m.phases ?? {})}`,
    `  input ${m.headInputErrorM !== undefined ? `${(m.headInputErrorM * 1000).toFixed(2)}mm` : '-'}; rig drift ${cm(m.rigDriftM)}, turn ${fmt(m.rigTurnDeg, 2)}°, height-vs-ground ${cm(m.rigHeightVsGroundP95M)}`,
    `  eyes p95 still ${cm(m.eyeErrorStillP95M)} walking ${cm(m.eyeErrorWalkingP95M)} max ${cm(m.eyeErrorMaxM)} lag ${fmt(m.eyeLagFrames)}; head yaw ${fmt(m.headYawErrorP95Deg, 1)}° pitch ${fmt(m.headPitchErrorP95Deg, 1)}°; pelvis lag ${fmt(m.pelvisLagFrames)} overshoot root ${cm(m.rootOvershootM)} pelvis ${cm(m.pelvisOvershootM)}`,
    `  yaw: twist max ${fmt(m.neckTwistMaxDeg, 0)}°, settle ${fmt(m.turnSettleMaxSec, 2)}s, turn lag ${fmt(m.turnLagMinSec, 2)}–${fmt(m.turnLagMaxSec, 2)}s, walking p95 ${fmt(m.walkYawErrorP95Deg, 1)}°`,
    `  feet: drift ${cm(m.footDriftMaxM)}, skating ${fmt((m.skatingShare ?? 0) * 100, 1)}%, sole min ${cm(m.soleHeightMinM)} planted max ${cm(m.plantedSoleHeightMaxM)}, separation ${cm(m.footSeparationMinM)}, jitter ${m.plantedJitterRmsM !== undefined && m.plantedJitterRmsM !== null ? `${(m.plantedJitterRmsM * 1000).toFixed(2)}mm` : '-'}`,
    `  steps: cadence ${fmt(m.cadenceMinHz, 2)}–${fmt(m.cadenceMaxHz, 2)}/s, length ${fmt(m.stepLengthMinLeg, 2)}–${fmt(m.stepLengthMaxLeg, 2)} leg, still ${fmt(m.stepsWhileStillMax)}, in place ${fmt(m.stepsInPlaceMax)}; crouch ratio ${fmt(m.crouchRatio, 2)}, lean r ${fmt(m.leanCorrelation, 2)}`,
    `  smooth: pelvis jerk ×${fmt(m.pelvisJerkRatio, 2)}, worst joint step ${m.jointStepWorst?.key ?? '-'} ${cm(m.jointStepWorst?.step)} (${fmt(m.jointStepWorst?.ratio, 2)} of limit), worst pop ${m.jointPopWorst?.key ?? '-'} ×${fmt(m.jointPopWorst?.ratio, 1)}, pelvis yaw step ${fmt(m.pelvisYawStepMaxDeg, 1)}°; wrists p95 ${cm(m.wristErrorP95M)}`
  ].join('\n');
}
