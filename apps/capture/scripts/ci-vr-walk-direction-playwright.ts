import { execFileSync } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';

import {
  attachXrEnvironment,
  createXrContext,
  enterIwerSessionFromButton,
  freezePageClock,
  launchXrBrowser,
  waitForIwerRuntime,
  waitForPageFunctions,
  waitForTextContentPrefix,
  waitForXrRenderLoop,
  wireXrConsoleErrors
} from '@holoim/tooling-testing/xr-env';

import type {} from '../src/runtime/automationHooks';
import type { BodySample } from '../src/types/contracts';

// The VR legs step where the body goes (B-078, B-079) and the body eases into a walk (B-077). Two walks run through
// the real WebXR path on a frozen 30 Hz page clock: a room-scale head walk (the IWER headset moves at 1.2 m/s) and a
// full thumbstick walk. Each walks forward, left, back, right, front-right and back-left, facing -Z, with a stop between.
// Per direction the check requires:
// - every step to land along the travel (the procedural steps sideways and backward, the recorded walk within 45°
//   of facing only: docs/features/archive/vr-recorded-walk.md, decision 4);
// - the pelvis to stay over the feet (hips against the ankles' midpoint);
// - the torso to keep its standing posture (a stick walk once moved the root twice and leaned the spine back);
// - for the head walk, the hips' horizontal acceleration over the walk start to stay near the head's own.
// The head moves on every XR frame, and each sample carries the time of the frame it was solved at.
// WALK_DIRECTION_VIDEO=1 also films each walk from the side and the front (H.264 MP4 in the artifact directory).

const FRAME_MS = 1000 / 30;
const baseUrl = process.env.BASE_URL ?? 'https://127.0.0.1:5174/';
const artifactDir = process.env.XR_TEST_ARTIFACT_DIR ?? 'output/ci-walk-direction';
const video = process.env.WALK_DIRECTION_VIDEO === '1';
const S = Math.SQRT1_2;

// Limits. A forward walk carries the pelvis about 12 cm ahead of the feet midpoint, as on desktop.
const MAX_STEP_ANGLE_MEAN_DEG = 15;
const MAX_STEP_ANGLE_DEG = 30;
const MIN_STEPS = 2;
const MAX_PELVIS_AHEAD_M = 0.3;
const MAX_PELVIS_ASIDE_M = 0.2;
const MAX_POSTURE_CHANGE_M = 0.02;
// The head walk's start eases the body in: the hips' horizontal acceleration stays under this (m/s², B-077; the head
// itself reaches 4).
const MAX_START_ACCEL_MS2 = 10;
const START_WINDOW_SAMPLES = 30;

// Directions in the user's frame: x right, z back (the head faces -Z). `recorded`: the recorded walk plays.
const DIRECTIONS = [
  { label: 'forward', x: 0, z: -1, recorded: true },
  { label: 'left', x: -1, z: 0, recorded: false },
  { label: 'back', x: 0, z: 1, recorded: false },
  { label: 'right', x: 1, z: 0, recorded: false },
  { label: 'diag-fr', x: S, z: -S, recorded: true },
  { label: 'diag-bl', x: -S, z: S, recorded: false }
] as const;
type Direction = (typeof DIRECTIONS)[number];
type Phase = { label: string; sec: number; dir: Direction | null };
const phasesFor = (moveSec: number): Phase[] => [
  { label: 'idle', sec: 1, dir: null },
  ...DIRECTIONS.flatMap((dir) => [{ label: dir.label, sec: moveSec, dir }, { label: 'stop', sec: 1.5, dir: null }])
];
const WALKS = [
  { name: 'head', speed: 1.2, bob: 0.02, phases: phasesFor(3) },
  { name: 'stick', speed: 0, bob: 0, phases: phasesFor(2.5) }
] as const;
type Walk = (typeof WALKS)[number];
type Sample = { phase: string; body: BodySample; t: number };

declare global {
  interface Window {
    __walkHead?: () => void;
    __lastFrameMs?: number;
    __walkPhase?: string | undefined;
  }
}

