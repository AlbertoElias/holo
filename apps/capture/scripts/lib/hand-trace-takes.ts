import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Browser, Page } from 'playwright';

import type { HaloDirection } from '@holoim/xr-ui-core';

import type { TracesSnapshot } from '../../src/runtime/automationHooks';
import type { LiveTraceProbe } from '../../src/ui/LiveTrace';
import { HALO_PINCH_STAGES, haloDrag, installMiddlePinchPose } from './iwer-halo.ts';
import { installHandBlend } from './iwer-hand-blend.ts';
// @ts-expect-error untyped helper modules shared with the object and summon checks
import { clickButton, openCapture, saveDownload, setupPage } from './object-take.mjs';
// @ts-expect-error untyped helper module shared with the summon check
import { enterIwer, stepper } from './summon-take.mjs';

// Scripted IWER headset takes for hand traces (PRD-023), recorded and
// exported by capture's own recorder on a manual clock: both hands in IWER's
// pointing pose, moved by setting `IWER_DEVICE.hands.*.position` each step.
// Every step also reads the tracked index fingertip back (the ground truth a
// trace is judged against) and the phase the script is in.
//
//   authored (PRD-023 v1, docs/features/authored-traces.md): the author marks
//     traces with the hands Halo's Ink (NW), summoned by the right (dominant)
//     hand's thumb–middle pinch and drag: Ink on, a 30 cm circle with the
//     right index at mid-reach, Ink off; an untraced 15 cm figure-eight with
//     the left; Ink on, a left circle with the right resting, Ink off; Ink on,
//     a short right line, Ink off, Undo (W), Redo (E); Ink on, another line,
//     Undo while tracing; Ink on, a short left line, and the Halo's S stops
//     the take. The right hand takes the pinch pose only for each summon.
//     Capture's status line, live trace and trace store are read as it goes.
//   shapes (v0, no Ink): still, a 30 cm circle with the right index, still, a
//     30 cm figure-eight with the left, still, then a circle drawn while
//     leaning in and crouching.
//   travel: a circle drawn while walking 1.6 m, a circle through a teleport
//     (capture's respawn: the character jumps back to its spawn in one step;
//     a headset that jumps is re-origined by capture and never moves the
//     avatar, see HEAD_TRACKING_JUMP_METERS), a circle through a snap turn
//     (the thumbstick), and a circle across a second of controllers between
//     hands. Ink is toggled around each circle through `__runHaloAction`.

/** 60 Hz, as capture's summon and object takes step. */
const STEP_SEC = 1 / 60;
export const CIRCLE_RADIUS = 0.15;
export const EIGHT_HALF_WIDTH = 0.15;
const HEAD = [0, 1.6, 0] as const;
const REST = { left: [-0.2, 1.25, -0.38], right: [0.2, 1.25, -0.38] } as const;
/** Where the right hand pinches to summon the Halo (held-mark-takes' origin). */
const SUMMON_ORIGIN = [0.18, 1.3, -0.4] as const;
/** The right hand's travel to and from the summon origin: inside capture's 0.4 s settle. */
const SUMMON_TRAVEL_SEC = 0.3;

export type HandTraceScenario = 'authored' | 'shapes' | 'travel';
type Side = 'left' | 'right';
type Vec3 = [number, number, number];

export type Phase = { name: string; start: number; end: number };
export type GroundTruthSample = {
  /** Seconds since the step after Start Recording (capture's first frame within a step or two). */
  t: number;
  /** Capture's simulation clock after this step (trace, hold and frame times are on it; it runs a little ahead of the script). */
  sim: number;
  phase: string;
  left: Vec3 | null;
  right: Vec3 | null;
  source: { left: string; right: string };
};

/** A Halo the script summoned with the right hand: script seconds of its press (the pinch closing) and its release (the commit). */
export type ScriptedSummon = { name: string; direction: HaloDirection; action: string; press: number; release: number; pressStep: number; releaseStep: number; pressSim: number; releaseSim: number };

/** A scripted `__runHaloAction` toggle, script seconds. */
export type HookToggle = { t: number; sim: number; action: 'ink'; done: boolean };

