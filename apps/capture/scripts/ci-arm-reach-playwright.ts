import { spawnSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium, type Page } from 'playwright';

import {
  attachXrEnvironment,
  createXrContext,
  enterIwerSessionFromButton,
  freezePageClock,
  launchXrBrowser,
  resolveSimulationViewport,
  waitForIwerRuntime,
  waitForPageFunctions,
  waitForTextContentPrefix,
  waitForXrRenderLoop,
  wireXrConsoleErrors
} from '@holoim/tooling-testing/xr-env';
import { writeContactSheet } from '@holoim/tooling-testing/preview';

import type {} from '../src/runtime/automationHooks';
import { measureArms, measureArmsBySegment, type ArmFrame, type ArmMetrics, type TorsoSection } from './lib/arm-quality.ts';
import { framesFromBodySamples, measureMotion } from './lib/motion-quality.ts';

// Drives the IWER headset through scripted arm reaches (forward, overhead,
// sideways, across the body, behind the back, by the ear, a wrist roll, a
// crouch, a walk, a lost and regained hand, and a switch between hands and
// controllers), once per input source, and grades the arm IK with the arm
// numbers in scripts/lib/arm-quality.ts (elbow swivel, flips, torso
// clearance, clavicle swing, wrist twist) and the shared motion instrument.
//
// ARM_REACH_INPUTS=hand,controller (default both); ARM_REACH_SESSION=ar runs
// a Quest passthrough session; ARM_REACH_VIDEO=1 writes an MP4 per input.

const STEP_MS = 1000 / 30;
const STEP_SEC = STEP_MS / 1000;
const HEAD_Y = 1.6;
const baseUrl = process.env.BASE_URL ?? 'https://127.0.0.1:5174/';
const passthrough = process.env.ARM_REACH_SESSION === 'ar';
const artifactDir = process.env.XR_TEST_ARTIFACT_DIR ?? `output/ci-arm-reach${passthrough ? '-ar' : ''}`;
const video = process.env.ARM_REACH_VIDEO === '1';
const inputs = (process.env.ARM_REACH_INPUTS ?? 'hand,controller').split(',') as Array<'hand' | 'controller'>;
const only = process.env.ARM_REACH_ONLY;

// Hand keys in the head's yaw frame: out (away from the midline), up from
// the eyes, ahead (metres); yaw turns the fingers outward, pitch raises them,
// roll turns the palm outward from palm-down (degrees, right hand; the left
// mirrors). The poses are what a person's hand does there: a hanging hand
// points down with the palm in, a forward reach is a handshake, a sideways
// reach points along the arm. Targets stay inside the reach of a person
// with 1.6 m eyes; forward-far is the one past it.
type Key = { out: number; y: number; ahead: number; yaw?: number; pitch?: number; roll?: number };
type Step = { label: string; to?: Key; sec?: number; hold?: number; head?: { down?: number; walk?: number }; lose?: boolean; regain?: boolean; switchInput?: boolean; rollSweep?: number };
const K = (out: number, y: number, ahead: number, yaw = 0, pitch = 0, roll = 0): Key => ({ out, y, ahead, yaw, pitch, roll });
const REST = K(0.2, -0.66, 0.08, 0, -80, -90);
const SCRIPT: Step[] = [
  { label: 'rest', to: REST, sec: 0.1, hold: 0.8 },
  { label: 'forward', to: K(0.2, -0.22, 0.5, 0, 0, -90), sec: 1.0, hold: 0.6 },
  { label: 'forward-far', to: K(0.2, -0.2, 0.65, 0, 0, -90), sec: 0.6, hold: 0.5 },
  { label: 'overhead', to: K(0.2, 0.3, 0.1, 0, 80, -90), sec: 1.1, hold: 0.6 },
  { label: 'side', to: K(0.68, -0.2, 0.0, -90, 0, 0), sec: 1.1, hold: 0.6 },
  { label: 'side-low', to: K(0.45, -0.55, 0.05, -60, -40, 0), sec: 0.8, hold: 0.4 },
  { label: 'across', to: K(-0.25, -0.3, 0.3, 60, 0, -45), sec: 1.1, hold: 0.6 },
  { label: 'chest', to: K(0.08, -0.42, 0.2, 50, 0, -60), sec: 0.8, hold: 0.5 },
  { label: 'ear', to: K(0.12, -0.04, 0.0, 0, 70, -90), sec: 0.9, hold: 0.5 },
  { label: 'behind', to: K(0.1, -0.78, -0.18, 0, -90, -90), sec: 1.2, hold: 0.6 },
  { label: 'mid', to: K(0.22, -0.45, 0.38, 0, 0, -90), sec: 1.0, hold: 0.3 },
  { label: 'roll', rollSweep: 90, sec: 3.0 },
  { label: 'lose', lose: true, to: K(0.2, -0.22, 0.5, 0, 0, -90), sec: 1.0, hold: 0.5 },
  { label: 'regain', regain: true, hold: 0.8 },
  { label: 'switch', switchInput: true, hold: 1.0 },
  { label: 'switch-back', switchInput: true, hold: 1.0 },
  { label: 'crouch', head: { down: 0.5 }, to: K(0.25, -0.5, 0.4, 0, -30, -90), sec: 1.3, hold: 0.8 },
  { label: 'stand', head: { down: 0 }, to: REST, sec: 1.2, hold: 0.5 },
  { label: 'walk', head: { walk: 1.5 }, sec: 1.8, hold: 0.6 }
];