async function walk(spec: Walk, view: 'side' | 'front' | null): Promise<{ samples: Sample[]; errors: string[] }> {
  const browser = await launchXrBrowser(chromium);
  try {
    const context = await createXrContext(browser, { viewport: view ? { width: 1280, height: 720 } : { width: 960, height: 720 } });
    const page = await context.newPage();
    const errors: string[] = [];
    wireXrConsoleErrors(page, errors, { label: spec.name });
    await attachXrEnvironment(page, { mode: 'iwer', cacheClearState: true });
    // tsx compiles with keepNames, which wraps named inner functions of the page.evaluate callbacks in an __name helper the page lacks.
    await page.addInitScript('globalThis.__name = (target) => target;');
    const url = new URL(baseUrl);
    url.searchParams.set('scene', '/fixtures/scenes/body-floor.gltf');
    url.searchParams.set('sceneScale', '1');
    url.searchParams.set('manualClock', '1');
    url.searchParams.set('avatarHeight', '1.8');
    await page.goto(url.href, { waitUntil: 'networkidle' });
    await waitForPageFunctions(page, ['__setManualClock', '__setFrameStepping', '__sampleBody', '__setSpectatorView', '__respawnCharacter']);
    await waitForTextContentPrefix(page, '#status', 'loaded');
    await page.evaluate((draw) => {
      window.__setManualClock(true, draw);
      window.__respawnCharacter();
    }, !!view);
    await waitForIwerRuntime(page);
    // A programmatic headset moves where the script sets it.
    if (spec.name === 'head') await page.evaluate(() => { window.IWER_DEVICE!.controlMode = 'programmatic' as never; });
    await enterIwerSessionFromButton(page, '#VRButton', { readyCheck: () => JSON.parse(window.render_game_to_text()).mode === 'vr' });
    if (view) {
      await page.evaluate((side) => {
        // 0 films the face, a quarter turn the left side.
        window.__setSpectatorView('body', { yawOffset: side ? Math.PI / 2 : 0 });
        const devui = window.IWER_DEVICE!.devui;
        for (const element of [devui?.devUIContainer, devui?.devUICanvas, document.getElementById('ui-root'), document.getElementById('VRButton'), document.getElementById('ARButton')]) {
          if (element instanceof HTMLElement) element.style.display = 'none';
        }
      }, view === 'side');
    }
    await freezePageClock(page);
    // The frozen clock replaces requestAnimationFrame, so wrap its fake. Before the first animation-frame callback of
    // each frame (IWER's device frame among them), move the head and note the frame's time: each body sample then
    // carries the sim time it was solved at.
    await page.evaluate(() => {
      const raf = window.requestAnimationFrame.bind(window);
      let last = -1;
      window.requestAnimationFrame = (callback) => raf((time) => {
        if (time !== last) {
          last = time;
          window.__walkHead?.();
          window.__lastFrameMs = performance.now();
        }
        callback(time);
      });
    });
    await waitForXrRenderLoop(page);
    await page.evaluate((draw) => window.__setFrameStepping(true, draw), !!view);
    const tick = () => page.clock.runFor(FRAME_MS);
    // Settle on the floor before the walk.
    for (let i = 0; i < 90; i++) await tick();
    const start = await page.evaluate(() => { const p = window.IWER_DEVICE!.position; return [p.x, p.y, p.z] as [number, number, number]; });
    const frameDir = path.join(artifactDir, `${spec.name}-${view}-frames`);
    if (view) {
      await rm(frameDir, { recursive: true, force: true });
      await mkdir(frameDir, { recursive: true });
    }
    if (spec.name === 'head') {
      // The head path runs in the page, once per XR frame, from the page clock: one move per 33 ms sample would hold
      // 2 or 3 frames, and a body that moves per frame would read the bursts as jerks.
      await page.evaluate(({ phases, speed, bob, start }) => {
        const ease = 0.3;
        let at = performance.now();
        const t0 = at;
        let walked = 0;
        const head = [...start];
        window.__walkHead = () => {
          const now = performance.now();
          let t = (at - t0) / 1000;
          const dt = (now - at) / 1000;
          at = now;
          let phase = null;
          for (const p of phases) {
            if (t < p.sec) { phase = p; break; }
            t -= p.sec;
          }
          window.__walkPhase = phase?.label;
          if (!phase?.dir) return;
          // Ease in and out over 0.3 s, as a walker starts and stops; the head bobs about 2 cm twice a stride.
          const ramp = Math.max(0, Math.min(1, (t + dt) / ease, (phase.sec - t) / ease));
          const stepM = speed * ramp * dt;
          head[0]! += phase.dir.x * stepM;
          head[2]! += phase.dir.z * stepM;
          walked += stepM;
          const y = start[1]! - bob * ramp * 0.5 * (1 - Math.cos((walked / (speed / 1.9)) * Math.PI * 2));
          window.IWER_DEVICE!.position.set(head[0]!, y, head[2]!);
        };
      }, { phases: spec.phases as unknown as Phase[], speed: spec.speed, bob: spec.bob, start });
    }
    const samples: Sample[] = [];
    let frame = 0;
    for (const phase of spec.phases) {
      if (spec.name === 'stick') {
        await page.evaluate(({ x, y }) => { window.IWER_DEVICE!.controllers.left!.updateAxes('thumbstick', x, y); }, { x: phase.dir?.x ?? 0, y: phase.dir?.z ?? 0 });
      }
      const frames = Math.round((phase.sec * 1000) / FRAME_MS);
      for (let i = 0; i < frames; i++) {
        // A screenshot waits for a composited frame, and a frozen clock draws none: take it while this frame runs.
        if (view) await Promise.all([page.screenshot({ path: path.join(frameDir, `${String(frame).padStart(5, '0')}.png`), timeout: 180_000 }), tick()]);
        else await tick();
        // The head walk's phase comes from the page's head path, which runs on the frames' own times.
        const sample = await page.evaluate(() => ({ body: window.__sampleBody(), t: window.__lastFrameMs ?? 0, phase: window.__walkPhase }));
        samples.push({ ...sample, phase: sample.phase ?? phase.label });
        frame++;
      }
    }
    if (view) {
      const mp4 = path.join(artifactDir, `${spec.name}-${view}.mp4`);
      execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-framerate', '30', '-i', path.join(frameDir, '%05d.png'), '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', mp4]);
      await rm(frameDir, { recursive: true, force: true });
      console.log(`[walk-direction] video ${mp4}`);
    }
    return { samples, errors };
  } finally {
    await browser.close();
  }
}

