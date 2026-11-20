// Arm-specific motion numbers for the VR arm IK, on top of the shared
// motion-quality instrument: where the elbow points (its swivel about the
// shoulder-wrist line), how often it flips, whether it enters the torso, how
// far the clavicle swings, and how much the wrist skin twists. Input is the
// body sampler's world positions (`__sampleBody`) and the hand sampler's
// wrist twist (`__sampleHands`); see scripts/ci-arm-reach-playwright.ts.

export type Vec3 = [number, number, number];
export type ArmSide = 'left' | 'right';
export type ArmFrame = {
  timeSec: number;
  segment?: string;
  bones: Partial<Record<string, Vec3>>;
  wrist?: Partial<Record<ArmSide, { tracked?: Vec3; avatar?: Vec3; twistDeg?: number; source?: string }>>;
};
// Torso cross-section in shares of the hip joints' half-spacing (ArmClearance's BodyWidths.torso).
export type TorsoSection = { half: number; front: number; back: number };

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a: Vec3) => Math.hypot(a[0], a[1], a[2]);
const norm = (a: Vec3): Vec3 => scale(a, 1 / (len(a) || 1));
const reject = (a: Vec3, axis: Vec3): Vec3 => sub(a, scale(axis, dot(a, axis)));
const deg = (rad: number) => (rad * 180) / Math.PI;
const wrapDeg = (d: number) => ((((d + 180) % 360) + 360) % 360) - 180;

export function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.round((p / 100) * (sorted.length - 1))))]!;
}

type TorsoFrame = { right: Vec3; up: Vec3; forward: Vec3; hips: Vec3; chest: Vec3; hipHalf: number };
function torsoFrame(bones: ArmFrame['bones']): TorsoFrame | null {
  const { hips, chest, leftHip, rightHip } = bones;
  if (!hips || !chest || !leftHip || !rightHip) return null;
  // Across the hips, not the shoulders: a protracting clavicle must not tilt the frame it is measured in.
  const right = norm(sub(rightHip, leftHip));
  const up = norm(reject(sub(chest, hips), right));
  return { right, up, forward: cross(up, right), hips, chest, hipHalf: len(sub(rightHip, leftHip)) / 2 };
}

export type ArmPoseFrame = {
  // Elbow swivel about the shoulder-wrist line: 0° hangs down, +90° points
  // away from the body (out on a forward reach, back on a sideways one),
  // ±180° up, negative toward the body. Null when the arm
  // is nearly straight or the line is near vertical (no defined bend plane).
  swivelDeg: number | null;
  elbowAngleDeg: number;
  // Signed elbow distance outside the torso section (negative = inside), cm.
  elbowTorsoCm: number | null;
  forearmTorsoCm: number | null;
  clavicleElevDeg: number | null;
  claviclePushDeg: number | null;
  wristErrorCm: number | null;
  twistDeg: number | null;
};

function torsoClearanceCm(point: Vec3, torso: TorsoFrame, section: TorsoSection): number | null {
  // Only beside the torso: between the hips and the shoulders.
  const rel = sub(point, torso.hips);
  const height = dot(rel, torso.up);
  const top = dot(sub(torso.chest, torso.hips), torso.up) * 1.25;
  if (height < 0 || height > top) return null;
  const x = dot(rel, torso.right) / (section.half * torso.hipHalf);
  const z = dot(rel, torso.forward);
  const depth = (z >= 0 ? section.front : section.back) * torso.hipHalf;
  const r = Math.hypot(x, z / depth);
  // Radial distance outside the ellipse, scaled to metres along the ray.
  const scaleM = Math.hypot(dot(rel, torso.right), z) / (r || 1);
  return ((r - 1) * scaleM) * 100;
}