const minJerk = (u: number) => u * u * u * (10 - 15 * u + 6 * u * u);
const lerp = (a: number, b: number, s: number) => a + (b - a) * s;
const lerpKey = (a: Key, b: Key, s: number): Key => ({ out: lerp(a.out, b.out, s), y: lerp(a.y, b.y, s), ahead: lerp(a.ahead, b.ahead, s), yaw: lerp(a.yaw ?? 0, b.yaw ?? 0, s), pitch: lerp(a.pitch ?? 0, b.pitch ?? 0, s), roll: lerp(a.roll ?? 0, b.roll ?? 0, s) });

type DeviceFrame = {
  segment: string;
  head: [number, number, number];
  hands: Record<'left' | 'right', { position: [number, number, number]; quaternion: Q; grip: Q }>;
  connected: Record<'left' | 'right', boolean>;
  switchInput: boolean;
};

type Q = [number, number, number, number];
const qMul = (a: Q, b: Q): Q => [
  a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
  a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
  a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
  a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2]
];
const qAxis = (axis: 0 | 1 | 2, degrees: number): Q => {
  const half = (degrees * Math.PI) / 360;
  const q: Q = [0, 0, 0, Math.cos(half)];
  q[axis] = Math.sin(half);
  return q;
};
// Yaw (Y), then pitch (X), then roll about the fingers (Z), in the head's frame facing -Z.
const handQuaternion = (yaw: number, pitch: number, roll: number): Q => qMul(qMul(qAxis(1, yaw), qAxis(0, pitch)), qAxis(2, roll));

function* devicePath(): Generator<DeviceFrame> {
  let key = SCRIPT[0]!.to!;
  let down = 0;
  let z = 0;
  let phase = 0;
  const lost = { left: false, right: false };
  for (const step of SCRIPT) {
    const from = key;
    const to = step.to ?? key;
    const fromDown = down;
    const toDown = step.head?.down ?? down;
    const fromZ = z;
    const toZ = z - (step.head?.walk ?? 0);
    const moveSec = step.sec ?? 0;
    const frames = Math.round(moveSec / STEP_SEC) + Math.round((step.hold ?? 0) / STEP_SEC);
    if (step.lose) lost.right = true;
    if (step.regain) lost.right = false;
    for (let i = 1; i <= frames; i += 1) {
      const t = i * STEP_SEC;
      const s = moveSec > 0 ? minJerk(Math.min(1, t / moveSec)) : 1;
      let current = lerpKey(from, to, s);
      if (step.rollSweep && t <= moveSec) {
        // Palm down → palm in → palm up and back: the wrist roll a reach for a cup makes.
        current = { ...current, roll: (current.roll ?? 0) + step.rollSweep * Math.sin((2 * Math.PI * t) / moveSec) };
      }
      down = lerp(fromDown, toDown, s);
      z = lerp(fromZ, toZ, s);
      const walking = step.head?.walk ? Math.sin(Math.PI * Math.min(1, t / moveSec)) : 0;
      phase += (1.4 + 0.45 * 1.2 * walking) * STEP_SEC;
      const bob = -0.018 * walking * Math.cos(2 * Math.PI * phase);
      const head: [number, number, number] = [0.015 * walking * Math.sin(Math.PI * phase), HEAD_Y - down + bob, z];
      const hands = {} as DeviceFrame['hands'];
      for (const side of ['left', 'right'] as const) {
        const sign = side === 'left' ? -1 : 1;
        const swing = step.head?.walk ? 0.12 * walking * Math.sin(Math.PI * phase) * sign : 0;
        hands[side] = {
          position: [head[0] + sign * current.out, head[1] + current.y + down * 0.0, head[2] - current.ahead - swing],
          quaternion: handQuaternion(sign * (current.yaw ?? 0), current.pitch ?? 0, sign * (current.roll ?? 0)),
          // A held controller's grip points along the hand with the palm in.
          grip: handQuaternion(sign * (current.yaw ?? 0), current.pitch ?? 0, sign * ((current.roll ?? 0) + 90))
        };
      }
      yield { segment: step.label, head, hands, connected: { left: !lost.left, right: !lost.right }, switchInput: Boolean(step.switchInput) && i === 1 };
    }
    key = to;
  }
}