const deg = (radians: number) => (radians * 180) / Math.PI;
const wrap = (radians: number) => Math.atan2(Math.sin(radians), Math.cos(radians));

/** Neck over hips in the body's own frame (forward, right), in metres: the torso's posture. */
function posture(body: BodySample): [number, number] {
  const { hips, neck } = body.bones;
  const yaw = body.solver.bodyYaw;
  const dx = neck![0] - hips![0];
  const dz = neck![2] - hips![2];
  return [-dx * Math.sin(yaw) - dz * Math.cos(yaw), dx * Math.cos(yaw) - dz * Math.sin(yaw)];
}

function measure(samples: Sample[]) {
  const idle = samples.filter((s) => s.phase === 'idle').slice(10).map((s) => posture(s.body));
  const idlePosture = [0, 1].map((k) => idle.reduce((sum, p) => sum + p[k]!, 0) / idle.length);
  const rows: Record<string, Record<string, number>> = {};
  for (const dir of DIRECTIONS) {
    const phase = samples.filter((s) => s.phase === dir.label);
    // The steady part skips the first 0.6 s; steps count from 0.3 s in.
    const steady = phase.slice(18);
    const first = steady[0]!.body;
    const last = steady.at(-1)!.body;
    const travel = [last.root[0] - first.root[0], last.root[2] - first.root[2]] as const;
    const travelLength = Math.hypot(travel[0], travel[1]) || 1;
    const travelYaw = Math.atan2(travel[0], travel[1]);
    // Each ankle's move from lift-off to landing, against the travel.
    const angles: number[] = [];
    let along = 0;
    const window_ = phase.slice(9);
    for (const side of ['left', 'right'] as const) {
      const key = `${side}Ankle`;
      let from: number[] | null = null;
      for (let k = 1; k < window_.length; k++) {
        const now = window_[k]!.body;
        const before = window_[k - 1]!.body;
        if (now.solver.swinging[side] && !before.solver.swinging[side]) from = before.bones[key]!;
        else if (!now.solver.swinging[side] && before.solver.swinging[side] && from) {
          const to = now.bones[key]!;
          const d = [to[0] - from[0]!, to[2] - from[2]!] as const;
          from = null;
          if (Math.hypot(d[0], d[1]) < 0.08) continue;
          const a = (d[0] * travel[0] + d[1] * travel[1]) / travelLength;
          const c = (d[0] * travel[1] - d[1] * travel[0]) / travelLength;
          angles.push(Math.abs(deg(Math.atan2(c, a))));
          along += a;
        }
      }
    }
    let ahead = 0;
    let aside = 0;
    let postureChange = 0;
    for (const { body } of steady) {
      const { hips, leftAnkle, rightAnkle } = body.bones;
      const dx = hips![0] - (leftAnkle![0] + rightAnkle![0]) / 2;
      const dz = hips![2] - (leftAnkle![2] + rightAnkle![2]) / 2;
      ahead += dx * Math.sin(travelYaw) + dz * Math.cos(travelYaw);
      aside += dx * Math.cos(travelYaw) - dz * Math.sin(travelYaw);
      const p = posture(body);
      postureChange += Math.hypot(p[0] - idlePosture[0]!, p[1] - idlePosture[1]!);
    }
    const n = steady.length;
    // The hips' horizontal world acceleration over the walk start, from the frame times the samples were solved at.
    // The vertical bob is left out: it is the gait's, through the whole walk.
    let startAccel = 0;
    const start = samples.slice(samples.indexOf(phase[0]!) - 3, samples.indexOf(phase[0]!) + START_WINDOW_SAMPLES);
    for (let k = 2; k < start.length; k++) {
      const [a, b, c] = [start[k - 2]!, start[k - 1]!, start[k]!];
      const t1 = (b.t - a.t) / 1000;
      const t2 = (c.t - b.t) / 1000;
      if (t1 <= 0 || t2 <= 0) continue;
      const accel = [0, 2].map((i) => ((c.body.bones.hips![i]! - b.body.bones.hips![i]!) / t2 - (b.body.bones.hips![i]! - a.body.bones.hips![i]!) / t1) / ((t1 + t2) / 2));
      startAccel = Math.max(startAccel, Math.hypot(accel[0]!, accel[1]!));
    }
    const recorded = (phase.at(-1)!.body.solver.recordedSteps ?? 0) - (phase[0]!.body.solver.recordedSteps ?? 0);
    rows[dir.label] = {
      speedMS: travelLength / (((n - 1) * FRAME_MS) / 1000),
      travelVsFacingDeg: deg(wrap(travelYaw - (last.solver.bodyYaw + Math.PI))),
      steps: angles.length,
      recordedSteps: recorded,
      stepAngleMeanDeg: angles.length ? angles.reduce((sum, a) => sum + a, 0) / angles.length : NaN,
      stepAngleMaxDeg: Math.max(0, ...angles),
      stepAlongMeanM: angles.length ? along / angles.length : 0,
      pelvisAheadM: ahead / n,
      pelvisAsideM: aside / n,
      postureChangeM: postureChange / n,
      startAccelMS2: startAccel
    };
  }
  return rows;
}