export function armPose(frame: ArmFrame, side: ArmSide, section: TorsoSection | null): ArmPoseFrame | null {
  const S = frame.bones[`${side}Shoulder`];
  const E = frame.bones[`${side}Elbow`];
  const W = frame.bones[`${side}Wrist`];
  const C = frame.bones[`${side}Clavicle`];
  const torso = torsoFrame(frame.bones);
  if (!S || !E || !W || !torso) return null;
  const outward = scale(torso.right, side === 'right' ? 1 : -1);
  const upper = sub(E, S);
  const fore = sub(W, E);
  const elbowAngleDeg = 180 - deg(Math.acos(Math.max(-1, Math.min(1, dot(norm(upper), norm(fore))))));
  const axis = norm(sub(W, S));
  const e = reject(upper, axis);
  const down = reject(scale(torso.up, -1), axis);
  let swivelDeg: number | null = null;
  if (elbowAngleDeg < 165 && len(e) > 1e-3 && len(down) > 0.25) {
    const d = norm(down);
    const o = norm(cross(axis, d));
    // o is ±(out or back) depending on the axis; orient it away from the
    // body: outward on a forward reach, backward on a sideways one.
    const away = add(outward, scale(torso.forward, -1));
    const out = dot(o, away) >= 0 ? o : scale(o, -1);
    const en = norm(e);
    swivelDeg = deg(Math.atan2(dot(en, out), dot(en, d)));
  }
  const mid = scale(add(E, W), 0.5);
  let clavicleElevDeg: number | null = null;
  let claviclePushDeg: number | null = null;
  if (C) {
    const c = norm(sub(S, C));
    clavicleElevDeg = deg(Math.asin(Math.max(-1, Math.min(1, dot(c, torso.up)))));
    claviclePushDeg = deg(Math.asin(Math.max(-1, Math.min(1, dot(c, torso.forward)))));
  }
  const wrist = frame.wrist?.[side];
  return {
    swivelDeg,
    elbowAngleDeg,
    elbowTorsoCm: section ? torsoClearanceCm(E, torso, section) : null,
    forearmTorsoCm: section ? torsoClearanceCm(mid, torso, section) : null,
    clavicleElevDeg,
    claviclePushDeg,
    wristErrorCm: wrist?.tracked && wrist.avatar ? len(sub(wrist.tracked, wrist.avatar)) * 100 : null,
    twistDeg: wrist?.twistDeg ?? null
  };
}

export type ArmMetrics = {
  frames: number;
  wristErrorP95Cm: number | null;
  wristErrorMaxCm: number | null;
  swivelMedianDeg: number | null;
  // Elbow above the shoulder-wrist line (|swivel| > 120°) or pointing into the body (swivel < -30°).
  elbowUpShare: number | null;
  elbowInShare: number | null;
  // A flip: the swivel turns more than 25° in one 30 Hz frame.
  elbowFlips: number;
  elbowFlipsPerMin: number;
  swivelMaxStepDeg: number | null;
  elbowTorsoMinCm: number | null;
  elbowInsideTorsoShare: number | null;
  forearmTorsoMinCm: number | null;
  clavicleElevRangeDeg: number | null;
  claviclePushRangeDeg: number | null;
  clavicleMaxStepDeg: number | null;
  twistP95Deg: number | null;
  twistMaxDeg: number | null;
  // Avatar wrist step against the tracked wrist step, worst frame (cm): a snap.
  wristSnapMaxCm: number | null;
  // Largest avatar wrist move in one frame (cm), whatever the input did.
  wristStepMaxCm: number | null;
};