async function run(browser: Awaited<ReturnType<typeof launchXrBrowser>>, input: 'hand' | 'controller', consoleErrors: string[]) {
  const label = `${input}${passthrough ? '-ar' : ''}`;
  const viewport = video ? { width: 1280, height: 720 } : resolveSimulationViewport();
  const context = await createXrContext(browser, { viewport });
  const page: Page = await context.newPage();
  wireXrConsoleErrors(page, consoleErrors, { label });
  await attachXrEnvironment(page, { mode: 'iwer', cacheClearState: true });
  await page.addInitScript('globalThis.__name = (target) => target;');
  const pageUrl = new URL('?scene=/fixtures/scenes/body-floor.gltf&sceneScale=1', baseUrl);
  pageUrl.searchParams.set('manualClock', '1');
  if (process.env.XR_AVATAR_URL) pageUrl.searchParams.set('avatar', process.env.XR_AVATAR_URL);
  await page.goto(pageUrl.href, { waitUntil: 'networkidle' });
  await waitForPageFunctions(page, ['__setManualClock', '__setFrameStepping', '__sampleBody', '__sampleHands', '__sampleArmClearance']);
  await waitForTextContentPrefix(page, '#status', 'loaded');
  await page.evaluate((mode: string) => {
    window.__setManualClock(true, false);
    window.IWER_DEVICE!.primaryInputMode = mode as 'hand' | 'controller';
  }, input);
  await waitForIwerRuntime(page);
  await enterIwerSessionFromButton(page, passthrough ? '#ARButton' : '#VRButton', {
    readyCheck: passthrough
      ? "(() => { const s = JSON.parse(window.render_game_to_text()); return s.mode === 'vr' && s.ar.sessionMode === 'ar' && !s.ar.cameraAuthor; })()"
      : () => JSON.parse(window.render_game_to_text()).mode === 'vr'
  });
  await page.evaluate((draw: boolean) => {
    window.IWER_DEVICE!.controlMode = 'programmatic';
    if (draw) {
      window.__setSpectatorView('body');
      const devui = window.IWER_DEVICE!.devui;
      for (const element of [devui?.devUIContainer, devui?.devUICanvas, document.getElementById('ui-root'), document.getElementById('VRButton'), document.getElementById('ARButton')]) {
        if (element instanceof HTMLElement) element.style.display = 'none';
      }
    }
  }, video);
  await freezePageClock(page);
  await waitForXrRenderLoop(page);
  await page.evaluate((draw: boolean) => window.__setFrameStepping(true, draw), video);

  const apply = (frame: DeviceFrame, mode: string) => page.evaluate(({ frame, mode }) => {
    const device = window.IWER_DEVICE!;
    if (frame.switchInput) device.primaryInputMode = (device.primaryInputMode === 'hand' ? 'controller' : 'hand');
    void mode;
    device.position.set(...frame.head);
    device.quaternion.set(0, 0, 0, 1);
    for (const side of ['left', 'right'] as const) {
      const pose = frame.hands[side];
      for (const [target, q] of [[device.hands[side], pose.quaternion], [device.controllers[side], pose.grip]] as const) {
        if (!target) continue;
        target.position.set(...pose.position);
        target.quaternion.set(...q);
        target.connected = frame.connected[side];
      }
    }
  }, { frame, mode });

  const path0 = [...devicePath()];
  // Hold the first pose until the height fit calibrates.
  for (let held = 0; ; held += STEP_MS) {
    await apply(path0[0]!, input);
    await page.clock.runFor(STEP_MS);
    const ready = await page.evaluate(() => JSON.parse(window.render_game_to_text()).heightAdaptation?.eyeHeight != null);
    if (ready && held > 400) break;
    if (held > 4000) throw new Error(`${label}: height fit did not calibrate`);
  }
  const widths = await page.evaluate(() => window.__sampleArmClearance().widths);
  const frameDir = path.join(artifactDir, 'video-frames', label);
  if (video) await mkdir(frameDir, { recursive: true });
  const samples: Array<Record<string, unknown>> = [];
  const frames: ArmFrame[] = [];
  for (let index = 0; index < path0.length; index += 1) {
    const frame = path0[index]!;
    if (only && !frame.segment.startsWith(only)) continue;
    await apply(frame, input);
    await page.clock.runFor(STEP_MS);
    const sample = await page.evaluate(() => {
      const tracking = JSON.parse(window.render_game_to_text()).tracking as Record<'left' | 'right', { poseValid: boolean; targetPosition: { x: number; y: number; z: number } }>;
      const target = (side: 'left' | 'right') => (tracking[side].poseValid ? [tracking[side].targetPosition.x, tracking[side].targetPosition.y, tracking[side].targetPosition.z] as [number, number, number] : null);
      return { body: window.__sampleBody(), hands: window.__sampleHands(), mode: window.IWER_DEVICE!.primaryInputMode, target: { left: target('left'), right: target('right') } };
    });
    const timeSec = index * STEP_SEC;
    const wrist: ArmFrame['wrist'] = {};
    for (const side of ['left', 'right'] as const) {
      const h = sample.hands[side];
      // The IK target (the tracked wrist, or the controller grip mapped to the wrist) is what the avatar wrist must reach.
      const target = sample.target[side] ?? h.tracked.wrist;
      wrist[side] = { source: h.source, ...(target ? { tracked: target } : {}), ...(h.avatar.wrist ? { avatar: h.avatar.wrist } : {}), ...(h.wristTwistDeg !== undefined ? { twistDeg: h.wristTwistDeg } : {}) };
    }
    frames.push({ timeSec, segment: frame.segment, bones: sample.body.bones, wrist });
    samples.push({ timeMs: timeSec * 1000, segment: frame.segment, body: sample.body, hands: sample.hands, mode: sample.mode });
    if (video) await page.screenshot({ path: path.join(frameDir, `${String(index).padStart(5, '0')}.png`) });
  }
  await context.close();
  const section: TorsoSection | null = widths?.torso ?? null;
  const motion = measureMotion(framesFromBodySamples(samples as never, 'avatar'));
  const report = { label, widths, overall: measureArms(frames, section), segments: measureArmsBySegment(frames, section), motion };
  await writeFile(path.join(artifactDir, `${label}-samples.json`), JSON.stringify(samples));
  await writeFile(path.join(artifactDir, `${label}-report.json`), JSON.stringify(report, null, 2));
  if (video) {
    const mp4 = path.join(artifactDir, `${label}.mp4`);
    spawnSync('ffmpeg', ['-loglevel', 'error', '-y', '-framerate', '30', '-i', path.join(frameDir, '%05d.png'), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '20', mp4], { stdio: 'inherit' });
    writeContactSheet(frameDir, path.join(artifactDir, `${label}-sheet.jpg`));
    console.log(`[arm-reach] video: ${mp4}`);
  }
  return report;
}