function judge(name: string, rows: ReturnType<typeof measure>): string[] {
  const failures: string[] = [];
  for (const dir of DIRECTIONS) {
    const r = rows[dir.label]!;
    const at = `${name} ${dir.label}`;
    if (r.steps! < MIN_STEPS) failures.push(`${at}: ${r.steps} steps (at least ${MIN_STEPS})`);
    if (!(r.stepAngleMeanDeg! <= MAX_STEP_ANGLE_MEAN_DEG)) failures.push(`${at}: steps ${r.stepAngleMeanDeg!.toFixed(1)}° from the travel on average (at most ${MAX_STEP_ANGLE_MEAN_DEG}°)`);
    if (r.stepAngleMaxDeg! > MAX_STEP_ANGLE_DEG) failures.push(`${at}: a step ${r.stepAngleMaxDeg!.toFixed(1)}° from the travel (at most ${MAX_STEP_ANGLE_DEG}°)`);
    if (!(r.stepAlongMeanM! > 0)) failures.push(`${at}: the steps do not go along the travel`);
    if (Math.abs(r.pelvisAheadM!) > MAX_PELVIS_AHEAD_M) failures.push(`${at}: pelvis ${(r.pelvisAheadM! * 100).toFixed(1)} cm ahead of the feet (at most ${MAX_PELVIS_AHEAD_M * 100} cm)`);
    if (Math.abs(r.pelvisAsideM!) > MAX_PELVIS_ASIDE_M) failures.push(`${at}: pelvis ${(r.pelvisAsideM! * 100).toFixed(1)} cm beside the feet (at most ${MAX_PELVIS_ASIDE_M * 100} cm)`);
    if (r.postureChangeM! > MAX_POSTURE_CHANGE_M) failures.push(`${at}: torso ${(r.postureChangeM! * 100).toFixed(1)} cm from its standing posture (at most ${MAX_POSTURE_CHANGE_M * 100} cm)`);
    // The stick moves the view at full speed at once (no VR stick acceleration: a comfort choice), so only the head walk eases in.
    if (name === 'head' && r.startAccelMS2! > MAX_START_ACCEL_MS2) failures.push(`${at}: hips ${r.startAccelMS2!.toFixed(1)} m/s² at the walk start (at most ${MAX_START_ACCEL_MS2})`);
    if (dir.recorded !== r.recordedSteps! > 0) failures.push(`${at}: ${r.recordedSteps} recorded steps (${dir.recorded ? 'the recorded walk should play' : 'procedural steps only'})`);
  }
  return failures;
}