/** What capture showed at a step of the authored take. */
export type ChromeSample = {
  t: number;
  sim: number;
  status: string | null;
  tracingElapsedMs: number | null;
  notice: string | null;
  live: LiveTraceProbe;
  traces: TracesSnapshot;
  haloOpen: boolean;
};

export type HandTraceTake = {
  scenario: HandTraceScenario;
  glb: string;
  phases: Phase[];
  /** When the one-step events happened, seconds as in `groundTruth`. */
  events: Array<{ name: 'teleport' | 'snap-turn'; t: number }>;
  groundTruth: GroundTruthSample[];
  locomotion: { snapCount: number; rigYaw: number } | null;
  /** Authored: the Halo summons, in order. */
  summons: ScriptedSummon[];
  /** Travel: the Ink toggles run through the automation hook. */
  toggles: HookToggle[];
  /** Authored: capture's chrome every sixth step and at every summon's press and release. */
  chrome: ChromeSample[];
  /** The trace store and the Halo action log right before the take stopped, and after. */
  final: {
    /** The trace store with every trace ended: authored, read right after the Halo's S; else after the last step. */
    kept: TracesSnapshot | null;
    afterStop: TracesSnapshot | null;
    liveAfterStop: LiveTraceProbe | null;
    actions: Array<{ input: string; action: string; done: boolean }>;
    /** Authored: Ink committed with no take recording, and what the status line said. */
    inkWhileStopped: { done: boolean; notice: string | null } | null;
    /** Authored: half a second into the next take. */
    nextTake: { open: TracesSnapshot['open']; tracingElapsedMs: number | null; status: string | null } | null;
  };
  /** Thumb–index gap of the middle-pinch pose, metres (the index must stay clear for the pinch to summon). */
  pinchGaps: Record<Side, { middle: number; index: number }> | null;
  /** Headset-view frames drawn during the take. */
  screenshots: string[];
};

type Pose = {
  head: readonly number[];
  left: readonly number[];
  right: readonly number[];
  /** The right hand's IWER pose: pointing, or the thumb–middle pinch that summons the Halo. */
  rightPose?: 'point' | 'middlePinch';
  input?: 'hand' | 'controller';
  turn?: number;
  respawn?: boolean;
};

type Script = {
  phases: Phase[];
  duration: number;
  pose: (t: number) => Pose;
  events: Array<{ name: 'teleport' | 'snap-turn'; t: number }>;
  summons: Array<Omit<ScriptedSummon, 'pressStep' | 'releaseStep' | 'pressSim' | 'releaseSim'>>;
  toggles: Array<{ t: number; action: 'ink' }>;
  /** Script seconds of the headset-view screenshots. */
  shots: Array<{ t: number; name: string }>;
};

const add = (a: readonly number[], b: readonly number[]) => a.map((v, i) => v + b[i]!);
const lerp = (a: readonly number[], b: readonly number[], k: number) => a.map((v, i) => v + (b[i]! - v) * k);
const smooth = (t: number) => t * t * (3 - 2 * t);
const within = (t: number, start: number, end: number) => Math.min(1, Math.max(0, (t - start) / (end - start)));
const circle = (u: number, mirror = 1) => [mirror * CIRCLE_RADIUS * (Math.cos(2 * Math.PI * u) - 1), CIRCLE_RADIUS * Math.sin(2 * Math.PI * u), 0];
const eight = (u: number) => {
  const a = 2 * Math.PI * u;
  return [EIGHT_HALF_WIDTH * Math.sin(a), EIGHT_HALF_WIDTH * Math.sin(a) * Math.cos(a), 0];
};

/**
 * The authored take as segments on a cursor: each sets both hands over its
 * stretch; a summon moves the right hand to the summon origin, pinches,
 * drags toward its direction, releases and travels to where the next
 * segment starts.
 */