// Gates (docs/features/vr-arm-natural.md). The far forward and overhead
// targets lie 10% (hand) and about 20% (controller) past the avatar's full
// reach; their bars stop a regression, they do not ask for a stretch.
type Gate = { segment?: string; metric: keyof ArmMetrics; min?: number; max?: number };
const GATES: Record<'hand' | 'controller', Gate[]> = {
  hand: [
    { segment: 'forward', metric: 'wristErrorP95Cm', max: 1.5 },
    { segment: 'forward-far', metric: 'wristErrorP95Cm', max: 6.5 },
    { segment: 'overhead', metric: 'wristErrorP95Cm', max: 6.5 }
  ],
  controller: [
    { segment: 'forward', metric: 'wristErrorP95Cm', max: 1.5 },
    { segment: 'forward-far', metric: 'wristErrorP95Cm', max: 13 },
    { segment: 'overhead', metric: 'wristErrorP95Cm', max: 13 }
  ]
};
const SHARED_GATES: Gate[] = [
  // Elbows hang down and a little out (B-073).
  ...['rest', 'stand', 'walk'].map((segment) => ({ segment, metric: 'swivelMedianDeg' as const, min: 0, max: 70 })),
  { segment: 'side-low', metric: 'swivelMedianDeg', min: -90, max: 90 },
  { metric: 'elbowFlipsPerMin', max: 0.5 },
  // A human clavicle range (B-074).
  { metric: 'clavicleElevRangeDeg', max: 30 },
  { metric: 'claviclePushRangeDeg', max: 45 },
  { metric: 'clavicleMaxStepDeg', max: 8 },
  // No visible stretch (B-075).
  { metric: 'armLengthSpreadPct', max: 2.5 }
];
const SEGMENT_CLAVICLE_MAX_DEG = 30;

