// Fidelity metrics for avatar hands against tracked hands, from samples
// produced by window.__sampleHands() during a recorded-input replay.
//
// Avatar and user hands differ in size and proportion, so shape metrics are
// computed in a hand-local frame (origin at the wrist, scaled by the
// wrist-to-middle-knuckle length) and compared as joint angles rather than raw
// positions. Wrist pose is compared in world space because the avatar arm is
// expected to put the hand where the user's hand is.

// Where natural-looking hands should land. Finger shape and wrist offset do
// not meet these yet (BUGS.md B-005); CI enforces THRESHOLDS below meanwhile.
export const TARGETS = Object.freeze({
  maxCurlErrorDeg: 20,
  minCurlCorrelation: 0.8,
  maxWristPositionErrorM: 0.05,
  maxWristRotationErrorDeg: 25
});

export const THRESHOLDS = Object.freeze({
  // Fraction of tracked frames that must arrive through real XRHand input.
  minXrHandCoverage: 0.9,
  // Per-finger curl (sum of joint flexion angles) mean absolute error, degrees.
  // Ceiling at today's worst finger (66°) so shape cannot regress; target 20°.
  maxCurlErrorDeg: 70,
  // Curl must follow the tracked curl over time when the finger actually moves.
  // Ceiling at today's worst finger (0.63); target 0.8.
  minCurlCorrelation: 0.6,
  minCurlRangeDegForCorrelation: 25,
  // Retargeting may smooth, but must not delay motion by more than this.
  maxCurlLagFrames: 2,
  // Thumb–index tips within this fraction of hand length count as touching.
  pinchContactRatio: 0.25,
  minPinchAgreement: 0.9,
  // Wrist placement in world space (p95). Today a constant ~7.5 cm offset;
  // the 2026-10-17 camera bug put it at 21 m. Target 5 cm and 25°.
  maxWristPositionErrorM: 0.1,
  maxWristRotationErrorDeg: 55,
  // Avatar fingertip jerk relative to the tracked fingertips.
  maxJerkRatio: 1.5
});

const FINGERS = {
  thumb: ['wrist', 'thumb-metacarpal', 'thumb-phalanx-proximal', 'thumb-phalanx-distal', 'thumb-tip'],
  index: ['wrist', 'index-finger-phalanx-proximal', 'index-finger-phalanx-intermediate', 'index-finger-phalanx-distal', 'index-finger-tip'],
  middle: ['wrist', 'middle-finger-phalanx-proximal', 'middle-finger-phalanx-intermediate', 'middle-finger-phalanx-distal', 'middle-finger-tip'],
  ring: ['wrist', 'ring-finger-phalanx-proximal', 'ring-finger-phalanx-intermediate', 'ring-finger-phalanx-distal', 'ring-finger-tip'],
  pinky: ['wrist', 'pinky-finger-phalanx-proximal', 'pinky-finger-phalanx-intermediate', 'pinky-finger-phalanx-distal', 'pinky-finger-tip']
};
const FRAME_JOINTS = ['wrist', 'index-finger-phalanx-proximal', 'middle-finger-phalanx-proximal', 'pinky-finger-phalanx-proximal'];
const TIP_JOINTS = ['thumb-tip', 'index-finger-tip', 'middle-finger-tip', 'ring-finger-tip', 'pinky-finger-tip'];

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const length = (a) => Math.hypot(a[0], a[1], a[2]);
const scale = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const normalize = (a) => scale(a, 1 / (length(a) || 1));
const angleDeg = (a, b) => (Math.acos(Math.max(-1, Math.min(1, dot(normalize(a), normalize(b))))) * 180) / Math.PI;

function percentile(values, p) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(p * (sorted.length - 1)))];
}
const mean = (values) => (values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null);

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

// Lag (in frames) at which the avatar series best matches the tracked series;
// positive means the avatar trails the user.
function bestLag(tracked, avatar, maxLag = 6) {
  let best = { lag: 0, r: -Infinity };
  for (let lag = -maxLag; lag <= maxLag; lag += 1) {
    const a = [];
    const b = [];
    for (let i = 0; i < tracked.length; i += 1) {
      const j = i + lag;
      if (j < 0 || j >= avatar.length) continue;
      a.push(tracked[i]);
      b.push(avatar[j]);
    }
    const r = a.length > 10 ? correlation(a, b) : null;
    if (r !== null && r > best.r) best = { lag, r };
  }
  return best.lag;
}