function authoredScript(): Script {
  type Segment = { name: string; start: number; end: number; left: (u: number) => readonly number[]; right: (u: number) => readonly number[]; rightPose?: (t: number) => Pose['rightPose'] };
  const segments: Segment[] = [];
  const summons: Script['summons'] = [];
  const shots: Script['shots'] = [];
  let cursor = 0;
  let left: readonly number[] = REST.left;
  let right: readonly number[] = REST.right;
  const push = (name: string, sec: number, leftAt: (u: number) => readonly number[], rightAt: (u: number) => readonly number[], rightPose?: Segment['rightPose']) => {
    segments.push({ name, start: cursor, end: cursor + sec, left: leftAt, right: rightAt, ...(rightPose ? { rightPose } : {}) });
    cursor += sec;
    left = leftAt(1);
    right = rightAt(1);
  };
  const hold = (name: string, sec: number) => {
    const l = left;
    const r = right;
    push(name, sec, () => l, () => r);
  };
  const summon = (name: string, direction: HaloDirection, action: string, back: readonly number[] = REST.right) => {
    const l = left;
    const from = right;
    push(`${name}-approach`, SUMMON_TRAVEL_SEC, () => l, (u) => lerp(from, SUMMON_ORIGIN, smooth(u)));
    const { dx, dy } = haloDrag(direction);
    const press = cursor;
    for (const [i, stage] of HALO_PINCH_STAGES.entries()) {
      push(`${name}-pinch-${i}`, stage.sec, () => l, (u) => add(SUMMON_ORIGIN, [dx * stage.drag(u), dy * stage.drag(u), 0]), () => 'middlePinch');
    }
    const release = cursor;
    summons.push({ name, direction, action, press, release });
    const at = right;
    push(`${name}-return`, SUMMON_TRAVEL_SEC, () => l, (u) => lerp(at, back, smooth(u)));
  };
  const move = (name: string, sec: number, side: Side, path: (u: number) => readonly number[]) => {
    const l = left;
    const r = right;
    if (side === 'right') push(name, sec, () => l, (u) => add(r, path(smooth(u))));
    else push(name, sec, (u) => add(l, path(smooth(u))), () => r);
  };

  hold('still', 0.6);
  summon('ink-on-1', 'nw', 'ink');
  hold('rest-1', 0.2);
  shots.push({ t: cursor + 1.2, name: 'live-right-circle' });
  move('right-circle', 2, 'right', (u) => circle(u));
  hold('rest-2', 0.2);
  summon('ink-off-1', 'nw', 'ink');
  move('figure-eight', 2.5, 'left', (u) => eight(u));
  shots.push({ t: cursor - 1.0, name: 'untraced-figure-eight' });
  hold('rest-3', 0.3);
  summon('ink-on-2', 'nw', 'ink');
  hold('rest-4', 0.2);
  shots.push({ t: cursor + 1.2, name: 'live-left-circle' });
  move('left-circle', 2, 'left', (u) => circle(u, -1));
  hold('rest-5', 0.2);
  summon('ink-off-2', 'nw', 'ink');
  hold('rest-6', 0.3);
  summon('ink-on-3', 'nw', 'ink');
  hold('rest-7', 0.15);
  move('right-line-1', 0.6, 'right', (u) => [0, 0.12 * u, 0]);
  hold('rest-8', 0.15);
  summon('ink-off-3', 'nw', 'ink');
  hold('rest-9', 0.3);
  summon('undo', 'w', 'undo');
  hold('rest-10', 0.3);
  summon('redo', 'e', 'redo');
  hold('rest-11', 0.3);
  summon('ink-on-4', 'nw', 'ink');
  hold('rest-12', 0.15);
  move('right-line-2', 0.6, 'right', (u) => [0, -0.12 * u, 0]);
  hold('rest-13', 0.15);
  summon('undo-while-tracing', 'w', 'undo');
  hold('rest-14', 0.3);
  summon('ink-on-5', 'nw', 'ink');
  hold('rest-15', 0.2);
  move('left-line', 0.8, 'left', (u) => [0.15 * u, 0, 0]);
  hold('rest-16', 0.2);
  summon('stop', 's', 'record');

  const duration = cursor;
  const phases: Phase[] = segments.map(({ name, start, end }) => ({ name, start, end }));
  return {
    phases,
    duration,
    events: [],
    summons,
    toggles: [],
    shots,
    pose: (t) => {
      const segment = segments.find((s) => t < s.end - 1e-9) ?? segments.at(-1)!;
      const u = within(t, segment.start, segment.end);
      return { head: HEAD, left: segment.left(u), right: segment.right(u), rightPose: segment.rightPose?.(t) ?? 'point' };
    }
  };
}