function judge(report: Awaited<ReturnType<typeof run>>): string[] {
  const misses: string[] = [];
  const check = (where: string, metrics: ArmMetrics | undefined, gate: Gate) => {
    const value = metrics?.[gate.metric];
    if (typeof value !== 'number') return misses.push(`${where} ${gate.metric}: not measured`);
    if ((gate.min !== undefined && value < gate.min) || (gate.max !== undefined && value > gate.max)) misses.push(`${where} ${gate.metric}: ${value.toFixed(1)} (bar ${gate.min ?? '-∞'}..${gate.max ?? '∞'})`);
  };
  for (const gate of [...SHARED_GATES, ...GATES[report.label as 'hand' | 'controller']]) {
    if (gate.segment && only && !gate.segment.startsWith(only)) continue;
    check(gate.segment ?? 'overall', gate.segment ? report.segments[gate.segment] : report.overall, gate);
  }
  for (const [name, m] of Object.entries(report.segments)) {
    for (const metric of ['clavicleElevRangeDeg', 'claviclePushRangeDeg'] as const) check(name, m, { metric, max: SEGMENT_CLAVICLE_MAX_DEG });
  }
  return misses;
}

const fmt = (v: number | null) => (v === null ? '  -  ' : Math.abs(v) >= 100 ? v.toFixed(0) : v.toFixed(1));
await mkdir(artifactDir, { recursive: true });
const browser = await launchXrBrowser(chromium);
const consoleErrors: string[] = [];
const misses: string[] = [];
try {
  for (const input of inputs) {
    const report = await run(browser, input, consoleErrors);
    misses.push(...judge(report).map((miss) => `${report.label} ${miss}`));
    console.log(`\n[arm-reach] ${report.label}: wristP95 ${fmt(report.overall.wristErrorP95Cm)} cm, flips/min ${fmt(report.overall.elbowFlipsPerMin)}, torso min ${fmt(report.overall.elbowTorsoMinCm)} cm, length spread ${fmt(report.overall.armLengthSpreadPct)}%, pops ${JSON.stringify((report.motion as Record<string, unknown>).popsPerMin ?? null)}`);
    console.log('segment       wristP95 wristMax swivelMed up%  in%  flips maxStep torsoMin foreMin clavElev clavPush clavStep twistP95 snapMax stepMax');
    for (const [name, m] of Object.entries(report.segments)) {
      console.log(`${name.padEnd(13)} ${fmt(m.wristErrorP95Cm).padStart(8)} ${fmt(m.wristErrorMaxCm).padStart(8)} ${fmt(m.swivelMedianDeg).padStart(9)} ${fmt(m.elbowUpShare === null ? null : m.elbowUpShare * 100).padStart(4)} ${fmt(m.elbowInShare === null ? null : m.elbowInShare * 100).padStart(4)} ${String(m.elbowFlips).padStart(5)} ${fmt(m.swivelMaxStepDeg).padStart(7)} ${fmt(m.elbowTorsoMinCm).padStart(8)} ${fmt(m.forearmTorsoMinCm).padStart(7)} ${fmt(m.clavicleElevRangeDeg).padStart(8)} ${fmt(m.claviclePushRangeDeg).padStart(8)} ${fmt(m.clavicleMaxStepDeg).padStart(8)} ${fmt(m.twistP95Deg).padStart(8)} ${fmt(m.wristSnapMaxCm).padStart(7)} ${fmt(m.wristStepMaxCm).padStart(7)}`);
    }
  }
  if (consoleErrors.length) console.log(`console errors:\n${consoleErrors.join('\n')}`);
} finally {
  await browser.close();
}
if (misses.length) throw new Error(`Arm reach gates failed:\n- ${misses.join('\n- ')}`);
console.log('[arm-reach] all gates passed');