// Orthonormal hand frame: y along the hand, z out of the palm side.
function handFrame(joints) {
  if (!FRAME_JOINTS.every((name) => joints[name])) return null;
  const wrist = joints.wrist;
  const along = sub(joints['middle-finger-phalanx-proximal'], wrist);
  const handLength = length(along);
  if (!(handLength > 1e-4)) return null;
  const y = normalize(along);
  const across = normalize(sub(joints['index-finger-phalanx-proximal'], joints['pinky-finger-phalanx-proximal']));
  const z = normalize(cross(across, y));
  const x = cross(y, z);
  return { wrist, handLength, axes: [x, y, z] };
}

function fingerCurlDeg(joints, chain) {
  if (!chain.every((name) => joints[name])) return null;
  let total = 0;
  for (let i = 1; i < chain.length - 1; i += 1) {
    total += angleDeg(sub(joints[chain[i]], joints[chain[i - 1]]), sub(joints[chain[i + 1]], joints[chain[i]]));
  }
  return total;
}

function localTips(joints, frame) {
  return TIP_JOINTS.map((name) => {
    const offset = sub(joints[name], frame.wrist);
    return frame.axes.map((axis) => dot(offset, axis) / frame.handLength);
  });
}

function rmsJerk(series) {
  const values = [];
  for (let i = 3; i < series.length; i += 1) {
    for (let k = 0; k < series[i].length; k += 1) {
      const jerk = sub(sub(sub(series[i][k], series[i - 1][k]), sub(series[i - 1][k], series[i - 2][k])),
        sub(sub(series[i - 1][k], series[i - 2][k]), sub(series[i - 2][k], series[i - 3][k])));
      values.push(dot(jerk, jerk));
    }
  }
  return values.length ? Math.sqrt(mean(values)) : null;
}

function analyzeSide(frames, side) {
  const curls = Object.fromEntries(Object.keys(FINGERS).map((finger) => [finger, { tracked: [], avatar: [] }]));
  const pinch = { tracked: [], avatar: [] };
  const wristPositionErrors = [];
  const wristRotationErrors = [];
  const tipSeries = { tracked: [], avatar: [] };
  let trackedFrames = 0;
  let xrHandFrames = 0;
  let mockFrames = 0;

  for (const { hands } of frames) {
    const sample = hands?.[side];
    if (!sample || sample.source === 'none') continue;
    trackedFrames += 1;
    if (sample.source === 'mock') mockFrames += 1;
    if (sample.source !== 'xr-hand') continue;
    xrHandFrames += 1;

    const trackedFrame = handFrame(sample.tracked);
    const avatarFrame = handFrame(sample.avatar);
    if (!trackedFrame || !avatarFrame) continue;

    for (const [finger, chain] of Object.entries(FINGERS)) {
      const tracked = fingerCurlDeg(sample.tracked, chain);
      const avatar = fingerCurlDeg(sample.avatar, chain);
      if (tracked === null || avatar === null) continue;
      curls[finger].tracked.push(tracked);
      curls[finger].avatar.push(avatar);
    }

    const pinchRatio = (joints, frame) => length(sub(joints['thumb-tip'], joints['index-finger-tip'])) / frame.handLength;
    pinch.tracked.push(pinchRatio(sample.tracked, trackedFrame));
    pinch.avatar.push(pinchRatio(sample.avatar, avatarFrame));

    wristPositionErrors.push(length(sub(sample.tracked.wrist, sample.avatar.wrist)));
    // Rotation between the two hand frames: average axis misalignment.
    wristRotationErrors.push(mean(trackedFrame.axes.map((axis, i) => angleDeg(axis, avatarFrame.axes[i]))));

    tipSeries.tracked.push(localTips(sample.tracked, trackedFrame));
    tipSeries.avatar.push(localTips(sample.avatar, avatarFrame));
  }

  const fingers = Object.fromEntries(Object.entries(curls).map(([finger, { tracked, avatar }]) => {
    const errors = tracked.map((value, i) => Math.abs(value - avatar[i]));
    const range = tracked.length ? Math.max(...tracked) - Math.min(...tracked) : 0;
    return [finger, {
      samples: tracked.length,
      meanErrorDeg: mean(errors),
      trackedRangeDeg: range,
      correlation: tracked.length > 10 ? correlation(tracked, avatar) : null,
      lagFrames: tracked.length > 10 ? bestLag(tracked, avatar) : null
    }];
  }));

  const contact = (ratio) => ratio < THRESHOLDS.pinchContactRatio;
  const trackedContacts = pinch.tracked.filter(contact).length;
  const agreement = pinch.tracked.length
    ? pinch.tracked.filter((ratio, i) => contact(ratio) === contact(pinch.avatar[i])).length / pinch.tracked.length
    : null;
  const trackedJerk = rmsJerk(tipSeries.tracked);
  const avatarJerk = rmsJerk(tipSeries.avatar);

  return {
    trackedFrames,
    xrHandFrames,
    mockFrames,
    xrHandCoverage: trackedFrames ? xrHandFrames / trackedFrames : null,
    fingers,
    pinch: { trackedContactFrames: trackedContacts, agreement },
    wrist: {
      positionErrorP95M: percentile(wristPositionErrors, 0.95),
      rotationErrorP95Deg: percentile(wristRotationErrors, 0.95)
    },
    jerk: { tracked: trackedJerk, avatar: avatarJerk, ratio: trackedJerk ? avatarJerk / trackedJerk : null }
  };
}