/** The script: phases and the pose at each time. */
function script(scenario: HandTraceScenario): Script {
  if (scenario === 'authored') return authoredScript();
  if (scenario === 'shapes') {
    const phases: Phase[] = [
      { name: 'still', start: 0, end: 1 },
      { name: 'circle', start: 1, end: 3 },
      { name: 'still-after-circle', start: 3, end: 4 },
      { name: 'figure-eight', start: 4, end: 6.5 },
      { name: 'still-after-eight', start: 6.5, end: 7.5 },
      { name: 'lean-crouch-circle', start: 7.5, end: 9.5 },
      { name: 'still-crouched', start: 9.5, end: 10.5 }
    ];
    return {
      phases,
      duration: 10.5,
      events: [],
      summons: [],
      toggles: [],
      shots: [],
      pose: (t) => {
        // Leaning 20 cm in and crouching 30 cm over the last circle; the hands go with the head.
        const body = [0, -0.3 * smooth(within(t, 7.5, 9.5)), -0.2 * smooth(within(t, 7.5, 9.5))];
        const right = t < 7.5 ? circle(within(t, 1, 3)) : circle(within(t, 7.5, 9.5));
        return {
          head: add(HEAD, body),
          right: add(add(REST.right, body), right),
          left: add(add(REST.left, body), eight(within(t, 4, 6.5)))
        };
      }
    };
  }
  const phases: Phase[] = [
    { name: 'still', start: 0, end: 1 },
    { name: 'walk-circle', start: 1, end: 3 },
    { name: 'still-after-walk', start: 3, end: 4 },
    { name: 'teleport-circle', start: 4, end: 6 },
    { name: 'still-after-teleport', start: 6, end: 7 },
    { name: 'snap-circle', start: 7, end: 9 },
    { name: 'still-after-snap', start: 9, end: 9.2 },
    // One circle across the controller second: hands, controllers, hands again.
    { name: 'hands-before-controllers', start: 9.2, end: 9.5 },
    { name: 'controllers', start: 9.5, end: 10.5 },
    { name: 'hands-again', start: 10.5, end: 11.5 },
    { name: 'still-end', start: 11.5, end: 11.8 }
  ];
  const teleportAt = 5;
  const snapAt = 8;
  return {
    phases,
    duration: 11.8,
    events: [{ name: 'teleport', t: teleportAt }, { name: 'snap-turn', t: snapAt }],
    summons: [],
    // Ink on just before each circle and off just after (the gap circle's off after the hands come back).
    toggles: [0.9, 3.1, 3.9, 6.1, 6.9, 9.05, 9.15, 11.6].map((t) => ({ t, action: 'ink' as const })),
    shots: [],
    pose: (t) => {
      // Walking 1.6 m forward at 0.8 m/s; the teleport takes the character back to its spawn.
      const walked = -1.6 * within(t, 1, 3);
      const body = [0, 0, walked];
      const u = t < 4 ? within(t, 1, 3) : t < 7 ? within(t, 4, 6) : t < 9.2 ? within(t, 7, 9) : within(t, 9.2, 11.5);
      return {
        head: add(HEAD, body),
        right: add(add(REST.right, body), circle(u)),
        left: add(REST.left, body),
        input: t >= 9.5 && t < 10.5 ? 'controller' : 'hand',
        turn: t >= snapAt && t < snapAt + STEP_SEC * 1.5 ? 1 : 0,
        respawn: t >= teleportAt && t < teleportAt + STEP_SEC * 0.5
      };
    }
  };
}

async function applyPose(page: Page, pose: Pose): Promise<void> {
  await page.evaluate((p) => {
    const device = window.IWER_DEVICE!;
    if (p.input && device.primaryInputMode !== p.input) device.primaryInputMode = p.input;
    device.position.set(p.head[0]!, p.head[1]!, p.head[2]!);
    device.hands.left!.position.set(p.left[0]!, p.left[1]!, p.left[2]!);
    device.hands.right!.position.set(p.right[0]!, p.right[1]!, p.right[2]!);
    device.controllers.left?.position.set(p.left[0]!, p.left[1]!, p.left[2]!);
    device.controllers.right?.position.set(p.right[0]!, p.right[1]!, p.right[2]!);
    if (p.rightPose) {
      const want = p.rightPose === 'middlePinch' ? 'middlePinch' : 'blend';
      if (device.hands.right!.poseId !== want) window.__setHandPoseId!('right', want);
    }
    window.__setMockInput({ thumbstick: { turnX: p.turn ?? 0 } });
    if (p.respawn && !window.__respawnCharacter()) throw new Error('Character respawn failed.');
  }, pose);
}