export function measureArms(frames: ArmFrame[], section: TorsoSection | null, sides: readonly ArmSide[] = ['left', 'right']): ArmMetrics {
  const err: number[] = [];
  const swivel: number[] = [];
  const steps: number[] = [];
  const twists: number[] = [];
  const snaps: number[] = [];
  const clavSteps: number[] = [];
  const wristSteps: number[] = [];
  let up = 0;
  let inward = 0;
  let flips = 0;
  let torsoMin: number | null = null;
  let foreMin: number | null = null;
  let inside = 0;
  let torsoCount = 0;
  const elev: number[] = [];
  const push: number[] = [];
  for (const side of sides) {
    let prev: ArmPoseFrame | null = null;
    let prevFrame: ArmFrame | null = null;
    for (const frame of frames) {
      const pose = armPose(frame, side, section);
      if (!pose) {
        prev = null;
        prevFrame = null;
        continue;
      }
      if (pose.wristErrorCm !== null) err.push(pose.wristErrorCm);
      if (pose.swivelDeg !== null) {
        swivel.push(pose.swivelDeg);
        if (Math.abs(pose.swivelDeg) > 120) up += 1;
        if (pose.swivelDeg < -30 && pose.swivelDeg > -120) inward += 1;
        if (prev?.swivelDeg != null) {
          const step = Math.abs(wrapDeg(pose.swivelDeg - prev.swivelDeg));
          steps.push(step);
          if (step > 25) flips += 1;
        }
      }
      if (pose.elbowTorsoCm !== null) {
        torsoCount += 1;
        if (pose.elbowTorsoCm < 0) inside += 1;
        torsoMin = torsoMin === null ? pose.elbowTorsoCm : Math.min(torsoMin, pose.elbowTorsoCm);
      }
      if (pose.forearmTorsoCm !== null) foreMin = foreMin === null ? pose.forearmTorsoCm : Math.min(foreMin, pose.forearmTorsoCm);
      if (pose.clavicleElevDeg !== null) elev.push(pose.clavicleElevDeg);
      if (pose.claviclePushDeg !== null) push.push(pose.claviclePushDeg);
      if (prev?.clavicleElevDeg != null && pose.clavicleElevDeg !== null && prev.claviclePushDeg != null && pose.claviclePushDeg !== null) {
        clavSteps.push(Math.hypot(pose.clavicleElevDeg - prev.clavicleElevDeg, pose.claviclePushDeg - prev.claviclePushDeg));
      }
      if (pose.twistDeg !== null) twists.push(Math.abs(pose.twistDeg));
      const wa = frame.wrist?.[side]?.avatar;
      const wt = frame.wrist?.[side]?.tracked;
      const pa = prevFrame?.wrist?.[side]?.avatar;
      const pt = prevFrame?.wrist?.[side]?.tracked;
      if (wa && pa) {
        wristSteps.push(len(sub(wa, pa)) * 100);
        snaps.push((len(sub(wa, pa)) - (wt && pt ? len(sub(wt, pt)) : 0)) * 100);
      }
      prev = pose;
      prevFrame = frame;
    }
  }
  const span = frames.length > 1 ? frames[frames.length - 1]!.timeSec - frames[0]!.timeSec : 0;
  const range = (v: number[]) => (v.length ? Math.max(...v) - Math.min(...v) : null);
  return {
    frames: frames.length,
    wristErrorP95Cm: percentile(err, 95),
    wristErrorMaxCm: err.length ? Math.max(...err) : null,
    swivelMedianDeg: percentile(swivel, 50),
    elbowUpShare: swivel.length ? up / swivel.length : null,
    elbowInShare: swivel.length ? inward / swivel.length : null,
    elbowFlips: flips,
    elbowFlipsPerMin: span > 0 ? (flips / span) * 60 / sides.length : 0,
    swivelMaxStepDeg: steps.length ? Math.max(...steps) : null,
    elbowTorsoMinCm: torsoMin,
    elbowInsideTorsoShare: torsoCount ? inside / torsoCount : null,
    forearmTorsoMinCm: foreMin,
    clavicleElevRangeDeg: range(elev),
    claviclePushRangeDeg: range(push),
    clavicleMaxStepDeg: clavSteps.length ? Math.max(...clavSteps) : null,
    twistP95Deg: percentile(twists, 95),
    twistMaxDeg: twists.length ? Math.max(...twists) : null,
    wristSnapMaxCm: snaps.length ? Math.max(...snaps) : null,
    wristStepMaxCm: wristSteps.length ? Math.max(...wristSteps) : null
  };
}

/** The metrics per scripted segment (frames carry a `segment` label). */
export function measureArmsBySegment(frames: ArmFrame[], section: TorsoSection | null): Record<string, ArmMetrics> {
  const bySegment = new Map<string, ArmFrame[]>();
  for (const frame of frames) {
    const key = frame.segment ?? 'all';
    if (!bySegment.has(key)) bySegment.set(key, []);
    bySegment.get(key)!.push(frame);
  }
  return Object.fromEntries([...bySegment].map(([key, list]) => [key, measureArms(list, section)]));
}