function checkSide(side, result) {
  const failures = [];
  const t = THRESHOLDS;
  if (result.trackedFrames === 0) return [`${side}: hand never tracked`];
  if (result.mockFrames > 0) failures.push(`${side}: ${result.mockFrames} frames used mock input instead of XRHand`);
  if (result.xrHandCoverage < t.minXrHandCoverage) failures.push(`${side}: XRHand coverage ${result.xrHandCoverage.toFixed(2)} < ${t.minXrHandCoverage}`);
  for (const [finger, metrics] of Object.entries(result.fingers)) {
    if (metrics.samples === 0) {
      failures.push(`${side} ${finger}: no comparable samples`);
      continue;
    }
    if (metrics.meanErrorDeg > t.maxCurlErrorDeg) failures.push(`${side} ${finger}: curl error ${metrics.meanErrorDeg.toFixed(1)}° > ${t.maxCurlErrorDeg}°`);
    if (metrics.trackedRangeDeg >= t.minCurlRangeDegForCorrelation) {
      if (metrics.correlation === null || metrics.correlation < t.minCurlCorrelation) {
        failures.push(`${side} ${finger}: curl correlation ${metrics.correlation?.toFixed(2) ?? 'n/a'} < ${t.minCurlCorrelation}`);
      }
      if (metrics.lagFrames !== null && Math.abs(metrics.lagFrames) > t.maxCurlLagFrames) {
        failures.push(`${side} ${finger}: curl lags tracking by ${metrics.lagFrames} frames`);
      }
    }
  }
  if (result.pinch.trackedContactFrames > 0 && result.pinch.agreement < t.minPinchAgreement) {
    failures.push(`${side}: pinch agreement ${result.pinch.agreement.toFixed(2)} < ${t.minPinchAgreement}`);
  }
  if (result.wrist.positionErrorP95M > t.maxWristPositionErrorM) failures.push(`${side}: wrist position p95 ${(result.wrist.positionErrorP95M * 100).toFixed(1)} cm > ${t.maxWristPositionErrorM * 100} cm`);
  if (result.wrist.rotationErrorP95Deg > t.maxWristRotationErrorDeg) failures.push(`${side}: wrist rotation p95 ${result.wrist.rotationErrorP95Deg.toFixed(1)}° > ${t.maxWristRotationErrorDeg}°`);
  if (result.jerk.ratio !== null && result.jerk.ratio > t.maxJerkRatio) failures.push(`${side}: fingertip jerk ${result.jerk.ratio.toFixed(2)}× tracked > ${t.maxJerkRatio}×`);
  return failures;
}

export function analyzeHandReplay(frames, { stepMs } = {}) {
  const sides = { left: analyzeSide(frames, 'left'), right: analyzeSide(frames, 'right') };
  const failures = Object.entries(sides).flatMap(([side, result]) => checkSide(side, result));
  return { frames: frames.length, stepMs, thresholds: THRESHOLDS, targets: TARGETS, sides, failures };
}

export function formatHandReport(report) {
  const lines = [`[hand-replay] ${report.label}: ${report.frames} frames (${(report.durationMs / 1000).toFixed(1)} s)`];
  for (const [side, result] of Object.entries(report.sides)) {
    if (result.trackedFrames === 0) {
      lines.push(`  ${side}: not tracked`);
      continue;
    }
    const fingers = Object.entries(result.fingers)
      .map(([finger, m]) => `${finger} ${m.meanErrorDeg?.toFixed(1) ?? '-'}°/r=${m.correlation?.toFixed(2) ?? '-'}/lag ${m.lagFrames ?? '-'}`)
      .join(', ');
    lines.push(`  ${side}: xr-hand ${(result.xrHandCoverage * 100).toFixed(0)}%; curl ${fingers}`);
    lines.push(`  ${side}: pinch agreement ${result.pinch.agreement?.toFixed(2) ?? '-'} (${result.pinch.trackedContactFrames} contact frames); wrist p95 ${result.wrist.positionErrorP95M !== null ? (result.wrist.positionErrorP95M * 100).toFixed(1) : '-'} cm / ${result.wrist.rotationErrorP95Deg?.toFixed(1) ?? '-'}°; jerk ×${result.jerk.ratio?.toFixed(2) ?? '-'}`);
  }
  return lines.join('\n');
}