/** Records one scripted take in the running capture app; the GLB and its ground truth land in `artifactDir`. */
export async function recordHandTraceTake({ browser, baseUrl, artifactDir, consoleErrors, scenario }: {
  browser: Browser;
  baseUrl: string;
  artifactDir: string;
  consoleErrors: string[];
  scenario: HandTraceScenario;
}): Promise<HandTraceTake> {
  await mkdir(artifactDir, { recursive: true });
  const label = `hand-traces-${scenario}`;
  const { context, page } = await setupPage(browser, { iwer: true, consoleErrors, label }) as { context: { close: () => Promise<void> }; page: Page };
  try {
    // tsx keeps function names with an __name helper the page lacks.
    await page.addInitScript('globalThis.__name = (target) => target;');
    await openCapture(page, baseUrl, {});
    await enterIwer(page, 'hand');
    const { step } = stepper(page) as { step: (count?: number) => Promise<void> };
    await page.evaluate(installHandBlend);
    const middlePinch = await page.evaluate(installMiddlePinchPose);
    await page.evaluate(() => window.__blendHands!('default', 'point', 1));
    const { phases, duration, pose, events, summons: plannedSummons, toggles: plannedToggles, shots } = script(scenario);
    await applyPose(page, pose(0));
    await step(30);

    await clickButton(page, 'Start Recording');
    await page.getByRole('button', { name: 'Stop Recording', exact: true }).waitFor({ timeout: 10_000 });
    const groundTruth: GroundTruthSample[] = [];
    const chrome: ChromeSample[] = [];
    const toggles: HookToggle[] = [];
    const screenshots: string[] = [];
    const summons: ScriptedSummon[] = plannedSummons.map((s) => ({ ...s, pressStep: Math.round(s.press / STEP_SEC), releaseStep: Math.round(s.release / STEP_SEC), pressSim: NaN, releaseSim: NaN }));
    const keySteps = new Set(summons.flatMap((s) => [s.pressStep, s.releaseStep, s.releaseStep + 1]));
    const shotSteps = new Map(shots.map((shot) => [Math.round(shot.t / STEP_SEC), shot.name]));
    const stopSummon = summons.find((s) => s.action === 'record');
    const steps = Math.round(duration / STEP_SEC);
    let kept: TracesSnapshot | null = null;
    let nextToggle = 0;
    const downloaded = stopSummon ? page.waitForEvent('download', { timeout: 120_000 }) : null;
    for (let i = 0; i <= steps; i += 1) {
      const t = i * STEP_SEC;
      await applyPose(page, pose(t));
      const shot = shotSteps.get(i);
      // A headset-view frame, IWER's own overlay hidden; the step is the script's own.
      if (shot) {
        await page.evaluate(() => {
          window.__setFrameStepping(true, true);
          for (const element of document.querySelectorAll<HTMLElement>('#ui-root, #VRButton, #ARButton, [data-webxr_runtime] > div')) element.style.visibility = 'hidden';
        });
      }
      await step(1);
      if (shot) {
        const file = path.join(artifactDir, `${label}-${shot}.png`);
        await page.screenshot({ path: file });
        screenshots.push(file);
        await page.evaluate(() => {
          window.__setFrameStepping(true, false);
          for (const element of document.querySelectorAll<HTMLElement>('#ui-root, #VRButton, #ARButton, [data-webxr_runtime] > div')) element.style.visibility = '';
        });
      }
      while (nextToggle < plannedToggles.length && plannedToggles[nextToggle]!.t <= t + 1e-9) {
        const toggle = plannedToggles[nextToggle]!;
        const ran = await page.evaluate((action) => ({ done: window.__runHaloAction(action, 'hands'), sim: window.__sampleHolds().simSec }), toggle.action);
        toggles.push({ ...toggle, ...ran });
        nextToggle += 1;
      }
      const readChrome = scenario === 'authored' && (i % 6 === 0 || keySteps.has(i));
      const read = await page.evaluate((withChrome) => {
        const sample = window.__sampleHands();
        const holds = window.__sampleHolds();
        const view = withChrome ? window.__sampleChrome() : null;
        return {
          sim: holds.simSec,
          left: sample.left.tracked['index-finger-tip'] ?? null,
          right: sample.right.tracked['index-finger-tip'] ?? null,
          source: { left: sample.left.source, right: sample.right.source },
          chrome: view ? {
            status: view.vr.statusLine?.text ?? null,
            tracingElapsedMs: view.ui.tracingElapsedMs,
            notice: view.ui.notice,
            live: holds.liveTrace,
            traces: holds.traces,
            haloOpen: holds.headset.halo !== null
          } : null
        };
      }, readChrome);
      groundTruth.push({
        t,
        sim: read.sim,
        phase: phases.find((phase) => t >= phase.start && t < phase.end)?.name ?? phases.at(-1)!.name,
        left: read.left as GroundTruthSample['left'],
        right: read.right as GroundTruthSample['right'],
        source: read.source
      });
      if (read.chrome) chrome.push({ t, sim: read.sim, ...read.chrome });
      for (const summon of summons) {
        if (summon.pressStep === i) summon.pressSim = read.sim;
        if (summon.releaseStep === i) summon.releaseSim = read.sim;
      }
      if (stopSummon && i === stopSummon.releaseStep) kept = read.chrome!.traces;
    }
    if (!stopSummon) kept = await page.evaluate(() => window.__sampleHolds().traces);
    // What capture did with the scripted locomotion: snap turns taken and the rig's yaw.
    const locomotion = await page.evaluate(() => (JSON.parse(window.render_game_to_text()) as { thumbstick?: { snapCount: number; rigYaw: number } }).thumbstick ?? null);
    const glb = path.join(artifactDir, `${label}.glb`);
    if (downloaded) {
      // The Halo's S stopped the take: release frames until the export lands.
      let settled = false;
      downloaded.then(() => { settled = true; }, () => { settled = true; });
      for (let attempt = 0; attempt < 400 && !settled; attempt += 1) {
        await page.clock.runFor(100);
        await Promise.race([downloaded.catch(() => undefined), new Promise((resolve) => setTimeout(resolve, 25))]);
      }
      await (await downloaded).saveAs(glb);
    } else {
      await saveDownload(page, async () => {
        await clickButton(page, 'Stop Recording');
        for (let i = 0; i < 40; i += 1) await step(1);
      }, glb);
    }
    const after = await page.evaluate(() => {
      const holds = window.__sampleHolds();
      return { traces: holds.traces, live: holds.liveTrace, actions: holds.actions.map(({ input, action, done }) => ({ input, action, done })) };
    });
    let inkWhileStopped: HandTraceTake['final']['inkWhileStopped'] = null;
    let nextTake: HandTraceTake['final']['nextTake'] = null;
    if (scenario === 'authored') {
      inkWhileStopped = await page.evaluate(() => ({ done: window.__runHaloAction('ink', 'hands'), notice: window.__sampleChrome().ui.notice }));
      await clickButton(page, 'Start Recording');
      await page.getByRole('button', { name: 'Stop Recording', exact: true }).waitFor({ timeout: 10_000 });
      await step(30);
      nextTake = await page.evaluate(() => {
        const view = window.__sampleChrome();
        return { open: window.__sampleHolds().traces.open, tracingElapsedMs: view.ui.tracingElapsedMs, status: view.vr.statusLine?.text ?? null };
      });
    }
    const take: HandTraceTake = {
      scenario, glb, phases, events, groundTruth, locomotion, summons, toggles, chrome,
      final: { kept, afterStop: after.traces, liveAfterStop: after.live, actions: after.actions, inkWhileStopped, nextTake },
      pinchGaps: middlePinch,
      screenshots
    };
    await writeFile(path.join(artifactDir, `${label}-ground-truth.json`), JSON.stringify(take));
    return take;
  } finally {
    await context.close();
  }
}