await mkdir(artifactDir, { recursive: true });
const report: Record<string, unknown> = {};
const failures: string[] = [];
// The two walks run at once: each page has its own frozen clock, so results do not change.
const results = await Promise.all(WALKS.map(async (spec) => ({ spec, ...(await walk(spec, null)) })));
for (const { spec, samples, errors } of results) {
  const rows = measure(samples);
  report[spec.name] = rows;
  await writeFile(path.join(artifactDir, `${spec.name}-samples.json`), JSON.stringify(samples));
  for (const [label, r] of Object.entries(rows)) {
    console.log(`[walk-direction] ${spec.name} ${label.padEnd(8)} ${r.speedMS!.toFixed(2)} m/s, ${r.steps} steps (${r.recordedSteps} recorded), step angle mean ${r.stepAngleMeanDeg!.toFixed(1)}° max ${r.stepAngleMaxDeg!.toFixed(1)}°, pelvis ahead ${(r.pelvisAheadM! * 100).toFixed(1)} cm aside ${(r.pelvisAsideM! * 100).toFixed(1)} cm, posture ${(r.postureChangeM! * 100).toFixed(1)} cm, start ${r.startAccelMS2!.toFixed(1)} m/s²`);
  }
  failures.push(...judge(spec.name, rows), ...errors.map((error) => `${spec.name}: console error ${error}`));
}
await writeFile(path.join(artifactDir, 'walk-direction-report.json'), JSON.stringify({ report, failures }, null, 2));
if (video) {
  for (const spec of WALKS) for (const view of ['side', 'front'] as const) await walk(spec, view);
}
if (failures.length) {
  console.error(`VR walk direction check failed:\n${failures.map((failure) => `  - ${failure}`).join('\n')}`);
  process.exit(1);
}
console.log('VR walk direction check passed.');
